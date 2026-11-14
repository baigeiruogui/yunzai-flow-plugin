/**
 * portability.mjs — 流程导出/导入 + 备份/恢复（§18.4）。
 *
 * 职责：
 * 1. exportWorkflow / importBundle：把单个工作流（含引用的子图）打包为 yf.workflow.bundle.v1，
 *    导出只带 secretAliases（凭据别名），绝不包含凭据正文；导入的流程默认停用。
 * 2. createBackup / restoreBackup：全量备份/恢复；备份同样不含凭据正文；
 *    恢复前先在 backupDir 写一份当前数据快照，且恢复后的所有流程强制停用。
 *
 * 在架构中的位置：被 server（API 层的导出/导入/备份/恢复路由）调用，依赖 storage 层读写数据。
 *
 * 主要导出：
 * - exportWorkflow · importBundle · createBackup · restoreBackup
 */
// 流程导出/导入 + 备份/恢复 (§18.4). 导出不含凭据正文，只带 secret alias；导入不自动启用；恢复后全部停用。
import { deepClone, nowIso, newId } from './lib.mjs'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 递归收集对象中的凭据别名：
 * - secretRef 节点记录其 id；
 * - 键名匹配 secret|cookie|token|password|privatekey 且值为非空字符串时，把值当作别名收集。
 * 收集结果去重（Set），用于导出时生成 secretAliases 列表，正文永不进入导出包。
 * @param {*} obj 任意对象/数组
 * @param {Set<string>} [acc] 累加器
 * @returns {Set<string>} 去重后的别名集合
 */
function collectSecretAliases(obj, acc = new Set()) {
  if (!obj || typeof obj !== 'object') return acc
  if (obj.kind === 'secretRef' && obj.id) acc.add(obj.id)
  for (const [k, v] of Object.entries(obj)) {
    if (/secret|cookie|token|password|privatekey/i.test(k) && typeof v === 'string' && v) acc.add(v)
    if (v && typeof v === 'object') collectSecretAliases(v, acc)
  }
  return acc
}

/**
 * 导出单个工作流为流程包（yf.workflow.bundle.v1）。
 * 内容：工作流主体（graph 深拷贝）、图中 core.subgraph 节点引用的子图定义（含 contentHash）、
 * secretAliases 别名列表。凭据正文不进入导出包，需在目标环境重新映射。
 * @param {object} store 工作流存储（Store/SqliteStore）
 * @param {object} subgraphs 子图存储（SubgraphStore）
 * @param {string} id 工作流 id
 * @returns {{format:string,exportedAt:string,workflow:object,subgraphs:Array,secretAliases:Array,note:string}} 流程包
 */
export function exportWorkflow(store, subgraphs, id) {
  const doc = store.getWorkflow(id)
  if (!doc) { const e = new Error('workflow not found'); e.code = 'NOT_FOUND'; throw e }
  const sgRefs = []
  for (const n of doc.graph?.nodes || []) {
    if (n.type === 'core.subgraph' && n.operation === 'call') {
      const def = subgraphs.get(n.params?.subgraphId, n.params?.version ?? null)
      if (def) sgRefs.push({ id: def.id, version: def.version, contentHash: def.contentHash, def: deepClone(def) })
    }
  }
  const al = collectSecretAliases(doc.graph)
  return {
    format: 'yf.workflow.bundle.v1',
    exportedAt: nowIso(),
    workflow: {
      id: doc.id, title: doc.title, workflowSchemaVersion: doc.workflowSchemaVersion || 1,
      permissions: doc.permissions, graph: deepClone(doc.graph), dependencies: doc.dependencies || [], ui: doc.ui,
    },
    subgraphs: sgRefs,
    secretAliases: [...al],
    note: '导出不含任何凭据正文；secretAliases 需在导入环境重新映射后使用。',
  }
}

/**
 * 导入流程包。语义：
 * - 校验 format，不符抛 BUNDLE_INVALID；
 * - 先保存包内子图定义，再导入工作流本体；
 * - 导入的工作流 revision 重置为 1、workflowVersion 重置为 0、enabled 强制 false（不自动启用）；
 * - keepId=false 时生成新 id 并在标题后加“(导入)”；keepId=true 保留原 id（覆盖）。
 * - 检查 secretAliases 是否已在目标环境存在（store._hasSecretAlias），缺失的收集为 SECRET_UNRESOLVED 警告。
 * @param {object} store 工作流存储
 * @param {object} subgraphs 子图存储
 * @param {object} bundle 流程包（exportWorkflow 的产物）
 * @param {{keepId?:boolean}} [opts]
 * @returns {{ok:boolean,workflowId:string,enabled:boolean,subgraphs:number,warnings:Array}}
 */
export function importBundle(store, subgraphs, bundle, { keepId = false } = {}) {
  if (!bundle || bundle.format !== 'yf.workflow.bundle.v1') throw Object.assign(new Error('不是有效的流程包'), { code: 'BUNDLE_INVALID' })
  const warnings = []
  for (const sg of bundle.subgraphs || []) { if (sg.def) subgraphs.save(deepClone(sg.def)) }
  const wf = deepClone(bundle.workflow)
  const newIdv = keepId ? wf.id : `wf_import_${newId('x').split('_')[1]}`
  const doc = {
    workflowSchemaVersion: wf.workflowSchemaVersion || 1,
    id: newIdv, title: (wf.title || '导入的流程') + (keepId ? '' : ' (导入)'),
    revision: 1, workflowVersion: 0, enabled: false,
    permissions: wf.permissions || { bots: ['bot_demo'], groups: [], capabilities: [] },
    graph: wf.graph || { nodes: [], controlEdges: [] }, dependencies: wf.dependencies || [],
    ui: wf.ui || { viewport: { x: 0, y: 0, zoom: 1 }, groups: [], notes: [] },
    createdAt: nowIso(), updatedAt: nowIso(),
  }
  store.saveWorkflow(doc)
  const unresolved = (bundle.secretAliases || []).filter((a) => !store._hasSecretAlias?.(a))
  if (unresolved.length) warnings.push({ code: 'SECRET_UNRESOLVED', aliases: unresolved, message: '这些 secretAlias 需在目标环境重新映射' })
  return { ok: true, workflowId: newIdv, enabled: false, subgraphs: (bundle.subgraphs || []).length, warnings }
}

/**
 * 全量备份当前工作流与子图为 yf.backup.v1。备份不含凭据正文（凭据由 SecretService 独立管理）。
 * @param {object} store 工作流存储
 * @param {object} subgraphs 子图存储
 * @returns {{format:string,createdAt:string,counts:{workflows:number,subgraphs:number},workflows:Array,subgraphs:Array,note:string}}
 */
export function createBackup(store, subgraphs) {
  const workflows = store.listWorkflows().map((w) => store.getWorkflow(w.id)).filter(Boolean)
  const sgs = subgraphs.list().map((s) => subgraphs.get(s.id, s.version)).filter(Boolean)
  return { format: 'yf.backup.v1', createdAt: nowIso(), counts: { workflows: workflows.length, subgraphs: sgs.length }, workflows, subgraphs: sgs, note: '备份不含凭据正文；恢复后所有流程置为停用。' }
}

/**
 * 从备份恢复。语义：
 * - 校验 format，不符抛 BACKUP_INVALID；
 * - 恢复前若给了 backupDir，先调用 createBackup 把当前数据写到 <backupDir>/pre-restore-<ts>.json（尽力而为），
 *   避免误恢复导致数据丢失；
 * - 恢复的子图直接保存；工作流深拷贝后 revision+1 且 enabled 强制 false（恢复后全部停用）。
 * @param {object} store 工作流存储
 * @param {object} subgraphs 子图存储
 * @param {object} backup 备份包（createBackup 的产物）
 * @param {{backupDir?:string|null}} [opts]
 * @returns {{ok:boolean,restored:{workflows:number,subgraphs:number},allDisabled:boolean,preBackup:object|null}}
 */
export function restoreBackup(store, subgraphs, backup, { backupDir = null } = {}) {
  if (!backup || backup.format !== 'yf.backup.v1') throw Object.assign(new Error('不是有效的备份'), { code: 'BACKUP_INVALID' })
  // 恢复前先备份当前数据，避免误恢复丢数据（§18.4）
  let preBackup = null
  if (backupDir) {
    try { const pre = createBackup(store, subgraphs); fs.mkdirSync(backupDir, { recursive: true }); const f = path.join(backupDir, `pre-restore-${Date.now()}.json`); fs.writeFileSync(f, JSON.stringify(pre)); preBackup = { file: f, counts: pre.counts } } catch (e) { /* best effort */ }
  }
  let wf = 0, sg = 0
  for (const def of backup.subgraphs || []) { subgraphs.save(deepClone(def)); sg++ }
  for (const doc of backup.workflows || []) { const d = deepClone(doc); d.enabled = false; d.revision = (d.revision || 1) + 1; store.saveWorkflow(d); wf++ }
  return { ok: true, restored: { workflows: wf, subgraphs: sg }, allDisabled: true, preBackup }
}
