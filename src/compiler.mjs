// ============================================================================
// compiler.mjs — 编译期图校验：把工作流定义编译为可执行计划
// 架构位置：位于 registry（能力定义）与 runtime（执行）之间；发布/保存前调用。
// 职责：校验图合法性（空图、重复 id、未知操作、参数 schema、绑定来源、端口、多控制输入、
//       缺少触发器、环检测），并产出执行计划（拓扑顺序 order、入口 entry、所需 capabilities）。
// 主要导出：compile(workflow, registry)
// 规范依据：§5.2 / §6 / §7.1 / §18.1
// ============================================================================
import { validateSchema } from './lib.mjs'

// 判断 family 是否为事件触发器（入口节点与 NO_TRIGGER 校验的判定依据）
const isTrigger = (fam) => fam.type === 'core.trigger'

/**
 * 校验工作流图并生成执行计划。校验不抛异常，问题全部汇总到 errors / warnings。
 * @param {object} workflow 工作流定义（含 nodes / controlEdges）
 * @param {object} registry 操作注册表，需提供 get(type, operation) → { family, operation }
 * @returns {{ok:boolean, errors:Array, warnings:Array, plan:object}} 校验结果与执行计划；
 *   plan.order 为拓扑执行顺序，plan.entry 为入口节点 id 列表，plan.capabilities 为所需能力集。
 */
export function compile(workflow, registry) {
  const errors = []
  const warnings = []
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : []
  const controlEdges = Array.isArray(workflow?.controlEdges) ? workflow.controlEdges : []

  if (nodes.length === 0) errors.push({ code: 'EMPTY_GRAPH', message: '图为空，不能发布' })

  const byId = new Map()
  for (const n of nodes) {
    if (!n.id) { errors.push({ code: 'NODE_NO_ID', message: '节点缺少 id' }); continue }
    if (byId.has(n.id)) errors.push({ nodeId: n.id, code: 'DUP_ID', message: `重复节点 id: ${n.id}` })
    byId.set(n.id, n)
    const found = registry.get(n.type, n.operation)
    if (!found) { errors.push({ nodeId: n.id, code: 'UNKNOWN_OP', message: `未知操作: ${n.type}/${n.operation}` }); continue }
    n.__fam = found.family; n.__op = found.operation
    // 校验节点静态填写的 params：允许部分提供，缺失字段可能由 binding 在运行时补齐
    for (const [k, v] of Object.entries(n.params || {})) {
      const schema = found.operation.inputSchema.properties?.[k]
      if (schema) { const e = validateSchema(v, schema, `/${k}`); for (const x of e) errors.push({ nodeId: n.id, field: k, code: 'PARAM_INVALID', message: x.message }) }
    }
    // 校验 binding：必须是 {kind:'ref'} 且来源节点已存在（含输出根字段提示）
    for (const [target, b] of Object.entries(n.bindings || {})) {
      if (!b || b.kind !== 'ref') { errors.push({ nodeId: n.id, field: target, code: 'BINDING_SHAPE', message: '绑定必须是 {kind:"ref"}' }); continue }
      if (!byId.has(b.nodeId)) { errors.push({ nodeId: n.id, field: target, code: 'BINDING_SRC_MISSING', message: `绑定来源不存在: ${b.nodeId}` }); continue }
      const src = byId.get(b.nodeId)
      const rootTok = String(b.pointer || '').split('/')[1]
      const outProps = src?.__op?.outputSchema?.properties
      if (outProps && rootTok && !(rootTok in outProps)) {
        warnings.push({ nodeId: n.id, field: target, code: 'BINDING_ROOT', message: `来源 ${src.id} 输出无 "${rootTok}" 字段` })
      }
    }
  }

  // 控制边校验：端点存在、端口合法，并统计各节点控制入度
  const inDegreeControl = new Map(nodes.map((n) => [n.id, 0]))
  for (const e of controlEdges) {
    const from = byId.get(e?.from?.nodeId), to = byId.get(e?.to?.nodeId)
    if (!from || !to) { errors.push({ code: 'EDGE_NODE_MISSING', message: `连线端点不存在: ${JSON.stringify(e)}` }); continue }
    const outPorts = from.__op?.ports?.out || []
    const inPorts = to.__op?.ports?.in || []
    if (!outPorts.includes(e.from.port)) errors.push({ edge: e, code: 'EDGE_OUT_PORT', message: `${from.id} 无输出端口 ${e.from.port}` })
    if (!inPorts.includes(e.to.port)) errors.push({ edge: e, code: 'EDGE_IN_PORT', message: `${to.id} 无输入端口 ${e.to.port}` })
    inDegreeControl.set(to.id, (inDegreeControl.get(to.id) || 0) + 1)
  }
  // 多控制输入只允许 Merge/Join 汇聚；普通节点入度 >1 视为并发汇聚语义缺失
  for (const [id, deg] of inDegreeControl) {
    const nn = byId.get(id)
    const isMerge = nn && nn.type === 'core.control' && nn.operation === 'merge'
    if (deg > 1 && !isMerge) errors.push({ nodeId: id, code: 'MULTI_CONTROL_INPUT', message: `${id} 有 ${deg} 个控制输入；请用 Merge/Join` })
  }
  // 至少需要一个触发器节点，否则流程永远无法被事件驱动
  const triggers = nodes.filter((n) => n.__fam && isTrigger(n.__fam))
  if (nodes.length && triggers.length === 0) errors.push({ code: 'NO_TRIGGER', message: '流程缺少事件触发节点' })

  // DAG 检测：控制边 + 数据绑定边合并为邻接表，用 Kahn 拓扑排序判定是否成环
  const adj = new Map(nodes.map((n) => [n.id, new Set()]))
  const indeg = new Map(nodes.map((n) => [n.id, 0]))
  // 去重加边：同一对 (a,b) 只计一次入度，避免重复连线干扰拓扑排序与环判定
  const addEdge = (a, b) => { if (!adj.has(a) || !adj.has(b)) return; if (!adj.get(a).has(b)) { adj.get(a).add(b); indeg.set(b, (indeg.get(b) || 0) + 1) } }
  for (const e of controlEdges) addEdge(e.from?.nodeId, e.to?.nodeId)
  for (const n of nodes) for (const b of Object.values(n.bindings || {})) if (b?.nodeId) addEdge(b.nodeId, n.id)
  // Kahn 算法：以入度为 0 的节点为起点不断摘除；若覆盖不到全部节点说明存在环
  const queue = nodes.filter((n) => (indeg.get(n.id) || 0) === 0).map((n) => n.id)
  const order = []
  while (queue.length) { const id = queue.shift(); order.push(id); for (const m of adj.get(id)) { indeg.set(m, indeg.get(m) - 1); if (indeg.get(m) === 0) queue.push(m) } }
  if (order.length !== nodes.length && nodes.length) errors.push({ code: 'CYCLE', message: '检测到环（控制或数据依赖）；循环必须使用显式循环节点' })

  // 汇总所有节点声明的 requiredCapabilities（去重），供运行时一次性申请权限
  const capabilities = [...new Set(nodes.flatMap((n) => n.__op?.requiredCapabilities || []))]
  // 入口 = 无控制输入且为触发器；触发器缺失时兜底为所有无控制输入的节点
  const entry = nodes.filter((n) => (inDegreeControl.get(n.id) || 0) === 0 && n.__fam && isTrigger(n.__fam)).map((n) => n.id)

  return {
    ok: errors.length === 0,
    errors, warnings,
    plan: {
      order,
      entry: entry.length ? entry : nodes.filter((n) => (inDegreeControl.get(n.id) || 0) === 0).map((n) => n.id),
      capabilities,
      nodeCount: nodes.length,
      edgeCount: controlEdges.length,
    },
  }
}
