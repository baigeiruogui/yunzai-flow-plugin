// 生成验收报告：跑测试 + 采集 registry/coverage/events/datasource 真数据 → docs/ACCEPTANCE.md
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRegistry } from '../src/registry.mjs'
import { napcatStats } from '../src/integrations/napcat/manifest.mjs'
import { DataSourceRegistry } from '../src/datasource.mjs'
import { EVENT_CATALOG } from '../src/events.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

let testOut = '', pass = 0, fail = 0
try { testOut = execSync('node --test', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
catch (e) { testOut = (e.stdout || '') + (e.stderr || '') }
pass = Number((testOut.match(/ℹ pass (\d+)/) || [])[1] || 0)
fail = Number((testOut.match(/ℹ fail (\d+)/) || [])[1] || 0)

const registry = buildRegistry()
const st = registry.stats()
const nc = napcatStats(registry.families)
const dsRegistry = new DataSourceRegistry(path.join(root, 'datasources'))
const tools = dsRegistry.tools()
const sgDir = path.join(root, 'data', 'subgraphs')
const sgCount = fs.existsSync(sgDir) ? fs.readdirSync(sgDir).filter((f) => f.endsWith('.json')).length : 0
const evBy = {}; for (const e of EVENT_CATALOG) evBy[e.status] = (evBy[e.status] || 0) + 1
const effects = {}; for (const f of registry.families) for (const o of f.operations) effects[o.effect] = (effects[o.effect] || 0) + 1
const helpCount = registry.toJSON().families.reduce((a, f) => a + f.operations.filter((o) => o.help && o.help.when && o.help.when !== '（见操作说明）').length, 0)
const now = new Date().toISOString()

const md = `# 云崽 Flow 插件 — 验收报告

> 自动生成于 ${now}（脚本：scripts/verify.mjs）

## 测试

- **node --test：${pass} 通过 / ${fail} 失败**

## 能力统计（真数据）

| 指标 | 数值 |
| --- | --- |
| 节点家族 | ${st.families} |
| 操作总数 | ${st.operations} |
| effect 分布 | ${JSON.stringify(effects)} |
| NapCat 基础操作映射 | ${nc.mapped} / ${nc.baseOps} |
| NapCat 结构化表单 | ${nc.structuredForms} · 通用表单 ${nc.genericForms} |
| NapCat 契约（结构/可执行/行为） | ${nc.mapped} / ${nc.mapped} / ${nc.contractTested}（${nc.contractList.join(', ')}）|
| NapCat 实机验证 | ${nc.liveVerified}（需真实实例）|
| 数据源包 / AI 工具 | ${dsRegistry.list().length} / ${tools.length}（写操作不导出）|
| 事件目录 | ${EVENT_CATALOG.length}（${JSON.stringify(evBy)}）|
| 子图（已存储版本） | ${sgCount} |
| 有手写帮助的操作 | ${helpCount} |

## 结论

本报告由代码与测试真值生成，非人工填写。NapCat 覆盖按 \`映射 / 结构化表单 / 通用表单 / 契约测试 / 实机\` 分轴统计，不以节点数量冒充全覆盖（§24.2）。
`
fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
fs.writeFileSync(path.join(root, 'docs', 'ACCEPTANCE.md'), md)
console.log(`wrote docs/ACCEPTANCE.md  (tests ${pass}/${pass + fail})`)
console.log(md)
process.exit(fail === 0 ? 0 : 1)
