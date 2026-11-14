// API 冒烟回归：正例 + 负例（404/400/422），防止接口回归。node scripts/api-smoke.mjs [baseUrl]
const BASE = (process.argv[2] || 'http://127.0.0.1:5088') + '/api/flow/v1'
let failed = 0
async function req(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  let json = null; try { json = await res.json() } catch {}
  return { status: res.status, json }
}
function check(name, cond, extra) { const ok = !!cond; console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : '  ' + JSON.stringify(extra || '')}`); if (!ok) failed++ }

const health = await req('GET', '/health'); check('health ok', health.status === 200 && health.json.ok)
const reg = await req('GET', '/registry'); check('registry families>0', reg.status === 200 && reg.json.families.length > 20)
const wfs = await req('GET', '/workflows'); check('workflows list', wfs.status === 200 && Array.isArray(wfs.json.workflows) && wfs.json.workflows.length > 0)
const wf = await req('GET', '/workflows/wf_hello'); check('get workflow', wf.status === 200 && wf.json.workflow.id === 'wf_hello')
const val = await req('POST', '/workflows/wf_hello/validate', {}); check('validate ok', val.status === 200 && val.json.ok === true)
const run = await req('POST', '/workflows/wf_hello/runs', { mode: 'simulate', event: { eventId: 'api_' + Date.now(), message: { text: '/你好' }, sender: { nickname: 'x' } } })
check('run succeeds', run.status === 200 && run.json.run && run.json.run.status === 'succeeded')
const runs = await req('GET', '/workflows/wf_hello/runs'); check('run history', runs.status === 200 && Array.isArray(runs.json.runs))
const exp = await req('GET', '/workflows/wf_hello/export'); check('export bundle', exp.status === 200 && exp.json.format === 'yf.workflow.bundle.v1' && !JSON.stringify(exp.json).includes('"value"'))
const bk = await req('GET', '/backup'); check('backup', bk.status === 200 && bk.json.format === 'yf.backup.v1')
const tools = await req('GET', '/tools'); check('tools', tools.status === 200 && Array.isArray(tools.json.tools))
const ds = await req('GET', '/datasources'); check('datasources', ds.status === 200 && ds.json.datasources.length >= 2)
const sg = await req('GET', '/subgraphs'); check('subgraphs', sg.status === 200 && Array.isArray(sg.json.subgraphs))
const cov = await req('GET', '/coverage'); check('coverage axes', cov.status === 200 && cov.json.napcat && cov.json.napcat.structuredForms === 178)
const auth = await req('GET', '/auth/status'); check('auth status', auth.status === 200 && typeof auth.json.requireAuth === 'boolean')
// 负例
const nf = await req('GET', '/workflows/does_not_exist_xyz'); check('404 unknown workflow', nf.status === 404)
const del = await req('DELETE', '/workflows/does_not_exist_xyz'); check('404 delete unknown', del.status === 404)
const badImp = await req('POST', '/workflows/import', { bundle: { nope: 1 } }); check('400 bad import', badImp.status === 400)
const badRes = await req('POST', '/restore', { backup: { nope: 1 } }); check('400 bad restore', badRes.status === 400)
const badRun = await req('POST', '/workflows/does_not_exist_xyz/runs', { mode: 'simulate' }); check('404 run unknown', badRun.status === 404)
const badTool = await req('POST', '/tools/call', { name: 'no_such_tool', arguments: {} }); check('400 unknown tool', badTool.status === 400)


// 更多负例/边界
const runNF = await req('GET', '/runs/does_not_exist_run'); check('404 unknown run', runNF.status === 404)
const expNF = await req('GET', '/workflows/does_not_exist_xyz/export'); check('404 export unknown', expNF.status === 404)
const emptyVal = await req('POST', '/workflows/wf_hello/validate', { graph: { nodes: [], controlEdges: [] } }); check('empty graph validate ok:false', emptyVal.status === 200 && emptyVal.json.ok === false)
const noToolName = await req('POST', '/tools/call', { arguments: {} }); check('400 tool missing name', noToolName.status === 400)
const idx = await fetch((process.argv[2] || 'http://127.0.0.1:5088') + '/'); check('static index 200', idx.status === 200)
const idxHead = await idx.text(); check('index has app.js', idxHead.includes('/app.js') || idxHead.includes('云崽 Flow'))

if (failed) { console.error(`API smoke: ${failed} 项失败`); process.exit(1) }
console.log('API smoke: 全部通过')
