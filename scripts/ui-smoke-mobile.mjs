// 移动端 UI 冒烟：用 390px iframe 验证窄屏布局（抽屉侧栏、底部检查器、顶栏不过高、无横向溢出）。
const CAMO = process.env.CAMOFOX_URL || 'http://127.0.0.1:9377'
const APP = process.argv[2] || 'http://127.0.0.1:5088/'
const uid = 'mobsmoke_' + Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function jpost(p, b) { const r = await fetch(CAMO + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return r.json() }
const open = await jpost('/tabs/open', { url: APP + '?mobsmoke=1', userId: uid })
const tabId = open.tabId
await sleep(2200)
const expr = `(async () => {
  document.querySelector('#obGo')?.click()
  const f = document.createElement('iframe'); f.id='mf'; f.src='/'
  Object.assign(f.style, { position:'fixed', left:'0', top:'0', width:'390px', height:'820px', border:'0', zIndex:'9999' })
  document.body.appendChild(f)
  await new Promise(r => setTimeout(r, 2200))
  const w = f.contentWindow, d = f.contentDocument
  const g = (s) => d.querySelector(s), cs = (s) => g(s) ? getComputedStyle(g(s)) : null
  const top = g('.topbar')
  const out = {
    mobMatch: w.matchMedia('(max-width:768px)').matches,
    topH: top ? Math.round(top.getBoundingClientRect().height) : 0,
    palettePos: cs('.palette') ? cs('.palette').position : 'MISSING',
    paletteDrawer: cs('.palette') ? cs('.palette').transform : 'MISSING',
    inspectorPos: cs('.inspector') ? cs('.inspector').position : 'MISSING',
    inspectorW: g('.inspector') ? Math.round(g('.inspector').getBoundingClientRect().width) : 0,
    mobBtn: cs('#btnPalette') ? cs('#btnPalette').display : 'MISSING',
    overflowX: d.documentElement.scrollWidth > w.innerWidth,
    nodes: d.querySelectorAll('.node').length,
  }
  f.remove(); return JSON.stringify(out)
})()`
const r = await jpost(`/tabs/${tabId}/evaluate`, { userId: uid, expression: expr })
const data = JSON.parse(r.result)
const checks = [
  ['390px 命中移动断点', data.mobMatch === true],
  ['顶栏不致过高 (<110px)', data.topH > 0 && data.topH < 110],
  ['侧栏为抽屉(absolute)', data.palettePos === 'absolute'],
  ['抽屉默认收起', data.paletteDrawer !== 'none' && data.paletteDrawer !== 'matrix(1, 0, 0, 1, 0, 0)'],
  ['检查器为底部面板', data.inspectorPos === 'absolute' && data.inspectorW >= 380],
  ['移动菜单按钮可见', data.mobBtn && data.mobBtn !== 'none'],
  ['无横向溢出', data.overflowX === false],
  ['画布有节点', data.nodes > 0],
]
let failed = 0
for (const [n, ok] of checks) { console.log(`${ok ? '✔' : '✖'} ${n}`); if (!ok) failed++ }
console.log('状态:', JSON.stringify(data))
if (failed) { console.error(`Mobile smoke: ${failed} 项失败`); process.exit(1) }
console.log('Mobile smoke: 全部通过')
