// 从 NapCat 源码 TypeBox PayloadSchema 生成结构化表单 overlay（§13.4 步骤1-3）。
// 输入：.napcat-src/router.ts（ActionName 枚举） + .napcat-src/files/**.ts（各 action 类）
// 输出：overlays/napcat/4.18.38/actions.generated.json
import fs from 'node:fs'
import path from 'node:path'

const router = fs.readFileSync('.napcat-src/router.ts', 'utf8')
const amBlock = router.slice(router.indexOf('export const ActionName'), router.indexOf('}', router.indexOf('export const ActionName')) + 1)
const actionMap = {}
for (const m of amBlock.matchAll(/(\w+)\s*:\s*'([^']+)'/g)) actionMap[m[1]] = m[2]

function splitTop(body) {
  const out = []; let depth = 0, cur = '', q = null
  for (const ch of body) {
    if (q) { cur += ch; if (ch === q) q = null; continue }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; cur += ch; continue }
    if ('([{<'.includes(ch)) depth++
    if (')]}>'.includes(ch)) depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out
}
function findTypeObject(src) {
  const idx = src.indexOf('Type.Object(')
  if (idx < 0) return null
  let i = idx + 'Type.Object('.length, depth = 1; const start = i
  for (; i < src.length; i++) { const c = src[i]; if (c === '(') depth++; else if (c === ')') { depth--; if (depth === 0) break } }
  return src.slice(start, i)
}
function mapType(expr) {
  if (/Type\.Optional/.test(expr) && !/Type\.(String|Number|Boolean|Array|Object|Union)/.test(expr.replace(/Type\.Optional\(/g, ''))) return { type: '', optional: true }
  let optional = /Type\.Optional/.test(expr)
  const s = expr
  if (/Type\.Union\([^)]*Type\.Number[^)]*Type\.String|Type\.Union\([^)]*Type\.String[^)]*Type\.Number/.test(s)) return { type: 'string', optional }
  if (/Type\.String|Type\.Literal\('|Type\.Union\(\[[^\]]*Type\.Literal/.test(s)) return { type: 'string', optional }
  if (/Type\.Number|Type\.Integer/.test(s)) return { type: 'number', optional }
  if (/Type\.Boolean/.test(s)) return { type: 'boolean', optional }
  if (/Type\.Array/.test(s)) return { type: 'array', optional }
  if (/Type\.Object|Type\.Record/.test(s)) return { type: 'object', optional }
  return { type: '', optional }
}
function descOf(expr) { const m = expr.match(/description:\s*['"]([^'"]*)['"]/); return m ? m[1] : '' }
function enumOf(expr) { const lits = [...expr.matchAll(/Type\.Literal\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]); return lits.length ? lits : null }

const entries = []
const filesDir = '.napcat-src/files'
function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.ts')) parseFile(p) } }
function parseFile(p) {
  const src = fs.readFileSync(p, 'utf8')
  const am = src.match(/actionName\s*=\s*ActionName\.(\w+)/) || src.match(/actionName\s*=\s*['"]([^'"]+)['"]/)
  if (!am) return
  const action = am[1].length > 0 && actionMap[am[1]] ? actionMap[am[1]] : am[1]
  // find payload schema: prefer const PayloadSchema = Type.Object(
  let body = null
  const psIdx = src.search(/PayloadSchema\s*=\s*Type\.Object\(|payloadSchema\s*=\s*Type\.Object\(/)
  if (psIdx >= 0) { body = findTypeObject(src.slice(psIdx)) }
  if (body == null) return
  // body is content inside Type.Object's parens, should start with { ... }
  const bi = body.indexOf('{'); const bj = body.lastIndexOf('}')
  const inner = bi >= 0 && bj > bi ? body.slice(bi + 1, bj) : ''
  const props = {}; const required = []; const fields = []
  for (const seg of splitTop(inner)) {
    const t = seg.trim(); if (!t) continue
    const mm = t.match(/^(\w+)\s*:\s*([\s\S]+)$/); if (!mm) continue
    const name = mm[1]; const expr = mm[2]
    const { type, optional } = mapType(expr); const description = descOf(expr); const en = enumOf(expr)
    const schema = {}; if (type) schema.type = type; if (description) schema.description = description; if (en) schema.enum = en
    props[name] = schema
    if (!optional) required.push(name)
    const uiType = en ? 'select' : type === 'number' ? 'number' : (type === 'object' || type === 'array') ? 'json' : type === 'boolean' ? 'select' : 'text'
    const field = { path: '/' + name, label: description || name, type: uiType }
    if (en) field.options = en.map(String)
    if (type === 'boolean') field.options = ['true', 'false']
    fields.push(field)
  }
  entries.push({
    action, title: action, source: 'typebox',
    inputSchema: { type: 'object', properties: props, required, additionalProperties: true },
    outputSchema: { type: 'object', properties: {} },
    ui: { fields }, requiredCapabilities: [`qq:action:${action}`],
  })
}
walk(filesDir)
// dedupe by action (keep first)
const seen = new Set(); const uniq = entries.filter((e) => { if (seen.has(e.action)) return false; seen.add(e.action); return true })
const outDir = 'overlays/napcat/4.18.38'
fs.writeFileSync(path.join(outDir, 'actions.generated.json'), JSON.stringify({ sourceVersion: '4.18.38', generatedFrom: 'NapCatQQ@bbd0d2ac TypeBox PayloadSchema', count: uniq.length, actions: uniq }, null, 2))
console.log('parsed actions:', uniq.length)
const withFields = uniq.filter((e) => Object.keys(e.inputSchema.properties).length > 0).length
console.log('with >=1 field:', withFields)
console.log('sample:', JSON.stringify(uniq.slice(0, 3).map((e) => ({ a: e.action, p: Object.keys(e.inputSchema.properties) }))))
