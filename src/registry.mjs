/**
 * registry.mjs — 节点家族注册表（registry）。
 *
 * 职责：
 * - 定义全部可编排节点（node）的家族（family）与操作（operation）：
 *   每个 operation 都是「输入 Schema / 输出 Schema / execute 执行函数」三元组。
 * - 统一声明每个操作的副作用等级 effect、所需 capability、端口 ports 与 UI 表单 ui。
 * - 通过 buildRegistry() 组装运行时查询入口（get / toJSON / stats）。
 *
 * 架构位置：
 * - 本文件是节点目录的唯一真源（single source of truth）。
 *   compiler / runtime 通过 buildRegistry().get(type, op) 查找节点定义并执行；
 *   Web 前端通过 toJSON() 拿到可序列化目录（不含 execute 函数）。
 *
 * 主要导出：
 * - families：节点家族数组（运行期会被 mergeNapcat 补充 NapCat 集成节点）。
 * - buildRegistry()：构建查询 / 序列化 / 统计入口。
 * - validateSchema：透传 lib.mjs 的 Schema 校验器。
 *
 * 数据结构约定：
 * - family：{ type, version, title, category, color, icon, operations[] }
 * - operation：{ id, title, effect, requiredCapabilities, ports,
 *                inputSchema, outputSchema, ui, meta?, execute? }
 *
 * execute 契约：
 * - execute(ctx, input) -> { status, output, control }，可为 async。
 * - status：'succeeded' | 'failed' | 'waiting'。
 *   'failed' 可带 error:{ code, message, retryable? }；'waiting' 需带 checkpointRef。
 * - output：本节点产出的数据对象，供下游 bindings 引用。
 * - control：路由出口，取 ports.out 之一（缺省为 'next'）；
 *   'stop'/'nomatch' 等特殊值由 runtime 解释。抛异常等价于节点失败。
 */
import { getPointer, validateSchema } from './lib.mjs'
/**
 * mergeNapcat(families) — 来自 ./integrations/napcat/manifest.mjs。
 * 把 NapCat 集成声明的节点家族原地合并进 families 数组；
 * 在 families 组装完成后、buildRegistry 使用前调用一次。
 */
import { mergeNapcat } from './integrations/napcat/manifest.mjs'
import { runCode } from './code/supervisor.mjs'
import { helpFor } from './help.mjs'

// Schema 简写：S(properties, required?) 生成 object schema；STR/NUM 为基础类型。
const S = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: true })
const STR = { type: 'string' }
const NUM = { type: 'number' }

// ok(output, control?)：构造 execute 的成功返回值（status='succeeded'，缺省走 next）。
function ok(output, control = 'next') { return { status: 'succeeded', output, control } }

// families：节点家族数组，是 buildRegistry / toJSON 的唯一数据源。
export const families = [
  // core.trigger 家族：事件触发。从 ctx.event 判断是否匹配，不匹配时走 nomatch 端口。
  {
    type: 'core.trigger', version: '1.0.0', title: '事件触发', category: '触发', color: '#7C9CFF', icon: '⚡',
    operations: [
      {
        id: 'event', title: '高级事件匹配 (任意事件族)', effect: 'pure', requiredCapabilities: [], ports: { in: [], out: ['next', 'nomatch'] },
        inputSchema: S({ eventType: STR, groups: { type: 'array', items: STR } }, ['eventType']),
        outputSchema: S({ event: { type: 'object' }, matched: { type: 'boolean' } }),
        ui: { fields: [{ path: '/eventType', label: '事件类型', type: 'text', placeholder: 'request.group.add' }, { path: '/groups', label: '群范围(空=全部)', type: 'json' }] },
        execute(ctx, input) {
          const ev = ctx.event || {}
          const t = String(input.eventType || '')
          const sub = String(ev.subtype || (ev.category ? ev.category + '.group.normal' : ''))
          const matched = !!t && (t === sub || sub.startsWith(t + '.') || t.startsWith(sub + '.') || t === ev.category || (t.endsWith('.*') && sub.startsWith(t.slice(0, -1))))
          const groups = Array.isArray(input.groups) && input.groups.length ? input.groups : null
          const inGroup = !groups || groups.includes(ev.chat?.id)
          if (!matched || !inGroup) return { status: 'succeeded', output: { event: ev, matched: false }, control: 'nomatch' }
          return ok({ event: ev, matched: true })
        },
      },
      {
        id: 'command', title: '命令匹配', effect: 'pure', requiredCapabilities: [], ports: { in: [], out: ['next', 'nomatch'] },
        inputSchema: S({ event: STR, command: STR, groups: { type: 'array', items: STR } }, ['command']),
        outputSchema: S({ event: { type: 'object' }, matched: { type: 'boolean' } }),
        ui: { fields: [{ path: '/command', label: '命令', type: 'text', placeholder: '/你好' }, { path: '/event', label: '事件组', type: 'select', options: ['message.group', 'message.private'] }, { path: '/groups', label: '允许的群(空=全部)', type: 'json' }] },
        execute(ctx, input) {
          const ev = ctx.event || {}
          const text = ev?.message?.text ?? ''
          const cmd = input.command || ''
          const isCmd = text === cmd || text.startsWith(cmd + ' ')
          const groups = Array.isArray(input.groups) && input.groups.length ? input.groups : null
          const inGroup = !groups || groups.includes(ev?.chat?.id)
          const matched = isCmd && inGroup
          if (!matched) return { status: 'succeeded', output: { matched: false, event: ev }, control: 'nomatch' }
          return ok({ event: ev, matched: true })
        },
      },
      {
        id: 'message', title: '任意消息', effect: 'pure', requiredCapabilities: [], ports: { in: [], out: ['next', 'error'] },
        inputSchema: S({ event: STR }), outputSchema: S({ event: { type: 'object' } }),
        ui: { fields: [{ path: '/event', label: '事件组', type: 'select', options: ['message.group', 'message.private'] }] },
        execute(ctx, input) { return ok({ event: ctx.event || {} }) },
      },
      {
        id: 'timer', title: '定时任务', effect: 'pure', requiredCapabilities: [], ports: { in: [], out: ['next'] },
        inputSchema: S({ cron: STR, timezone: STR }, ['cron']), outputSchema: S({ event: { type: 'object' } }),
        ui: { fields: [{ path: '/cron', label: 'cron(5段)', type: 'text', placeholder: '0 8 * * *' }, { path: '/timezone', label: '时区', type: 'text', placeholder: 'Asia/Shanghai' }] },
        execute(ctx, input) { return ok({ event: { eventId: `timer_${Date.now()}`, category: 'timer', raw: { cron: input.cron } } }) },
      },
    ],
  },
  // core.template 家族：模板。用 {{变量}} 占位符渲染文本（变量缺失时替换为空串）。
  {
    type: 'core.template', version: '1.0.0', title: '模板', category: '数据', color: '#8BE9A0', icon: '📝',
    operations: [
      {
        id: 'text', title: '文本模板', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: ['next', 'error'] },
        inputSchema: S({ template: STR, variables: { type: 'object' } }, ['template']),
        outputSchema: S({ text: STR }),
        ui: { fields: [{ path: '/template', label: '模板文本 ({{变量}})', type: 'textarea', placeholder: '你好，{{昵称}}！' }] },
        execute(ctx, input) {
          const vars = input.variables || {}
          const text = String(input.template || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''))
          return ok({ text })
        },
      },
    ],
  },
  // core.http 家族：HTTP 请求，经 capabilities.invoke('http.request') 代理执行（effect=read）。
  {
    type: 'core.http', version: '1.0.0', title: 'HTTP 请求', category: '数据', color: '#7FD1E0', icon: '🌐',
    operations: [
      {
        id: 'request', title: 'request (GET/POST/…)', effect: 'read', requiredCapabilities: ['http:request'], ports: { in: ['in'], out: ['next', 'error'] },
        inputSchema: S({ method: STR, url: STR, headers: { type: 'object' }, body: {}, responseMode: STR }, ['url']),
        outputSchema: S({ status: NUM, ok: { type: 'boolean' }, body: {} }),
        ui: { fields: [{ path: '/method', label: '方法', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] }, { path: '/url', label: 'URL', type: 'text', placeholder: 'mock://hello' }, { path: '/responseMode', label: '响应模式', type: 'select', options: ['json', 'text'] }] },
        async execute(ctx, input) {
          const out = await ctx.capabilities.invoke('http.request', { url: input.url, method: input.method || 'GET', headers: input.headers, body: input.body })
          return ok({ status: out.status, ok: out.ok, body: out.body })
        },
      },
    ],
  },
  // core.data 家族：数据处理基础节点（JSON Pointer 取值、对象映射）；下方还会追加数组变换。
  {
    type: 'core.data', version: '1.0.0', title: '数据处理', category: '数据', color: '#C9A7FF', icon: '🧮',
    operations: [
      {
        id: 'pick', title: '取值 (JSON Pointer)', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: ['next', 'error'] },
        inputSchema: S({ source: {}, pointer: STR }, ['pointer']), outputSchema: S({ value: {}, found: { type: 'boolean' } }),
        ui: { fields: [{ path: '/pointer', label: 'JSON Pointer', type: 'text', placeholder: '/body/data/name' }] },
        execute(ctx, input) {
          const v = getPointer(input.source, input.pointer)
          return ok({ value: v ?? null, found: v !== undefined })
        },
      },
      {
        id: 'json', title: '对象映射', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: ['next', 'error'] },
        inputSchema: S({ map: { type: 'object' } }), outputSchema: S({ object: { type: 'object' } }),
        ui: { fields: [{ path: '/map', label: '映射对象', type: 'json' }] },
        execute(ctx, input) { return ok({ object: input.map || {} }) },
      },
    ],
  },
  // core.condition 家族：判断。比较左/右值后按结果从 true/false 端口分流。
  {
    type: 'core.condition', version: '1.0.0', title: '判断', category: '控制', color: '#FFC66D', icon: '🔀',
    operations: [
      {
        id: 'compare', title: '比较 (true/false 分支)', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: ['true', 'false'] },
        inputSchema: S({ left: {}, op: STR, right: {} }, ['op']), outputSchema: S({ result: { type: 'boolean' } }),
        ui: { fields: [{ path: '/op', label: '比较符', type: 'select', options: ['==', '!=', '>', '>=', '<', '<=', 'contains', 'exists'] }, { path: '/right', label: '比较值', type: 'text' }] },
        execute(ctx, input) {
          const l = input.left, r = input.right, op = input.op
          let res = false
          switch (op) {
            case '==': res = String(l) === String(r); break
            case '!=': res = String(l) !== String(r); break
            case '>': res = Number(l) > Number(r); break
            case '>=': res = Number(l) >= Number(r); break
            case '<': res = Number(l) < Number(r); break
            case '<=': res = Number(l) <= Number(r); break
            case 'contains': res = String(l ?? '').includes(String(r ?? '')); break
            case 'exists': res = l !== undefined && l !== null; break
          }
          return { status: 'succeeded', output: { result: res }, control: res ? 'true' : 'false' }
        },
      },
    ],
  },
  // core.loop 家族：循环。forEach 是控制流循环（runtime 执行 body 子图）；forEachTemplate 是数据级批量渲染 MVP。
  {
    type: 'core.loop', version: '1.0.0', title: '循环', category: '控制', color: '#FFC66D', icon: '🔁',
    operations: [
      {
        id: 'forEach', title: '遍历 ForEach (控制流)', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: ['body', 'done'] },
        inputSchema: S({ items: { type: 'array' }, maxIterations: NUM }), outputSchema: S({ count: NUM, results: { type: 'array' } }),
        ui: { fields: [{ path: '/items', label: '集合 (JSON 数组或绑定)', type: 'json' }, { path: '/maxIterations', label: '最大迭代', type: 'number' }] },
        // 调度语义由 runtime 的 execLoop 负责：每个 item 执行一次 body 子图，再走 done。
        async execute() { return ok({ count: 0, results: [] }) },
      },
      {
        id: 'forEachTemplate', title: '批量遍历(模板渲染) • MVP', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: ['next', 'error'] },
        inputSchema: S({ items: { type: 'array' }, template: STR, maxIterations: NUM }), outputSchema: S({ rendered: { type: 'array' }, count: NUM }),
        ui: { fields: [{ path: '/template', label: '每项模板 ({{item}})', type: 'textarea', placeholder: '第{{index}}项: {{item}}' }, { path: '/maxIterations', label: '最大迭代', type: 'number' }] , note: 'MVP：数据级遍历（真实控制流循环在路线图中）' },
        execute(ctx, input) {
          const items = Array.isArray(input.items) ? input.items.slice(0, input.maxIterations || 1000) : []
          const rendered = items.map((item, index) => String(input.template || '{{item}}').replace(/\{\{\s*item\s*\}\}/g, String(item)).replace(/\{\{\s*index\s*\}\}/g, String(index)))
          return ok({ rendered, count: rendered.length })
        },
      },
    ],
  },
  // core.cache 家族：缓存 / Redis。原子自增与读写，经 cache.* capability 代理。
  {
    type: 'core.cache', version: '1.0.0', title: '缓存 / Redis', category: '数据', color: '#F78C6C', icon: '🗄️',
    operations: [
      {
        id: 'incr', title: '原子自增 (首次/签到)', effect: 'write', requiredCapabilities: ['redis:write'], ports: { in: ['in'], out: ['next', 'error'] },
        inputSchema: S({ businessKey: STR, ttlSec: NUM }, ['businessKey']), outputSchema: S({ value: NUM, first: { type: 'boolean' } }),
        ui: { fields: [{ path: '/businessKey', label: '业务 Key', type: 'text', placeholder: 'checkin:{{group}}:{{user}}:2026-11-14' }, { path: '/ttlSec', label: 'TTL 秒', type: 'number' }] },
        async execute(ctx, input) { const r = await ctx.capabilities.invoke('cache.incr', { businessKey: input.businessKey, ttlSec: input.ttlSec }); return ok({ value: r.value, first: r.first }) },
      },
      {
        id: 'set', title: '写入 (set)', effect: 'write', requiredCapabilities: ['redis:write'], ports: { in: ['in'], out: ['next', 'error'] },
        inputSchema: S({ businessKey: STR, value: {}, ttlSec: NUM }, ['businessKey']), outputSchema: S({ ok: { type: 'boolean' } }),
        ui: { fields: [{ path: '/businessKey', label: '业务 Key', type: 'text' }, { path: '/value', label: '值(JSON)', type: 'json' }, { path: '/ttlSec', label: 'TTL 秒', type: 'number' }] },
        async execute(ctx, input) { const r = await ctx.capabilities.invoke('cache.set', { businessKey: input.businessKey, value: input.value, ttlSec: input.ttlSec }); return ok({ ok: r.ok }) },
      },
      {
        id: 'get', title: '读取 (get)', effect: 'read', requiredCapabilities: ['redis:read'], ports: { in: ['in'], out: ['next', 'error'] },
        inputSchema: S({ businessKey: STR }, ['businessKey']), outputSchema: S({ found: { type: 'boolean' }, value: {} }),
        ui: { fields: [{ path: '/businessKey', label: '业务 Key', type: 'text' }] },
        async execute(ctx, input) { const r = await ctx.capabilities.invoke('cache.get', { businessKey: input.businessKey }); return ok({ found: r.found, value: r.value ?? null }) },
      },
    ],
  },
  // core.crypto 家族：加解密与签名（AEAD AES-256-GCM / Ed25519），经 crypto.* capability 代理。
  {
    type: 'core.crypto', version: '1.0.0', title: '加解密', category: '数据', color: '#F07178', icon: '🔐',
    operations: [
      {
        id: 'encrypt', title: 'AEAD 加密 (AES-256-GCM)', effect: 'pure', requiredCapabilities: ['crypto:encrypt'], ports: { in: ['in'], out: ['next', 'error'] },
        inputSchema: S({ plaintext: STR, secretRef: STR, aad: STR }, ['plaintext']), outputSchema: S({ envelope: { type: 'object' } }),
        ui: { fields: [{ path: '/plaintext', label: '明文', type: 'textarea' }, { path: '/secretRef', label: '密钥引用(secretRef id)', type: 'secret' }, { path: '/aad', label: 'AAD', type: 'text' }] },
        async execute(ctx, input) { const env = await ctx.capabilities.invoke('crypto.encrypt', { plaintext: input.plaintext, secretRef: input.secretRef || 'demo_aes', aad: input.aad }); return ok({ envelope: env }) },
      },
      {
        id: 'decrypt', title: 'AEAD 解密', effect: 'pure', requiredCapabilities: ['crypto:decrypt'], ports: { in: ['in'], out: ['next', 'error'] },
        inputSchema: S({ envelope: { type: 'object' }, secretRef: STR }), outputSchema: S({ plaintext: STR }),
        ui: { fields: [{ path: '/secretRef', label: '密钥引用', type: 'secret' }] },
        async execute(ctx, input) { const r = await ctx.capabilities.invoke('crypto.decrypt', { envelope: input.envelope, secretRef: input.secretRef || 'demo_aes' }); return ok({ plaintext: r.plaintext }) },
      },
      {
        id: 'sign', title: '签名 (Ed25519)', effect: 'pure', requiredCapabilities: ['crypto:sign'], ports: { in: ['in'], out: ['next', 'error'] },
        inputSchema: S({ message: STR, secretRef: STR }), outputSchema: S({ signature: { type: 'object' } }),
        ui: { fields: [{ path: '/message', label: '待签名消息', type: 'textarea' }, { path: '/secretRef', label: '签名密钥', type: 'secret' }] },
        async execute(ctx, input) { const s = await ctx.capabilities.invoke('crypto.sign', { message: input.message, secretRef: input.secretRef || 'demo_sign' }); return ok({ signature: s }) },
      },
    ],
  },
  // core.render 家族：出图。把文本渲染为图片资源（经 render:text capability）。
  {
    type: 'core.render', version: '1.0.0', title: '出图', category: '数据', color: '#89DDFF', icon: '🖼️',
    operations: [
      {
        id: 'textImage', title: '文本出图', effect: 'pure', requiredCapabilities: ['render:text'], ports: { in: ['in'], out: ['next', 'error'] },
        inputSchema: S({ text: STR, width: NUM, height: NUM }), outputSchema: S({ resource: { type: 'object' } }),
        ui: { fields: [{ path: '/text', label: '文本', type: 'textarea' }, { path: '/width', label: '宽', type: 'number' }, { path: '/height', label: '高', type: 'number' }] },
        async execute(ctx, input) { const r = await ctx.capabilities.invoke('render.textImage', input); return ok({ resource: r }) },
      },
    ],
  },
  // qq.message 家族：QQ 消息发送（send_msg / send_group_msg），经 qq.send capability 代理。
  {
    type: 'qq.message', version: '1.0.0', title: 'QQ 消息', category: 'QQ', color: '#5FA8FF', icon: '💬',
    operations: [
      {
        id: 'send_msg', title: '发送消息', effect: 'send', requiredCapabilities: ['qq:message:send:current'], ports: { in: ['in'], out: ['next', 'error'] },
        meta: { canonicalAction: 'send_msg', availability: 'supported', genericForm: false, contractTested: true, liveVerified: false, sourceVersion: '4.18.38' },
        inputSchema: S({ target: { type: 'object' }, message: { type: 'array' }, text: STR }),
        outputSchema: S({ message_id: STR, receipt: { type: 'object' } }),
        ui: { fields: [{ path: '/target', label: '目标', type: 'select', options: ['currentConversation', 'group', 'private'] }, { path: '/text', label: '文本内容(快捷)', type: 'textarea' }] },
        async execute(ctx, input) {
          const ev = ctx.event || {}
          let target = ev?.chat || { type: 'group', id: 'unknown' }
          if (input.target && input.target.kind === 'group') target = { type: 'group', id: input.target.id }
          const msg = input.message && input.message.length ? input.message : [{ type: 'text', data: { text: input.text || '' } }]
          const r = await ctx.capabilities.invoke('qq.send', { target, message: msg })
          return ok({ message_id: r.message_id, receipt: r.receipt })
        },
      },
      {
        id: 'send_group_msg', title: '发送群消息', effect: 'send', requiredCapabilities: ['qq:message:send:group'], ports: { in: ['in'], out: ['next', 'error'] },
        meta: { canonicalAction: 'send_group_msg', availability: 'supported', genericForm: false, contractTested: false, liveVerified: false, sourceVersion: '4.18.38' },
        inputSchema: S({ group_id: STR, text: STR }, ['group_id']), outputSchema: S({ message_id: STR }),
        ui: { fields: [{ path: '/group_id', label: '群号', type: 'text' }, { path: '/text', label: '文本', type: 'textarea' }] },
        async execute(ctx, input) { const r = await ctx.capabilities.invoke('qq.send', { target: { type: 'group', id: input.group_id }, message: [{ type: 'text', data: { text: input.text || '' } }] }); return ok({ message_id: r.message_id }) },
      },
    ],
  },
  // qq.member 家族：QQ 群成员管理（如群禁言），经 qq.action capability 代理。
  {
    type: 'qq.member', version: '1.0.0', title: 'QQ 群成员', category: 'QQ', color: '#5FA8FF', icon: '👥',
    operations: [
      {
        id: 'set_group_ban', title: '群禁言', effect: 'admin', requiredCapabilities: ['qq:group:admin'], ports: { in: ['in'], out: ['next', 'error'] },
        meta: { canonicalAction: 'set_group_ban', availability: 'supported', genericForm: false, contractTested: false, liveVerified: false, sourceVersion: '4.18.38' },
        inputSchema: S({ group_id: STR, user_id: STR, duration: NUM }, ['group_id', 'user_id']), outputSchema: S({ ok: { type: 'boolean' } }),
        ui: { fields: [{ path: '/group_id', label: '群号', type: 'text' }, { path: '/user_id', label: 'QQ', type: 'text' }, { path: '/duration', label: '时长(秒)', type: 'number' }] },
        async execute(ctx, input) { const r = await ctx.capabilities.invoke('qq.action', { name: 'set_group_ban', params: input }); return ok({ ok: r.ok }) },
      },
    ],
  },
  // qq.request 家族：QQ 申请处理（如入群申请审批），经 qq.action capability 代理。
  {
    type: 'qq.request', version: '1.0.0', title: 'QQ 申请', category: 'QQ', color: '#5FA8FF', icon: '📨',
    operations: [
      {
        id: 'set_group_add_request', title: '处理入群申请', effect: 'admin', requiredCapabilities: ['qq:request:handle'], ports: { in: ['in'], out: ['next', 'error'] },
        meta: { canonicalAction: 'set_group_add_request', availability: 'supported', genericForm: false, contractTested: true, liveVerified: false, sourceVersion: '4.18.38' },
        inputSchema: S({ flag: STR, approve: { type: 'boolean' }, reason: STR }, ['flag']), outputSchema: S({ ok: { type: 'boolean' } }),
        ui: { fields: [{ path: '/flag', label: 'flag(事件提供)', type: 'text' }, { path: '/approve', label: '通过', type: 'select', options: ['true', 'false'] }, { path: '/reason', label: '理由', type: 'text' }] },
        async execute(ctx, input) { const r = await ctx.capabilities.invoke('qq.action', { name: 'set_group_add_request', params: input }); return ok({ ok: r.ok }) },
      },
    ],
  },
  // integration.datasource 家族：数据源集成，统一经 datasource.call 调用外部数据源操作。
  {
    type: 'integration.datasource', version: '1.0.0', title: '数据源', category: '数据', color: '#A0E57C', icon: '🔌',
    operations: [
      {
        id: 'call', title: '调用数据源操作', effect: 'read', requiredCapabilities: ['datasource:demo.user-profile:read'], ports: { in: ['in'], out: ['next', 'error'] },
        inputSchema: S({ pkg: STR, version: STR, op: STR, input: { type: 'object' } }, ['op']), outputSchema: S({ result: {} }),
        ui: { fields: [{ path: '/pkg', label: '数据源包', type: 'text', placeholder: 'demo.user-profile' }, { path: '/op', label: '操作', type: 'text', placeholder: 'getProfile' }] },
        async execute(ctx, input) { const r = await ctx.capabilities.invoke('datasource.call', { pkg: input.pkg || 'demo.user-profile', version: input.version || '1.0.0', op: input.op, input: input.input }); return ok({ result: r }) },
      },
    ],
  },
]

// ---- §9 目录补充：给 core.data 追加数组变换，并新增 core.regex / core.wait 家族 ----
// 数组变换 filter/sort/unique/mapField：纯函数，直接操作数组数据（无 capability 依赖）。
{
  const dataFam = families.find((f) => f.type === 'core.data')
  if (dataFam) {
    dataFam.operations.push(
      {
        id: 'filter', title: '数组过滤', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: ['next', 'error'] },
        inputSchema: S({ items: { type: 'array' }, field: STR, op: STR, value: {} }, ['items', 'field', 'op']),
        outputSchema: S({ items: { type: 'array' }, count: NUM }),
        ui: { fields: [{ path: '/items', label: '数组(可绑定)', type: 'json' }, { path: '/field', label: '字段', type: 'text' }, { path: '/op', label: '比较符', type: 'select', options: ['==', '!=', '>', '>=', '<', '<=', 'contains', 'exists'] }, { path: '/value', label: '比较值', type: 'text' }] },
        execute(ctx, input) {
          const items = Array.isArray(input.items) ? input.items : []
          const f = input.field, op = input.op, v = input.value
          const test = (x) => { const a = x?.[f]; switch (op) { case '==': return String(a) === String(v); case '!=': return String(a) !== String(v); case '>': return Number(a) > Number(v); case '>=': return Number(a) >= Number(v); case '<': return Number(a) < Number(v); case '<=': return Number(a) <= Number(v); case 'contains': return String(a ?? '').includes(String(v)); case 'exists': return a !== undefined && a !== null; default: return false } }
          const out = items.filter(test)
          return ok({ items: out, count: out.length })
        },
      },
      {
        id: 'sort', title: '数组排序', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: ['next', 'error'] },
        inputSchema: S({ items: { type: 'array' }, field: STR, order: STR }, ['items', 'field']),
        outputSchema: S({ items: { type: 'array' } }),
        ui: { fields: [{ path: '/items', label: '数组(可绑定)', type: 'json' }, { path: '/field', label: '字段', type: 'text' }, { path: '/order', label: '方向', type: 'select', options: ['asc', 'desc'] }] },
        execute(ctx, input) {
          const items = Array.isArray(input.items) ? [...input.items] : []
          const dir = input.order === 'desc' ? -1 : 1
          items.sort((a, b) => { const x = a?.[input.field], y = b?.[input.field]; if (x === y) return 0; return (x < y ? -1 : 1) * dir })
          return ok({ items })
        },
      },
      {
        id: 'unique', title: '数组去重', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: ['next', 'error'] },
        inputSchema: S({ items: { type: 'array' }, field: STR }, ['items']),
        outputSchema: S({ items: { type: 'array' }, count: NUM }),
        ui: { fields: [{ path: '/items', label: '数组(可绑定)', type: 'json' }, { path: '/field', label: '按字段(空=整体)', type: 'text' }] },
        execute(ctx, input) {
          const items = Array.isArray(input.items) ? input.items : []
          const seen = new Set(); const out = []
          for (const it of items) { const k = input.field ? JSON.stringify(it?.[input.field]) : JSON.stringify(it); if (!seen.has(k)) { seen.add(k); out.push(it) } }
          return ok({ items: out, count: out.length })
        },
      },
      {
        id: 'mapField', title: '抽取字段(数组)', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: ['next', 'error'] },
        inputSchema: S({ items: { type: 'array' }, field: STR }, ['items', 'field']),
        outputSchema: S({ items: { type: 'array' } }),
        ui: { fields: [{ path: '/items', label: '数组(可绑定)', type: 'json' }, { path: '/field', label: '字段', type: 'text' }] },
        execute(ctx, input) { return ok({ items: (Array.isArray(input.items) ? input.items : []).map((x) => x?.[input.field]) }) },
      },
    )
  }
  families.push(
    // core.regex 家族：正则提取 / 替换 / 拆分文本。
    {
      type: 'core.regex', version: '1.0.0', title: '正则', category: '数据', color: '#C9A7FF', icon: '🔎',
      operations: [
        {
          id: 'extract', title: '正则提取', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: ['next', 'error'] },
          inputSchema: S({ text: STR, pattern: STR, flags: STR, group: NUM }, ['text', 'pattern']),
          outputSchema: S({ value: {}, matched: { type: 'boolean' }, all: { type: 'array' } }),
          ui: { fields: [{ path: '/text', label: '文本(可绑定)', type: 'textarea' }, { path: '/pattern', label: '正则', type: 'text' }, { path: '/flags', label: 'flags', type: 'text' }, { path: '/group', label: '分组序号', type: 'number' }] },
          execute(ctx, input) {
            const re = new RegExp(input.pattern, (input.flags || '').replace('g', '') + 'g')
            const all = [...String(input.text ?? '').matchAll(re)].map((m) => (input.group ? m[Number(input.group)] : m[0]))
            return ok({ value: all[0] ?? null, matched: all.length > 0, all })
          },
        },
        {
          id: 'replace', title: '正则替换', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: ['next', 'error'] },
          inputSchema: S({ text: STR, pattern: STR, replacement: STR, flags: STR }, ['text', 'pattern', 'replacement']),
          outputSchema: S({ text: STR }),
          ui: { fields: [{ path: '/text', label: '文本(可绑定)', type: 'textarea' }, { path: '/pattern', label: '正则', type: 'text' }, { path: '/replacement', label: '替换为', type: 'text' }, { path: '/flags', label: 'flags', type: 'text' }] },
          execute(ctx, input) { return ok({ text: String(input.text ?? '').replace(new RegExp(input.pattern, input.flags || 'g'), input.replacement ?? '') }) },
        },
        {
          id: 'split', title: '正则拆分', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: ['next', 'error'] },
          inputSchema: S({ text: STR, pattern: STR }), outputSchema: S({ items: { type: 'array' } }),
          ui: { fields: [{ path: '/text', label: '文本(可绑定)', type: 'textarea' }, { path: '/pattern', label: '正则', type: 'text' }] },
          execute(ctx, input) { return ok({ items: String(input.text ?? '').split(new RegExp(input.pattern)) }) },
        },
      ],
    },
    // core.wait 家族：等待 / 延时（MVP 内存等待，上限 2000ms；持久化唤醒为路线图）。
    {
      type: 'core.wait', version: '1.0.0', title: '等待', category: '控制', color: '#FFC66D', icon: '⏳',
      operations: [
        {
          id: 'delay', title: '延时 (上限 2000ms)', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: ['next', 'error'] },
          inputSchema: S({ ms: NUM }, ['ms']), outputSchema: S({ waitedMs: NUM }),
          ui: { fields: [{ path: '/ms', label: '毫秒', type: 'number' }], note: 'MVP：内存等待上限 2000ms；文档中的持久化唤醒为路线图' },
          async execute(ctx, input) { const ms = Math.max(0, Math.min(2000, Number(input.ms) || 0)); await new Promise((r) => setTimeout(r, ms)); return ok({ waitedMs: ms }) },
        },
      ],
    },
  )
}

// ---- §7.2/§9 控制节点：新增 core.control 家族（Merge / Stop），后续再补 switch 与 tryCatch ----
families.push({
  // core.control 家族：控制流节点。merge 合流取第一个非空输入；stop 终止当前分支。
  type: 'core.control', version: '1.0.0', title: '控制', category: '控制', color: '#FFC66D', icon: '🔀',
  operations: [
    {
      id: 'merge', title: '合流 Merge (取实际到达值)', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: ['next', 'error'] },
      inputSchema: S({}), outputSchema: S({ value: {}, source: STR }),
      ui: { fields: [], note: '把互斥分支的值合到一处：取第一个非空输入。未到达的分支不等待。' },
      execute(ctx, input) {
        for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== null && v !== '') return ok({ value: v, source: k })
        return ok({ value: null, source: null })
      },
    },
    {
      id: 'stop', title: '终止 Stop', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: [] },
      inputSchema: S({}), outputSchema: S({ stopped: { type: 'boolean' } }),
      ui: { fields: [], note: '终止当前流程分支，不再向下游执行。' },
      execute() { return { status: 'succeeded', output: { stopped: true }, control: 'stop' } },
    },
  ],
})

// ---- §7.2 Switch 多路分支：向 core.control 追加 switch 节点 ----
{
  const ctrl = families.find((f) => f.type === 'core.control')
  if (ctrl) ctrl.operations.push({
    id: 'switch', title: '多路分支 Switch (2路+默认)', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: ['case1', 'case2', 'default'] },
    inputSchema: S({ value: {}, v1: STR, v2: STR }), outputSchema: S({ matched: STR }),
    ui: { fields: [{ path: '/v1', label: 'case1 匹配值', type: 'text' }, { path: '/v2', label: 'case2 匹配值', type: 'text' }] },
    execute(ctx, input) {
      const v = input.value
      let c = 'default'
      if (input.v1 !== undefined && input.v1 !== '' && String(v) === String(input.v1)) c = 'case1'
      else if (input.v2 !== undefined && input.v2 !== '' && String(v) === String(input.v2)) c = 'case2'
      return { status: 'succeeded', output: { matched: c }, control: c }
    },
  })
}

// 向 core.control 追加 tryCatch：body 子图失败可走 catch，最终都走 done（调度语义由 runtime 实现）。
families.find((f) => f.type === 'core.control').operations.push({
    id: 'tryCatch', title: 'Try/Catch 错误域', effect: 'pure', requiredCapabilities: [], ports: { in: ['in'], out: ['body', 'catch', 'done'] },
    inputSchema: S({}), outputSchema: S({ ok: { type: 'boolean' }, error: {}, caught: { type: 'boolean' } }),
    ui: { fields: [], note: 'body 子图中的失败被捕获并可走 catch；无论成败都会走 done。' },
    async execute() { return ok({ ok: true }) },
  })

// 合并 NapCat 集成节点：在 core.* 组装完成后调用，确保前端目录与运行时一致。
mergeNapcat(families)

// core.code 家族：JavaScript 代码节点。runCode 在独立子进程执行（owner-trusted-process，故障隔离）。
families.push({
  type: 'core.code', version: '1.0.0', title: '代码', category: '数据', color: '#C9A7FF', icon: '</>',
  operations: [
    {
      id: 'js', title: 'JavaScript 代码 (独立进程)', effect: 'pure', requiredCapabilities: ['code:execute'],
      ports: { in: ['in'], out: ['next', 'error'] },
      inputSchema: S({ code: STR, input: {} }, ['code']),
      outputSchema: S({ result: {}, logs: { type: 'array' } }),
      ui: { fields: [{ path: '/code', label: '代码 (async 函数体，可 return)', type: 'code' }, { path: '/input', label: '输入对象 (可绑定)', type: 'json' }], note: 'owner-trusted-process：独立子进程+超时+内存上限（故障隔离），模拟模式禁网。' },
      async execute(ctx, input) {
        const r = await runCode(input.code || 'return {}', input.input || {}, { timeoutMs: ctx.budget?.timeoutMs || 3000, mode: ctx.mode || 'simulate' })
        if (!r.ok) throw Object.assign(new Error(r.error.message || '代码执行失败'), { code: r.error.code || 'CODE_ERROR' })
        return ok({ result: r.result, logs: r.logs || [] })
      },
    },
  ],
})

// core.subgraph 家族：子图调用。按 subgraphId + version + contentHash 锁定，v1 禁止递归。
families.push({
  type: 'core.subgraph', version: '1.0.0', title: '子图', category: '高级', color: '#A0E57C', icon: '🧩',
  operations: [
    {
      id: 'call', title: '调用发布子图', effect: 'pure', requiredCapabilities: ['subgraph:call'], ports: { in: ['in'], out: ['next', 'error'] },
      inputSchema: S({ subgraphId: STR, version: {}, contentHash: STR, inputs: { type: 'object' } }, ['subgraphId']),
      outputSchema: S({ outputs: { type: 'object' } }),
      ui: { fields: [{ path: '/subgraphId', label: '子图 ID', type: 'text' }, { path: '/version', label: '版本(空=latest)', type: 'number' }, { path: '/inputs', label: '输入(可绑定)', type: 'json' }], note: '锁定 subgraphId + version + contentHash；v1 禁止递归。' },
      async execute() { return ok({ outputs: {} }) },
    },
  ],
})

/**
 * buildRegistry() — 组装运行时注册表查询入口。
 *
 * @returns {{
 *   registryVersion: string,
 *   families: object[],
 *   get(type: string, op: string): { family: object, operation: object } | null,
 *   toJSON(): object,   // 可序列化目录（剥离 execute 函数）
 *   stats(): { families: number, operations: number }
 * }}
 */
export function buildRegistry() {
  const byType = new Map()
  for (const f of families) byType.set(f.type, f)
  return {
    registryVersion: 'napcat@4.18.42/mvp',
    families,
    get(type, op) {
      const fam = byType.get(type)
      if (!fam) return null
      const operation = fam.operations.find((o) => o.id === op)
      if (!operation) return null
      return { family: fam, operation }
    },
    /**
     * toJSON() — 返回可序列化目录：剥离 execute 函数，
     * 每个 operation 附带 help 文案（helpFor），供 Web 前端 / API 展示。
     */
    toJSON() {
      return {
        registryVersion: 'napcat@4.18.42/mvp',
        families: families.map((f) => ({
          type: f.type, version: f.version, title: f.title, category: f.category, color: f.color, icon: f.icon,
          operations: f.operations.map((o) => ({ id: o.id, title: o.title, effect: o.effect, requiredCapabilities: o.requiredCapabilities, ports: o.ports, inputSchema: o.inputSchema, outputSchema: o.outputSchema, ui: o.ui, meta: o.meta, help: helpFor(f.type, o) })),
        })),
      }
    },
    /**
     * stats() — 统计注册表规模：家族数与操作总数。
     * @returns {{ families: number, operations: number }}
     */
    stats() {
      const fams = families.length
      const ops = families.reduce((a, f) => a + f.operations.length, 0)
      return { families: fams, operations: ops }
    },
  }
}

// 透传导出：Schema 校验器（供 compiler / API 校验节点输入）。
export { validateSchema }
