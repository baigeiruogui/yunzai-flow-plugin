// UI 冒烟回归（扩展版）：camofox 真开页面，断言更多交互，防止"小问题"回归。
// 依赖本机 camofox REST(127.0.0.1:9377)。node scripts/ui-smoke.mjs [appUrl]
const CAMO = process.env.CAMOFOX_URL || 'http://127.0.0.1:9377'
const APP = process.argv[2] || 'http://127.0.0.1:5088/'
const uid = 'smoke_' + Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function jpost(path, body) {
  const res = await fetch(CAMO + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return res.json()
}
async function evaluate(tabId, expression) {
  const r = await jpost(`/tabs/${tabId}/evaluate`, { userId: uid, expression })
  if (!r.ok) throw new Error('evaluate failed: ' + JSON.stringify(r))
  return r.result
}

const expr = `(async () => {
  const out = {}
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const disp = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display : 'MISSING' }
  window.__uiErr = null
  window.addEventListener('error', e => { window.__uiErr = 'ERR:' + e.message })
  window.addEventListener('unhandledrejection', e => { window.__uiErr = 'REJ:' + ((e.reason && e.reason.message) || e.reason) })
  out.modalInitial = disp('#modal')
  const ob = document.querySelector('#onboard')
  if (ob && getComputedStyle(ob).display !== 'none') { document.querySelector('#obGo')?.click(); await sleep(80) }
  out.onboardAfter = disp('#onboard')
  out.buttons = ['btnRun','btnNew','btnUndo','btnRedo','btnValidate','btnSave','btnPublish','btnExport','btnImport','btnBackup','btnGroup','btnCatalog','btnCoverage'].every(id => !!document.getElementById(id))
  const n0 = document.querySelectorAll('.node').length
  document.querySelector('.pal-op')?.click(); await sleep(150)
  const n1 = document.querySelectorAll('.node').length
  document.querySelector('#btnUndo')?.click(); await sleep(150)
  const n2 = document.querySelectorAll('.node').length
  document.querySelector('#btnRedo')?.click(); await sleep(150)
  const n3 = document.querySelectorAll('.node').length
  out.addUndoRedo = (n1 === n0 + 1) && (n2 === n0) && (n3 === n0 + 1)
  let spill = 0
  document.querySelectorAll('.node').forEach(node => { const nr = node.getBoundingClientRect(); node.querySelectorAll('.bd code').forEach(el => { const r = el.getBoundingClientRect(); if (r.right > nr.right + 1) spill++ }) })
  out.textNoSpill = spill === 0; out.spill = spill
  const ns = [...document.querySelectorAll('.node')]
  if (ns[0] && ns[1]) { ns[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); ns[1].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })) }
  await sleep(80)
  out.multiSelect = document.querySelectorAll('.node.sel').length
  ns[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(120)
  out.helpShown = (document.querySelector('#inspBody')?.textContent || '').includes('帮助')
  document.querySelector('#btnRun')?.click()
  for (let i = 0; i < 50; i++) { await sleep(100); const s = document.querySelector('#runStatus')?.textContent || ''; if (s && s !== '未运行' && !s.includes('中…')) break }
  out.runStatus = document.querySelector('#runStatus')?.textContent || ''
  await sleep(300)
  out.history = document.querySelectorAll('#history .hist').length
  const h = document.querySelector('#history .hist'); if (h) { h.click(); await sleep(300) }
  out.historyLoad = document.querySelector('#runStatus')?.textContent || ''
  document.querySelector('#btnImport')?.click(); await sleep(200); out.importModal = ((document.querySelector('#modalTitle')?.textContent || '').includes('导入')) && !!document.querySelector('#impBox'); document.querySelector('#modalX')?.click(); await sleep(120)
  document.querySelector('#btnCoverage')?.click(); await sleep(250); out.modalOpen = disp('#modal')
  document.querySelector('#modalX')?.click(); await sleep(120); out.modalClosed = disp('#modal')
  out.overflow = document.documentElement.scrollWidth > window.innerWidth
  out.err = window.__uiErr
  return JSON.stringify(out)
})()`

const open = await jpost('/tabs/open', { url: APP + (APP.includes('?') ? '&' : '?') + 'smoke=1', userId: uid })
const tabId = open.tabId
await sleep(2200)
let data
try { data = JSON.parse(await evaluate(tabId, expr)) } catch (e) { console.error('UI smoke ERROR:', e.message); process.exit(2) }

const checks = [
  ['遮罩默认隐藏 (modal none)', data.modalInitial === 'none'],
  ['引导可关闭 (onboard none)', data.onboardAfter === 'none'],
  ['关键按钮齐全', data.buttons === true],
  ['加节点/撤销/重做正确', data.addUndoRedo === true],
  ['节点长文本不溢出', data.textNoSpill === true],
  ['Shift 多选=2', data.multiSelect === 2],
  ['检查器显示帮助', data.helpShown === true],
  ['运行完成 (成功/已跳过)', !!data.runStatus && (data.runStatus.includes('成功') || data.runStatus.includes('已跳过'))],
  ['运行历史有记录', data.history >= 1],
  ['历史可载回', !!data.historyLoad && data.historyLoad !== '未运行'],
  ['导入弹窗可开', data.importModal === true],
  ['覆盖率弹窗可开', data.modalOpen === 'grid'],
  ['覆盖率弹窗可关', data.modalClosed === 'none'],
  ['无横向溢出', data.overflow === false],
  ['无 JS 错误', data.err == null],
]
let failed = 0
for (const [name, ok] of checks) { console.log(`${ok ? '✔' : '✖'} ${name}`); if (!ok) failed++ }
console.log('状态:', JSON.stringify(data))
if (failed) { console.error(`UI smoke: ${failed} 项失败`); process.exit(1) }
console.log('UI smoke: 全部通过')
