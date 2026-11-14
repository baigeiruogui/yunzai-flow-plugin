// ============================================================================
// 文件：src/integrations/napcat/manifest.mjs — NapCat action 清单 → registry 家族
// 职责：把 schemas/napcat 的 actions.json 映射为家族/操作/effect/权限元数据；
//   对缺结构化表单的操作生成通用表单（genericOp）；并提供覆盖率分轴统计（napcatStats）。
// 架构位置：接入层元数据装配，buildRegistry 时通过 mergeNapcat 合入手写家族。
// 主要导出：loadManifest、mergeNapcat(families)、napcatStats(families)。
// 关键约定：overlay 合并时手写 overlay 优先于源码生成；覆盖率分轴统计，
//   不混淆表单完整性 / 契约测试 / 实机验证（§24.2）。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const manifestPath = path.resolve(__dirname, '../../../schemas/napcat/4.18.38/actions.json')

const ICONS = {
  'qq.message': '💬', 'qq.member': '👥', 'qq.request': '📨', 'qq.user': '👤', 'qq.album': '🖼️',
  'qq.voice': '🎤', 'qq.social': '⭐', 'qq.utility': '🛠️', 'qq.credentials': '🔑', 'qq.guild': '📡',
  'qq.system': '⚙️', 'qq.file': '📁', 'qq.group': '👥',
}

// 依据 action 名称推断副作用等级：send（发送/上传）、admin（管理/破坏性）、read（只读）。
function effectOf(action) {
  const a = action.toLowerCase()
  if (/^(send|upload|forward)|send_|_send|create_flash|send_packet/.test(a)) return 'send'
  if (/kick|ban|delete|del_|set_|clean|restart|exit|refuse|cancel|operate|mark_|_like|comment|rename|move|trans_/.test(a)) return 'admin'
  return 'read'
}

export function loadManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}

// overlay 合并表（惰性构建并缓存）：先载入源码生成的 actions.generated.json，再载入手写 actions.overlay.json；
// 后者覆盖前者 → 手写 overlay 优先于源码生成（按 action 名以 Map.set 去重覆盖）。
let _overlay = null
function overlayMap() {
  if (_overlay) return _overlay
  _overlay = new Map()
  const base = path.resolve(__dirname, '../../../overlays/napcat/4.18.38')
  try { for (const a of JSON.parse(fs.readFileSync(path.join(base, 'actions.generated.json'), 'utf8')).actions) _overlay.set(a.action, a) } catch {}
  try { for (const a of JSON.parse(fs.readFileSync(path.join(base, 'actions.overlay.json'), 'utf8')).actions) _overlay.set(a.action, a) } catch {}
  return _overlay
}

// 通用表单操作：结构化表单缺失时的兜底；参数以 JSON 原样透传给 qq.action 能力。
function genericOp(action) {
  return {
    id: action,
    title: action,
    effect: effectOf(action),
    requiredCapabilities: [`qq:action:${action}`],
    ports: { in: ['in'], out: ['next', 'error'] },
    inputSchema: { type: 'object', properties: { params: { type: 'object' } }, additionalProperties: true },
    outputSchema: { type: 'object', properties: { result: {} } },
    ui: {
      fields: [{ path: '/params', label: '参数 (JSON，按上游 schema)', type: 'json' }],
      generic: true, canonicalAction: action, availability: 'mapped',
    },
    meta: { canonicalAction: action, availability: 'mapped', genericForm: true, contractTested: false, liveVerified: false, sourceVersion: '4.18.38' },
    async execute(ctx, input) {
      const r = await ctx.capabilities.invoke('qq.action', { name: action, params: input.params || {} })
      return { status: 'succeeded', output: { result: r }, control: 'next' }
    },
  }
}

// 结构化表单操作：使用 overlay（手写或源码生成）提供的专用输入/输出 schema 与 UI 字段。
function structuredOp(action, ov) {
  return {
    id: action,
    title: ov.title || action,
    effect: ov.effect || effectOf(action),
    requiredCapabilities: ov.requiredCapabilities || [`qq:action:${action}`],
    ports: { in: ['in'], out: ['next', 'error'] },
    inputSchema: ov.inputSchema || { type: 'object' },
    outputSchema: ov.outputSchema || { type: 'object', properties: { result: {} } },
    ui: { fields: ov.ui?.fields || [], canonicalAction: action, availability: 'structured', structured: true },
    meta: { canonicalAction: action, availability: 'structured', genericForm: false, structuredForm: true, source: ov.source || 'hand', contractTested: !!ov.contractTested, liveVerified: false, sourceVersion: '4.18.38' },
    async execute(ctx, input) {
      const r = await ctx.capabilities.invoke('qq.action', { name: action, params: input })
      return { status: 'succeeded', output: { result: r }, control: 'next' }
    },
  }
}

// 将清单中的操作合并进手写 families（原地修改）：已有家族补齐缺失操作，
// 没有对应手写家族的则追加新家族；已有同名操作（id 或 canonicalAction）跳过。
export function mergeNapcat(families) {
  const manifest = loadManifest()
  const byType = new Map(families.map((f) => [f.type, f]))
  for (const mf of manifest.families) {
    let fam = byType.get(mf.type)
    if (!fam) {
      fam = { type: mf.type, version: '1.0.0', title: mf.title, category: 'QQ', color: '#5FA8FF', icon: ICONS[mf.type] || '❔', operations: [] }
      families.push(fam); byType.set(mf.type, fam)
    }
    for (const action of mf.actions) {
      const exists = fam.operations.some((o) => o.id === action || o.meta?.canonicalAction === action)
      if (exists) continue
      const ov = overlayMap().get(action)
      fam.operations.push(ov ? structuredOp(action, ov) : genericOp(action))
    }
  }
  return families
}

// 覆盖率分轴统计：基础操作数 / 已映射 / 结构化表单 / 通用表单 / 契约测试 / 实机验证等分轴计数，
// 各轴独立呈现、互不冒充（见 §24.2）。
export function napcatStats(families) {
  const mf = loadManifest()
  const all = families.filter((f) => f.type.startsWith('qq.'))
  const ops = all.flatMap((f) => f.operations)
  const canonical = new Set(ops.map((o) => o.meta?.canonicalAction).filter(Boolean))
  const structured = ops.filter((o) => o.meta && o.meta.genericForm === false)
  const contract = ops.filter((o) => o.meta?.contractTested)
  const live = ops.filter((o) => o.meta?.liveVerified)
  return {
    sourceVersion: mf.sourceVersion,
    baseOps: mf.total,
    mapped: canonical.size,
    structuredForms: structured.length,
    genericForms: ops.filter((o) => o.meta?.genericForm).length,
    contractTested: contract.length,
    contractList: contract.map((o) => o.meta.canonicalAction),
    structuredHand: ops.filter((o) => o.meta && o.meta.structuredForm && o.meta.source !== 'typebox').length,
    structuredFromSource: ops.filter((o) => o.meta && o.meta.source === 'typebox').length,
    liveVerified: live.length,
    families: all.length,
  }
}
