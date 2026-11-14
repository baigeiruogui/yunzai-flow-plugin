// ============================================================================
// 文件：src/integrations/napcat/transport.mjs — OneBot 传输适配（§8.3/§13.6）
// 职责：实现 HTTP 与 WS 两种 OneBot 直连传输，处理 echo 关联、retcode 业务失败判定、access token 鉴权。
// 架构位置：被 NapCatAdapter 包装后注入 services.napcat；未配置 httpUrl/wsUrl 时服务端保持模拟（host-first）。
// 主要导出：OneBotHttpTransport、OneBotWsTransport、NapCatAdapter。
// ============================================================================
import crypto from 'node:crypto'

// 构造 OneBot 业务失败错误（status!=ok 或 retcode 非 0），携带 retcode 与原始响应 data。
function businessError(data) { const e = new Error(data.message || data.msg || 'OneBot 业务失败'); e.code = 'ONEBOT_BUSINESS'; e.retcode = data.retcode; e.detail = data; return e }

export class OneBotHttpTransport {
  constructor({ baseUrl, accessToken } = {}) { this.baseUrl = (baseUrl || '').replace(/\/+$/, ''); this.token = accessToken || null }
  // 调用一个 OneBot action：POST {baseUrl}/{action}，携带 access token；按 status/retcode 判定成功或抛业务错误。
  async call(action, params = {}) {
    const echo = crypto.randomUUID()
    const headers = { 'content-type': 'application/json' }
    if (this.token) headers['authorization'] = 'Bearer ' + this.token
    let res
    try { res = await fetch(`${this.baseUrl}/${action}`, { method: 'POST', headers, body: JSON.stringify({ action, params, echo }) }) }
    catch (e) { const err = new Error('OneBot 网络失败: ' + e.message); err.code = 'ONEBOT_NETWORK'; throw err }
    if (res.status !== 200) { const e = new Error('OneBot HTTP ' + res.status); e.code = 'ONEBOT_HTTP'; throw e }
    const data = await res.json().catch(() => null)
    if (!data || typeof data !== 'object') { const e = new Error('OneBot 响应不是 JSON'); e.code = 'ONEBOT_HTTP'; throw e }
    const ok = data.status === 'ok' && (data.retcode === 0 || data.retcode === undefined)
    if (!ok) throw businessError(data)
    return { retcode: data.retcode ?? 0, data: data.data, echo: data.echo, raw: data }
  }
}

export class OneBotWsTransport {
  constructor({ wsUrl, accessToken } = {}) {
    this.url = (wsUrl || '').replace(/\/+$/, '')
    if (this.url && accessToken) this.url += (this.url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(accessToken)
    this.seq = 0; this.pending = new Map(); this.ws = null; this._ready = null
  }
  async _connect() {
    if (this._ready) return this._ready
    this._ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', (e) => reject(new Error('OneBot WS 连接失败')))
      ws.addEventListener('message', (ev) => {
        let data; try { data = JSON.parse(ev.data) } catch { return }
        if (data.echo && this.pending.has(String(data.echo))) {
          const p = this.pending.get(String(data.echo)); this.pending.delete(String(data.echo))
          const ok = data.status === 'ok' && (data.retcode === 0 || data.retcode === undefined)
          ok ? p.resolve({ retcode: data.retcode ?? 0, data: data.data, echo: data.echo, raw: data }) : p.reject(businessError(data))
        }
      })
      ws.addEventListener('close', () => { this.ws = null; this._ready = null })
    })
    return this._ready
  }
  // 调用 action：先确保 WS 已连接，用自增 echo 关联响应；超时则拒绝并从 pending 清理。
  async call(action, params = {}, { timeoutMs = 10000 } = {}) {
    await this._connect()
    const echo = String(++this.seq)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); const e = new Error('OneBot WS 超时'); e.code = 'ONEBOT_TIMEOUT'; reject(e) }, timeoutMs)
      this.pending.set(echo, { resolve: (r) => { clearTimeout(timer); resolve(r) }, reject: (e) => { clearTimeout(timer); reject(e) } })
      try { this.ws.send(JSON.stringify({ action, params, echo })) } catch (e) { clearTimeout(timer); this.pending.delete(echo); reject(e) }
    })
  }
}

export class NapCatAdapter {
  constructor({ transport }) { this.transport = transport }
  async call(action, params = {}) { return this.transport.call(action, params) }
}
