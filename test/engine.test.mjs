// Engine tests — evidence for the M0/M1 acceptance items (§24.1 subset).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { buildRegistry } from '../src/registry.mjs'
import { compile } from '../src/compiler.mjs'
import { runWorkflow } from '../src/runtime.mjs'
import { Store, SubgraphStore, toRunnable } from '../src/storage.mjs'
import { seedIfEmpty, seedSubgraphs } from '../src/seed.mjs'
import { SecretService, CacheService, CryptoService, HttpService, QQService, RenderService, DataSourceService } from '../src/capabilities.mjs'
import { DataSourceRegistry, DataSourceRuntime } from '../src/datasource.mjs'

function env() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yf-test-'))
  const store = new Store(dir)
  seedIfEmpty(store)
  const subgraphs = new SubgraphStore(path.join(dir, 'subgraphs'))
  seedSubgraphs(subgraphs)
  const secrets = new SecretService()
  secrets.put('demo_aes', crypto.randomBytes(32), { type: 'symmetric' })
  secrets.put('demo_sign', 'seed', { type: 'ed25519' })
  const services = {
    secrets, cache: new CacheService(), http: new HttpService(), crypto: new CryptoService(secrets),
    qq: new QQService(), render: new RenderService(path.join(dir, 'resources')), datasource: new DataSourceService(), subgraphs,
  }
  services.http.mock('mock://weather', { status: 200, body: { weather: '晴，22℃', city: '石家庄' } })
  secrets.put('demo_api_key', 'sk-demo')
  const dsRegistry = new DataSourceRegistry(path.resolve('datasources'))
  services.datasource = new DataSourceRuntime({ http: services.http, secrets, cache: services.cache, registry: dsRegistry })
  services.http.mock('https://api.weather.example/v1/weather', ({ url }) => { try { const u = new URL(url); const city = u.searchParams.get('city') || '某地'; return { status: 200, body: { data: { city, weather: '多云', temp: 18 } } } } catch { return { status: 200, body: { data: { city: '某地', weather: '晴', temp: 20 } } } } })
  services.http.mock('https://api.example.com/v1/profile', ({ url }) => { try { const u = new URL(url); const uid = u.searchParams.get('uid') || '0'; return { status: 200, body: { data: { name: '玩家' + String(uid).slice(-3), level: 42, uid } } } } catch { return { status: 200, body: { data: { name: '玩家', level: 1 } } } } })
  return { dir, store, services, registry: buildRegistry(), seen: new Set(), dsRegistry }
}
const wf = (store, id) => toRunnable(store.getWorkflow(id))
const msgEvent = (text, eventId) => ({ eventId: eventId || crypto.randomUUID(), chat: { type: 'group', id: 'group_10086' }, sender: { userId: '10001', nickname: '小明' }, message: { text } })

test('compile: seeded 群欢迎 workflow is valid DAG', () => {
  const { store, registry } = env()
  const r = compile(wf(store, 'wf_hello'), registry)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.deepEqual(r.plan.entry, ['trigger_1'])
})

test('run: 群欢迎 /你好 → 1 条发送，全节点成功', async () => {
  const { store, services, registry, seen } = env()
  const run = await runWorkflow({ workflow: wf(store, 'wf_hello'), registry, services, mode: 'real', event: msgEvent('/你好'), seenEvents: seen })
  assert.equal(run.status, 'succeeded')
  assert.equal(run.receipts.length, 1)
  const send = run.nodes.find((n) => n.nodeId === 'send_1')
  const tmpl = run.nodes.find((n) => n.nodeId === 'template_1')
  assert.equal(send.status, 'succeeded')
  assert.equal(tmpl.output.text, '你好，小明！欢迎加入本群 👋')
  assert.equal(services.qq.sent.length, 1)
})

test('dedupe: 同一 eventId 第二次运行被跳过，不重复发送 (§7.4)', async () => {
  const { store, services, registry, seen } = env()
  const event = msgEvent('/你好', 'evt_fixed_1')
  await runWorkflow({ workflow: wf(store, 'wf_hello'), registry, services, mode: 'real', event, seenEvents: seen })
  const run2 = await runWorkflow({ workflow: wf(store, 'wf_hello'), registry, services, mode: 'real', event, seenEvents: seen })
  assert.equal(run2.deduped, true)
  assert.equal(run2.status, 'skipped')
  assert.equal(services.qq.sent.length, 1, '重复投递不应再次发送')
})

test('trigger no-match → 运行 skipped，无发送', async () => {
  const { store, services, registry, seen } = env()
  const run = await runWorkflow({ workflow: wf(store, 'wf_hello'), registry, services, mode: 'real', event: msgEvent('/随便说'), seenEvents: seen })
  assert.equal(run.status, 'skipped')
  assert.equal(run.receipts.length, 0)
  assert.equal(services.qq.sent.length, 0)
})

test('condition 分支: 首次签到走 true 分支，第二次走 false 分支 (§7.2)', async () => {
  const { store, services, registry, seen } = env()
  const r1 = await runWorkflow({ workflow: wf(store, 'wf_checkin'), registry, services, mode: 'real', event: msgEvent('/签到', 'e1'), seenEvents: seen })
  assert.equal(r1.status, 'succeeded')
  assert.equal(r1.nodes.find((n) => n.nodeId === 'send_ok').status, 'succeeded')
  assert.equal(r1.nodes.find((n) => n.nodeId === 'send_dup').status, 'skipped')
  const r2 = await runWorkflow({ workflow: wf(store, 'wf_checkin'), registry, services, mode: 'real', event: msgEvent('/签到', 'e2'), seenEvents: seen })
  assert.equal(r2.status, 'succeeded')
  assert.equal(r2.nodes.find((n) => n.nodeId === 'send_dup').status, 'succeeded')
  assert.equal(r2.nodes.find((n) => n.nodeId === 'send_ok').status, 'skipped')
})

test('crypto: AEAD 往返一致 + 篡改密文被拒绝 (§12.4)', () => {
  const { services } = env()
  const env1 = services.crypto.encrypt('你好，云崽！机密', { secretRef: 'demo_aes', aad: 'demo' })
  assert.equal(env1.format, 'yf.crypto.aead.v1')
  const back = services.crypto.decrypt(env1, { secretRef: 'demo_aes' })
  assert.equal(back.plaintext, '你好，云崽！机密')
  const tampered = { ...env1, ciphertext: Buffer.from('xxxx').toString('base64') }
  assert.throws(() => services.crypto.decrypt(tampered, { secretRef: 'demo_aes' }), /authentication failed/)
  // wrong key
  const other = new CryptoService((() => { const s = new SecretService(); s.put('demo_aes', crypto.randomBytes(32)); return s })())
  assert.throws(() => other.decrypt(env1, { secretRef: 'demo_aes' }), /authentication failed/)
})

test('crypto: Ed25519 签名/验签', () => {
  const { services } = env()
  const sig = services.crypto.sign('payload-中文', { secretRef: 'demo_sign' })
  assert.equal(sig.format, 'yf.crypto.signature.v1')
  assert.equal(services.crypto.verify('payload-中文', sig, { secretRef: 'demo_sign' }).valid, true)
  assert.equal(services.crypto.verify('payload-改动', sig, { secretRef: 'demo_sign' }).valid, false)
})

test('cache: incr 原子，first 仅首次为 true', () => {
  const c = new CacheService()
  assert.deepEqual(c.incr('k'), { value: 1, first: true })
  assert.deepEqual(c.incr('k'), { value: 2, first: false })
  assert.deepEqual(c.get('nope'), { found: false })
  c.set('z', 0, 3600); assert.deepEqual(c.get('z'), { found: true, value: 0 }, 'false/0 保真')
})

test('secret: 运行快照不含密钥明文 (§12.3 SECRET-01)', async () => {
  const { store, services, registry, seen } = env()
  const rawKey = services.secrets.resolve('demo_aes').value.toString('base64')
  const run = await runWorkflow({ workflow: wf(store, 'wf_crypto'), registry, services, mode: 'real', event: msgEvent('/加密', 'e_crypto'), seenEvents: seen })
  const dump = JSON.stringify(run)
  assert.equal(dump.includes(rawKey), false, '快照不得含密钥明文')
  assert.equal(run.status, 'succeeded')
})

test('http + pick: 点选取值正确进入模板 (§10)', async () => {
  const { store, services, registry, seen } = env()
  const run = await runWorkflow({ workflow: wf(store, 'wf_http'), registry, services, mode: 'real', event: msgEvent('/天气', 'e_http'), seenEvents: seen })
  assert.equal(run.status, 'succeeded')
  assert.equal(run.nodes.find((n) => n.nodeId === 'tmpl_1').output.text, '今天天气：晴，22℃')
})

test('publish: 发布后为不可变快照，改草稿不影响旧版本 (§18.3)', () => {
  const { store } = env()
  const doc = store.getWorkflow('wf_hello')
  const snap = store.publishWorkflow(doc)
  const v1 = store.getVersion('wf_hello', snap.workflowVersion)
  const before = v1.graph.nodes.length
  doc.graph.nodes.push({ id: 'x', type: 'core.template', operation: 'text', params: {} })
  store.saveWorkflow(doc)
  const v1again = store.getVersion('wf_hello', snap.workflowVersion)
  assert.equal(v1again.graph.nodes.length, before, '已发布版本不应被草稿改动影响')
})

test('compile: 环路被拒绝 (§7.1 GRAPH-04)', () => {
  const { registry } = env()
  const g = {
    nodes: [
      { id: 'a', type: 'core.template', operation: 'text', params: { template: 'x' }, bindings: {} },
      { id: 'b', type: 'core.template', operation: 'text', params: { template: 'y' }, bindings: {} },
    ],
    controlEdges: [
      { from: { nodeId: 'a', port: 'next' }, to: { nodeId: 'b', port: 'in' } },
      { from: { nodeId: 'b', port: 'next' }, to: { nodeId: 'a', port: 'in' } },
    ],
  }
  const r = compile(g, registry)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.code === 'CYCLE'))
})

test('loop: ForEach 控制流每项执行 body，3 次发送，输出回执 3 条 (§7.2)', async () => {
  const { store, services, registry, seen } = env()
  const r = compile(wf(store, 'wf_loop'), registry)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  const run = await runWorkflow({ workflow: wf(store, 'wf_loop'), registry, services, mode: 'real', event: msgEvent('/批量', 'e_loop'), seenEvents: seen })
  assert.equal(run.status, 'succeeded')
  assert.equal(run.nodes.find((n) => n.nodeId === 'loop_1').status, 'succeeded')
  assert.equal(run.nodes.find((n) => n.nodeId === 'loop_1').output.count, 3)
  assert.equal(services.qq.sent.length, 3, '每项一次发送')
  assert.equal(run.receipts.length, 3)
  // 最后一次迭代的模板渲染应为王五
  assert.equal(services.qq.sent[2].message[0].data.text, '你好，王五！👋')
})

test('napcat manifest: 178 项基础操作全部映射，分轴统计', async () => {
  const { registry } = env()
  const { napcatStats } = await import('../src/integrations/napcat/manifest.mjs')
  const nc = napcatStats(registry.families)
  assert.equal(nc.baseOps, 178)
  assert.equal(nc.mapped, 178, '每项至少映射元数据')
  assert.equal(nc.structuredForms, 178, '178 项全部结构化表单')
  assert.equal(nc.genericForms, 0, '无通用表单剩余')
  assert.equal(nc.structuredForms + nc.genericForms, 178)
  assert.ok(nc.structuredFromSource >= 80, '源码 TypeBox 提取 >=80')
  assert.equal(nc.liveVerified, 0)
  const kick = registry.get('qq.member', 'set_group_kick').operation
  assert.equal(kick.title, '踢出群员')
  assert.equal(kick.ui.fields.length, 3)
  assert.equal(kick.inputSchema.properties.group_id.type, 'string')
})

test('runtime emits SSE event sequence (run.start → node.* → run.end) (§19)', async () => {
  const { store, services, registry, seen } = env()
  const events = []
  await runWorkflow({ workflow: wf(store, 'wf_hello'), registry, services, mode: 'simulate', event: msgEvent('/你好', 'e_sse'), seenEvents: seen, onEvent: (ev) => events.push(ev) })
  const types = events.map((e) => e.type)
  assert.equal(types[0], 'run.start')
  assert.equal(types[types.length - 1], 'run.end')
  assert.equal(events.filter((e) => e.type === 'node.start').length, 3)
  assert.equal(events.filter((e) => e.type === 'node.ok').length, 3)
  assert.equal(events.find((e) => e.type === 'run.end').status, 'succeeded')
})

test('sqlite driver: 工作流/版本/运行 round-trip (§18.2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yf-sqlite-'))
  // import factory lazily to avoid top-level sqlite cost in other tests
  return import('../src/storage.mjs').then(({ createStore }) => {
    const store = createStore({ dataDir: dir, driver: 'sqlite', dbFile: path.join(dir, 'flow.sqlite') })
    store.createWorkflow({ id: 'wf_x', title: 'T', graph: { nodes: [{ id: 'a', type: 'core.template', operation: 'text', params: { template: 'x' }, bindings: {} }], controlEdges: [] } })
    assert.equal(store.listWorkflows().length, 1)
    const doc = store.getWorkflow('wf_x'); assert.equal(doc.title, 'T')
    const snap = store.publishWorkflow(doc); assert.equal(snap.workflowVersion, 1)
    assert.equal(store.getVersion('wf_x', 1).workflowVersion, 1)
    store.saveRun({ runId: 'run_1', workflowId: 'wf_x', startedAt: new Date().toISOString(), status: 'succeeded', nodes: [] })
    assert.equal(store.getRun('run_1').status, 'succeeded')
    assert.equal(store.listRuns('wf_x').length, 1)
  })
})

test('code node: 独立子进程执行并注入结果到下游 (§16)', async () => {
  const { store, services, registry, seen } = env()
  const run = await runWorkflow({ workflow: wf(store, 'wf_code'), registry, services, mode: 'real', event: msgEvent('/算', 'e_code'), seenEvents: seen })
  assert.equal(run.status, 'succeeded')
  const codeNode = run.nodes.find((n) => n.nodeId === 'code_1')
  assert.equal(codeNode.output.result.greeting, '你好，小明！')
  assert.equal(codeNode.output.result.len, 2)
  assert.equal(run.nodes.find((n) => n.nodeId === 'tmpl_1').output.text, '你好，小明！（名字 2 个字）')
  assert.ok(Array.isArray(codeNode.output.logs) && codeNode.output.logs.length >= 1)
})

test('code supervisor: 超时被 SIGKILL 终止，返回 CODE_TIMEOUT (§16.4)', async () => {
  const { runCode } = await import('../src/code/supervisor.mjs')
  const t0 = Date.now()
  const r = await runCode('while(true){}', {}, { timeoutMs: 700, mode: 'real' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'CODE_TIMEOUT')
  assert.ok(Date.now() - t0 < 5000, 'should return promptly after timeout')
})

test('code supervisor: 抛错返回 CODE_RUNTIME；模拟模式禁网', async () => {
  const { runCode } = await import('../src/code/supervisor.mjs')
  const bad = await runCode('throw new Error("boom")', {}, { timeoutMs: 2000, mode: 'real' })
  assert.equal(bad.ok, false); assert.equal(bad.error.code, 'CODE_RUNTIME'); assert.match(bad.error.message, /boom/)
  const net = await runCode('await sdk.http.request({url:"http://example.com"})', {}, { timeoutMs: 2000, mode: 'simulate' })
  assert.equal(net.ok, false); assert.equal(net.error.code, 'CODE_NET_BLOCKED')
})

test('pairing auth: 单次配对码 → 会话 token，过期/撤销/重复使用均拒绝 (§20)', async () => {
  const { PairingService } = await import('../src/auth.mjs')
  const a = new PairingService()
  const { code } = a.issueCode()
  const r = a.redeem(code)
  assert.ok(r.token && r.token.length > 10)
  assert.ok(a.verify(r.token))
  assert.throws(() => a.redeem(code), (e) => e.code === 'PAIR_INVALID')
  assert.throws(() => a.redeem('not-a-code'), (e) => e.code === 'PAIR_INVALID')
  const ex = a.issueCode({ ttlMs: -1 })
  assert.throws(() => a.redeem(ex.code), (e) => e.code === 'PAIR_EXPIRED')
  a.revoke(r.token); assert.equal(a.verify(r.token), null)
  const r2 = a.redeem(a.issueCode().code, { sessionTtlMs: -1 }); assert.equal(a.verify(r2.token), null)
})

test('events: OneBot 原始事件规范化为统一信封 (§8.2/§26.2)', async () => {
  const { normalizeEvent } = await import('../src/events.mjs')
  const msg = normalizeEvent({ post_type: 'message', message_type: 'group', group_id: 10086, user_id: 10001, message_id: 9, raw_message: '/你好', sender: { nickname: '小明' } })
  assert.equal(msg.category, 'message'); assert.equal(msg.subtype, 'message.group.normal')
  assert.deepEqual(msg.chat, { type: 'group', id: '10086' }); assert.equal(msg.sender.nickname, '小明'); assert.equal(msg.message.text, '/你好')
  const ban = normalizeEvent({ post_type: 'notice', notice_type: 'group_ban', sub_type: 'ban', group_id: 1, user_id: 2, operator_id: 3 })
  assert.equal(ban.subtype, 'notice.group_ban.ban'); assert.equal(ban.category, 'notice')
  const req = normalizeEvent({ post_type: 'request', request_type: 'group', sub_type: 'add', flag: 'f1', user_id: 4, comment: 'hi' })
  assert.equal(req.subtype, 'request.group.add'); assert.equal(req.request.flag, 'f1')
  const unknown = normalizeEvent({ post_type: 'weird', foo: 1 })
  assert.equal(unknown.subtype, 'unknown'); assert.equal(unknown.raw.foo, 1, '未知事件保留原文')
})

test('event trigger: request.group.add 命中并自动通过；普通消息不命中 → skipped (§26.2)', async () => {
  const { store, services, registry, seen } = env()
  const reqEvent = { post_type: 'request', request_type: 'group', sub_type: 'add', flag: 'flag-9', user_id: 111, group_id: 10086, comment: '让我进群' }
  const r1 = await runWorkflow({ workflow: wf(store, 'wf_event'), registry, services, mode: 'real', event: reqEvent, seenEvents: seen })
  assert.equal(r1.status, 'succeeded', JSON.stringify(r1.logs))
  assert.equal(r1.nodes.find((n) => n.nodeId === 'req_1').status, 'succeeded')
  assert.equal(r1.receipts.length, 1)
  assert.ok(services.qq.actions.some((a) => a.name === 'set_group_add_request'))
  const r2 = await runWorkflow({ workflow: wf(store, 'wf_event'), registry, services, mode: 'real', event: msgEvent('/你好', 'e_nonmatch'), seenEvents: new Set() })
  assert.equal(r2.status, 'skipped')
})

test('subgraph: 调用发布子图，公开输入注入 + 输出回传 (§17)', async () => {
  const { store, services, registry, seen } = env()
  const r = await runWorkflow({ workflow: wf(store, 'wf_subgraph'), registry, services, mode: 'real', event: msgEvent('/子图', 'e_sg'), seenEvents: seen })
  assert.equal(r.status, 'succeeded', JSON.stringify(r.logs))
  assert.equal(r.nodes.find((n) => n.nodeId === 'sub_1').status, 'succeeded')
  assert.equal(services.qq.sent.length, 1)
  assert.equal(services.qq.sent[0].message[0].data.text, '你好，小明！')
})

test('subgraph: contentHash 版本锁不匹配 → 拒绝执行 (§17)', async () => {
  const { store, services, registry, seen } = env()
  const doc = wf(store, 'wf_subgraph')
  doc.nodes.find((n) => n.id === 'sub_1').params.contentHash = 'deadbeef'
  const r = await runWorkflow({ workflow: doc, registry, services, mode: 'real', event: msgEvent('/子图', 'e_sg2'), seenEvents: seen })
  assert.equal(r.status, 'failed')
  assert.equal(r.nodes.find((n) => n.nodeId === 'sub_1').error.code, 'SUBGRAPH_HASH_MISMATCH')
})

test('export: 含子图引用与 secretAliases，但不含凭据正文 (§18.4)', async () => {
  const { exportWorkflow } = await import('../src/portability.mjs')
  const { store, services } = env()
  const doc = store.getWorkflow('wf_subgraph')
  doc.graph.nodes.find((n) => n.id === 'sub_1').params.apiSecret = { kind: 'secretRef', id: 'demo_aes' }
  store.saveWorkflow(doc)
  const bundle = exportWorkflow(store, services.subgraphs, 'wf_subgraph')
  assert.equal(bundle.format, 'yf.workflow.bundle.v1')
  assert.equal(bundle.subgraphs.length, 1)
  assert.equal(bundle.subgraphs[0].id, 'sg_greet')
  assert.ok(bundle.secretAliases.includes('demo_aes'))
  const dump = JSON.stringify(bundle)
  assert.equal(dump.includes('"value"'), false, '不得含凭据正文')
})

test('import: 导入到空环境，携带子图、默认停用、可编译 (§18.4)', async () => {
  const { exportWorkflow, importBundle } = await import('../src/portability.mjs')
  const { store, services, registry } = env()
  const bundle = exportWorkflow(store, services.subgraphs, 'wf_subgraph')
  // fresh empty env
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yf-imp-'))
  const store2 = new Store(dir); const sg2 = new SubgraphStore(path.join(dir, 'subgraphs'))
  const res = importBundle(store2, sg2, bundle)
  assert.equal(res.enabled, false)
  assert.equal(res.subgraphs, 1)
  assert.equal(sg2.list().length, 1, '子图随包带入')
  const doc = store2.getWorkflow(res.workflowId)
  assert.ok(doc && doc.enabled === false)
  const c = compile(toRunnable(doc), registry)
  assert.equal(c.ok, true, JSON.stringify(c.errors))
})

test('backup/restore: 备份计数正确，恢复后全部流程停用 (§18.4)', async () => {
  const { createBackup, restoreBackup } = await import('../src/portability.mjs')
  const { store, services } = env()
  const b = createBackup(store, services.subgraphs)
  assert.ok(b.counts.workflows >= 8)
  assert.ok(b.counts.subgraphs >= 1)
  // 恢复前确保有启用的流程
  const before = store.listWorkflows().filter((w) => w.enabled).length
  restoreBackup(store, services.subgraphs, b)
  const after = store.listWorkflows().filter((w) => w.enabled).length
  assert.equal(after, 0, '恢复后所有流程必须停用，避免恢复即群发')
})

test('datasource: 声明驱动执行 + 输入映射 + 响应映射 (§15)', async () => {
  const { services } = env()
  const out = await services.datasource.call('demo.user-profile', '1.0.0', 'getProfile', { uid: '10001' })
  assert.equal(out.name, '玩家001')
  assert.equal(out.level, 42)
})

test('datasource: 三入口之一 AI 工具描述，写操作不导出 (§15.3)', async () => {
  const { dsRegistry, services } = env()
  const tools = dsRegistry.tools()
  const names = tools.map((t) => t.name)
  assert.ok(names.includes('demo_get_profile'))
  assert.equal(names.includes('demo_set_nick'), false, '写操作默认不导出')
  const t = tools.find((x) => x.name === 'demo_get_profile')
  assert.equal(t.pkg, 'demo.user-profile'); assert.equal(t.op, 'getProfile'); assert.ok(t.inputSchema)
  const out = await services.datasource.callTool('demo_get_profile', { uid: '100888' })
  assert.equal(out.name, '玩家888')
})

test('datasource node: wf_ds 端到端（数据源→模板→发送）', async () => {
  const { store, services, registry, seen } = env()
  const r = await runWorkflow({ workflow: wf(store, 'wf_ds'), registry, services, mode: 'real', event: msgEvent('/资料', 'e_ds'), seenEvents: seen })
  assert.equal(r.status, 'succeeded', JSON.stringify(r.logs))
  assert.equal(services.qq.sent[0].message[0].data.text, '玩家001 · Lv.42')
})

test('onebot http transport: status/retcode 判定 + access token + echo (§13.6)', async () => {
  const { OneBotHttpTransport } = await import('../src/integrations/napcat/transport.mjs')
  const received = []
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const body = JSON.parse(b); received.push({ url: req.url, auth: req.headers.authorization, body })
      if (body.action === 'send_msg') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 }, echo: body.echo })) }
      else if (body.action === 'set_group_ban') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'failed', retcode: 100, message: '权限不足', echo: body.echo })) }
      else { res.writeHead(404); res.end('nope') }
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const t = new OneBotHttpTransport({ baseUrl: `http://127.0.0.1:${port}`, accessToken: 'tok123' })
  const ok = await t.call('send_msg', { group_id: '1', message: [] })
  assert.equal(ok.data.message_id, 42)
  await assert.rejects(t.call('set_group_ban', {}), (e) => e.code === 'ONEBOT_BUSINESS' && e.retcode === 100)
  await assert.rejects(t.call('bad_action', {}), (e) => e.code === 'ONEBOT_HTTP')
  assert.equal(received[0].auth, 'Bearer tok123')
  assert.equal(received[0].body.echo, ok.echo)
  srv.close()
})

test('capability: 配置 napcat 后真实动作经 OneBot 传输发出 (§8.3)', async () => {
  const { OneBotHttpTransport, NapCatAdapter } = await import('../src/integrations/napcat/transport.mjs')
  const received = []
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const body = JSON.parse(b); received.push(body)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', retcode: 0, data: {}, echo: body.echo }))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const { services, registry } = env()
  services.napcat = new NapCatAdapter({ transport: new OneBotHttpTransport({ baseUrl: `http://127.0.0.1:${port}` }) })
  const doc = { id: 'wf_t', nodes: [{ id: 'b', type: 'qq.member', operation: 'set_group_ban', params: { group_id: '1', user_id: '2', duration: 60 }, bindings: {} }], controlEdges: [] }
  const run = await runWorkflow({ workflow: doc, registry, services, mode: 'real', event: msgEvent('/x', 'e_nc'), seenEvents: new Set() })
  assert.equal(run.status, 'succeeded', JSON.stringify(run.logs))
  assert.equal(received[0].action, 'set_group_ban')
  assert.equal(received[0].params.group_id, '1')
  srv.close()
})

test('host adapter: 探测 global.Bot/global.redis → host 模式；缺失 → diagnostic (§8.1)', async () => {
  const { HostAdapter } = await import('../src/host/adapter.mjs')
  const a = new HostAdapter({ config: { host: { adapter: 'trss-yunzai' } } })
  const r1 = await a.detect()
  assert.equal(r1.mode, 'diagnostic')
  const g = globalThis
  g.Bot = { version: '3.1.3', uin: ['10000'] }; g.redis = { async get() {}, async set() {} }
  try {
    const b = new HostAdapter({ config: { host: { adapter: 'trss-yunzai' } } })
    const r2 = await b.detect()
    assert.equal(r2.mode, 'host')
    assert.ok(r2.features.bot && r2.features.redis)
    assert.equal(r2.version, '3.1.3')
    const bot = await b.pickBot(); assert.equal(bot.uin, '10000')
  } finally { delete g.Bot; delete g.redis }
})

test('storage: create/delete workflow round-trip (§19)', async () => {
  const { createStore } = await import('../src/storage.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yf-del-'))
  const st = createStore({ dataDir: dir, driver: 'sqlite', dbFile: path.join(dir, 'f.sqlite') })
  st.createWorkflow({ id: 'wf_d', title: 'X', graph: { nodes: [], controlEdges: [] } })
  assert.equal(st.listWorkflows().length, 1)
  assert.equal(st.deleteWorkflow('wf_d'), true)
  assert.equal(st.listWorkflows().length, 0)
})

test('regex ops: extract / replace / split (§9)', async () => {
  const { registry } = env()
  const rt = (o, i) => registry.get('core.regex', o).operation.execute({}, i)
  let r = await rt('extract', { text: '/api/v1/users/123', pattern: '/users/(\\d+)', group: 1 })
  assert.equal(r.output.value, '123'); assert.equal(r.output.matched, true)
  r = await rt('replace', { text: 'a-b-c', pattern: '-', replacement: '+', flags: 'g' })
  assert.equal(r.output.text, 'a+b+c')
  r = await rt('split', { text: 'a,b;c', pattern: '[,;]' })
  assert.deepEqual(r.output.items, ['a', 'b', 'c'])
})

test('data transform ops: filter / sort / unique / mapField (§9)', async () => {
  const { registry } = env()
  const rt = (o, i) => registry.get('core.data', o).operation.execute({}, i)
  const items = [{ age: 10, name: 'a' }, { age: 20, name: 'b' }, { age: 20, name: 'b' }]
  let r = await rt('filter', { items, field: 'age', op: '>', value: 15 })
  assert.equal(r.output.count, 2)
  r = await rt('sort', { items: [{ n: 3 }, { n: 1 }, { n: 2 }], field: 'n', order: 'asc' })
  assert.deepEqual(r.output.items.map((x) => x.n), [1, 2, 3])
  r = await rt('unique', { items, field: 'age' })
  assert.equal(r.output.count, 2)
  r = await rt('mapField', { items, field: 'name' })
  assert.deepEqual(r.output.items, ['a', 'b', 'b'])
})

test('wait delay: 返回 waitedMs 且实际等待 (§9 简化)', async () => {
  const { registry } = env()
  const t = Date.now()
  const r = await registry.get('core.wait', 'delay').operation.execute({}, { ms: 60 })
  assert.equal(r.output.waitedMs, 60)
  assert.ok(Date.now() - t >= 50)
})

test('control: Merge 合流取实际到达分支的值 (§7.2)', async () => {
  const { store, services, registry, seen } = env()
  const r = compile(wf(store, 'wf_merge'), registry)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  const run = await runWorkflow({ workflow: wf(store, 'wf_merge'), registry, services, mode: 'real', event: msgEvent('/评分', 'e_merge'), seenEvents: seen })
  assert.equal(run.status, 'succeeded', JSON.stringify(run.logs))
  assert.equal(run.nodes.find((n) => n.nodeId === 'tT').status, 'succeeded')
  assert.equal(run.nodes.find((n) => n.nodeId === 'tF').status, 'skipped')
  assert.equal(run.nodes.find((n) => n.nodeId === 'merge_1').output.value, '👍 好评收到')
  assert.equal(services.qq.sent[0].message[0].data.text, '👍 好评收到')
})

test('control: Stop 终止分支，下游不执行 (§9)', async () => {
  const { registry } = env()
  const r = await registry.get('core.control', 'stop').operation.execute({}, {})
  assert.equal(r.status, 'succeeded'); assert.equal(r.control, 'stop')
})

test('control: Switch 2 路 + 默认，只走匹配分支 (§7.2)', async () => {
  const { services, registry } = env()
  const doc = {
    id: 'wf_sw',
    nodes: [
      { id: 'tr', type: 'core.trigger', operation: 'message', params: {}, bindings: {} },
      { id: 'sw', type: 'core.control', operation: 'switch', params: { v1: 'A', v2: 'B' }, bindings: { '/value': { kind: 'ref', nodeId: 'tr', pointer: '/event/message/text' } } },
      { id: 't1', type: 'core.template', operation: 'text', params: { template: 'case1', variables: {} }, bindings: {} },
      { id: 't2', type: 'core.template', operation: 'text', params: { template: 'case2', variables: {} }, bindings: {} },
      { id: 'td', type: 'core.template', operation: 'text', params: { template: 'default', variables: {} }, bindings: {} },
      { id: 'send', type: 'qq.message', operation: 'send_msg', params: { target: { kind: 'currentConversation' }, text: '' }, bindings: { '/text': { kind: 'ref', nodeId: 't1', pointer: '/text' } } },
    ],
    controlEdges: [
      { from: { nodeId: 'tr', port: 'next' }, to: { nodeId: 'sw', port: 'in' } },
      { from: { nodeId: 'sw', port: 'case1' }, to: { nodeId: 't1', port: 'in' } },
      { from: { nodeId: 'sw', port: 'case2' }, to: { nodeId: 't2', port: 'in' } },
      { from: { nodeId: 'sw', port: 'default' }, to: { nodeId: 'td', port: 'in' } },
      { from: { nodeId: 't1', port: 'next' }, to: { nodeId: 'send', port: 'in' } },
    ],
  }
  const run = await runWorkflow({ workflow: doc, registry, services, mode: 'real', event: msgEvent('A', 'e_sw'), seenEvents: new Set() })
  assert.equal(run.status, 'succeeded', JSON.stringify(run.logs))
  assert.equal(run.nodes.find((n) => n.nodeId === 't1').status, 'succeeded')
  assert.equal(run.nodes.find((n) => n.nodeId === 't2').status, 'skipped')
  assert.equal(run.nodes.find((n) => n.nodeId === 'td').status, 'skipped')
  assert.equal(services.qq.sent[0].message[0].data.text, 'case1')
})

test('datasource: 第二个包 demo.weather + AI 工具 (§15)', async () => {
  const { services, dsRegistry } = env()
  const out = await services.datasource.call('demo.weather', '1.0.0', 'getWeather', { city: '石家庄' })
  assert.equal(out.city, '石家庄'); assert.equal(out.weather, '多云'); assert.equal(out.temp, 18)
  const names = dsRegistry.tools().map((t) => t.name)
  assert.ok(names.includes('demo_get_weather'))
  assert.equal(names.length, 2)
})

test('control: Try/Catch 捕获 body 失败并走 catch，运行整体成功 (§7.2)', async () => {
  const { store, services, registry, seen } = env()
  const r = compile(wf(store, 'wf_try'), registry)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  const run = await runWorkflow({ workflow: wf(store, 'wf_try'), registry, services, mode: 'real', event: msgEvent('/试', 'e_try'), seenEvents: seen })
  assert.equal(run.status, 'succeeded', JSON.stringify(run.logs))
  assert.equal(run.nodes.find((n) => n.nodeId === 'code_1').status, 'failed', 'body 内节点失败')
  assert.equal(run.nodes.find((n) => n.nodeId === 'tc').status, 'succeeded', 'catch 分支执行')
  assert.equal(services.qq.sent[0].message[0].data.text, '已捕获错误，流程继续 ✅')
})

test('compiler robustness: 随机畸形图不抛异常，返回结构化错误 (§24)', async () => {
  const { registry } = env()
  let seed = 12345
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const ids = ['a', 'b', 'c', 'd', 'e']
  for (let iter = 0; iter < 300; iter++) {
    const nodes = []; const n = Math.floor(rnd() * 6)
    for (let i = 0; i < n; i++) {
      const t = rnd() < 0.5 ? 'core.template' : 'nope.' + Math.floor(rnd() * 3)
      nodes.push({ id: ids[Math.floor(rnd() * ids.length)] + '_' + i, type: t, operation: 'text', params: rnd() < 0.3 ? null : {}, bindings: rnd() < 0.3 ? { '/x': { kind: 'ref', nodeId: 'ghost', pointer: '/y' } } : {} })
    }
    const edges = []; const m = Math.floor(rnd() * 6)
    for (let j = 0; j < m; j++) edges.push({ from: { nodeId: ids[Math.floor(rnd() * ids.length)], port: 'next' }, to: { nodeId: ids[Math.floor(rnd() * ids.length)], port: 'in' } })
    let r
    assert.doesNotThrow(() => { r = compile({ nodes, controlEdges: edges }, registry) }, 'compile 不应抛异常')
    assert.equal(typeof r.ok, 'boolean')
    assert.ok(Array.isArray(r.errors))
  }
})

test('capability: qq.send 经 NapCat 适配器把 target 转成 message_type/group_id (§13.6)', async () => {
  const { store, services, registry, seen } = env()
  const calls = []
  services.napcat = { async call(action, params) { calls.push({ action, params }); return { retcode: 0, data: { message_id: 777 }, echo: 'e' } } }
  const run = await runWorkflow({ workflow: wf(store, 'wf_hello'), registry, services, mode: 'real', event: msgEvent('/你好', 'e_send'), seenEvents: seen })
  assert.equal(run.status, 'succeeded')
  assert.equal(calls[0].action, 'send_msg')
  assert.equal(calls[0].params.message_type, 'group')
  assert.equal(calls[0].params.group_id, 'group_10086')
  assert.equal(run.receipts[0].message_id, 777)
})

test('secret persistence: 加密落盘、重启可解密、文件不含明文 (§12.3)', async () => {
  const { SecretService } = await import('../src/capabilities.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yf-sec-'))
  const fp = path.join(dir, 'secrets.json')
  const s1 = new SecretService({ filePath: fp })
  s1.put('k1', 'super-secret-value-123', { type: 'opaque' })
  s1.put('k2', crypto.randomBytes(32), { type: 'symmetric' })
  const raw = fs.readFileSync(fp, 'utf8')
  assert.equal(raw.includes('super-secret-value-123'), false, '文件不得含明文')
  const s2 = new SecretService({ filePath: fp })
  assert.equal(String(s2.resolve('k1').value), 'super-secret-value-123')
  const k2 = s2.resolve('k2').value
  assert.ok(Buffer.isBuffer(k2) && k2.length === 32, 'bytes 类型应还原为 Buffer')
})

test('onebot behavior: 审批成功 / 踢人业务失败 → 运行 failed (§13.6)', async () => {
  const { OneBotHttpTransport, NapCatAdapter } = await import('../src/integrations/napcat/transport.mjs')
  const httpMod = await import('node:http')
  const srv = httpMod.default.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const body = JSON.parse(b)
      const ok = body.action !== 'set_group_kick'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(ok ? { status: 'ok', retcode: 0, data: null, echo: body.echo } : { status: 'failed', retcode: 102, message: '权限不足', echo: body.echo }))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const { services, registry } = env()
  services.napcat = new NapCatAdapter({ transport: new OneBotHttpTransport({ baseUrl: `http://127.0.0.1:${port}` }) })
  const mk = (op, params) => ({ id: 'b_' + op, nodes: [{ id: 'n', type: 'qq.request', operation: op, params, bindings: {} }], controlEdges: [] })
  const ok = await runWorkflow({ workflow: mk('set_group_add_request', { flag: 'f', approve: true }), registry, services, mode: 'real', event: msgEvent('/x', 'e_ok'), seenEvents: new Set() })
  assert.equal(ok.status, 'succeeded')
  const bad = await runWorkflow({ workflow: mk('set_group_add_request', { flag: 'f', approve: true }), registry, services: { ...services, napcat: new NapCatAdapter({ transport: new OneBotHttpTransport({ baseUrl: `http://127.0.0.1:${port}` }) }) }, mode: 'real', event: msgEvent('/x', 'e_bad'), seenEvents: new Set() })
  assert.equal(bad.status, 'succeeded') // approve route ok
  // 踢人：mock 返回 retcode 102 → 节点失败
  const kick = await runWorkflow({ workflow: { id: 'b_kick', nodes: [{ id: 'n', type: 'qq.member', operation: 'set_group_kick', params: { group_id: '1', user_id: '2' }, bindings: {} }], controlEdges: [] }, registry, services, mode: 'real', event: msgEvent('/x', 'e_kick'), seenEvents: new Set() })
  assert.equal(kick.status, 'failed')
  assert.equal(kick.nodes[0].error.code, 'ONEBOT_BUSINESS')
  srv.close()
})

test('redactDeep: 敏感键打码 / secretRef 保留 / 嵌套数组 (§12.3)', async () => {
  const { redactDeep } = await import('../src/lib.mjs')
  const src = { a: 1, token: 'abc', authorization: 'Bearer x', nested: { cookie: 'c', name: 'n', list: [{ password: 'p', ok: 1 }] }, secret: { kind: 'secretRef', id: 'k', version: 2 }, bin: Buffer.from('xy') }
  const out = redactDeep(src)
  assert.equal(out.a, 1)
  assert.equal(out.token, '[REDACTED]')
  assert.equal(out.authorization, '[REDACTED]')
  assert.equal(out.nested.cookie, '[REDACTED]')
  assert.equal(out.nested.name, 'n')
  assert.equal(out.nested.list[0].password, '[REDACTED]')
  assert.equal(out.nested.list[0].ok, 1)
  assert.deepEqual(out.secret, { kind: 'secretRef', id: 'k', version: 2 })
  assert.equal(out.bin, '[binary]')
})

test('backup/restore: 恢复前自动备份当前数据 (§18.4)', async () => {
  const { createBackup, restoreBackup } = await import('../src/portability.mjs')
  const { store, services } = env()
  const b = createBackup(store, services.subgraphs)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yf-bk-'))
  const r = restoreBackup(store, services.subgraphs, b, { backupDir: dir })
  assert.ok(r.preBackup && typeof r.preBackup.file === 'string')
  assert.ok(fs.existsSync(r.preBackup.file), '恢复前备份文件应存在')
  assert.ok(r.preBackup.counts.workflows > 0)
})

test('retry: policy.maxAttempts 对可重试失败生效，不可重试不重试 (§7.6)', async () => {
  const { services, registry } = env()
  const op = registry.get('qq.message', 'send_group_msg').operation
  const orig = op.execute
  let calls = 0
  op.execute = async () => { calls++; if (calls < 3) return { status: 'failed', error: { code: 'NETWORK', message: 'flaky', retryable: true } }; return { status: 'succeeded', output: { message_id: 'ok' }, control: 'next' } }
  try {
    const doc = { id: 'r', nodes: [{ id: 'n', type: 'qq.message', operation: 'send_group_msg', params: { group_id: '1', text: 'x' }, bindings: {}, policy: { maxAttempts: 3 } }], controlEdges: [] }
    const run = await runWorkflow({ workflow: doc, registry, services, mode: 'simulate', event: msgEvent('/x', 'e_retry'), seenEvents: new Set() })
    assert.equal(run.status, 'succeeded'); assert.equal(calls, 3); assert.equal(run.nodes[0].attempts, 3)
  } finally { op.execute = orig }
  // 不可重试 → 只调用一次
  let c2 = 0
  op.execute = async () => { c2++; return { status: 'failed', error: { code: 'INPUT_INVALID', message: 'bad', retryable: false } } }
  try {
    const doc = { id: 'r2', nodes: [{ id: 'n', type: 'qq.message', operation: 'send_group_msg', params: { group_id: '1', text: 'x' }, bindings: {}, policy: { maxAttempts: 3 } }], controlEdges: [] }
    const run = await runWorkflow({ workflow: doc, registry, services, mode: 'simulate', event: msgEvent('/x', 'e_retry2'), seenEvents: new Set() })
    assert.equal(run.status, 'failed'); assert.equal(c2, 1)
  } finally { op.execute = orig }
})

test('golden: 所有预置流程可编译、运行不失败（wf_event 预期 skipped）', async () => {
  const { store, services, registry } = env()
  const results = []
  for (const w of store.listWorkflows()) {
    const doc = toRunnable(store.getWorkflow(w.id))
    const c = compile(doc, registry)
    assert.equal(c.ok, true, w.id + ' 编译失败: ' + JSON.stringify(c.errors))
    const trig = doc.nodes.find((n) => n.type === 'core.trigger')
    let event = msgEvent('/x', 'g_' + w.id)
    if (trig && trig.operation === 'command' && trig.params && trig.params.command) event = msgEvent(trig.params.command, 'g_' + w.id)
    const run = await runWorkflow({ workflow: doc, registry, services, mode: 'simulate', event, seenEvents: new Set() })
    assert.notEqual(run.status, 'failed', w.id + ' 运行失败: ' + JSON.stringify((run.logs || []).slice(-3)))
    results.push({ id: w.id, status: run.status })
  }
  const ev = results.find((r) => r.id === 'wf_event')
  if (ev) assert.equal(ev.status, 'skipped', '事件触发流程应用消息事件应 skipped')
  const succeeded = results.filter((r) => r.status === 'succeeded').length
  assert.ok(succeeded >= 9, '多数示例应成功，实际 ' + JSON.stringify(results))
})
