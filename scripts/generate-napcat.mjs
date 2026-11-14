// Generate the NapCat action manifest from the dev-spec appendix (§26.1) — the "schema 生成链" seed (§13.4).
// Real deployments would re-lock this against the versioned OpenAPI + source registrar; here we derive it
// from the spec's own 178-item appendix so the mapping is reproducible from an in-repo source.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(__dirname, '..')
const docPath = path.resolve(pluginRoot, '../../云崽可视化工作流插件_开发文档_v1.0.md')
const outDir = path.join(pluginRoot, 'schemas/napcat/4.18.38')
fs.mkdirSync(outDir, { recursive: true })

const lines = fs.readFileSync(docPath, 'utf8').split('\n')
const families = []
let cur = null
const headRe = /^#### 26\.1\.\d+ (.+?)（(qq\.[a-z]+)，(\d+) 项）/
const rowRe = /^\| \d{2}-\d{2} \| `([^`]+)` \|/
for (const ln of lines) {
  const h = ln.match(headRe)
  if (h) { cur = { type: h[2], title: h[1].trim(), count: Number(h[3]), actions: [] }; families.push(cur); continue }
  const r = ln.match(rowRe)
  if (r && cur) cur.actions.push(r[1])
}
const total = families.reduce((a, f) => a + f.actions.length, 0)
const manifest = {
  sourceVersion: '4.18.38',
  generatedFrom: '云崽可视化工作流插件_开发文档_v1.0.md §26.1（NapCat OneBot 11 HTTP API 4.18.38 基础操作清单）',
  note: '共 178 项基础 POST 操作。家族映射为本项目建议。实现程度分轴报告（映射/表单/契约/实机），不以数量冒充全覆盖。',
  total,
  families,
}
fs.writeFileSync(path.join(outDir, 'actions.json'), JSON.stringify(manifest, null, 2))
console.log(`wrote ${families.length} families, ${total} actions -> schemas/napcat/4.18.38/actions.json`)
for (const f of families) console.log(`  ${f.type.padEnd(16)} ${String(f.actions.length).padStart(2)}  (declared ${f.count})`)
if (total !== 178) { console.error('WARN expected 178, got', total); process.exitCode = 2 }
