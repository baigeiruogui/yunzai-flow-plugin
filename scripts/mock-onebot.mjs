// 本地 OneBot 11 协议服务器（开发/联调用）：实现 HTTP /{action}，状态与日志可视化。
// 用于在没有真实 NapCat 实例时验证本插件的真·直连链路（§8.3）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const state = {
  startedAt: new Date().toISOString(),
  accessToken: process.env.ONEBOT_TOKEN || '',
  calls: [],
  sent: [],
  groups: { '10086': { name: '测试群', members: ['10001', '10002'] } },
}

function ok(data, echo) { return { status: 'ok', retcode: 0, data, echo } }
function fail(message, retcode, echo) { return { status: 'failed', retcode, data: null, message, echo } }

const handlers = {
  get_login_info: () => ok({ user_id: 10000, nickname: '本地 OneBot' }),
  get_version_info: () => ok({ app_name: 'yunzai-flow-mock-onebot', app_version: '1.0.0', protocol_version: 'v11' }),
  get_status: () => ok({ online: true, good: true }),
  get_group_list: () => ok(Object.entries(state.groups).map(([id, g]) => ({ group_id: Number(id), group_name: g.name }))),
  get_group_info: (p) => (state.groups[String(p.group_id)] ? ok({ group_id: Number(p.group_id), group_name: state.groups[String(p.group_id)].name }) : fail('群不存在', 1404, p.echo)),
  get_group_member_list: (p) => ok((state.groups[String(p.group_id)]?.members || []).map((uid) => ({ group_id: Number(p.group_id), user_id: Number(uid) }))),
  send_msg: (p) => { const mid = 1000 + state.sent.length; state.sent.push({ message_id: mid, at: new Date().toISOString(), params: p }); return ok({ message_id: mid }) },
  send_group_msg: (p) => { const mid = 1000 + state.sent.length; state.sent.push({ message_id: mid, at: new Date().toISOString(), params: p }); return ok({ message_id: mid }) },
  set_group_ban: (p) => (state.groups[String(p.group_id)] ? ok(null) : fail('无权限', 102, p.echo)),
  set_group_kick: (p) => (state.groups[String(p.group_id)] ? ok(null) : fail('无权限', 102, p.echo)),
  delete_msg: () => ok(null),
  set_group_add_request: () => ok(null),
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ...state, calls: state.calls.slice(-40), sent: state.sent.slice(-20) }))
  }
  if (req.method === 'GET' && url.pathname === '/' ) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(renderPage())
  }
  if (req.method !== 'POST') { res.writeHead(405); return res.end() }
  if (state.accessToken) {
    const auth = req.headers['authorization'] || url.searchParams.get('access_token') || ''
    if (auth !== 'Bearer ' + state.accessToken && auth !== state.accessToken) { res.writeHead(401); return res.end(JSON.stringify(fail('token 无效', 1401))) }
  }
  const action = url.pathname.replace(/^\//, '')
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let parsed = {}; try { parsed = JSON.parse(body || '{}') } catch {}
    const params = { ...parsed.params, echo: parsed.echo }
    const rec = { at: new Date().toISOString(), action, params, echo: parsed.echo }
    state.calls.push(rec)
    const h = handlers[action]
    const out = h ? h(params) : fail(`未实现 action: ${action}（本 mock 仅实现常用项）`, 1404, parsed.echo)
    out.echo = parsed.echo
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(out))
  })
})

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) }
function renderPage() {
  const rows = state.calls.slice(-30).reverse().map((c) => `<tr><td>${esc(c.at.split('T')[1].slice(0, 8))}</td><td><b>${esc(c.action)}</b></td><td><code>${esc(JSON.stringify(c.params).slice(0, 120))}</code></td></tr>`).join('')
  const sent = state.sent.slice(-10).reverse().map((s) => `<li>#${s.message_id} → ${esc(JSON.stringify(s.params.message || s.params.group_id).slice(0, 90))}</li>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>本地 OneBot</title><style>
  body{background:#15171C;color:#E6E9F0;font-family:system-ui,"PingFang SC",sans-serif;margin:0;padding:24px}
  h1{font-size:18px;margin:0 0 4px}.sub{color:#8A93A6;font-size:12px;margin-bottom:18px}
  .cards{display:flex;gap:12px;margin-bottom:18px}.card{background:#242832;border:1px solid #3B4352;border-radius:10px;padding:12px 16px}
  .card .n{font-size:22px;font-weight:800;color:#7C9CFF}.card .l{font-size:11px;color:#8A93A6}
  table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #2c323e}
  th{color:#8A93A6;font-weight:500;font-size:11px}code{font-family:ui-monospace,monospace;color:#b9c1d2;font-size:11px}
  ul{font-size:12px;color:#b9c1d2}</style></head><body>
  <h1>本地 OneBot 11 协议服务器</h1>
  <div class="sub">用于验证 云崽 Flow 的直连传输（§8.3）：POST /{action} · access_token=${state.accessToken ? '已启用' : '未设置'} · 启动 ${esc(state.startedAt)}</div>
  <div class="cards"><div class="card"><div class="n">${state.calls.length}</div><div class="l">收到 action</div></div>
  <div class="card"><div class="n">${state.sent.length}</div><div class="l">发出消息</div></div>
  <div class="card"><div class="n">${Object.keys(state.groups).length}</div><div class="l">群</div></div></div>
  <h3 style="font-size:13px">最近调用</h3><table><tr><th>时间</th><th>action</th><th>params</th></tr>${rows || '<tr><td colspan=3 style="color:#6b7488">暂无</td></tr>'}</table>
  <h3 style="font-size:13px;margin-top:18px">已发送消息</h3><ul>${sent || '<li style="color:#6b7488">暂无</li>'}</ul>
  </body></html>`
}

const port = Number(process.env.ONEBOT_PORT || 5701)
server.listen(port, '0.0.0.0', () => console.log(`[mock-onebot] listening http://0.0.0.0:${port}  token=${state.accessToken || '(none)'}  actions=${Object.keys(handlers).length}+`))
export { server, state }
