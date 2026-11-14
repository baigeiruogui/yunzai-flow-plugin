// ============================================================================
// 文件：src/events.mjs — 事件全族规范化（§8.2）+ 事件目录（§26.2）
// 职责：把 OneBot 原始事件（post_type / message_type / notice_type …）归一为统一事件信封；
//   并维护 §26.2 的事件组/子类型覆盖清单（supported / conditional / opt-in / preserve）。
// 架构位置：位于接入层与运行时之间，触发器与运行时消费 normalizeEvent 的输出。
// 主要导出：EVENT_CATALOG（事件目录常量）、normalizeEvent(raw)（OneBot 原始事件 → 统一信封）。
// 原则：未知事件保留不丢（status: preserve，原件挂在 raw）。
// ============================================================================
import { newId, nowIso } from './lib.mjs'

// §26.2 事件组/子类型覆盖清单（状态依据官方兼容页 + 源码发射路径需实机核实）
export const EVENT_CATALOG = [
  { group: 'message', subtype: 'message.private.friend', status: 'supported' },
  { group: 'message', subtype: 'message.private.group', status: 'supported' },
  { group: 'message', subtype: 'message.group.normal', status: 'supported' },
  { group: 'message_sent', subtype: 'message_sent.private', status: 'opt-in' },
  { group: 'message_sent', subtype: 'message_sent.group', status: 'opt-in' },
  { group: 'request', subtype: 'request.friend', status: 'supported' },
  { group: 'request', subtype: 'request.group.add', status: 'supported' },
  { group: 'request', subtype: 'request.group.invite', status: 'supported' },
  { group: 'meta_event', subtype: 'meta_event.lifecycle.connect', status: 'supported' },
  { group: 'meta_event', subtype: 'meta_event.heartbeat', status: 'supported' },
  { group: 'notice', subtype: 'notice.friend_add', status: 'supported' },
  { group: 'notice', subtype: 'notice.friend_recall', status: 'supported' },
  { group: 'notice', subtype: 'notice.group_admin.set', status: 'supported' },
  { group: 'notice', subtype: 'notice.group_admin.unset', status: 'supported' },
  { group: 'notice', subtype: 'notice.group_ban.ban', status: 'supported' },
  { group: 'notice', subtype: 'notice.group_ban.lift_ban', status: 'supported' },
  { group: 'notice', subtype: 'notice.group_card', status: 'supported' },
  { group: 'notice', subtype: 'notice.group_increase.approve', status: 'supported' },
  { group: 'notice', subtype: 'notice.group_increase.invite', status: 'supported' },
  { group: 'notice', subtype: 'notice.group_decrease.leave', status: 'supported' },
  { group: 'notice', subtype: 'notice.group_decrease.kick', status: 'supported' },
  { group: 'notice', subtype: 'notice.group_decrease.kick_me', status: 'supported' },
  { group: 'notice', subtype: 'notice.group_recall', status: 'supported' },
  { group: 'notice', subtype: 'notice.group_upload', status: 'supported' },
  { group: 'notice', subtype: 'notice.group_msg_emoji_like', status: 'conditional' },
  { group: 'notice', subtype: 'notice.essence.add', status: 'conditional' },
  { group: 'notice', subtype: 'notice.essence.delete', status: 'conditional' },
  { group: 'notice', subtype: 'notice.poke', status: 'supported' },
  { group: 'notice', subtype: 'notice.input_status', status: 'supported' },
  { group: 'notice', subtype: 'notice.title', status: 'supported' },
  { group: 'notice', subtype: 'notice.profile_like', status: 'supported' },
  { group: 'notice', subtype: 'notice.gray_tip', status: 'conditional' },
  { group: 'notice', subtype: 'notice.group_name', status: 'conditional' },
  { group: 'notice', subtype: 'notice.bot_offline', status: 'conditional' },
  { group: 'online_file', subtype: 'online_file_send.receive', status: 'conditional' },
  { group: 'online_file', subtype: 'online_file_send.refuse', status: 'conditional' },
  { group: 'online_file', subtype: 'online_file_receive.cancel', status: 'conditional' },
  { group: 'unknown', subtype: 'unknown', status: 'preserve' },
]

// 从原始事件提取会话标识：优先 chat 对象，其次 group_id（群）/ user_id（私聊）。
function chatOf(raw) {
  if (raw.chat && raw.chat.type) return { type: raw.chat.type, id: raw.chat.id != null ? String(raw.chat.id) : null }
  if (raw.group_id != null) return { type: 'group', id: String(raw.group_id) }
  if (raw.user_id != null) return { type: 'private', id: String(raw.user_id) }
  return { type: null, id: null }
}
function senderOf(raw) {
  const s = raw.sender || {}
  const uid = raw.user_id != null ? raw.user_id : (s.userId != null ? s.userId : s.user_id)
  return { userId: uid != null ? String(uid) : null, nickname: s.nickname || s.card || (raw.sender && raw.sender.card) || null }
}
function textOf(raw) {
  if (raw.message && typeof raw.message === 'object' && !Array.isArray(raw.message) && typeof raw.message.text === 'string') return raw.message.text
  if (typeof raw.raw_message === 'string') return raw.raw_message
  if (Array.isArray(raw.message)) return raw.message.map((x) => (x && x.type === 'text' ? x.data?.text || '' : '')).join('')
  if (typeof raw.message === 'string') return raw.message
  return ''
}
function classify(raw) {
  const pt = raw.post_type
  if (!pt) { if (raw.message) return (raw.chat && raw.chat.type === 'private') ? 'message.private.friend' : 'message.group.normal'; return 'unknown' }
  if (pt === 'message' || pt === 'message_sent') {
    const mt = raw.message_type || (raw.group_id != null ? 'group' : 'private')
    if (pt === 'message_sent') return `${pt}.${mt}`
    if (mt === 'group') return 'message.group.normal'
    return 'message.private.' + (raw.sub_type || 'friend')
  }
  if (pt === 'request') return 'request.' + (raw.request_type || 'unknown') + (raw.sub_type ? '.' + raw.sub_type : '')
  if (pt === 'meta_event') return 'meta_event.' + (raw.meta_event_type || 'unknown') + (raw.sub_type ? '.' + raw.sub_type : '')
  if (pt === 'notice') {
    const nt = raw.notice_type || 'unknown'
    if (nt === 'group_admin') return 'notice.group_admin.' + (raw.sub_type || '')
    if (nt === 'group_ban') return 'notice.group_ban.' + (raw.sub_type || 'ban')
    if (nt === 'group_card') return 'notice.group_card'
    if (nt === 'group_increase' || nt === 'group_decrease') return `notice.${nt}.${raw.sub_type || ''}`
    if (nt === 'essence') return 'notice.essence.' + (raw.sub_type || '')
    if (nt === 'notify') return 'notice.' + (raw.sub_type || 'unknown')
    return 'notice.' + nt
  }
  return 'unknown'
}

// normalizeEvent(raw) —— 事件规范化主入口。
// 输入：OneBot 原始事件（如 { post_type:'message', message_type:'group', group_id, user_id,
//   raw_message, time, self_id … }）；也接受已是统一信封的对象（含 eventId+category+chat，则补默认值原样返回）。
// 输出：统一事件信封，含 eventId、receivedAt/sourceTime、botId、platform、category、subtype、
//   chat、sender、message({text,segments})、request、notice、raw 等；未知事件归为 unknown 并保留 raw。
export function normalizeEvent(raw = {}) {
  // Already-normalized envelope (has category + chat + eventId) → keep, fill defaults.
  if (raw.eventId && raw.category && raw.chat) {
    return { ...raw, receivedAt: raw.receivedAt || nowIso(), platform: raw.platform || 'qq' }
  }
  const subtype = classify(raw)
  const category = subtype.split('.')[0]
  const ev = {
    eventId: raw.eventId || (raw.message_id != null ? String(raw.message_id) : raw.time != null ? `t_${raw.time}_${raw.notice_type || raw.request_type || raw.post_type || 'e'}` : newId('evt')),
    receivedAt: raw.time ? new Date(Number(raw.time) * 1000).toISOString() : nowIso(),
    sourceTime: raw.time ? new Date(Number(raw.time) * 1000).toISOString() : nowIso(),
    botId: raw.self_id != null ? String(raw.self_id) : 'bot_demo',
    platform: 'qq',
    category,
    subtype,
    chat: chatOf(raw),
    sender: senderOf(raw),
    message: { text: textOf(raw), segments: Array.isArray(raw.message) ? raw.message : [] },
    request: category === 'request' ? { flag: raw.flag ?? null, comment: raw.comment ?? null, subType: raw.sub_type ?? null } : null,
    notice: category === 'notice' ? { noticeType: raw.notice_type ?? null, subType: raw.sub_type ?? null, operatorId: raw.operator_id != null ? String(raw.operator_id) : null, targetId: raw.target_id != null ? String(raw.target_id) : null, file: raw.file || null } : null,
    rawRef: raw.rawRef || null,
    origin: 'normalized',
    raw,
  }
  return ev
}
