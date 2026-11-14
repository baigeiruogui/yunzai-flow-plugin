'use strict'
/* ============================================================================
 * 云崽 Flow — 可视化工作流编辑器（前端单文件，原生 JS，无框架/无构建）
 *
 * 【职责】
 *   把后端注册表（registry）里的"节点家族/操作"渲染成可拖拽的画布，让用户
 *   编排节点、连线、配参数、绑定上游数据，然后把 doc.graph 交给后端校验/运行，
 *   并以 SSE 实时回放每个节点状态。
 *
 * 【与后端 API 的关系】
 *   全部走 REST，前缀 /api/flow/v1（见常量 API），返回 JSON：
 *     GET  /bootstrap          宿主/Bot/传输/流程清单 + registry 版本
 *     GET  /registry           节点家族与操作的元数据（字段、端口、帮助）
 *     GET|POST|PUT|DELETE /workflows[/:id]   流程 CRUD、/validate、/publish、/export、/import
 *     POST /workflows/:id/runs          批量运行
 *     POST /workflows/:id/runs/stream   流式运行（text/event-stream）
 *     GET  /workflows/:id/runs、/runs/:runId   历史运行
 *     POST /transport、GET /catalog、GET /coverage、GET /backup
 *   前端只持有"可运行的文档"（doc graph），不直接执行节点——执行、校验、能力
 *   检查都在后端完成，前端负责编辑器体验与可视化。
 *
 * 【整体数据流】
 *   init(): bootstrap + registry
 *     → renderTabs / renderPalette / renderMeta（用 registry 搭出左侧节点库）
 *     → loadWorkflow(id)（取 workflow，重置视图/历史）
 *     → renderAll()（applyTransform + renderGroups + renderNodes + renderEdges）
 *     → 用户编辑（加节点/连线/改参数/绑定）
 *     → runFlow()（POST /runs/stream，SSE 逐帧 → handleRunEvent 点亮节点）
 *   简记：bootstrap → registry → workflow → render → run。
 * ========================================================================== */
const API = '/api/flow/v1'
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const NODE_W = 224
const HEADER_H = 40
const PORT_Y0 = 52
const PORT_GAP = 24

const state = {
  registry: null, boot: null, workflows: [],
  doc: null, view: { x: 80, y: 40, scale: 1 },
  selectedId: null, selectedIds: new Set(), clipboard: null, connecting: null, run: null, selEdge: null, _loadToken: 0,
  history: [], hIdx: -1,
  filter: '',
}

/**
 * 统一 REST 调用封装：拼 API 前缀、注入 JSON 头、解析响应。
 * 非 2xx 时抛出带 status/data 的 Error，便于上层区分 409（revision 冲突）等。
 * @param {string} path  相对 /api/flow/v1 的路径，如 '/bootstrap'
 * @param {RequestInit} [opts] fetch 选项（method/body 等）
 * @returns {Promise<any>} 解析后的 JSON
 */
async function api(path, opts = {}) {
  const res = await fetch(API + path, { headers: { 'content-type': 'application/json' }, ...opts })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.data = data; e.status = res.status; throw e }
  return data
}
// 全局错误可见化：静默失败变成 toast，避免"点了没反应却不知道为啥"
window.addEventListener('error', (e) => { try { toast('页面错误：' + (e.message || '未知'), 'err') } catch {} })
window.addEventListener('unhandledrejection', (e) => { try { toast('操作失败：' + ((e.reason && e.reason.message) || e.reason || '未知'), 'err') } catch {} })
/**
 * 顶部短暂提示（约 2.6s 自动消失）。
 * @param {string} msg  提示文案
 * @param {string} [kind] ''|'ok'|'err'，决定配色
 */
function toast(msg, kind = '') { const t = $('#toast'); t.textContent = msg; t.className = 'toast ' + kind; t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), 2600) }

/* ============================================================================
 * 一、初始化 & 流程切换
 * 启动时并行拉取 /bootstrap（宿主/传输/流程清单）与 /registry（节点家族注册表，
 * 决定左侧节点库和检查器可选字段），载入首个流程后绑定顶栏事件。
 * ========================================================================== */
async function init() {
  const [boot, reg] = await Promise.all([api('/bootstrap'), api('/registry')])
  state.boot = boot; state.registry = reg; state.workflows = boot.workflows
  renderTabs(); renderPalette(); renderMeta()
  if (state.workflows.length) await loadWorkflow(state.workflows[0].id)
  wireChrome()
}

function renderMeta() {
  const b = state.boot
  $('#meta').innerHTML = `<span class="badge">宿主 <b>${esc(b.host.adapter)}</b>${b.host.mode === 'diagnostic' ? ' (诊断)' : ''}</span><span class="badge">Bot <b>${esc(b.bot.name)}</b></span><span class="badge">registry <b>${esc(b.registryVersion)}</b></span>`
  renderTransport()
}
function renderTabs() {
  $('#wfTabs').innerHTML = state.workflows.map((w) => `<div class="wf-tab ${state.doc && state.doc.id === w.id ? 'active' : ''}" data-id="${esc(w.id)}">${esc(w.title)}<span class="tabdel" data-del="${esc(w.id)}" title="删除流程">✕</span></div>`).join('')
  $('#wfTabs').querySelectorAll('.wf-tab').forEach((el) => {
    el.onclick = (e) => { if (e.target.dataset.del) return; loadWorkflow(el.dataset.id) }
    ;(el.querySelector('.tabdel')).onclick = (e) => { e.stopPropagation(); deleteWorkflow(el.dataset.id, el.textContent) }
    el.ondblclick = (e) => { if (el.classList.contains('active')) renameWorkflow() }
  })
}
/** 删除流程（带确认弹窗）；若删的是当前流程则自动切到剩余第一个。 */
async function deleteWorkflow(id, label) {
  if (!confirm(`删除流程「${label}」？此操作不可撤销。`)) return
  try { await api('/workflows/' + id, { method: 'DELETE' }); await refreshWorkflows(); if (state.doc && state.doc.id === id) { if (state.workflows.length) await loadWorkflow(state.workflows[0].id) } toast('已删除流程') }
  catch (e) { toast('删除失败: ' + e.message, 'err') }
}
/** 重命名当前流程（用 revision 乐观锁保存，409 视为版本冲突）。 */
async function renameWorkflow() {
  if (!state.doc) return
  const t = prompt('新流程名称', state.doc.title); if (t == null || !t.trim()) return
  try { const r = await api('/workflows/' + state.doc.id, { method: 'PUT', body: JSON.stringify({ title: t.trim(), revision: state.doc.revision }) }); state.doc.title = t.trim(); state.doc.revision = r.revision; await refreshWorkflows(); renderTabs(); toast('已重命名') }
  catch (e) { toast('重命名失败: ' + (e.status === 409 ? 'revision 冲突' : e.message), 'err') }
}
function familyMap() { const m = new Map(); for (const f of state.registry.families) m.set(f.type, f); return m }
function opOf(node) { const f = familyMap().get(node.type); return f ? f.operations.find((o) => o.id === node.operation) : null }

/**
 * 拉取并切换到指定流程：重置选择/视图/历史，随后重建全部渲染。
 * 用自增的 state._loadToken 做竞态保护——快速切换时丢弃过期响应，
 * 避免旧流程的响应覆盖新流程。
 * @param {string} id 流程 id
 */
async function loadWorkflow(id) {
  const tk = ++state._loadToken
  const { workflow, validation } = await api('/workflows/' + id)
  if (tk !== state._loadToken) return // 忽略过期请求（快速切换流程时防止旧覆盖新）
  state.doc = workflow; state.selectedId = null; state.connecting = null; state.run = null
  state.view = fitView(workflow.graph.nodes)
  state.history = []; state.hIdx = -1; state.selEdge = null; state.selectedIds = new Set(); state._nodeEls = new Map(); state.dirty = false; const _nh = $('#nodes'); if (_nh) _nh.innerHTML = ''
  renderTabs(); renderAll(); clearInspector(); renderRunPanel(null); renderPaletteActive(); loadRunHistory()
  // preset event text from trigger command
  const trig = workflow.graph.nodes.find((n) => n.type === 'core.trigger' && n.operation === 'command')
  if (trig && trig.params.command) $('#evtText').value = trig.params.command
  if (validation && !validation.ok) toast('该流程有 ' + validation.errors.length + ' 个校验错误', 'err')
  pushHistory()
}

/* ============================================================================
 * 二、左侧节点库（palette）
 * 依据 registry.families 按分类折叠展示"家族 → 操作"，点击操作即在画布加节点。
 * ========================================================================== */
/**
 * 重建左侧节点库：按 category 分组列出家族与操作，支持 state.filter 搜索过滤；
 * 底部显示家族/操作总数与 registry 来源锁版本。
 */
function renderPalette() {
  const cats = new Map()
  for (const f of state.registry.families) { if (!cats.has(f.category)) cats.set(f.category, []); cats.get(f.category).push(f) }
  let html = ''
  for (const [cat, fams] of cats) {
    html += `<div class="pal-cat">${esc(cat)}</div>`
    for (const f of fams) {
      const match = !state.filter || f.title.includes(state.filter) || f.type.includes(state.filter) || f.operations.some((o) => o.title.includes(state.filter))
      if (!match) continue
      html += `<div class="pal-fam ${state.filter ? 'open' : ''}" data-type="${esc(f.type)}">
        <div class="pal-fam-head"><div class="pal-ic" style="background:${esc(f.color)}22;color:${esc(f.color)}">${f.icon || '◻'}</div>
          <div class="pal-ft">${esc(f.title)}</div><div class="pal-count">${f.operations.length}</div></div>
        <div class="pal-ops">${f.operations.map((o) => `<div class="pal-op" data-type="${esc(f.type)}" data-op="${esc(o.id)}">${esc(o.title)}</div>`).join('')}</div>
      </div>`
    }
  }
  $('#palList').innerHTML = html
  $('#palList').querySelectorAll('.pal-fam-head').forEach((h) => (h.onclick = () => h.parentElement.classList.toggle('open')))
  $('#palList').querySelectorAll('.pal-op').forEach((el) => (el.onclick = () => addNode(el.dataset.type, el.dataset.op)))
  $('#palFoot').textContent = `${state.registry.families.length} 家族 · ${state.registry.families.reduce((a, f) => a + f.operations.length, 0)} 操作 · 来源锁 ${state.boot.registryVersion}`
}
function renderPaletteActive() { $('#palList').querySelectorAll('.pal-fam').forEach((el) => {}) }

/* ============================================================================
 * 三、画布节点与连线渲染
 * 数据模型（state.doc.graph）：
 *   - nodes[]          节点，含 position 坐标（仅用于排版，不参与执行）
 *   - bindings{}       数据绑定（"数据边"的真值）：某字段 ← 上游节点输出指针
 *   - controlEdges[]   控制边（执行顺序/分支），与 bindings 分开独立存储
 * 易混点：坐标只影响画布上的视觉位置；真正的执行顺序与分支完全由 controlEdges
 *         决定，bindings 只决定数据从哪里流进来。
 * ========================================================================== */
function nodeById(id) { return state.doc.graph.nodes.find((n) => n.id === id) }
function addNode(type, opId) {
  const fam = familyMap().get(type); const op = fam.operations.find((o) => o.id === opId)
  let i = 1; while (nodeById(`${opId}_${i}`)) i++
  const cx = (-state.view.x + $('#canvasWrap').clientWidth / 2) / state.view.scale - NODE_W / 2
  const cy = (-state.view.y + $('#canvasWrap').clientHeight / 2) / state.view.scale - 40
  const node = { id: `${opId}_${i}`, type, familyVersion: fam.version, operation: opId, operationVersion: op.version, params: defaultParams(op), bindings: {}, position: { x: Math.round(cx), y: Math.round(cy) } }
  state.doc.graph.nodes.push(node)
  pushHistory()
  state.selectedId = node.id
  renderAll(); selectNode(node.id)
  toast(`已添加 ${fam.title} · ${op.title}`)
}
function defaultParams(op) {
  const p = {}
  for (const f of op.ui?.fields || []) {
    const k = f.path.replace(/^\//, '')
    if (f.type === 'number') p[k] = f.path.includes('ttl') ? 3600 : (f.path.includes('Iter') ? 1000 : 0)
    else if (f.type === 'select') p[k] = f.options?.[0] || ''
    else if (f.type === 'json') p[k] = {}
    else p[k] = ''
  }
  return p
}

function renderAll() { applyTransform(); renderGroups(); renderNodes(); renderEdges() }

function applyTransform() { $('#stage').style.transform = `translate(${state.view.x}px,${state.view.y}px) scale(${state.view.scale})`; $('#zoomLabel').textContent = Math.round(state.view.scale * 100) + '%' }

/**
 * 节点的"渲染签名"：只取影响外观的字段（类型/操作/标题/效果/参数）。
 * 参数不变则签名不变，增量渲染时据此跳过重建。
 * @param {object} n 节点
 * @returns {string}
 */
function nodeSig(n) { const op = opOf(n); return JSON.stringify([n.type, n.operation, op && op.title, op && op.effect, n.params]) }
/**
 * 由单个节点数据构建其 DOM 卡片：头部（图标/标题/效果标签）、参数摘要、
 * 输入端口与各输出端口。输出端口点击触发 startConnect，头部按下触发 startDrag。
 * @param {object} n 节点
 * @returns {HTMLElement}
 */
function buildNodeEl(n) {
  const fam = familyMap().get(n.type); const op = opOf(n)
  const el = document.createElement('div')
  el.className = 'node'
  el.dataset.id = n.id
  el.style.left = n.position.x + 'px'; el.style.top = n.position.y + 'px'
  const fields = (op?.ui?.fields || []).slice(0, 2)
  const body = fields.map((f) => {
    const k = f.path.replace(/^\//, ''); const v = n.params?.[k]
    return `<div class="kv"><span>${esc(f.label)}</span><code>${esc(v === '' || v == null ? '—' : (typeof v === 'object' ? JSON.stringify(v) : v))}</code></div>`
  }).join('')
  el.innerHTML = `
      <div class="status-dot"></div>
      <div class="hd"><div class="ic" style="background:${esc(fam.color)}22;color:${esc(fam.color)}">${esc(fam.icon || '◻')}</div>
        <div class="tt"><b>${esc(op?.title || n.operation)}</b><small>${esc(n.type)}</small></div>
        <div class="eff ${esc(op?.effect || '')}">${esc(op?.effect || '')}</div></div>
      <div class="bd">${body || `<div class="kv"><span>${esc(fam.title)}</span><code>${esc(n.operation)}</code></div>`}</div>`
  if ((op?.ports?.in || []).includes('in')) el.insertAdjacentHTML('beforeend', `<div class="handle in" data-in="${n.id}" style="top:${PORT_Y0 - 6}px"></div>`)
  ;(op?.ports?.out || []).forEach((port, idx) => {
    const h = document.createElement('div'); h.className = 'handle out'; h.dataset.out = n.id; h.dataset.port = port; h.style.top = (PORT_Y0 + idx * PORT_GAP - 6) + 'px'
    h.innerHTML = `<span class="plabel">${esc(port)}</span>`
    h.onclick = (e) => { e.stopPropagation(); startConnect(n.id, port, h) }
    el.appendChild(h)
  })
  el.querySelector('.hd').onmousedown = (e) => startDrag(e, n, el)
  el.onclick = (e) => { e.stopPropagation(); selectNode(n.id, e.shiftKey) }
  el.querySelector('.handle.in')?.addEventListener('click', (e) => { e.stopPropagation(); finishConnect(n.id) })
  return el
}
/**
 * 增量渲染节点：以 id 为键复用既有 DOM（state._nodeEls）。
 * 删除已不存在的、按 nodeSig 变更重建受影响的，其余只更新坐标/选中/运行态，
 * 避免整块 innerHTML 重绘带来的闪烁与事件丢失。
 */
function renderNodes() {
  const host = $('#nodes')
  if (!state._nodeEls) state._nodeEls = new Map()
  const nodes = state.doc.graph.nodes
  const ids = new Set(nodes.map((n) => n.id))
  for (const [id, el] of state._nodeEls) { if (!ids.has(id)) { el.remove(); state._nodeEls.delete(id) } }
  for (const n of nodes) {
    const sig = nodeSig(n)
    let el = state._nodeEls.get(n.id)
    if (!el) { el = buildNodeEl(n); el.__sig = sig; state._nodeEls.set(n.id, el); host.appendChild(el) }
    else if (el.__sig !== sig) { const fresh = buildNodeEl(n); fresh.__sig = sig; el.replaceWith(fresh); state._nodeEls.set(n.id, fresh); el = fresh }
    el.style.left = n.position.x + 'px'; el.style.top = n.position.y + 'px'
    el.classList.toggle('sel', !!(state.selectedIds && state.selectedIds.has(n.id)))
    const runNode = state.run?.nodes?.find((x) => x.nodeId === n.id)
    if (runNode) el.dataset.st = runNode.status; else if (el.dataset.st) delete el.dataset.st
  }
}

function outY(node, port) { const op = opOf(node); const i = (op?.ports?.out || []).indexOf(port); return node.position.y + PORT_Y0 + (i < 0 ? 0 : i) * PORT_GAP }
function inY(node) { return node.position.y + PORT_Y0 }

/**
 * 把所有连线绘制到 SVG：
 *   - 数据边（bindings）：灰色虚线，仅示意，不可交互；
 *   - 控制边（controlEdges）：蓝色带箭头实线，可点击选中删除；上游运行成功
 *     时变绿、被选中时变黄。
 */
function renderEdges() {
  const svg = $('#edges'); let html = ''
  const defs = `<defs><marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6" fill="none" stroke="#5FA8FF" stroke-width="1.4"/></marker></defs>`
  for (const n of state.doc.graph.nodes) {
    for (const [target, b] of Object.entries(n.bindings || {})) {
      const src = nodeById(b.nodeId); if (!src) continue
      const x1 = src.position.x + NODE_W, y1 = outY(src, opOf(src)?.ports?.out?.[0]), x2 = n.position.x, y2 = inY(n)
      html += `<path d="${bezier(x1, y1, x2, y2)}" fill="none" stroke="#5c6b86" stroke-width="1.4" stroke-dasharray="5 5" opacity=".7" style="pointer-events:none"/>`
    }
  }
  ;(state.doc.graph.controlEdges || []).forEach((e, idx) => {
    const a = nodeById(e.from.nodeId), b = nodeById(e.to.nodeId); if (!a || !b) return
    const x1 = a.position.x + NODE_W, y1 = outY(a, e.from.port), x2 = b.position.x, y2 = inY(b)
    const hot = state.run?.nodes?.find((x) => x.nodeId === e.to.nodeId)?.status === 'succeeded'
    const sel = state.selEdge && state.selEdge.index === idx
    html += `<path data-eidx="${idx}" d="${bezier(x1, y1, x2, y2)}" fill="none" stroke="${sel ? '#FFC66D' : hot ? '#4BD18A' : '#5FA8FF'}" stroke-width="${sel ? 3 : 2}" marker-end="url(#ar)" style="pointer-events:stroke;cursor:pointer"/>`
  })
  svg.innerHTML = defs + html
  svg.querySelectorAll('path[data-eidx]').forEach((p) => (p.onclick = (e) => { e.stopPropagation(); selectEdge(Number(p.dataset.eidx)) }))
}

function bezier(x1, y1, x2, y2) { const dx = Math.max(40, Math.min(150, Math.abs(x2 - x1) * 0.5)); return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}` }

/* ============================================================================
 * 四、拖拽移动、连线交互、平移缩放
 * 拖动只改 node.position（视觉坐标）；连线只写 controlEdges，二者都不触发执行。
 * ========================================================================== */
/**
 * 按住节点头部拖动：按当前缩放比换算位移，实时更新坐标与相关连线。
 * @param {MouseEvent} e
 * @param {object} n 节点
 * @param {HTMLElement} el 节点 DOM
 */
function startDrag(e, n, el) {
  if (e.button !== 0) return
  e.stopPropagation(); selectNode(n.id)
  const sx = e.clientX, sy = e.clientY, ox = n.position.x, oy = n.position.y
  const move = (ev) => { n.position.x = Math.round(ox + (ev.clientX - sx) / state.view.scale); n.position.y = Math.round(oy + (ev.clientY - sy) / state.view.scale); el.style.left = n.position.x + 'px'; el.style.top = n.position.y + 'px'; renderEdges() }
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up) }
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
}
/**
 * 点击输出端口进入"连线中"状态并高亮该端口；再次点同一端口则取消。
 * 之后点击目标节点的输入端口由 finishConnect 完成连线。
 */
function startConnect(nodeId, port, handleEl) {
  if (state.connecting && state.connecting.nodeId === nodeId && state.connecting.port === port) { state.connecting = null; document.querySelectorAll('.handle.connecting').forEach((h) => h.classList.remove('connecting')); setHint(); return }
  document.querySelectorAll('.handle.connecting').forEach((h) => h.classList.remove('connecting'))
  state.connecting = { nodeId, port }; handleEl.classList.add('connecting')
  setHint(`已选 <b>${esc(nodeId)}.${esc(port)}</b> 输出端口 → 点击目标节点的输入端口完成连线（点空白取消）`)
}
function finishConnect(toId) {
  if (!state.connecting) return
  if (state.connecting.nodeId === toId) { toast('不能连接到自身', 'err'); return }
  const exists = (state.doc.graph.controlEdges || []).some((e) => e.from.nodeId === state.connecting.nodeId && e.from.port === state.connecting.port && e.to.nodeId === toId)
  if (!exists) { state.doc.graph.controlEdges.push({ from: { nodeId: state.connecting.nodeId, port: state.connecting.port }, to: { nodeId: toId, port: 'in' } }); pushHistory() }
  state.connecting = null; document.querySelectorAll('.handle.connecting').forEach((h) => h.classList.remove('connecting'))
  setHint(); renderEdges(); toast('已连线')
}
function setHint(html) { $('#hint').innerHTML = html || '拖拽节点 · 点输出端口→点输入端口连线 · 滚轮缩放 · 拖空白平移' }

/* ============================================================================
 * 五、右侧检查器（inspector）
 * 展示选中节点的参数表单、数据绑定、最近运行输出、帮助与元数据。
 * ========================================================================== */
/**
 * 选中节点并刷新检查器。
 * @param {string} id 节点 id
 * @param {boolean} [additive] true 为 Shift 多选切换（加/减选）
 */
function selectNode(id, additive) {
  if (!state.selectedIds) state.selectedIds = new Set()
  if (additive) { if (state.selectedIds.has(id)) state.selectedIds.delete(id); else state.selectedIds.add(id) }
  else state.selectedIds = new Set([id])
  state.selectedId = state.selectedIds.has(id) ? id : (state.selectedIds.size ? [...state.selectedIds][state.selectedIds.size - 1] : null)
  document.querySelectorAll('.node').forEach((el) => el.classList.toggle('sel', state.selectedIds.has(el.dataset.id)))
  if (state.selectedId) renderInspector(); else clearInspector()
}
function clearInspector() { $('#inspEmpty').hidden = false; $('#inspBody').hidden = true }
function bindablesOf(n) {
  const t = n.type, op = n.operation, out = []
  if (t === 'core.template' && op === 'text') {
    const vars = Object.keys(n.params?.variables || {})
    const ph = [...String(n.params?.template || '').matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1])
    for (const k of new Set([...vars, ...ph])) out.push({ path: '/variables/' + k, label: '变量 ' + k })
  } else if (t === 'qq.message' && op === 'send_msg') out.push({ path: '/text', label: '文本内容' })
  else if (t === 'core.condition') out.push({ path: '/left', label: '左值' })
  else if (t === 'core.data' && op === 'pick') out.push({ path: '/source', label: '源数据' })
  else if (t === 'core.loop') out.push({ path: '/items', label: '集合 items' })
  else if (t === 'core.crypto' && op === 'decrypt') out.push({ path: '/envelope', label: '密文信封' })
  else if (t === 'core.http' && op === 'request') out.push({ path: '/body', label: '请求体' }, { path: '/url', label: 'URL' })
  else if (t.includes('.')) out.push({ path: '/params', label: '参数 params' })
  return out
}
function flattenInto(v, prefix, set, depth) {
  if (depth > 3) return
  if (v === null || typeof v !== 'object') { set.set(prefix || '/(self)', { pointer: prefix, label: prefix || '(self)', sample: String(v).slice(0, 28) }); return }
  const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v)
  for (const [k, val] of entries) { const pt = prefix + '/' + k; if (val && typeof val === 'object') flattenInto(val, pt, set, depth + 1); else set.set(pt, { pointer: pt, label: pt, sample: String(val).slice(0, 28) }) }
}
function sourceFields(src) {
  const op = opOf(src); const set = new Map()
  for (const k of Object.keys(op?.outputSchema?.properties || {})) set.set('/' + k, { pointer: '/' + k, label: k })
  const runOut = state.run?.nodes?.find((x) => x.nodeId === src.id)?.output
  if (runOut && typeof runOut === 'object') flattenInto(runOut, '', set, 0)
  return [...set.values()].filter((f) => f.pointer !== undefined).slice(0, 60)
}
function openBindPicker(node, targetPath, label) {
  const sources = state.doc.graph.nodes.filter((x) => x.id !== node.id)
  let html = ''
  for (const src of sources) {
    const op = opOf(src); const fields = sourceFields(src); if (!fields.length) continue
    html += `<div style="margin-bottom:12px"><div class="col-title" style="margin-bottom:5px">${esc(src.id)} · ${esc(op?.title || src.operation)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${fields.map((f) => `<button class="hud-btn" data-pick="${esc(src.id)}" data-ptr="${esc(f.pointer)}" title="${esc(f.pointer)}">${esc(f.label)}${f.sample ? ` <span style="color:#8A93A6">= ${esc(f.sample)}</span>` : ''}</button>`).join('')}</div></div>`
  }
  if (!html) html = '<div class="help">没有其它节点可作数据来源。先添加一个上游节点。</div>'
  showModal('为「' + label + '」选择数据来源', html)
  $('#modalBody').querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => {
    node.bindings[targetPath] = { kind: 'ref', nodeId: b.dataset.pick, pointer: b.dataset.ptr }
    $('#modal').hidden = true; renderEdges(); renderInspector(); toast('已绑定 ' + targetPath + ' ← ' + b.dataset.pick + b.dataset.ptr, 'ok')
  }))
}
function bindSectionHtml(n) {
  const bindables = bindablesOf(n)
  const known = new Set(bindables.map((b) => b.path))
  const extra = Object.keys(n.bindings || {}).filter((pt) => !known.has(pt)).map((pt) => ({ path: pt, label: pt }))
  const rows = [...bindables, ...extra].map((b) => {
    const cur = n.bindings?.[b.path]
    const src = cur ? `<code>${esc(cur.nodeId)}${esc(cur.pointer || '')}</code>` : '<span style="color:#6b7488">未绑定</span>'
    return `<div class="bind" style="justify-content:space-between"><span>${esc(b.label)}</span><span style="display:flex;gap:6px;align-items:center"><span class="arrow">←</span>${src}<button class="hud-btn" data-bindpath="${esc(b.path)}" data-bindlabel="${esc(b.label)}">${cur ? '改' : '选择'}来源</button>${cur ? `<button class="hud-btn" data-unbind="${esc(b.path)}">✕</button>` : ''}</span></div>`
  }).join('')
  return rows || '<div class="help">此节点无数据绑定口。</div>'
}
/**
 * 重绘检查器：按字段类型生成参数输入（input/textarea/select）、数据绑定区、
 * 最近一次运行输出、帮助与元数据，并绑定输入/解绑/删除等事件。
 */
function renderInspector() {
  const n = nodeById(state.selectedId); if (!n) return clearInspector()
  const fam = familyMap().get(n.type), op = opOf(n)
  const h = op?.help || {}
  $('#inspEmpty').hidden = true; const box = $('#inspBody'); box.hidden = false
  const fields = op.ui?.fields || []
  const fieldHtml = fields.map((f) => {
    const k = f.path.replace(/^\//, ''); const v = n.params?.[k] ?? ''
    const val = typeof v === 'object' ? JSON.stringify(v, null, 0) : v
    let input
    if (f.type === 'textarea' || f.type === 'code') input = `<textarea data-k="${esc(k)}" data-t="text" style="min-height:90px;font-family:var(--mono)">${esc(val)}</textarea>`
    else if (f.type === 'select') input = `<select data-k="${esc(k)}" data-t="text">${(f.options || []).map((o) => `<option ${String(o) === String(val) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
    else if (f.type === 'number') input = `<input type="number" data-k="${esc(k)}" data-t="number" value="${esc(val)}"/>`
    else if (f.type === 'json') input = `<textarea data-k="${esc(k)}" data-t="json">${esc(val === '' ? '{}' : val)}</textarea>`
    else if (f.type === 'secret') input = `<input data-k="${esc(k)}" data-t="text" value="${esc(val)}" placeholder="secretRef id"/>`
    else input = `<input data-k="${esc(k)}" data-t="text" value="${esc(val)}"/>`
    return `<div class="field"><label>${esc(f.label)}</label>${input}</div>`
  }).join('')
  const bindHtml = bindSectionHtml(n)
  const runNode = state.run?.nodes?.find((x) => x.nodeId === n.id)
  const outHtml = runNode?.output ? JSON.stringify(runNode.output, null, 2) : '（运行后显示该节点输出）'
  box.innerHTML = `
    <div class="insp-h"><div class="ic" style="background:${esc(fam.color)}22;color:${esc(fam.color)}">${fam.icon}</div>
      <div><b>${esc(op.title)}</b><br><small>${esc(n.type)} / ${esc(n.operation)}</small></div></div>
    <div class="sect"><div class="st">参数</div>${fieldHtml || '<div class="help">此节点无参数。</div>'}</div>
    <div class="sect"><div class="st">数据绑定</div>${bindHtml}</div>
    <div class="sect"><div class="st">输出（最近一次运行）</div><div class="io">${esc(outHtml)}</div></div>
    <div class="sect"><div class="st">帮助</div>
      <div class="help"><b>作用：</b>${esc(h.what || '—')}<br><b>何时用：</b>${esc(h.when || '—')}<br><b>输入：</b>${esc(h.inputs || '—')} · <b>输出：</b>${esc(h.outputs || '—')}${h.example ? `<br><b>示例：</b><code>${esc(h.example)}</code>` : ''}<br><b>常见错误：</b>${esc(h.errors || '—')}</div>
    </div>
    <div class="sect"><div class="st">元数据</div>
      <div class="cov-row"><span class="k">effect</span><span>${esc(op.effect)}</span></div>
      <div class="cov-row"><span class="k">capabilities</span><span>${esc((op.requiredCapabilities || []).join(', ') || '—')}</span></div>
      <div class="cov-row"><span class="k">ports.out</span><span>${esc((op.ports?.out || []).join(', '))}</span></div>
    </div>
    <button class="btn del" id="btnDel">删除节点</button>`
  box.querySelectorAll('[data-k]').forEach((inp) => {
    inp.oninput = () => {
      const k = inp.dataset.k, t = inp.dataset.t; let val = inp.value
      if (t === 'number') val = Number(val); else if (t === 'json') { try { val = JSON.parse(val) } catch { return } }
      n.params[k] = val; state.dirty = true; renderEdges(); renderNodes()
    }
  })
  box.querySelectorAll('[data-bindpath]').forEach((b) => (b.onclick = () => openBindPicker(n, b.dataset.bindpath, b.dataset.bindlabel)))
  box.querySelectorAll('[data-unbind]').forEach((b) => (b.onclick = () => { delete n.bindings[b.dataset.unbind]; renderEdges(); renderInspector() }))
  $('#btnDel').onclick = () => deleteNode(n.id)
  if (runNode && runNode.error) box.insertAdjacentHTML('beforeend', `<div class="sect"><div class="st" style="border-color:var(--err)">错误</div><div class="io" style="color:#ff9db0">${esc(runNode.error.code)}: ${esc(runNode.error.message)}</div></div>`)
}
function deleteNode(id) {
  state.doc.graph.nodes = state.doc.graph.nodes.filter((n) => n.id !== id)
  state.doc.graph.controlEdges = (state.doc.graph.controlEdges || []).filter((e) => e.from.nodeId !== id && e.to.nodeId !== id)
  for (const n of state.doc.graph.nodes) for (const [t, b] of Object.entries(n.bindings || {})) if (b.nodeId === id) delete n.bindings[t]
  pushHistory()
  state.selectedId = null; renderAll(); clearInspector(); toast('已删除节点')
}

function deleteSelected() {
  if (!state.selectedIds || state.selectedIds.size === 0) return
  const ids = new Set(state.selectedIds)
  state.doc.graph.nodes = state.doc.graph.nodes.filter((n) => !ids.has(n.id))
  state.doc.graph.controlEdges = (state.doc.graph.controlEdges || []).filter((e) => !ids.has(e.from.nodeId) && !ids.has(e.to.nodeId))
  for (const n of state.doc.graph.nodes) for (const [t, b] of Object.entries(n.bindings || {})) if (ids.has(b.nodeId)) delete n.bindings[t]
  pushHistory(); state.selectedIds = new Set(); state.selectedId = null; renderAll(); clearInspector(); toast('已删除 ' + ids.size + ' 个节点')
}
function copySelected() {
  if (!state.selectedIds || !state.selectedIds.size) { toast('未选中节点', 'err'); return }
  const ids = state.selectedIds
  const nodes = state.doc.graph.nodes.filter((n) => ids.has(n.id)).map((n) => JSON.parse(JSON.stringify(n)))
  const edges = (state.doc.graph.controlEdges || []).filter((e) => ids.has(e.from.nodeId) && ids.has(e.to.nodeId)).map((e) => JSON.parse(JSON.stringify(e)))
  state.clipboard = { nodes, edges }; toast('已复制 ' + nodes.length + ' 个节点')
}
function pasteClipboard() {
  if (!state.clipboard || !state.clipboard.nodes.length) { toast('剪贴板为空', 'err'); return }
  pushHistory()
  const map = new Map()
  for (const n of state.clipboard.nodes) { const cp = JSON.parse(JSON.stringify(n)); const nid = 'n_' + Math.random().toString(36).slice(2, 7); map.set(n.id, nid); cp.id = nid; cp.position = { x: n.position.x + 50, y: n.position.y + 50 }; for (const [t, b] of Object.entries(cp.bindings || {})) if (map.has(b.nodeId)) b.nodeId = map.get(b.nodeId); state.doc.graph.nodes.push(cp) }
  for (const e of state.clipboard.edges) { const cp = JSON.parse(JSON.stringify(e)); cp.from.nodeId = map.get(e.from.nodeId); cp.to.nodeId = map.get(e.to.nodeId); state.doc.graph.controlEdges.push(cp) }
  state.selectedIds = new Set(map.values()); state.selectedId = [...map.values()][0] || null
  renderAll(); if (state.selectedId) renderInspector(); toast('已粘贴 ' + map.size + ' 个节点')
}
function duplicateSelected() { copySelected(); pasteClipboard() }
function groupSelected() {
  if (!state.selectedIds || !state.selectedIds.size) { toast('先选中节点', 'err'); return }
  const ns = state.doc.graph.nodes.filter((n) => state.selectedIds.has(n.id))
  const pad = 26
  const minX = Math.min(...ns.map((n) => n.position.x)) - pad, minY = Math.min(...ns.map((n) => n.position.y)) - 34
  const maxX = Math.max(...ns.map((n) => n.position.x + NODE_W)) + pad, maxY = Math.max(...ns.map((n) => n.position.y + 140)) + pad
  state.doc.ui = state.doc.ui || { viewport: { x: 0, y: 0, zoom: 1 }, groups: [], notes: [] }
  state.doc.ui.groups = state.doc.ui.groups || []
  const g = { id: 'g_' + Math.random().toString(36).slice(2, 6), label: '分组 ' + (state.doc.ui.groups.length + 1), x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  state.doc.ui.groups.push(g); pushHistory(); renderAll(); toast('已创建 ' + g.label)
}
function renderGroups() {
  const host = $('#groups'); if (!host) return; host.innerHTML = ''
  if (!state.doc.ui) return
  for (const g of state.doc.ui.groups || []) {
    const el = document.createElement('div'); el.className = 'group-box'; el.style.cssText = `left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px`
    el.innerHTML = `<div class="group-label">${esc(g.label)}<span class="gdel" data-gid="${g.id}" title="删除分组">✕</span></div>`
    el.querySelector('.gdel').onclick = (e) => { e.stopPropagation(); state.doc.ui.groups = state.doc.ui.groups.filter((x) => x.id !== g.id); pushHistory(); renderAll(); toast('已删除分组') }
    host.appendChild(el)
  }
}

/* ============================================================================
 * 六、运行（SSE 流式）
 * 发送测试事件 → 后端 POST /workflows/:id/runs/stream 以 text/event-stream
 * 逐帧推进。SSE 帧格式：每帧 "data: {json}\n\n"（服务端另带 id/event 行），
 * 前端只取以 "data:" 开头的那行解析 JSON。事件 type 依次可能是：
 *   run.start | node.start | node.ok | node.fail | loop.iteration | run.end | done，
 * 最后一帧 done 携带完整 run（前端据此定稿面板与历史）。
 * 若流式不可用，回退到普通 POST /runs，再用 animateRun 逐节点回放。
 * ========================================================================== */
/**
 * 运行当前流程：组装一条测试事件，消费 SSE 流实时点亮节点/轨迹/日志，
 * 结束后渲染运行面板与历史。流式失败时回退到批量运行 + 动画回放。
 */
async function runFlow() {
  if (!state.doc) return
  const mode = $('#modeSel').value
  const text = $('#evtText').value, nick = $('#evtNick').value
  const event = { eventId: 'ui_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), chat: { type: 'group', id: 'group_10086' }, sender: { userId: '10001', nickname: nick }, message: { text } }
  setRunStatus('running', '实时运行中…')
  state.run = { nodes: [] }; $('#trace').innerHTML = ''; $('#logs').innerHTML = ''
  try {
    const res = await fetch(API + `/workflows/${state.doc.id}/runs/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, event }) })
    if (!res.ok || !res.body) throw new Error('stream ' + res.status)
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let finalRun = null
    while (true) {
      const { value, done } = await reader.read(); if (done) break
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2)
        const line = chunk.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        let ev; try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
        handleRunEvent(ev)
        if (ev.type === 'done') finalRun = ev.run
      }
    }
    if (finalRun) {
      state.run = finalRun; renderRunPanel(finalRun); renderEdges()
      setRunStatus(finalRun.status, statusText(finalRun))
      if (finalRun.status === 'succeeded') toast('运行成功 · ' + (finalRun.receipts?.length || 0) + ' 条发送回执', 'ok')
      else if (finalRun.status === 'skipped') toast('已跳过（未匹配 / 去重）', '')
      else toast('运行失败，查看节点轨迹', 'err')
      renderInspector(); loadRunHistory()
    }
  } catch (e) {
    try { const { run } = await api(`/workflows/${state.doc.id}/runs`, { method: 'POST', body: JSON.stringify({ mode, event }) }); await animateRun(run) }
    catch (e2) { setRunStatus('failed', '失败: ' + e2.message); toast('运行失败: ' + e2.message, 'err') }
  }
}
/**
 * 处理一条 SSE 运行事件：节点开始/成功/失败更新节点状态灯与轨迹，
 * 循环迭代与结束则追加到日志。
 * @param {{type:string, nodeId?:string}} ev
 */
function handleRunEvent(ev) {
  if (ev.type === 'node.start') { markNode(ev.nodeId, 'running'); upsertTrace(ev.nodeId, { status: 'running' }) }
  else if (ev.type === 'node.ok') { markNode(ev.nodeId, 'succeeded', true); upsertTrace(ev.nodeId, { status: 'succeeded', ms: ev.ms, output: ev.output }) }
  else if (ev.type === 'node.fail') { markNode(ev.nodeId, 'failed'); upsertTrace(ev.nodeId, { status: 'failed', error: ev.error }) }
  else if (ev.type === 'loop.iteration') appendLog('info', `循环 ${ev.nodeId} 第 ${ev.index} 次 → ${JSON.stringify(ev.item)}`)
  else if (ev.type === 'run.end') appendLog('info', `运行结束: ${ev.status} · ${ev.ms}ms`)
}
function markNode(id, st, flash) { const el = document.querySelector(`.node[data-id="${id}"]`); if (!el) return; el.dataset.st = st; if (flash) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 500) } }
function upsertTrace(nodeId, patch) {
  if (!state.run) state.run = { nodes: [] }
  let nr = state.run.nodes.find((x) => x.nodeId === nodeId)
  if (!nr) { const nd = nodeById(nodeId); nr = { nodeId, type: nd?.type, operation: nd?.operation, status: 'idle', ms: 0 }; state.run.nodes.push(nr) }
  Object.assign(nr, patch); renderTraceLive()
}
function renderTraceLive() {
  const host = $('#trace'); if (!host) return
  host.innerHTML = (state.run?.nodes || []).map((nr) => `<div class="tr" data-s="${esc(nr.status)}"><span class="st"></span><b>${esc(nr.nodeId)}</b><code>${esc(nr.type || '')}</code>${nr.error ? `<code style="color:#ff9db0">${esc(nr.error.code)}</code>` : ''}<span class="ms">${nr.ms != null ? nr.ms + 'ms' : ''} · ${esc(nr.status)}</span></div>`).join('')
}
function appendLog(level, msg) { const t = document.querySelector('#logs'); t.insertAdjacentHTML('beforeend', `<div class="log-line ${level}"><span class="t"></span>${esc(msg)}</div>`) }
async function animateRun(run) {
  state.run = { nodes: [] }; renderRunPanel(run)
  for (const nr of run.nodes) {
    state.run.nodes.push(nr)
    const el = document.querySelector(`.node[data-id="${nr.nodeId}"]`)
    if (el) { el.dataset.st = nr.status; if (nr.status === 'succeeded') { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 500) } }
    renderTraceIncremental(run)
    await sleep(140)
  }
  state.run = run
  renderTraceIncremental(run)
  renderEdges()
  renderRunPanel(run)
  setRunStatus(run.status, statusText(run))
  if (run.status === 'succeeded') toast('运行成功 · ' + (run.receipts?.length || 0) + ' 条发送回执', 'ok')
  else if (run.status === 'skipped') toast('已跳过（未匹配 / 去重）', '')
  else toast('运行失败，查看节点轨迹', 'err')
  renderInspector()
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function statusText(run) { return run.deduped ? '已去重' : run.status === 'succeeded' ? `成功 · ${run.ms}ms` : run.status === 'skipped' ? '已跳过' : '失败' }
function setRunStatus(cls, txt) { const el = $('#runStatus'); el.className = 'run-status ' + cls; el.textContent = txt }

/**
 * 渲染底部运行面板：节点轨迹 + 日志/回执/副作用；run 为 null 时清空为初始态。
 * @param {object|null} run
 */
function renderRunPanel(run) {
  if (!run) { $('#trace').innerHTML = '<div class="help">点击右上角“运行”执行流程。</div>'; $('#logs').innerHTML = ''; setRunStatus('', '未运行'); return }
  renderTraceIncremental(run)
  const logs = (run.logs || []).map((l) => `<div class="log-line ${l.level === 'error' ? 'error' : l.level === 'warn' ? 'warn' : 'info'}"><span class="t">${esc((l.at || '').split('T')[1]?.slice(0, 8) || '')}</span>${esc(l.msg)}</div>`).join('')
  const receipts = (run.receipts || []).map((r) => `<div class="log-line ok">📨 回执 ${esc(r.message_id)} → ${esc(r.target?.type || '')}:${esc(r.target?.id || '')} ${esc(JSON.stringify(r.message || ''))}</div>`).join('')
  const effects = (run.effects || []).map((e) => `<div class="log-line info">⚙ ${esc(e.kind)} ${e.simulated ? '(模拟拦截)' : ''} ${esc(e.effectState || '')}</div>`).join('')
  $('#logs').innerHTML = logs + (receipts ? `<div style="margin-top:6px">${receipts}</div>` : '') + (effects ? `<div style="margin-top:6px">${effects}</div>` : '') || '<div class="help">无日志</div>'
}
function renderTraceIncremental(run) {
  const nodes = state.run?.nodes || run.nodes || []
  $('#trace').innerHTML = (run.nodes || []).map((nr) => {
    const cur = nodes.find((x) => x.nodeId === nr.nodeId) || nr
    return `<div class="tr" data-s="${esc(cur.status)}"><span class="st"></span><b>${esc(nr.nodeId)}</b><code>${esc(nr.type)}</code>${cur.error ? `<code style="color:#ff9db0">${esc(cur.error.code)}</code>` : ''}<span class="ms">${cur.ms != null ? cur.ms + 'ms' : ''} · ${esc(cur.status)}</span></div>`
  }).join('')
}

/* ============================================================================
 * 七、顶栏/画布事件绑定（chrome）
 * 工具栏按钮、快捷键（撤销/重做/复制/粘贴/删除）、画布平移/缩放/框选、弹窗关闭。
 * ========================================================================== */
/** 绑定全部工具栏按钮、快捷键与画布平移缩放框选事件。 */
function wireChrome() {
  $('#btnPalette') && ($('#btnPalette').onclick = () => document.querySelector('.palette').classList.toggle('open'))
  window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = '有未保存的改动，确定离开？' } })
  $('#btnRun').onclick = runFlow
  $('#btnCoverage').onclick = showCoverage
  $('#btnCatalog').onclick = showCatalog
  $('#btnGroup').onclick = groupSelected
  $('#obX').onclick = dismissOnboard
  $('#obGo').onclick = dismissOnboard
  $('#tpBadge').onclick = configureTransport
  $('#tpBadge').style.cursor = 'pointer'
  $('#btnExport').onclick = exportCurrent
  $('#btnImport').onclick = openImport
  $('#btnBackup').onclick = downloadBackup
  $('#btnSave').onclick = saveWorkflow
  $('#btnNew').onclick = newWorkflow
  $('#btnUndo').onclick = undo
  $('#btnRedo').onclick = redo
  $('#btnValidate').onclick = validateWorkflow
  $('#btnPublish').onclick = publishWorkflow
  $('#search').oninput = (e) => { state.filter = e.target.value.trim(); renderPalette() }
  $('#chev').onclick = () => { $('#runpanel').classList.toggle('collapsed'); $('#chev').textContent = $('#runpanel').classList.contains('collapsed') ? '▾' : '▴' }
  $('#runHead').onclick = (e) => { if (e.target.id === 'runHead' || e.target.classList.contains('run-title')) { $('#runpanel').classList.toggle('collapsed'); $('#chev').textContent = $('#runpanel').classList.contains('collapsed') ? '▾' : '▴' } }
  document.addEventListener('keydown', (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase()
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return }
    if (mod && k === 'y') { e.preventDefault(); redo(); return }
    if (mod && k === 'd') { e.preventDefault(); duplicateSelected(); return }
    if (mod && k === 'c') { e.preventDefault(); copySelected(); return }
    if (mod && k === 'v') { e.preventDefault(); pasteClipboard(); return }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (state.selEdge) deleteEdge(); else deleteSelected() }
  })
  // pan + zoom
  const wrap = $('#canvasWrap')
  wrap.addEventListener('mousedown', (e) => {
    if (e.target.closest('.node') || e.target.closest('.canvas-hud') || e.target.closest('#edges') || e.target.closest('.group-box')) return
    state.connecting = null; document.querySelectorAll('.handle.connecting').forEach((h) => h.classList.remove('connecting')); setHint()
    const sx = e.clientX, sy = e.clientY
    if (e.shiftKey) {
      const rect = document.createElement('div'); rect.className = 'marquee'; document.body.appendChild(rect)
      const move = (ev) => { const x = Math.min(sx, ev.clientX), y = Math.min(sy, ev.clientY), w = Math.abs(ev.clientX - sx), h = Math.abs(ev.clientY - sy); Object.assign(rect.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' }) }
      const up = () => {
        document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
        const box = rect.getBoundingClientRect(); rect.remove()
        const ids = new Set()
        document.querySelectorAll('.node').forEach((el) => { const r = el.getBoundingClientRect(); if (r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top) ids.add(el.dataset.id) })
        state.selectedIds = ids; state.selectedId = ids.size ? [...ids][0] : null
        document.querySelectorAll('.node').forEach((el) => el.classList.toggle('sel', ids.has(el.dataset.id)))
        if (state.selectedId) renderInspector(); else clearInspector(); toast('框选 ' + ids.size + ' 个节点')
      }
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); return
    }
    const ox = state.view.x, oy = state.view.y
    const mv = (ev) => { state.view.x = ox + (ev.clientX - sx); state.view.y = oy + (ev.clientY - sy); applyTransform() }
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up)
  })
  wrap.addEventListener('wheel', (e) => { e.preventDefault(); const rect = wrap.getBoundingClientRect(); const mx = e.clientX - rect.left, my = e.clientY - rect.top; const old = state.view.scale; const ns = Math.max(0.35, Math.min(1.8, old * (e.deltaY < 0 ? 1.1 : 0.9))); state.view.x = mx - (mx - state.view.x) * (ns / old); state.view.y = my - (my - state.view.y) * (ns / old); state.view.scale = ns; applyTransform() }, { passive: false })
  $('#zoomIn').onclick = () => { state.view.scale = Math.min(1.8, state.view.scale * 1.15); applyTransform() }
  $('#zoomOut').onclick = () => { state.view.scale = Math.max(0.35, state.view.scale * 0.87); applyTransform() }
  $('#fitView').onclick = () => { state.view = fitView(state.doc.graph.nodes); applyTransform() }
  $('#modalX').onclick = () => ($('#modal').hidden = true)
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').hidden = true }
}
function fitView(nodes) {
  if (!nodes || !nodes.length) return { x: 80, y: 40, scale: 1 }
  const minX = Math.min(...nodes.map((n) => n.position.x)), minY = Math.min(...nodes.map((n) => n.position.y))
  const maxX = Math.max(...nodes.map((n) => n.position.x + NODE_W)), maxY = Math.max(...nodes.map((n) => n.position.y + 140))
  const wrap = $('#canvasWrap'); const W = wrap?.clientWidth || 900, H = wrap?.clientHeight || 500
  const pad = 70; const scale = Math.max(0.4, Math.min(1, Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxY - minY))))
  return { x: pad - minX * scale, y: pad - minY * scale + 6, scale }
}
async function saveWorkflow() {
  try {
    const payload = { graph: state.doc.graph, title: state.doc.title, revision: state.doc.revision }
    const res = await api('/workflows/' + state.doc.id, { method: 'PUT', body: JSON.stringify(payload) })
    state.doc.revision = res.revision; state.dirty = false; toast('草稿已保存 · revision ' + res.revision, 'ok')
  } catch (e) { toast(e.status === 409 ? '保存冲突：revision 已变，请刷新' : '保存失败: ' + e.message, 'err') }
}
async function validateWorkflow() {
  try { const r = await api('/workflows/' + state.doc.id + '/validate', { method: 'POST', body: JSON.stringify({ graph: state.doc.graph }) })
    if (r.ok) toast(`校验通过 · ${r.plan.nodeCount} 节点 / ${r.plan.edgeCount} 控制边 · caps ${r.plan.capabilities.length}`, 'ok')
    else { toast(`${r.errors.length} 个错误: ` + r.errors[0].message, 'err'); showModal('校验错误', `<pre class="io">${esc(JSON.stringify(r.errors, null, 2))}</pre>`) }
  } catch (e) { toast('校验失败: ' + e.message, 'err') }
}
async function publishWorkflow() {
  try { const r = await api('/workflows/' + state.doc.id + '/publish', { method: 'POST', body: JSON.stringify({}) })
    state.doc.workflowVersion = r.workflowVersion; toast(`已发布 v${r.workflowVersion} · 不可变快照`, 'ok'); renderTabs()
  } catch (e) { toast(e.status === 422 ? '校验未通过，无法发布' : '发布失败: ' + e.message, 'err') }
}
function showModal(title, html) { $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html; $('#modal').hidden = false }
async function showCoverage() {
  const c = await api('/coverage')
  const m = c.mvp, n = c.napcat
  showModal('覆盖率报告（分轴统计）', `
    <div class="cov-grid">
      <div class="cov-card"><div class="n">${m.families}</div><div class="l">已实现家族</div></div>
      <div class="cov-card"><div class="n">${m.operations}</div><div class="l">已实现操作</div></div>
      <div class="cov-card"><div class="n">${n.baseOps}</div><div class="l">NapCat 基础操作 (路线图)</div></div>
    </div>
    <div class="sect"><div class="st">MVP（可运行·有测试）</div>
      <div class="cov-row"><span class="k">effects 分布</span><span>${esc(JSON.stringify(m.effects))}</span></div>
      <div class="cov-row"><span class="k">说明</span><span>${esc(m.note)}</span></div></div>
    <div class="sect"><div class="st">NapCat 覆盖（分轴，不混算）</div>
      <div class="cov-row"><span class="k">版本</span><span>${esc(n.version)}</span></div>
      <div class="cov-row"><span class="k">基础操作</span><span>${n.baseOps}</span></div>
      <div class="cov-row"><span class="k">已映射(元数据)</span><span>${n.mappedStructured} / ${n.baseOps}</span></div>
      <div class="cov-row"><span class="k">结构化表单 / 通用表单</span><span>${n.structuredForms} / ${n.genericForms}</span></div>
      <div class="cov-row"><span class="k">契约（结构/可执行/行为）</span><span>${n.contractStructural || 0} / ${n.contractExecutable || 0} / ${n.contractTested}（${esc((n.contractList || []).join(', '))}）</span></div>
      <div class="cov-row"><span class="k">实机验证</span><span>${n.liveVerified}（需真实 NapCat 连接）</span></div>
      <div class="cov-row"><span class="k">说明</span><span>${esc(n.note)}</span></div></div>
    <div class="sect"><div class="st">事件 / 消息段</div>
      <div class="cov-row"><span class="k">事件</span><span>${esc(c.events.implemented.join(', '))}</span></div>
      <div class="cov-row"><span class="k">消息段</span><span>${esc(c.segments.implemented.join(', '))}</span></div></div>
    <div class="help" style="margin-top:10px">⚠ ${esc(c.caveat)}</div>`)
}

init().catch((e) => { console.error(e); toast('初始化失败: ' + e.message, 'err') })
window.showCoverage = showCoverage


/* ============================================================================
 * 八、导入 / 导出 / 备份（§18.4）
 * ========================================================================== */
/** 触发浏览器下载一个 JSON 文件。 */
function downloadJson(obj, name) { const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 100) }
async function refreshWorkflows() { try { const { workflows } = await api('/workflows'); state.workflows = workflows; renderTabs() } catch (e) {} }
/** 导出当前流程包（不含凭据正文）并下载为 <id>.bundle.json。 */
async function exportCurrent() { try { const b = await api(`/workflows/${state.doc.id}/export`); downloadJson(b, `${state.doc.id}.bundle.json`); toast('已导出（不含凭据正文）', 'ok') } catch (e) { toast('导出失败: ' + e.message, 'err') } }
async function downloadBackup() { try { const b = await api('/backup'); downloadJson(b, `yf-backup-${Date.now()}.json`); toast('已下载全量备份（恢复后全部停用）', 'ok') } catch (e) { toast('备份失败: ' + e.message, 'err') } }
/** 打开"导入流程包"弹窗：解析粘贴的 bundle JSON，POST /workflows/import（默认停用）。 */
function openImport() {
  showModal('导入流程包', `<div class="field"><label>粘贴 bundle JSON（导出得到的 yf.workflow.bundle.v1）</label><textarea id="impBox" style="min-height:170px;font-family:var(--mono)" placeholder='{"format":"yf.workflow.bundle.v1", ...}'></textarea></div><button class="btn primary" id="impGo">导入（默认停用）</button>`)
  $('#impGo').onclick = async () => {
    try {
      const bundle = JSON.parse($('#impBox').value)
      const r = await api('/workflows/import', { method: 'POST', body: JSON.stringify({ bundle }) })
      $('#modal').hidden = true; await refreshWorkflows(); await loadWorkflow(r.workflowId)
      toast('已导入（停用）: ' + r.workflowId, 'ok')
    } catch (e) { toast('导入失败: ' + (e.data?.error || e.message), 'err') }
  }
}


/* ============================================================================
 * 九、传输切换（§8.3）：模拟 ↔ 直连 OneBot 11
 * ========================================================================== */
/** 依据 boot.transport 刷新顶栏传输徽标（模拟/真实 + 连接地址）。 */
function renderTransport() {
  const t = state.boot?.transport || { mode: 'simulated' }
  const badge = $('#tpBadge'); if (!badge) return
  const live = t.mode !== 'simulated'
  badge.innerHTML = live ? `🟢 OneBot · ${esc(t.mode.replace('direct-onebot-', ''))}` : '⚪ 模拟传输'
  badge.style.color = live ? '#8ff0b8' : ''
  badge.style.borderColor = live ? '#2f5a44' : ''
  badge.title = live ? (t.httpUrl || t.wsUrl || '') : '未连接真实 OneBot（点击「传输」配置）'
}
/**
 * 打开"传输连接"弹窗：填写 OneBot HTTP/WS 地址与 Access Token，
 * "连接并探测"或"回到模拟"；成功后刷新顶栏传输徽标。
 */
async function configureTransport() {
  const t = state.boot?.transport || {}
  showModal('传输连接 (§8.3)', `
    <div class="help" style="margin-bottom:12px">直连 OneBot 11 HTTP（NapCat/OneBot 标准）。留空并保存 = 回到模拟传输。连接成功后「运行」的真实模式会真正发出 action。</div>
    <div class="field"><label>HTTP 地址（如 http://127.0.0.1:5701）</label><input id="tpHttp" value="${esc(t.httpUrl || '')}" placeholder="http://127.0.0.1:5701"/></div>
    <div class="field"><label>WS 地址（可选，ws://…）</label><input id="tpWs" value="${esc(t.wsUrl || '')}" placeholder="ws://127.0.0.1:5700"/></div>
    <div class="field"><label>Access Token（可选）</label><input id="tpTok" type="password" placeholder="留空表示无 token"/></div>
    <div style="display:flex;gap:8px"><button class="btn primary" id="tpConnect">连接并探测</button><button class="btn" id="tpSim">回到模拟</button></div>`)
  $('#tpConnect').onclick = async () => {
    const httpUrl = $('#tpHttp').value.trim(), wsUrl = $('#tpWs').value.trim(), accessToken = $('#tpTok').value.trim()
    try {
      const r = await api('/transport', { method: 'POST', body: JSON.stringify({ httpUrl, wsUrl, accessToken }) })
      state.boot.transport = r.transport; renderTransport(); $('#modal').hidden = true
      toast('已连接 OneBot · ' + (r.transport.login?.nickname || r.transport.mode), 'ok')
    } catch (e) { toast('连接失败: ' + (e.data?.message || e.message), 'err') }
  }
  $('#tpSim').onclick = async () => {
    try { const r = await api('/transport', { method: 'POST', body: JSON.stringify({ mode: 'simulated' }) }); state.boot.transport = r.transport; renderTransport(); $('#modal').hidden = true; toast('已回到模拟传输') } catch (e) { toast('失败: ' + e.message, 'err') }
  }
}


/* ============================================================================
 * 十、节点目录 / 帮助（§2/§4.3）与首次引导
 * ========================================================================== */
/** 拉取 /catalog 并以弹窗展示所有家族/操作（含"结构化/通用表单"标记）。 */
async function showCatalog() {
  try {
    const cat = await api('/catalog')
    const fams = cat.families.map((f) => {
      const ops = f.operations.map((o) => `<div class="cat-op"><b>${esc(o.title)}</b> <span class="w">${esc(o.help?.what || '')}</span><span class="tag ${o.meta?.genericForm ? 'gn' : 'st'}">${o.meta?.genericForm ? '通用表单' : '结构化'}</span> <code style="color:#8A93A6">${esc(f.type)}/${esc(o.id)}</code></div>`).join('')
      return `<div class="cat-fam"><div class="cat-fam-h"><span>${f.icon || '◻'}</span>${esc(f.title)} <span class="n">${f.operations.length}</span></div><div class="cat-ops">${ops}</div></div>`
    }).join('')
    showModal(`节点目录 · ${cat.families.length} 家族 / ${cat.families.reduce((a, f) => a + f.operations.length, 0)} 操作`, `<div class="cat-list">${fams}</div>`)
    $('#modalBody').querySelectorAll('.cat-fam-h').forEach((h) => (h.onclick = () => h.parentElement.classList.toggle('open')))
  } catch (e) { toast('加载目录失败: ' + e.message, 'err') }
}
function maybeOnboard() {
  try { if (!localStorage.getItem('yf_onboarded')) { $('#onboard').hidden = false } } catch { $('#onboard').hidden = false }
}
function dismissOnboard() { $('#onboard').hidden = true; try { localStorage.setItem('yf_onboarded', '1') } catch {} }
setTimeout(maybeOnboard, 400)


/* ============================================================================
 * 十一、撤销/重做（快照栈）、连线删除、复制、新建（§3.2/§19）
 * 历史快照只序列化 nodes + controlEdges，上限 60 步；
 * 参数修改不入栈（renderInspector 里只标 dirty，不 pushHistory）。
 * ========================================================================== */
/**
 * 记录一步历史快照：序列化 nodes+controlEdges 入栈；与栈顶相同则跳过
 * （避免无效步），并截断 redo 分支；超 60 步丢掉最旧快照。
 */
function pushHistory() {
  if (!state.doc) return
  state.dirty = true
  const snap = JSON.stringify({ nodes: state.doc.graph.nodes, controlEdges: state.doc.graph.controlEdges })
  if (state.hIdx >= 0 && state.history[state.hIdx] === snap) return
  state.history = state.history.slice(0, state.hIdx + 1)
  state.history.push(snap)
  if (state.history.length > 60) state.history.shift()
  state.hIdx = state.history.length - 1
}
function applyHistory() {
  const snap = state.history[state.hIdx]; if (!snap) return
  const g = JSON.parse(snap)
  state.doc.graph.nodes = g.nodes; state.doc.graph.controlEdges = g.controlEdges
  state.selectedId = null; state.selEdge = null
  renderAll(); clearInspector()
}
/** 撤销一步：回到上一快照并重绘。 */
function undo() { if (state.hIdx > 0) { state.hIdx--; applyHistory(); toast('已撤销') } }
/** 重做一步：前进到下一快照并重绘。 */
function redo() { if (state.hIdx < state.history.length - 1) { state.hIdx++; applyHistory(); toast('已重做') } }
function selectEdge(idx) { state.selEdge = { index: idx }; state.selectedId = null; document.querySelectorAll('.node').forEach((el) => el.classList.remove('sel')); clearInspector(); renderEdges(); setHint('已选中连线，按 Delete 删除（点空白取消）') }
function deleteEdge() { if (!state.selEdge) return; state.doc.graph.controlEdges.splice(state.selEdge.index, 1); state.selEdge = null; pushHistory(); renderEdges(); setHint(); toast('已删除连线') }
function duplicateNode(id) {
  const n = nodeById(id); if (!n) return
  let base = n.id.replace(/_\d+$/, ''); let i = 1; while (nodeById(`${base}_${i}`)) i++
  const cp = JSON.parse(JSON.stringify(n)); cp.id = `${base}_${i}`; cp.position = { x: n.position.x + 40, y: n.position.y + 40 }
  state.doc.graph.nodes.push(cp); pushHistory(); state.selectedId = cp.id; renderAll(); selectNode(cp.id); toast('已复制节点 ' + cp.id)
}
/** 新建空白流程并切换过去。 */
async function newWorkflow() {
  try { const r = await api('/workflows', { method: 'POST', body: JSON.stringify({ title: '未命名流程' }) }); await refreshWorkflows(); await loadWorkflow(r.workflow.id); toast('已新建流程') }
  catch (e) { toast('新建失败: ' + e.message, 'err') }
}


/* ============================================================================
 * 十二、运行历史（§3.1）
 * ========================================================================== */
/** 拉取当前流程的历史运行列表并渲染；点击某条则 openRun 回放。 */
async function loadRunHistory() {
  const host = $('#history'); if (!host || !state.doc) return
  try {
    const { runs } = await api(`/workflows/${state.doc.id}/runs`)
    if (!runs.length) { host.innerHTML = '<div class="help">暂无历史运行</div>'; return }
    host.innerHTML = runs.map((r) => `<div class="hist" data-s="${esc(r.status)}" data-run="${esc(r.runId)}"><span class="dot"></span><b>${esc(r.status)}</b><span style="color:#8A93A6">${esc(r.mode)}</span><span class="t">${esc((r.startedAt || '').replace('T', ' ').slice(5, 19))}</span></div>`).join('')
    host.querySelectorAll('.hist').forEach((el) => (el.onclick = () => openRun(el.dataset.run)))
  } catch (e) { host.innerHTML = '<div class="help">历史加载失败</div>' }
}
/** 载入某次历史运行：回填各节点状态灯、连线高亮、运行面板与状态文案。 */
async function openRun(runId) {
  try {
    const { run } = await api('/runs/' + runId)
    state.run = run
    document.querySelectorAll('.node').forEach((el) => { const nr = run.nodes.find((x) => x.nodeId === el.dataset.id); el.dataset.st = nr ? nr.status : '' })
    renderEdges(); renderRunPanel(run); setRunStatus(run.status, statusText(run))
    toast('已载入运行 ' + runId)
  } catch (e) { toast('载入失败: ' + e.message, 'err') }
}
