// ============================================================================
// 文件：src/server.mjs — 控制 API（§19 子集）+ 静态 Web 服务（控制面进程入口）
// 职责：以零依赖 node:http 同时提供两件事：
//   1) 控制 API：流程/工作流 CRUD、运行与 SSE 实时事件流、配对鉴权、NapCat 传输切换、
//      导入导出/备份恢复、数据源与 AI 工具、子图查询/发布、渲染资源读取等 REST 端点；
//   2) 静态服务：托管 web/ 目录下的前端资源。
// 架构位置：本插件的进程入口与 HTTP 控制面。此处装配 registry / store / services / 数据源 /
//   NapCat 传输 / 宿主探测 / 限流器，路由表见 routes，所有请求经 http.createServer 统一分发。
// 主要导出：server（http.Server）、services（能力/数据源/传输集合）、store（存储）、registry（节点注册表）。
// 说明：本文件只做“装配 + 路由分发”，业务实现分散在 compiler / runtime / storage / capabilities 等模块。
// ============================================================================
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildRegistry } from './registry.mjs'
import { napcatStats } from './integrations/napcat/manifest.mjs'
import { PairingService, tokenFromRequest } from './auth.mjs'
import { EVENT_CATALOG } from './events.mjs'
import { exportWorkflow, importBundle, createBackup, restoreBackup } from './portability.mjs'
import { DataSourceRegistry, DataSourceRuntime } from './datasource.mjs'
import { OneBotHttpTransport, OneBotWsTransport, NapCatAdapter } from './integrations/napcat/transport.mjs'
import { HostAdapter } from './host/adapter.mjs'
import { redactDeep } from './lib.mjs'
import { RunLimiter } from './scheduler.mjs'
import { compile } from './compiler.mjs'
import { runWorkflow } from './runtime.mjs'
import { createStore, SubgraphStore, toRunnable } from './storage.mjs'
import { SecretService, CacheService, CryptoService, HttpService, QQService, RenderService, DataSourceService } from './capabilities.mjs'
import { seedIfEmpty, seedSubgraphs } from './seed.mjs'
import { deepClone } from './lib.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'config.json'), 'utf8'))
const dataDir = path.resolve(root, config.storage.database ? path.dirname(config.storage.database) : 'data')

const registry = buildRegistry()
const store = createStore({ dataDir, driver: config.storage.driver, dbFile: config.storage.database ? path.resolve(root, config.storage.database) : undefined })
const secrets = new SecretService({ filePath: path.join(dataDir, 'secrets.json') })
if (!secrets.has('demo_aes')) secrets.put('demo_aes', crypto.randomBytes(32), { type: 'symmetric', version: 1, uses: ['encrypt', 'decrypt'] })
if (!secrets.has('demo_sign')) secrets.put('demo_sign', 'demo-signing-seed', { type: 'ed25519', version: 1, uses: ['sign', 'verify'] })
if (!secrets.has('demo_api_key')) secrets.put('demo_api_key', 'sk-demo-9f8e7d', { type: 'api_key', version: 1, uses: ['http'] })
const subgraphs = new SubgraphStore(path.join(dataDir, 'subgraphs'))
seedSubgraphs(subgraphs)
const services = {
  secrets, cache: new CacheService(), http: new HttpService(),
  crypto: new CryptoService(secrets), qq: new QQService(),
  render: new RenderService(path.join(dataDir, 'resources')), datasource: new DataSourceService(),
  subgraphs,
}
services.http.mock('mock://weather', { status: 200, body: { weather: '晴，22℃', city: '石家庄', aqi: 42 } })
const dsRegistry = new DataSourceRegistry(path.join(root, 'datasources'))
services.datasource = new DataSourceRuntime({ http: services.http, secrets, cache: services.cache, registry: dsRegistry })
services.http.mock('https://api.weather.example/v1/weather', ({ url }) => { try { const u = new URL(url); const city = u.searchParams.get('city') || '某地'; return { status: 200, body: { data: { city, weather: '多云', temp: 18 } } } } catch { return { status: 200, body: { data: { city: '某地', weather: '晴', temp: 20 } } } } })
services.http.mock('https://api.example.com/v1/profile', ({ url }) => { try { const u = new URL(url); const uid = u.searchParams.get('uid') || '0'; return { status: 200, body: { data: { name: '玩家' + String(uid).slice(-3), level: 42, uid } } } } catch { return { status: 200, body: { data: { name: '玩家', level: 1 } } } } })
if (config.napcat?.httpUrl) services.napcat = new NapCatAdapter({ transport: new OneBotHttpTransport({ baseUrl: config.napcat.httpUrl, accessToken: config.napcat.accessToken }) })
else if (config.napcat?.wsUrl) services.napcat = new NapCatAdapter({ transport: new OneBotWsTransport({ wsUrl: config.napcat.wsUrl, accessToken: config.napcat.accessToken }) })
seedIfEmpty(store)
const auth = new PairingService()
const limiter = new RunLimiter({ maxActive: config.runtime.maxActiveRuns, perConversation: config.runtime.maxActivePerConversation, queueLimit: config.runtime.queueLimit })
const hostAdapter = new HostAdapter({ config })
let hostReport = null
const seenEvents = new Set()

const state = { startedAt: new Date().toISOString(), requests: 0 }

// send —— 统一响应出口。约定：obj 为普通对象 → JSON；为字符串/Buffer → 原样发送。
// 调用方还可返回 [code, obj]（自定义状态码）或 ['RAW', buf, headers]（原样字节流），见下方路由分发。
function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)
  res.writeHead(code, { 'content-type': typeof obj === 'object' && !Buffer.isBuffer(obj) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers })
  res.end(body)
}
// readBody —— 读取并 JSON.parse 请求体，带大小上限（默认 8MB）；超限抛 BODY_TOO_LARGE，坏 JSON 抛 BAD_JSON。
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' })); req.destroy() } else chunks.push(c) })
    req.on('end', () => { const s = Buffer.concat(chunks).toString('utf8'); try { resolve(s ? JSON.parse(s) : {}) } catch (e) { reject(Object.assign(new Error('invalid json'), { code: 'BAD_JSON' })) } })
    req.on('error', reject)
  })
}

// coverageReport —— 生成覆盖率看板：按家族/操作/effect 统计 MVP 切片，并叠加 NapCat 映射、
// 事件目录、消息段、数据源等多轴数据；强调“分轴统计”，不以单一入口冒充全覆盖（§24.2）。
function coverageReport() {
  const s = registry.stats()
  const effects = {}
  for (const f of registry.families) for (const o of f.operations) effects[o.effect] = (effects[o.effect] || 0) + 1
  const nc = napcatStats(registry.families)
  return {
    mvp: { families: s.families, operations: s.operations, effects, note: '本仓库已实现的 MVP 纵向切片（可运行、有测试）；含 NapCat 178 项映射元数据' },
    napcat: {
      version: nc.sourceVersion + ' (spec) / docs current 4.18.42',
      baseOps: nc.baseOps, mappedStructured: nc.mapped, structuredForms: nc.structuredForms, genericForms: nc.genericForms,
      contractTested: nc.contractTested, contractList: nc.contractList, contractStructural: nc.mapped, contractExecutable: nc.mapped, liveVerified: nc.liveVerified, families: nc.families,
      note: '178 项基础操作已全部生成家族/操作/effect/权限元数据与通用表单；其中 ' + nc.structuredForms + ' 项为结构化专用表单，' + nc.contractTested + ' 项通过契约测试，0 项实机验证（需真实 NapCat 连接）。执行均为模拟适配器。',
    },
    events: (() => {
      const by = {}; for (const e of EVENT_CATALOG) by[e.status] = (by[e.status] || 0) + 1
      return { total: EVENT_CATALOG.length, byStatus: by, implemented: EVENT_CATALOG.filter((e) => e.status === 'supported').map((e) => e.subtype), note: '事件全族已规范化；supported/conditional/opt-in/preserve 分状态，实机发射需真连接核实' }
    })(),
    segments: { implemented: ['text'], note: '23 类消息段为路线图；MVP 仅 text' },
    datasources: { packages: dsRegistry.list().length, tools: dsRegistry.tools().length, note: '画布/SDK/REST 共用 DataSourceRuntime；写操作默认不导出为 AI 工具' },
    caveat: '覆盖率分轴统计，不以“节点数/一个原始调用入口”冒充全覆盖（见 §24.2）。',
  }
}

// sanitizeRun —— 运行结果脱敏：对每个节点的 output 与 effects 递归 redactDeep，避免敏感值外泄后再落库/返回。
function sanitizeRun(run) {
  if (!run) return run
  return { ...run, nodes: (run.nodes || []).map((n) => ({ ...n, output: n.output === undefined ? undefined : redactDeep(n.output) })), effects: redactDeep(run.effects || []), receipts: run.receipts }
}

// 路由表：每项为 [method, 正则, handler]；命中后 handler 返回对象，或 [状态码, 对象] / ['RAW', 缓冲, 头]。
// 端点用途一览：
//   GET    /health                              健康检查（无需鉴权）
//   GET    /catalog, /registry                   节点注册表快照
//   GET    /bootstrap                            前端启动聚合数据（宿主/传输/机器人/限额/覆盖率等）
//   GET    /coverage                             覆盖率看板
//   GET    /workflows                            流程列表
//   POST   /workflows                            创建流程
//   GET    /workflows/:id                        流程详情 + 编译校验结果
//   PUT    /workflows/:id                        按 revision（If-Match）更新流程
//   DELETE /workflows/:id                        删除流程
//   POST   /workflows/:id/validate               仅校验指定图（可传覆盖 graph）
//   POST   /workflows/:id/publish                发布（编译通过才发布快照）
//   POST   /workflows/:id/runs                   运行流程（受限流器约束）
//   GET    /workflows/:id/runs                   列出运行摘要
//   GET    /runs/:id                             单个运行详情（脱敏）
//   POST   /auth/pair | GET /auth/status | POST /auth/logout   配对鉴权会话
//   POST   /transport                            切换 NapCat 传输（simulated / http / ws）
//   GET    /workflows/:id/export | POST /workflows/import      导入导出
//   GET    /backup | POST /restore               备份 / 恢复
//   GET    /datasources | GET /tools | POST /tools/call        数据源与 AI 工具
//   GET    /subgraphs | POST /subgraphs/publish                子图查询与发布
//   GET    /resources/:name                      读取渲染资源（SVG）
// 另有 POST /workflows/:id/runs/stream（SSE 实时运行事件流），在主循环之前单独处理。
const routes = [
  ['GET', /^\/api\/flow\/v1\/health$/, async () => ({ ok: true, uptimeMs: Date.now() - Date.parse(state.startedAt) })],
  ['GET', /^\/api\/flow\/v1\/catalog$/, async () => registry.toJSON()],
  ['GET', /^\/api\/flow\/v1\/registry$/, async () => registry.toJSON()],
  ['GET', /^\/api\/flow\/v1\/bootstrap$/, async () => {
    if (!hostReport) hostReport = await hostAdapter.detect()
    return ({
    host: { ...hostReport, redis: config.host.redis, renderer: config.host.renderer },
    transport: { mode: services.napcat ? 'direct-onebot' : 'simulated', httpUrl: config.napcat?.httpUrl || '', wsUrl: config.napcat?.wsUrl || '', tokenSet: !!config.napcat?.accessToken },
    bot: { id: 'bot_demo', name: '云崽 Demo', online: true },
    registryVersion: registry.toJSON().registryVersion,
    limits: config.runtime, secrets: secrets.list(), workflows: store.listWorkflows(), coverage: coverageReport(),
    })
  }],
  ['GET', /^\/api\/flow\/v1\/coverage$/, async () => coverageReport()],
  ['POST', /^\/api\/flow\/v1\/workflows$/, async (m, req) => {
    const body = await readBody(req)
    const id = `wf_${crypto.randomBytes(4).toString('hex')}`
    const doc = store.createWorkflow({ id, title: body.title || '未命名流程', graph: body.graph || { nodes: [], controlEdges: [] } })
    return { ok: true, workflow: doc }
  }],
  ['DELETE', /^\/api\/flow\/v1\/workflows\/([^/]+)$/, async (m) => {
    const ok = store.deleteWorkflow(m[1]); return ok ? { ok: true } : [404, { error: 'NOT_FOUND' }]
  }],
  ['GET', /^\/api\/flow\/v1\/workflows$/, async () => ({ workflows: store.listWorkflows() })],
  ['GET', /^\/api\/flow\/v1\/workflows\/([^/]+)$/, async (m) => {
    const doc = store.getWorkflow(m[1]); if (!doc) return [404, { error: 'NOT_FOUND' }]
    const compileResult = compile(toRunnable(doc), registry)
    return { workflow: doc, validation: compileResult }
  }],
  ['PUT', /^\/api\/flow\/v1\/workflows\/([^/]+)$/, async (m, req) => {
    const doc = store.getWorkflow(m[1]); if (!doc) return [404, { error: 'NOT_FOUND' }]
    const body = await readBody(req)
    const expected = Number(req.headers['if-match'] || body.revision)
    if (body.revision != null && expected != null && Number(body.revision) !== doc.revision) {
      return [409, { error: 'REVISION_CONFLICT', current: doc.revision, incoming: body.revision }]
    }
    if (body.graph) doc.graph = body.graph
    if (body.title != null) doc.title = body.title
    if (body.permissions) doc.permissions = body.permissions
    doc.revision = doc.revision + 1
    store.saveWorkflow(doc)
    return { ok: true, revision: doc.revision, workflow: doc }
  }],
  ['POST', /^\/api\/flow\/v1\/workflows\/([^/]+)\/validate$/, async (m, req) => {
    const doc = store.getWorkflow(m[1]); if (!doc) return [404, { error: 'NOT_FOUND' }]
    const body = await readBody(req).catch(() => ({}))
    const target = body.graph ? { ...doc, graph: body.graph } : doc
    return compile(toRunnable(target), registry)
  }],
  ['POST', /^\/api\/flow\/v1\/workflows\/([^/]+)\/publish$/, async (m) => {
    const doc = store.getWorkflow(m[1]); if (!doc) return [404, { error: 'NOT_FOUND' }]
    const r = compile(toRunnable(doc), registry)
    if (!r.ok) return [422, { error: 'VALIDATION_FAILED', details: r }]
    const snap = store.publishWorkflow(doc)
    doc.workflowVersion = snap.workflowVersion; doc.enabled = true; doc.revision += 0; store.saveWorkflow(doc)
    return { ok: true, workflowVersion: snap.workflowVersion, publishedAt: snap.publishedAt }
  }],
  ['POST', /^\/api\/flow\/v1\/workflows\/([^/]+)\/runs$/, async (m, req) => {
    const doc = store.getWorkflow(m[1]); if (!doc) return [404, { error: 'NOT_FOUND' }]
    const body = await readBody(req); const mode = body.mode || 'simulate'
    const r = compile(toRunnable(doc), registry)
    if (!r.ok) return [422, { error: 'VALIDATION_FAILED', details: r }]
    const key = body.event?.chat?.id || 'default'
    let run
    try { run = await limiter.run(key, () => runWorkflow({ workflow: toRunnable(doc), registry, services, mode, event: body.event, botId: body.botId || 'bot_demo', triggerId: 'trigger', seenEvents })) }
    catch (e) { if (e.code === 'QUEUE_FULL' || e.code === 'QUEUE_TIMEOUT') return [429, { error: e.code, message: e.message, scheduler: limiter.snapshot() }]; throw e }
    const safe = sanitizeRun(run); store.saveRun(safe)
    return { run: safe }
  }],
  ['GET', /^\/api\/flow\/v1\/workflows\/([^/]+)\/runs$/, async (m) => ({ runs: store.listRuns(m[1]).map((r) => ({ runId: r.runId, status: r.status, mode: r.mode, startedAt: r.startedAt, ms: r.ms })) })],
  ['GET', /^\/api\/flow\/v1\/runs\/([^/]+)$/, async (m) => { const r = store.getRun(m[1]); return r ? { run: sanitizeRun(r) } : [404, { error: 'NOT_FOUND' }] }],
  ['POST', /^\/api\/flow\/v1\/auth\/pair$/, async (m, req) => {
    const body = await readBody(req)
    try { const r = auth.redeem(body.code); return { ok: true, token: r.token, expiresAt: r.expiresAt }; }
    catch (e) { return [401, { error: e.code, message: e.message }]; }
  }],
  // 传输切换：simulated 清空配置并断开直连；http 先 get_login_info 探活成功再挂载；ws 直接挂载；失败回退模拟。
  ['POST', /^\/api\/flow\/v1\/transport$/, async (m, req) => {
    const body = await readBody(req)
    const { httpUrl = '', wsUrl = '', accessToken = '', mode = 'auto' } = body
    if (mode === 'simulated' || (!httpUrl && !wsUrl)) {
      config.napcat.httpUrl = ''; config.napcat.wsUrl = ''
      services.napcat = null
      return { ok: true, transport: { mode: 'simulated' } }
    }
    config.napcat.httpUrl = httpUrl; config.napcat.wsUrl = wsUrl; config.napcat.accessToken = accessToken
    try {
      if (httpUrl) {
        const t = new OneBotHttpTransport({ baseUrl: httpUrl, accessToken })
        const info = await t.call('get_login_info', {})
        services.napcat = new NapCatAdapter({ transport: t })
        return { ok: true, transport: { mode: 'direct-onebot-http', httpUrl, login: info.data } }
      }
      if (wsUrl) { services.napcat = new NapCatAdapter({ transport: new OneBotWsTransport({ wsUrl, accessToken }) }); return { ok: true, transport: { mode: 'direct-onebot-ws', wsUrl } } }
    } catch (e) { services.napcat = null; return [400, { error: e.code || 'TRANSPORT_FAILED', message: e.message }] }
    return { ok: true, transport: { mode: 'simulated' } }
  }],
  ['GET', /^\/api\/flow\/v1\/auth\/status$/, async () => ({ requireAuth: !!config.web.requireAuth, ...auth.status() })],
  ['POST', /^\/api\/flow\/v1\/auth\/logout$/, async (m, req) => ({ ok: true, revoked: auth.revoke(tokenFromRequest(req)) })],
  ['GET', /^\/api\/flow\/v1\/workflows\/([^/]+)\/export$/, async (m) => { try { return exportWorkflow(store, subgraphs, m[1]) } catch (e) { return [404, { error: e.code || 'NOT_FOUND' }] } }],
  ['POST', /^\/api\/flow\/v1\/workflows\/import$/, async (m, req) => {
    const body = await readBody(req)
    try { return importBundle(store, subgraphs, body.bundle || body) } catch (e) { return [400, { error: e.code || 'IMPORT_FAILED', message: e.message }] }
  }],
  ['GET', /^\/api\/flow\/v1\/backup$/, async () => createBackup(store, subgraphs)],
  ['POST', /^\/api\/flow\/v1\/restore$/, async (m, req) => {
    const body = await readBody(req)
    try { return restoreBackup(store, subgraphs, body.backup || body, { backupDir: path.join(dataDir, 'backups') }) } catch (e) { return [400, { error: e.code || 'RESTORE_FAILED', message: e.message }] }
  }],
  ['GET', /^\/api\/flow\/v1\/datasources$/, async () => ({ datasources: dsRegistry.list() })],
  ['GET', /^\/api\/flow\/v1\/tools$/, async () => ({ tools: dsRegistry.tools() })],
  ['POST', /^\/api\/flow\/v1\/tools\/call$/, async (m, req) => { const body = await readBody(req); try { const out = await services.datasource.callTool(body.name, body.arguments || body.args || {}); return { ok: true, output: out } } catch (e) { return [400, { error: e.code || 'TOOL_FAILED', message: e.message }] } }],
  ['GET', /^\/api\/flow\/v1\/subgraphs$/, async () => ({ subgraphs: subgraphs.list().filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i).map((v) => subgraphs.latest(v.id)) })],
  ['POST', /^\/api\/flow\/v1\/subgraphs\/publish$/, async (m, req) => {
    const body = await readBody(req)
    const def = body.def || body
    if (!def.id || !def.version) return [400, { error: 'SUBGRAPH_INVALID', message: 'id 和 version 必填' }]
    return { ok: true, subgraph: subgraphs.save(def) }
  }],
  ['GET', /^\/api\/flow\/v1\/resources\/([^/]+)$/, async (m) => {
    const f = path.join(dataDir, 'resources', `${m[1]}.svg`)
    if (!fs.existsSync(f)) return [404, { error: 'NOT_FOUND' }]
    return ['RAW', fs.readFileSync(f), { 'content-type': 'image/svg+xml' }]
  }],
]

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' }

// HTTP 服务主入口：计数 → 解析 URL → 鉴权 → SSE 特例 → 路由表 → 静态资源 → 兜底 404/错误。
const server = http.createServer(async (req, res) => {
  state.requests++
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const p = decodeURIComponent(url.pathname)
  try {
    // ---- 鉴权中间件 (§20)：requireAuth 开启时保护所有 /api/flow/v1 业务接口；
    //      /auth/pair、/auth/status 与 /health 放行，其余校验配对会话令牌，失败返回 401。----
    if (config.web.requireAuth && /^\/api\/flow\/v1\//.test(p) && !/\/auth\/(pair|status)$/.test(p) && p !== '/api/flow/v1/health') {
      if (!auth.verify(tokenFromRequest(req))) return send(res, 401, { error: 'UNAUTHORIZED', message: '需要配对会话令牌' })
    }
    // ---- SSE 流处理 (§19)：POST /workflows/:id/runs/stream ----
    // 编译校验通过后以 text/event-stream 持续推送：每个运行事件以 `event: <type>` + JSON 帧发送并递增 seq；
    // 结束推送 done（带脱敏后的 run）并落库；运行失败或异常推送 error 帧；任何分支都显式 end 响应。----
    if (req.method === 'POST' && /^\/api\/flow\/v1\/workflows\/([^/]+)\/runs\/stream$/.test(p)) {
      const id = p.match(/workflows\/([^/]+)\/runs\/stream/)[1]
      const doc = store.getWorkflow(id)
      if (!doc) return send(res, 404, { error: 'NOT_FOUND' })
      const body = await readBody(req); const mode = body.mode || 'simulate'
      const r = compile(toRunnable(doc), registry)
      if (!r.ok) return send(res, 422, { error: 'VALIDATION_FAILED', details: r })
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      let seq = 0
      const writeEv = (ev) => { try { res.write(`id: ${seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`) } catch {} }
      try {
        const skey = body.event?.chat?.id || 'default'
        let run
        try { run = await limiter.run(skey, () => runWorkflow({ workflow: toRunnable(doc), registry, services, mode, event: body.event, botId: body.botId || 'bot_demo', triggerId: 'trigger', seenEvents, onEvent: (ev) => { ev.seq = ++seq; writeEv(ev) } })) }
        catch (e) { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: e.code || 'RUN_FAILED', message: e.message })}\n\n`); return res.end() }
        const safe = sanitizeRun(run); store.saveRun(safe)
        res.write(`id: ${seq + 1}\nevent: done\ndata: ${JSON.stringify({ type: 'done', run: safe })}\n\n`)
        res.end()
      } catch (e) { try { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`); res.end() } catch {} }
      return
    }

    // 路由分发：按方法 + 正则匹配；[code,obj] 为自定义状态码，['RAW',buf,headers] 为原样输出，其余按 200 JSON。
    for (const [method, re, handler] of routes) {
      if (req.method !== method) continue
      const m = p.match(re); if (!m) continue
      const out = await handler(m, req)
      if (Array.isArray(out) && typeof out[0] === 'number') return send(res, out[0], out[1])
      if (Array.isArray(out) && out[0] === 'RAW') return send(res, 200, out[1], out[2])
      return send(res, 200, out)
    }
    // 静态资源：托管 web/ 目录，'/' 映射 index.html；做路径归一与目录越界防护后流式返回。
    if (req.method === 'GET') {
      let rel = p === '/' ? '/index.html' : p
      const f = path.join(root, 'web', path.normalize(rel).replace(/^([/\\])+/, ''))
      if (f.startsWith(path.join(root, 'web')) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' })
        return fs.createReadStream(f).pipe(res)
      }
    }
    send(res, 404, { error: 'NOT_FOUND', path: p })
  } catch (e) {
    send(res, e.code === 'BAD_JSON' ? 400 : 500, { error: e.code || 'SERVER_ERROR', message: e.message })
  }
})

const port = Number(process.env.PORT || config.web.port || 5088)
const host = process.env.HOST || config.web.host || '127.0.0.1'
// 启动监听：生成一次性配对码（10 分钟有效）并打印监听地址与注册表版本。
server.listen(port, host, () => {
  const pairing = auth.issueCode({ ttlMs: 10 * 60 * 1000 })
console.log(`[yunzai-flow] pairing code (10min, single-use): ${pairing.code}`)
console.log(`[yunzai-flow] listening http://${host}:${port}  registry=${registry.toJSON().registryVersion}  workflows=${store.listWorkflows().length}`)
})
export { server, services, store, registry }
