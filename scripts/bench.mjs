// 性能基准 (§3.5)：合成大图，测编译与模拟运行耗时。node scripts/bench.mjs
import { buildRegistry } from '../src/registry.mjs'
import { compile } from '../src/compiler.mjs'
import { runWorkflow } from '../src/runtime.mjs'
import { CacheService } from '../src/capabilities.mjs'

const registry = buildRegistry()
function gen(n, fanout = 0) {
  const nodes = []
  const edges = []
  nodes.push({ id: 'trigger_1', type: 'core.trigger', operation: 'message', params: {}, bindings: {} })
  for (let i = 0; i < n; i++) nodes.push({ id: `t_${i}`, type: 'core.template', operation: 'text', params: { template: 'node ' + i, variables: {} }, bindings: {} })
  for (let i = 0; i < n - 1; i++) edges.push({ from: { nodeId: `t_${i}`, port: 'next' }, to: { nodeId: `t_${i + 1}`, port: 'in' } })
  edges.push({ from: { nodeId: 'trigger_1', port: 'next' }, to: { nodeId: 't_0', port: 'in' } })
  return { id: 'bench', nodes, controlEdges: edges }
}

const rows = []
for (const n of [100, 300, 500]) {
  const wf = gen(n)
  let t = performance.now(); const c = compile(wf, registry); const ct = performance.now() - t
  t = performance.now()
  const run = await runWorkflow({ workflow: wf, registry, services: { cache: new CacheService() }, mode: 'simulate', event: { eventId: 'b', message: { text: 'x' } }, seenEvents: new Set() })
  const rt = performance.now() - t
  rows.push({ nodes: n + 1, ok: c.ok, compileMs: +ct.toFixed(1), runMs: +rt.toFixed(1), runStatus: run.status, invoked: run.nodes.filter((x) => x.status === 'succeeded').length })
}
console.log(JSON.stringify(rows, null, 2))
