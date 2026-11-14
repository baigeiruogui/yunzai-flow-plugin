// ============================================================================
// 文件：src/help.mjs — 节点帮助内容（§2）
// 职责：为节点操作提供统一展示文案：作用 / 何时使用 / 输入 / 参数 / 输出 / 可复现示例 / 常见错误。
// 架构位置：由 registry.toJSON 注入 op.help，供前端检查器与「节点目录」展示。
// 主要导出：HELP（按 `type/op` 索引的帮助表）、helpFor(type, op)（未覆盖时走 generic 回退）。
// ============================================================================
const H = (what, when, inputs, params, outputs, example, errors) => ({ what, when, inputs, params, outputs, example, errors })

export const HELP = {
  'core.trigger/command': H('按命令文本触发流程', '需要「/命令」响应时用；支持限定群', '事件（运行时注入）', 'command 命令文本；event 事件组；groups 允许的群', 'event 统一事件信封、matched', 'command=/你好 → 群内发送「/你好」即触发', '命令不匹配→nomatch 跳过（不是失败）；群不在范围不触发'),
  'core.trigger/event': H('按任意事件族触发（高级）', '需要处理入群申请、禁言、撤回、戳一戳等非消息事件', '事件（运行时注入）', 'eventType 点分类型，如 request.group.add / notice.group_ban.ban', 'event、matched', 'eventType=request.group.add 处理入群申请', '类型写错→nomatch；未知事件保留在 raw'),
  'core.trigger/timer': H('定时触发', '周期任务（如每日签到提醒）', '无', 'cron（5 段）、timezone', 'event（timer）', 'cron=0 8 * * * 每天 8 点', 'cron 段数不对会报错；重启补跑策略见文档'),
  'core.template/text': H('文本模板，把变量填进 {{占位符}}', '生成回复文本', 'variables 变量对象（可绑定）', 'template 文本；{{昵称}} 占位符由「插入数据」生成', 'text', 'template=你好，{{昵称}}！ + 绑定昵称=事件发送者昵称', '占位符没绑→渲染为空；模板表达力有限，复杂逻辑用代码节点'),
  'core.http/request': H('发起 HTTP 请求', '调用第三方 API', 'query/headers/body 可绑定', 'method/url/responseMode', 'status、ok、body', 'GET mock://weather → body', '非 2xx 不抛异常但 ok=false；204 空响应不按 JSON 解析'),
  'core.data/pick': H('按 JSON Pointer 取值', '从上游 JSON 提取字段', 'source 源数据（可绑定）', 'pointer 指针，如 /body/data/name', 'value、found', 'http.body + pointer=/weather → 天气', '字段不存在→found=false（不报错）；数组用索引 /list/0/name'),
  'core.condition/compare': H('条件比较，分流 true/false', '需要按条件走不同分支', 'left（可绑定）', 'op 比较符；right 比较值', 'result，控制出口 true/false', 'left=签到首次, op===, right=true → 走 true', '未选分支标 skipped 不是假成功；两分支需 Merge 合流'),
  'core.loop/forEach': H('遍历集合，每项执行一次 body', '批量处理（如给多个用户发消息）', 'items 集合（可绑定）', 'items、maxIterations', 'count、results', 'items=[张三,李四] body 内模板 {{item}} → 两次发送', '超过 maxIterations 截断；v1 禁止递归；body 内引用 loop /item'),
  'core.cache/incr': H('原子自增（签到/计数）', '需要「仅首次」语义，如每日签到', 'businessKey（可含变量）', 'businessKey 业务 key；ttlSec 过期秒', 'value 当前值、first 是否首次', '签到：incr → first=true 走成功分支', '务必用原子 incr，不要 get→set 两步；false/0 保真'),
  'core.cache/set': H('写入缓存值', '保存状态', 'value 可绑定', 'businessKey、value、ttlSec', 'ok', 'set 用户偏好 86400 秒', 'TTL 为 0 表示不失效需确认；负数拒绝'),
  'core.cache/get': H('读取缓存值', '读取之前写入的状态', '无', 'businessKey', 'found、value', 'get 签到记录', 'miss 返回 found=false，不把 false/0 当 miss'),
  'core.crypto/encrypt': H('AEAD 加密（AES-256-GCM）', '加密敏感数据，输出可安全传输', 'plaintext 明文', 'plaintext、secretRef 密钥引用、aad 附加认证', 'envelope 版本化密文信封', 'encrypt("机密") → yf.crypto.aead.v1 信封', '密钥必须 secretRef；AAD 要两端一致；篡改密文解密会失败'),
  'core.crypto/decrypt': H('AEAD 解密', '解密本插件/AEAD 信封', 'envelope 密文对象（可绑定）', 'envelope、secretRef', 'plaintext', 'decrypt(上游 encrypt 输出)', '认证失败/错 key 抛错且不泄漏明文；格式/算法须匹配'),
  'core.crypto/sign': H('Ed25519 签名', '给第三方服务签名', 'message 待签名内容', 'message、secretRef', 'signature 版本化签名', 'sign(请求体) → yf.crypto.signature.v1', '签名覆盖的字节必须与发送字节完全一致；验签用同一 key'),
  'core.render/textImage': H('文本出图', '生成图片消息', 'text 文本', 'text、width、height', 'resource 资源引用', 'text="今日天气：晴" → res_xxx.svg', '出图失败不发送空文件；资源有 TTL'),
  'core.code/js': H('运行 JS（独立子进程，故障隔离）', '可视化节点表达不了的逻辑', 'input 输入对象（可绑定）', 'code async 函数体，可 return；sdk 提供 log/uuid/base64/hash/http', 'result、logs', 'code: return {len: input.name.length}', '模拟模式禁网（CODE_NET_BLOCKED）；超时被 SIGKILL（CODE_TIMEOUT）；不是安全沙箱'),
  'core.subgraph/call': H('调用已发布子图（版本锁定）', '复用封装好的子流程', 'inputs 公开输入（可绑定）', 'subgraphId、version、contentHash', 'outputs 公开输出', 'call sg_greet@1 with {prefix,name} → {text}', 'contentHash 不匹配拒绝（版本锁）；v1 禁止递归；子图内部失败 → SUBGRAPH_INNER_FAILED'),
  'qq.message/send_msg': H('发送消息到当前会话/指定目标', '回复或主动发消息', 'text 文本可绑定', 'target 目标；message 消息段；text 文本快捷', 'message_id、receipt 回执', 'target=当前会话 + text=模板输出 → 发送', '模拟模式不真发；真实需传输已连接；重试默认 1 次避免重复发送'),
  'qq.message/send_group_msg': H('向指定群发消息', '主动向固定群推送', 'text 可绑定', 'group_id 群号；text', 'message_id', 'group_id=10086 → 发送', '群号错误会业务失败；需该账号在群内'),
  'qq.member/set_group_ban': H('群禁言', '管理群成员', 'user_id 可绑定', 'group_id、user_id、duration 秒', 'ok', 'duration=600 → 禁言 10 分钟', '需机器人为管理员（否则 retcode 失败）；duration=0 为解禁'),
  'qq.request/set_group_add_request': H('处理入群申请', '自动审批入群', 'flag 来自事件（可绑定）', 'flag、approve 通过与否、reason 理由', 'ok', 'approve=true + flag=事件 flag → 通过', '不能伪造成功；无管理权限返回错误；结果未知不无限重试'),
  'integration.datasource/call': H('调用数据源声明中的操作', '对接某个服务（声明驱动，不是裸 HTTP）', 'input 输入（可绑定）', 'pkg 包、version、op 操作、input 入参', 'result 映射后的输出', 'pkg=demo.user-profile op=getProfile uid=10001 → {name,level}', '未声明/操作不存在报错；写操作默认不导出为 AI 工具'),
}

export function helpFor(type, op) {
  const found = HELP[`${type}/${op.id}`]
  if (found) return found
  const inputs = Object.keys(op.inputSchema?.properties || {})
  const outputs = Object.keys(op.outputSchema?.properties || {})
  return H(op.title || op.id, '（见操作说明）', inputs.length ? inputs.join(', ') : '无', inputs.length ? inputs.join(', ') : '无', outputs.length ? outputs.join(', ') : '—', '', '输入校验失败 / 能力未授权 / 上游业务失败')
}
