/**
 * seed.mjs — 示例流程种子数据。
 *
 * 职责：仅在空库（workflow / subgraph 列表为空）时注入示例流程，保证幂等；
 * 已有任何数据时立即返回，绝不覆盖用户数据。
 *
 * 架构位置：存储初始化阶段调用（store / sg 就绪后），
 * 给 Web 前端与演示环境提供可直接运行、可参考的示例 workflow 与 subgraph。
 *
 * 主要导出：
 * - seedIfEmpty(store, log?)：store.listWorkflows() 为空时注入示例 workflow。
 * - seedSubgraphs(sg)：sg.list() 为空时注入示例子图 sg_greet。
 *
 * 数据结构约定：
 * - N() 构造 workflow 节点；CE() 构造控制边（control edge）；
 *   两者直接生成 storage / runtime 约定的 graph 结构，不经过 compiler。
 */
// N(...)：构造一个 workflow 节点，补齐 familyVersion / operationVersion / position 等默认字段。
const N = (id, type, operation, params, bindings, x, y, extra = {}) => ({
  id, type, familyVersion: '1.0.0', operation, operationVersion: '1.0.0', params: params || {}, bindings: bindings || {}, position: { x, y }, ...extra,
})
// CE(...)：构造一条控制边（from 节点出口端口 -> to 节点 'in' 端口）。
const CE = (fromId, fromPort, toId) => ({ from: { nodeId: fromId, port: fromPort }, to: { nodeId: toId, port: 'in' } })

/**
 * seedIfEmpty(store, log?) — 空库时注入示例 workflow。
 * store.listWorkflows() 非空则直接返回（幂等）；log 缺省为 no-op。
 */
export function seedIfEmpty(store, log = () => {}) {
  if (store.listWorkflows().length > 0) return
  const now = new Date().toISOString()
  // mk(...)：按统一骨架保存一条 workflow（graph 由 nodes + controlEdges 组成）。
  const mk = (id, title, nodes, controlEdges, permissions) => store.saveWorkflow({
    workflowSchemaVersion: 1, id, title, revision: 1, workflowVersion: 0, enabled: id === 'wf_hello',
    permissions: permissions || { bots: ['bot_demo'], groups: ['group_10086'], capabilities: [] },
    graph: { nodes, controlEdges }, dependencies: [],
    ui: { viewport: { x: 0, y: 0, zoom: 1 }, groups: [], notes: [] },
    createdAt: now, updatedAt: now,
  })

  // 示例：命令触发 -> 模板渲染 -> 发送消息（群欢迎 /你好）。
  mk('wf_hello', '群欢迎 · /你好', [
    N('trigger_1', 'core.trigger', 'command', { event: 'message.group', command: '/你好', groups: [] }, {}, 60, 150),
    N('template_1', 'core.template', 'text', { template: '你好，{{昵称}}！欢迎加入本群 👋', variables: { 昵称: '' } },
      { '/variables/昵称': { kind: 'ref', nodeId: 'trigger_1', pointer: '/event/sender/nickname' } }, 420, 150),
    N('send_1', 'qq.message', 'send_msg', { target: { kind: 'currentConversation' }, text: '' },
      { '/text': { kind: 'ref', nodeId: 'template_1', pointer: '/text' } }, 800, 150),
  ], [CE('trigger_1', 'next', 'template_1'), CE('template_1', 'next', 'send_1')])

  // 示例：签到——原子自增取 first 值，比较分支判断是否首次签到。
  mk('wf_checkin', '签到 · 原子自增 + 分支', [
    N('trigger_1', 'core.trigger', 'command', { event: 'message.group', command: '/签到', groups: [] }, {}, 40, 180),
    N('incr_1', 'core.cache', 'incr', { businessKey: 'checkin:demo:group_10086', ttlSec: 86400 }, {}, 330, 180),
    N('cond_1', 'core.condition', 'compare', { op: '==', right: 'true' },
      { '/left': { kind: 'ref', nodeId: 'incr_1', pointer: '/first' } }, 600, 180),
    N('tmpl_ok', 'core.template', 'text', { template: '✅ 签到成功！今天第 {{n}} 次打卡' , variables: { n: '' } },
      { '/variables/n': { kind: 'ref', nodeId: 'incr_1', pointer: '/value' } }, 880, 90),
    N('send_ok', 'qq.message', 'send_msg', { target: { kind: 'currentConversation' }, text: '' },
      { '/text': { kind: 'ref', nodeId: 'tmpl_ok', pointer: '/text' } }, 1180, 90),
    N('tmpl_dup', 'core.template', 'text', { template: '今天已经签到过啦～', variables: {} }, {}, 880, 290),
    N('send_dup', 'qq.message', 'send_msg', { target: { kind: 'currentConversation' }, text: '' },
      { '/text': { kind: 'ref', nodeId: 'tmpl_dup', pointer: '/text' } }, 1180, 290),
  ], [
    CE('trigger_1', 'next', 'incr_1'), CE('incr_1', 'next', 'cond_1'),
    { from: { nodeId: 'cond_1', port: 'true' }, to: { nodeId: 'tmpl_ok', port: 'in' } },
    CE('tmpl_ok', 'next', 'send_ok'),
    { from: { nodeId: 'cond_1', port: 'false' }, to: { nodeId: 'tmpl_dup', port: 'in' } },
    CE('tmpl_dup', 'next', 'send_dup'),
  ])

  // 示例：AES-256-GCM 加密后，把 envelope 的 format / kid 渲染并发送。
  mk('wf_crypto', '加密 · AES-256-GCM', [
    N('trigger_1', 'core.trigger', 'command', { event: 'message.group', command: '/加密', groups: [] }, {}, 60, 160),
    N('enc_1', 'core.crypto', 'encrypt', { plaintext: '你好，云崽！这是机密内容', secretRef: 'demo_aes', aad: 'demo' }, {}, 380, 160),
    N('tmpl_1', 'core.template', 'text', { template: '🔐 加密完成 · 格式={{fmt}} · kid={{kid}}', variables: { fmt: '', kid: '' } },
      { '/variables/fmt': { kind: 'ref', nodeId: 'enc_1', pointer: '/envelope/format' }, '/variables/kid': { kind: 'ref', nodeId: 'enc_1', pointer: '/envelope/kid' } }, 720, 160),
    N('send_1', 'qq.message', 'send_msg', { target: { kind: 'currentConversation' }, text: '' },
      { '/text': { kind: 'ref', nodeId: 'tmpl_1', pointer: '/text' } }, 1080, 160),
  ], [CE('trigger_1', 'next', 'enc_1'), CE('enc_1', 'next', 'tmpl_1'), CE('tmpl_1', 'next', 'send_1')])

  // 示例：mock HTTP 请求 -> JSON Pointer 取 weather -> 模板 -> 发送。
  mk('wf_http', 'HTTP · JSON 点选取值', [
    N('trigger_1', 'core.trigger', 'command', { event: 'message.group', command: '/天气', groups: [] }, {}, 60, 170),
    N('http_1', 'core.http', 'request', { method: 'GET', url: 'mock://weather', responseMode: 'json' }, {}, 360, 170),
    N('pick_1', 'core.data', 'pick', { pointer: '/weather' },
      { '/source': { kind: 'ref', nodeId: 'http_1', pointer: '/body' } }, 680, 170),
    N('tmpl_1', 'core.template', 'text', { template: '今天天气：{{w}}', variables: { w: '' } },
      { '/variables/w': { kind: 'ref', nodeId: 'pick_1', pointer: '/value' } }, 960, 170),
    N('send_1', 'qq.message', 'send_msg', { target: { kind: 'currentConversation' }, text: '' },
      { '/text': { kind: 'ref', nodeId: 'tmpl_1', pointer: '/text' } }, 1280, 170),
  ], [CE('trigger_1', 'next', 'http_1'), CE('http_1', 'next', 'pick_1'), CE('pick_1', 'next', 'tmpl_1'), CE('tmpl_1', 'next', 'send_1')])

  // 示例：ForEach 控制流循环，body 子图对集合中每项渲染问候。
  mk('wf_loop', '批量 · ForEach 控制流循环', [
    N('trigger_1', 'core.trigger', 'command', { event: 'message.group', command: '/批量', groups: [] }, {}, 60, 190),
    N('loop_1', 'core.loop', 'forEach', { items: ['张三', '李四', '王五'], maxIterations: 100 }, {}, 340, 190),
    N('tmpl_1', 'core.template', 'text', { template: '你好，{{name}}！👋', variables: { name: '' } },
      { '/variables/name': { kind: 'ref', nodeId: 'loop_1', pointer: '/item' } }, 660, 120),
    N('send_1', 'qq.message', 'send_msg', { target: { kind: 'currentConversation' }, text: '' },
      { '/text': { kind: 'ref', nodeId: 'tmpl_1', pointer: '/text' } }, 980, 120),
  ], [
    CE('trigger_1', 'next', 'loop_1'),
    { from: { nodeId: 'loop_1', port: 'body' }, to: { nodeId: 'tmpl_1', port: 'in' } },
    CE('tmpl_1', 'next', 'send_1'),
  ])

  // 示例：独立进程代码节点，接收昵称并返回问候语。
  mk('wf_code', '代码节点 · 独立进程', [
    N('trigger_1', 'core.trigger', 'command', { event: 'message.group', command: '/算', groups: [] }, {}, 60, 170),
    N('code_1', 'core.code', 'js', { code: 'sdk.log("计算", input.name); return { greeting: "你好，" + input.name + "！", len: String(input.name).length }', input: {} },
      { '/input/name': { kind: 'ref', nodeId: 'trigger_1', pointer: '/event/sender/nickname' } }, 360, 170),
    N('tmpl_1', 'core.template', 'text', { template: '{{g}}（名字 {{n}} 个字）', variables: { g: '', n: '' } },
      { '/variables/g': { kind: 'ref', nodeId: 'code_1', pointer: '/result/greeting' }, '/variables/n': { kind: 'ref', nodeId: 'code_1', pointer: '/result/len' } }, 700, 170),
    N('send_1', 'qq.message', 'send_msg', { target: { kind: 'currentConversation' }, text: '' },
      { '/text': { kind: 'ref', nodeId: 'tmpl_1', pointer: '/text' } }, 1000, 170),
  ], [CE('trigger_1', 'next', 'code_1'), CE('code_1', 'next', 'tmpl_1'), CE('tmpl_1', 'next', 'send_1')])

  // 示例：入群申请事件 -> 自动通过申请 -> 发送提示。
  mk('wf_event', '事件 · 入群申请自动通过', [
    N('trigger_1', 'core.trigger', 'event', { eventType: 'request.group.add', groups: [] }, {}, 60, 170),
    N('req_1', 'qq.request', 'set_group_add_request', { flag: '', approve: true, reason: '自动通过' },
      { '/flag': { kind: 'ref', nodeId: 'trigger_1', pointer: '/event/request/flag' } }, 380, 170),
    N('send_1', 'qq.message', 'send_msg', { target: { kind: 'currentConversation' }, text: '✅ 已自动通过入群申请' }, {}, 720, 170),
  ], [CE('trigger_1', 'next', 'req_1'), CE('req_1', 'next', 'send_1')])

  // 示例：调用已发布子图 sg_greet（由 seedSubgraphs 注入）。
  mk('wf_subgraph', '子图 · 调用发布子图', [
    N('trigger_1', 'core.trigger', 'command', { event: 'message.group', command: '/子图', groups: [] }, {}, 60, 170),
    N('sub_1', 'core.subgraph', 'call', { subgraphId: 'sg_greet', version: 1, inputs: { prefix: '你好' } },
      { '/inputs/name': { kind: 'ref', nodeId: 'trigger_1', pointer: '/event/sender/nickname' } }, 360, 170),
    N('send_1', 'qq.message', 'send_msg', { target: { kind: 'currentConversation' }, text: '' },
      { '/text': { kind: 'ref', nodeId: 'sub_1', pointer: '/outputs/text' } }, 720, 170),
  ], [CE('trigger_1', 'next', 'sub_1'), CE('sub_1', 'next', 'send_1')])

  // 示例：数据源 getProfile 取资料卡 -> 模板 -> 发送。
  mk('wf_ds', '数据源 · 用户资料卡', [
    N('trigger_1', 'core.trigger', 'command', { event: 'message.group', command: '/资料', groups: [] }, {}, 60, 170),
    N('ds_1', 'integration.datasource', 'call', { pkg: 'demo.user-profile', version: '1.0.0', op: 'getProfile', input: {} },
      { '/input/uid': { kind: 'ref', nodeId: 'trigger_1', pointer: '/event/sender/userId' } }, 380, 170),
    N('tmpl_1', 'core.template', 'text', { template: '{{name}} · Lv.{{level}}', variables: { name: '', level: '' } },
      { '/variables/name': { kind: 'ref', nodeId: 'ds_1', pointer: '/result/name' }, '/variables/level': { kind: 'ref', nodeId: 'ds_1', pointer: '/result/level' } }, 720, 170),
    N('send_1', 'qq.message', 'send_msg', { target: { kind: 'currentConversation' }, text: '' },
      { '/text': { kind: 'ref', nodeId: 'tmpl_1', pointer: '/text' } }, 1020, 170),
  ], [CE('trigger_1', 'next', 'ds_1'), CE('ds_1', 'next', 'tmpl_1'), CE('tmpl_1', 'next', 'send_1')])

  // 示例：分支合流 Merge，好评 / 差评分别渲染后取实际到达值。
  mk('wf_merge', '控制 · 分支合流 Merge', [
    N('trigger_1', 'core.trigger', 'command', { event: 'message.group', command: '/评分', groups: [] }, {}, 40, 200),
    N('cond_1', 'core.condition', 'compare', { op: 'contains', right: '/评分' }, { '/left': { kind: 'ref', nodeId: 'trigger_1', pointer: '/event/message/text' } }, 320, 200),
    N('tT', 'core.template', 'text', { template: '👍 好评收到', variables: {} }, {}, 600, 110),
    N('tF', 'core.template', 'text', { template: '已记录你的反馈', variables: {} }, {}, 600, 300),
    N('merge_1', 'core.control', 'merge', {}, { '/a': { kind: 'ref', nodeId: 'tT', pointer: '/text' }, '/b': { kind: 'ref', nodeId: 'tF', pointer: '/text' } }, 900, 200),
    N('send_1', 'qq.message', 'send_msg', { target: { kind: 'currentConversation' }, text: '' }, { '/text': { kind: 'ref', nodeId: 'merge_1', pointer: '/value' } }, 1180, 200),
  ], [
    CE('trigger_1', 'next', 'cond_1'),
    { from: { nodeId: 'cond_1', port: 'true' }, to: { nodeId: 'tT', port: 'in' } },
    CE('tT', 'next', 'merge_1'),
    { from: { nodeId: 'cond_1', port: 'false' }, to: { nodeId: 'tF', port: 'in' } },
    CE('tF', 'next', 'merge_1'),
    CE('merge_1', 'next', 'send_1'),
  ])

  // 示例：Try/Catch 错误域，body 抛错走 catch 后流程继续。
  mk('wf_try', '控制 · Try/Catch 错误域', [
    N('trigger_1', 'core.trigger', 'command', { event: 'message.group', command: '/试', groups: [] }, {}, 40, 180),
    N('try_1', 'core.control', 'tryCatch', {}, {}, 320, 180),
    N('code_1', 'core.code', 'js', { code: 'throw new Error("boom")', input: {} }, {}, 600, 90),
    N('tc', 'core.template', 'text', { template: '已捕获错误，流程继续 ✅', variables: {} }, {}, 600, 300),
    N('send_1', 'qq.message', 'send_msg', { target: { kind: 'currentConversation' }, text: '' }, { '/text': { kind: 'ref', nodeId: 'tc', pointer: '/text' } }, 940, 300),
  ], [
    CE('trigger_1', 'next', 'try_1'),
    { from: { nodeId: 'try_1', port: 'body' }, to: { nodeId: 'code_1', port: 'in' } },
    { from: { nodeId: 'try_1', port: 'catch' }, to: { nodeId: 'tc', port: 'in' } },
    CE('tc', 'next', 'send_1'),
  ])

  log(`seeded ${store.listWorkflows().length} example workflows`)
}


/**
 * seedSubgraphs(sg) — 空库时注入示例子图 sg_greet。
 * 内部节点通过 __input__ 伪节点读取公开输入；contentHash 由存储层锁定。
 */
export function seedSubgraphs(sg) {
  if (!sg || sg.list().length) return
  sg.save({
    id: 'sg_greet', name: '打招呼卡片', version: 1,
    publicInputs: [{ id: 'prefix', label: '前缀' }, { id: 'name', label: '名字' }],
    publicOutputs: [{ id: 'text', fromNodeId: 't', pointer: '/text' }],
    graph: {
      nodes: [{ id: 't', type: 'core.template', familyVersion: '1.0.0', operation: 'text', operationVersion: '1.0.0', params: { template: '{{prefix}}，{{name}}！', variables: { prefix: '', name: '' } }, bindings: { '/variables/prefix': { kind: 'ref', nodeId: '__input__', pointer: '/prefix' }, '/variables/name': { kind: 'ref', nodeId: '__input__', pointer: '/name' } }, position: { x: 60, y: 80 } }],
      controlEdges: [],
    },
  })
}
