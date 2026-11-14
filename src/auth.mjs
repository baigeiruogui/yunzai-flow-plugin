/**
 * auth.mjs — 配对认证（§20）。
 *
 * 职责：实现“一次性配对码 → Bearer 会话令牌”的认证流程，以及从请求中提取令牌的工具函数。
 * 配对码语义：单次使用（redeem 后作废）、可过期（ttlMs）、会话可撤销（revoke）。
 *
 * 在架构中的位置：被 server（API 层）在需要鉴权的路由上调用；PairingService 管理内存态
 * （codes/sessions 两个 Map），进程重启后配对码与会话全部失效。
 *
 * 主要导出：
 * - PairingService：签发配对码、兑换会话令牌、校验/撤销令牌、统计状态
 * - tokenFromRequest：从 Authorization: Bearer 或 yf_session cookie 提取会话令牌
 */
// Pairing auth (§20): one-time pairing code → bearer session token. Single-use, expiring, revocable.
import crypto from 'node:crypto'

/**
 * 构造带 code 的错误对象，便于调用方按 code 区分失败原因。
 * @param {string} code 错误码（如 PAIR_INVALID / PAIR_EXPIRED）
 * @param {string} message 中文错误信息
 * @returns {Error}
 */
function authErr(code, message) { const e = new Error(message); e.code = code; return e }

/**
 * 配对认证服务（纯内存）。
 * - 配对码：6 位数字，默认 120 秒过期，redeem 成功后立即作废（单次）。
 * - 会话令牌：24 字节 base64url，默认 30 天过期，可 revoke 撤销。
 */
export class PairingService {
  /**
   * @param {{sessionTtlMs?:number}} [opts] 会话令牌默认有效期（毫秒），默认 30 天
   */
  constructor({ sessionTtlMs = 30 * 24 * 3600 * 1000 } = {}) {
    this.codes = new Map()
    this.sessions = new Map()
    this.sessionTtlMs = sessionTtlMs
  }
  /**
   * 签发一次性配对码（6 位数字）。
   * @param {{ttlMs?:number}} [opts] 配对码有效期（毫秒），默认 120000
   * @returns {{code:string,expiresAt:number}} code=6 位数字，expiresAt=绝对过期时间戳
   */
  issueCode({ ttlMs = 120000 } = {}) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
    const rec = { code, expiresAt: Date.now() + ttlMs, used: false }
    this.codes.set(code, rec)
    return { code, expiresAt: rec.expiresAt }
  }
  /**
   * 兑换配对码 → 会话令牌。
   * 语义：配对码不存在/已使用 → PAIR_INVALID；已过期 → PAIR_EXPIRED；
   * 成功则把配对码标记 used（单次），生成新会话并返回令牌。
   * @param {string|number} code 配对码
   * @param {{sessionTtlMs?:number}} [opts] 覆盖会话默认有效期
   * @returns {{token:string,expiresAt:number}} token=base64url 会话令牌
   */
  redeem(code, { sessionTtlMs } = {}) {
    const rec = this.codes.get(String(code))
    if (!rec) throw authErr('PAIR_INVALID', '配对码无效')
    if (rec.used) throw authErr('PAIR_INVALID', '配对码已使用')
    if (Date.now() > rec.expiresAt) throw authErr('PAIR_EXPIRED', '配对码已过期')
    rec.used = true
    const token = crypto.randomBytes(24).toString('base64url')
    const ttl = sessionTtlMs ?? this.sessionTtlMs
    const s = { token, createdAt: Date.now(), expiresAt: Date.now() + ttl }
    this.sessions.set(token, s)
    return { token, expiresAt: s.expiresAt }
  }
  /**
   * 校验会话令牌：有效返回会话记录；不存在或已过期返回 null（过期会顺手从内存清除）。
   * @param {string} [token] 会话令牌
   * @returns {{token:string,createdAt:number,expiresAt:number}|null}
   */
  verify(token) {
    if (!token) return null
    const s = this.sessions.get(token)
    if (!s) return null
    if (Date.now() > s.expiresAt) { this.sessions.delete(token); return null }
    return s
  }
  /** 撤销会话令牌，返回是否真的删除了会话。 */
  revoke(token) { return this.sessions.delete(token) }
  /** 状态统计：当前有效会话数与未使用且未过期的配对码数。 */
  status() { return { activeSessions: this.sessions.size, activeCodes: [...this.codes.values()].filter((c) => !c.used && Date.now() <= c.expiresAt).length } }
}

// Extract a session token from Authorization: Bearer or a yf_session cookie.
/**
 * 从 HTTP 请求中提取会话令牌：优先 Authorization: Bearer <token>，其次 yf_session cookie（URL 解码）。
 * 都没有时返回 null。
 * @param {{headers:{authorization?:string,cookie?:string}}} req 请求对象
 * @returns {string|null} 会话令牌或 null
 */
export function tokenFromRequest(req) {
  const h = req.headers['authorization'] || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  if (m) return m[1]
  const cookie = req.headers['cookie'] || ''
  const c = cookie.match(/(?:^|;\s*)yf_session=([^;]+)/)
  return c ? decodeURIComponent(c[1]) : null
}
