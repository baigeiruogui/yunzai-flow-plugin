// ============================================================================
// runtime.mjs — 运行时执行引擎：驱动工作流真正跑起来
// 架构位置：位于 compiler（产出计划）与 scheduler（限流）之间的执行核心；
//           接收 workflow + registry + services，产出完整运行快照。
// 职责：事件归一化、去重（dedupe）、节点执行与三种控制流（tryCatch / loop / subgraph）、
//       参数绑定解析、失败与重试处理、effect ledger 汇总与 receipts 提取。
// 主要导出：runWorkflow(...)；并 re-export normalizeEvent。
// 规范依据：§7（执行、分支、去重、幂等）— MVP 子集
// ============================================================================
import { newId, nowIso, deepClone, getPointer, setPointer } from './lib.mjs'
import { createCapabilityClient } from './capabilities.mjs'

export { normalizeEvent } from './events.mjs'
import { normalizeEvent } from './events.mjs'

/**
 * 执行一次工作流运行并返回完整快照；业务错误不抛出，统一以 status / nodes 状态表达。
 * @param {object} args
 * @param {object} args.workflow 工作流定义（nodes / controlEdges / id / workflowVersion）
 * @param {object} args.registry 操作注册表（提供 get(type, operation)）
 * @param {object} args.services 外部服务集合（如 subgraphs 的 get 方法）
 * @param {string} [args.mode='simulate'] 执行模式：simulate / live 等，透传给能力客户端
 * @param {object} [args.event] 触发事件，会被 normalizeEvent 归一化
 * @param {string} [args.botId='bot_demo'] 机器人 id，参与去重键
 * @param {string} [args.triggerId='trigger'] 触发器 id，参与去重键
 * @param {Set} [args.seenEvents] 事件去重集合：命中则整体跳过，未命中则登记
 * @param {Function} [args.onEvent] 运行事件回调（emit），回调异常被吞掉不影响主流程
 * @param {object} [args.seedOutputs] 初始 outputs 种子（子图调用时注入 __input__）
 * @param {number} [args.depth=0] 子图嵌套深度，用于限制递归层级
 * @returns {Promise<object>} 运行快照：status / nodes / logs / effects / receipts / ms 等
 */
export async function runWorkflow({
  workflow, registry, services, mode = 'simulate', event, botId = 'bot_demo', triggerId = 'trigger', seenEvents, onEvent = null, seedOutputs = null, depth = 0,
}) {
  const workflowId = workflow.id
  const workflowVersion = workflow.workflowVersion ?? 0
  const runId = newId('run')
  const startedAt = nowIso()
  const t0 = Date.now()
  // emit 用 try/catch 包裹：回调侧异常不能影响主执行流程
  const emit = (type, payload = {}) => { try { onEvent && onEvent({ ...payload, type, at: nowIso() }) } catch {} }
  emit('run.start', { runId, workflowId, workflowVersion, mode })
  const ev = normalizeEvent(event)
  const logs = []
  const effects = []
  const log = (level, msg, extra) => logs.push({ at: nowIso(), level, msg, ...(extra || {}) })

  const nodes = workflow.nodes || []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  // controlNext: nodeId -> { port: [目标节点 id 列表] }，描述每个节点各控制端口指向的后继
  const controlNext = new Map()
  for (const e of workflow.controlEdges || []) {
    if (!controlNext.has(e.from.nodeId)) controlNext.set(e.from.nodeId, {})
    const m = controlNext.get(e.from.nodeId)
    ;(m[e.from.port] ||= []).push(e.to.nodeId)
  }

  // states: nodeId -> 节点状态对象；outputs: nodeId -> 节点输出（供 binding 读取）
  const states = new Map()
  const outputs = new Map()
  if (seedOutputs) for (const [k, v] of Object.entries(seedOutputs)) outputs.set(k, v)
  for (const n of nodes) states.set(n.id, { nodeId: n.id, type: n.type, operation: n.operation, status: 'idle', ms: 0 })

  // ---- 事件去重（§7.4）----
  // 去重键 = bot + 事件 id + 工作流 + 触发器：同一事件的重复投递只执行一次
  const dedupeKey = `${botId}|${ev.eventId}|${workflowId}|${triggerId}`
  if (seenEvents && seenEvents.has(dedupeKey)) {
    log('warn', `重复事件已去重: ${dedupeKey}`)
    return {
      runId, workflowId, workflowVersion, mode, status: 'skipped', deduped: true, reason: 'DUPLICATE_EVENT',
      startedAt, endedAt: nowIso(), ms: Date.now() - t0,
      event: { eventId: ev.eventId, chat: ev.chat, sender: ev.sender, message: ev.message },
      nodes: [...states.values()].map((x) => ({ ...x, status: 'skipped' })), logs, effects, receipts: [], botId,
    }
  }
  // 先登记再执行：并发重复投递到达时，后来的请求会命中上面的 has 分支被跳过
  if (seenEvents) seenEvents.add(dedupeKey)


  // 能力客户端：所有外部副作用统一经此执行并记入 effects ledger，便于审计与 receipts 提取
  const capabilities = createCapabilityClient({ mode, services, runId, botId, workflowId, scopeIdentity: ev.chat?.id, ledger: effects, logger: log })
  // visited：防止同一节点在同一控制流内被重复执行（循环体会显式清除闭包内节点）
  const visited = new Set()
  let hardFailed = false // 不在任何 try 内发生的失败 → 整次运行失败
  let noMatch = false // 有节点返回 control='nomatch' → 运行结果标记 skipped
  const tryStack = [] // tryCatch 栈：栈顶保存最近一层 try 的失败标记，异常只回传给栈顶

  // 解析节点绑定：把上游 output 按 JSON Pointer 写入 input 对应字段；源缺失时跳过（保持 undefined）
  const resolveBindings = (n) => {
    const input = deepClone(n.params || {})
    for (const [target, b] of Object.entries(n.bindings || {})) {
      if (!b || b.kind !== 'ref') continue
      const srcOut = outputs.get(b.nodeId)
      const val = srcOut === undefined ? undefined : getPointer(srcOut, b.pointer)
      if (val === undefined) continue
      try { setPointer(input, target, val) } catch (e) { log('warn', `绑定写入失败 ${n.id} ${target}: ${e.message}`) }
    }
    return input
  }

  // 判断 key 是否被 binding 覆盖（含子路径）；被覆盖时缺参校验不再要求 params 提供该字段
  const hasBindingFor = (n, key) => Object.keys(n.bindings || {}).some((t) => t === `/${key}` || t.startsWith(`/${key}/`))

  /**
   * 执行 tryCatch 控制流：先跑 body 后继；body 内失败会置 tryStack 栈顶 failed，
   * 随后切 catch 分支并输出 {error, caught:true}；无论成败最后都跑 done。
   * @param {string} nodeId 节点 id
   * @param {object} n 节点定义
   * @param {object} st 节点状态对象
   */
  async function execTry(nodeId, n, st) {
    const t = Date.now()
    const tc = { failed: false, error: null }
    tryStack.push(tc)
    const bodyTargets = controlNext.get(nodeId)?.['body'] || []
    for (const b of bodyTargets) { await execNode(b); if (tc.failed) break }
    tryStack.pop()
    st.ms = Date.now() - t
    st.status = 'succeeded'
    if (tc.failed) {
      outputs.set(nodeId, { error: tc.error, caught: true }); st.output = { error: tc.error, caught: true }; st.control = 'catch'
      log('warn', `try ${n.id} 捕获错误 → catch: ${tc.error?.code || ''}`)
      for (const c of controlNext.get(nodeId)?.['catch'] || []) await execNode(c)
    } else {
      outputs.set(nodeId, { ok: true }); st.output = { ok: true }; st.control = 'body'
    }
    for (const d of controlNext.get(nodeId)?.['done'] || []) await execNode(d)
  }

  /**
   * 执行子图调用：解析入参 → 取子图定义（支持版本/哈希锁）→ 递归 runWorkflow → 提取 publicOutputs。
   * 嵌套深度超过 6 直接拒绝，防止子图互相引用造成无限递归。
   * @param {string} nodeId 节点 id
   * @param {object} n 节点定义
   * @param {object} st 节点状态对象
   */
  async function execSubgraph(nodeId, n, st) {
    const t = Date.now()
    const input = resolveBindings(n)
    const sgId = n.params?.subgraphId, ver = n.params?.version ?? 'latest'
    if (!sgId) throw Object.assign(new Error('缺少 subgraphId'), { code: 'SUBGRAPH_NO_ID' })
    const def = services.subgraphs ? services.subgraphs.get(sgId, ver === 'latest' ? null : Number(ver)) : null
    if (!def) throw Object.assign(new Error(`子图不存在: ${sgId}@${ver}`), { code: 'SUBGRAPH_NOT_FOUND' })
    if (n.params?.contentHash && def.contentHash && n.params.contentHash !== def.contentHash) throw Object.assign(new Error('子图内容摘要不匹配（版本锁）'), { code: 'SUBGRAPH_HASH_MISMATCH' })
    if (depth >= 6) throw Object.assign(new Error('子图嵌套过深'), { code: 'SUBGRAPH_DEPTH' })
    // 子图通过约定的种子输出 __input__ 接收调用方传入的 inputs
    const subInputs = input.inputs || {}
    const subRun = await runWorkflow({ workflow: { id: `${workflowId}:${nodeId}`, nodes: def.graph.nodes || [], controlEdges: def.graph.controlEdges || [] }, registry, services, mode, event: ev, botId, triggerId: 'sub', seenEvents: null, seedOutputs: { __input__: subInputs }, depth: depth + 1 })
    if (subRun.status === 'failed') { const ef = subRun.nodes.find((x) => x.status === 'failed'); throw Object.assign(new Error('子图内部失败: ' + (ef?.error?.message || '')), { code: 'SUBGRAPH_INNER_FAILED' }) }
    const outputsObj = {}
    for (const po of def.publicOutputs || []) { const nr = subRun.nodes.find((x) => x.nodeId === po.fromNodeId); const val = nr && nr.output !== undefined ? getPointer(nr.output, po.pointer || '') : undefined; outputsObj[po.id] = val }
    st.ms = Date.now() - t
    outputs.set(nodeId, { outputs: outputsObj })
    st.output = { outputs: outputsObj }; st.control = 'next'; st.status = 'succeeded'
    emit('node.ok', { nodeId, status: 'succeeded', control: 'next', ms: st.ms, output: st.output })
    log('info', `子图 ${n.id} 调用 ${sgId}@${def.version} 完成`)
    for (const t2 of controlNext.get(nodeId)?.['next'] || []) await execNode(t2)
  }

  /**
   * 执行 forEach 循环：先求 body 后继的传递闭包，每轮迭代重置闭包内节点的 visited/状态，
   * 让同一批节点可重复执行；每轮结果单独快照输出。
   * @param {string} nodeId 节点 id
   * @param {object} n 节点定义
   * @param {object} st 节点状态对象
   */
  async function execLoop(nodeId, n, st) {
    const t = Date.now()
    const input = resolveBindings(n)
    // 截断到 maxIterations（默认 1000），防止超大数组或失控循环拖垮运行时
    const items = Array.isArray(input.items) ? input.items.slice(0, input.maxIterations || 1000) : []
    const bodyTargets = controlNext.get(nodeId)?.['body'] || []
    // 求 body 后继的传递闭包：循环体可能包含多级分支/子流，闭包内节点都要参与重置与快照
    const bodyReach = new Set()
    const stack = [...bodyTargets]
    while (stack.length) { const id = stack.pop(); if (bodyReach.has(id)) continue; bodyReach.add(id); for (const p of Object.values(controlNext.get(id) || {})) for (const m of p) stack.push(m) }
    const results = []
    for (let idx = 0; idx < items.length; idx++) {
      outputs.set(nodeId, { item: items[idx], index: idx })
      emit('loop.iteration', { nodeId, index: idx, item: items[idx] })
      // 每轮迭代前清除 body 闭包内节点的 visited 与状态，使它们可被再次执行
      for (const id of bodyReach) { visited.delete(id); const s2 = states.get(id); if (s2) s2.status = 'idle' }
      for (const t2 of bodyTargets) await execNode(t2)
      const snap = {} // 本轮迭代的输出快照，供调试/展示每轮独立结果
      for (const id of bodyReach) if (outputs.has(id)) snap[id] = outputs.get(id)
      results.push({ index: idx, item: items[idx], outputs: snap })
      if (hardFailed) break
    }
    st.ms = Date.now() - t
    if (hardFailed) return
    outputs.set(nodeId, { count: results.length, results })
    st.output = { count: results.length, results }
    st.control = 'done'; st.status = 'succeeded'
    log('info', `循环 ${n.id} 完成 ${results.length} 次迭代 → done`)
    for (const t2 of controlNext.get(nodeId)?.['done'] || []) await execNode(t2)
  }

  /**
   * 执行单个节点：visited 去重、控制流分发（tryCatch/loop/subgraph）、参数校验、重试与失败处理。
   * 本函数自身不抛出（异常转为 failed 状态）；失败会写入 tryStack 栈顶或置 hardFailed。
   * @param {string} nodeId 节点 id
   */
  async function execNode(nodeId) {
    if (visited.has(nodeId)) return
    visited.add(nodeId)
    const n = byId.get(nodeId)
    const st = states.get(nodeId)
    const found = registry.get(n.type, n.operation)
    const t = Date.now()
    st.status = 'running'
    st.startedAt = nowIso()
    emit('node.start', { nodeId, nodeType: n.type, operation: n.operation })
    try {
      if (!found) throw Object.assign(new Error(`未知操作 ${n.type}/${n.operation}`), { code: 'UNKNOWN_OP' })
      const op = found.operation
      if (n.type === 'core.control' && n.operation === 'tryCatch') { await execTry(nodeId, n, st); return }
      if (n.type === 'core.loop' && n.operation === 'forEach') { await execLoop(nodeId, n, st); return }
      if (n.type === 'core.subgraph' && n.operation === 'call') { await execSubgraph(nodeId, n, st); return }
      const input = resolveBindings(n)
      // 缺参判定：input 未提供且没有 binding 覆盖才报错
      const missing = (op.inputSchema.required || []).filter((k) => input[k] === undefined && !hasBindingFor(n, k))
      if (missing.length) throw Object.assign(new Error(`缺少必填参数: ${missing.join(', ')}`), { code: 'INPUT_INVALID' })
      const ctx = { capabilities, event: ev, node: n, botId, mode, budget: { timeoutMs: 3000 }, log: (m) => log('info', `[${n.id}] ${m}`) }
      // 重试次数夹在 [1,5]：policy.maxAttempts 缺失/非法时安全兜底为 1
      const maxAttempts = Math.max(1, Math.min(5, Number(n.policy && n.policy.maxAttempts) || 1))
      let res = await op.execute(ctx, input)
      let attempt = 1
      // 仅对 retryable 失败重试，退避 10ms*attempt，避免瞬时故障时打爆下游
      while (res && res.status === 'failed' && res.error && res.error.retryable && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 10 * attempt))
        res = await op.execute(ctx, input); attempt++
      }
      st.attempts = attempt
      st.ms = Date.now() - t
      if (res.status === 'succeeded') {
        outputs.set(nodeId, res.output)
        st.output = res.output
        st.control = res.control || 'next'
        st.effect = op.effect
        st.status = 'succeeded'
        emit('node.ok', { nodeId, status: 'succeeded', control: st.control, ms: st.ms, output: res.output })
        log('info', `节点 ${n.id} (${n.type}/${n.operation}) 成功 → ${st.control}`)
        if (res.control === 'nomatch') { noMatch = true; return }
        const next = controlNext.get(nodeId)?.[res.control] || []
        for (const t2 of next) await execNode(t2)
        // body 内已失败时停止继续遍历本节点后继，把控制权交还 execTry 的 catch/done
        if (tryStack.length && tryStack[tryStack.length - 1].failed) return
      } else if (res.status === 'failed') {
        st.status = 'failed'; st.error = res.error || { code: 'NODE_FAILED', message: '执行失败' }
        emit('node.fail', { nodeId, error: st.error })
        // 在 try 内 → 只标记栈顶供 catch 接管；否则 → 整次运行失败
        if (tryStack.length) { const tc = tryStack[tryStack.length - 1]; tc.failed = true; tc.error = st.error } else { hardFailed = true }
        log('error', `节点 ${n.id} 失败: ${st.error.code} ${st.error.message}`)
      } else if (res.status === 'waiting') {
        st.status = 'waiting'; st.checkpointRef = res.checkpointRef
      } else {
        st.status = 'cancelled'
      }
    } catch (e) {
      st.ms = Date.now() - t
      st.status = 'failed'
      st.error = { code: e.code || 'NODE_EXCEPTION', message: e.message, retryable: false, effectState: 'none' }
      emit('node.fail', { nodeId, error: st.error })
      if (tryStack.length) { const tc = tryStack[tryStack.length - 1]; tc.failed = true; tc.error = st.error } else { hardFailed = true }
      log('error', `节点 ${nodeId} 异常: ${e.code || ''} ${e.message}`)
    }
  }

  // 入口 = 没有任何 in 端口控制边的节点；按序执行，出现硬失败即中断后续入口
  const entries = nodes.filter((n) => !(workflow.controlEdges || []).some((e) => e.to.nodeId === n.id && e.to.port === 'in'))
  for (const e of entries) { if (hardFailed) break; await execNode(e.id) }

  // 未被控制流触达的节点统一标记 skipped，保证快照中每个节点都有终态
  for (const n of nodes) { const st = states.get(n.id); if (st.status === 'idle') st.status = 'skipped' }

  const receipts = []
  // 优先从 effect ledger 提取 QQ 发送回执；没有回执时退回节点输出里自带的 receipt
  for (const eff of effects) if (eff.kind === 'qq.send' && eff.result && eff.result.message_id) receipts.push({ message_id: eff.result.message_id, target: eff.input?.target, message: eff.input?.message, simulated: !!eff.simulated })
  if (!receipts.length) for (const [id, out] of outputs) { if (out && out.receipt) receipts.push({ nodeId: id, ...out.receipt }) }

  const status = hardFailed ? 'failed' : noMatch ? 'skipped' : 'succeeded'
  return finish({ status })

  /**
   * 汇总并返回统一结构的运行快照；发 run.end 事件。
   * @param {object} args
   * @param {string} args.status 终态：succeeded / failed / skipped
   * @param {boolean} [args.deduped=false] 是否因去重而跳过
   * @param {string} [args.reason] 跳过/失败原因
   * @returns {object} 运行快照
   */
  function finish({ status, deduped = false, reason }) {
    const endedAt = nowIso()
    emit('run.end', { runId, status, deduped: !!deduped, ms: Date.now() - t0, reason })
    return {
      runId, workflowId, workflowVersion, mode, status, deduped: !!deduped, reason,
      startedAt, endedAt, ms: Date.now() - t0,
      event: { eventId: ev.eventId, chat: ev.chat, sender: ev.sender, message: ev.message },
      nodes: [...states.values()],
      logs, effects, receipts,
      botId,
    }
  }
}
