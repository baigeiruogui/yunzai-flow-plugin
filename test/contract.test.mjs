// 全量契约测试：对全部 178 个 NapCat 操作做「结构契约 + 可执行性契约」检查（§13.4/§24.2）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { buildRegistry } from '../src/registry.mjs'
import { compile } from '../src/compiler.mjs'
import { runWorkflow } from '../src/runtime.mjs'
import { SecretService, CacheService, CryptoService, HttpService, QQService, RenderService } from '../src/capabilities.mjs'

const registry = buildRegistry()
const qqFamilies = registry.families.filter((f) => f.type.startsWith('qq.'))
const qqOps = qqFamilies.flatMap((f) => f.operations.map((o) => ({ fam: f, op: o })))

function svc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yf-contract-'))
  const secrets = new SecretService(); secrets.put('a', crypto.randomBytes(32)); secrets.put('b', 'seed')
  return { secrets, cache: new CacheService(), http: new HttpService(), crypto: new CryptoService(secrets), qq: new QQService(), render: new RenderService(path.join(dir, 'r')) }
}
function dummy(schema) {
  if (!schema) return 'x'
  switch (schema.type) { case 'string': return 'x'; case 'number': case 'integer': return 0; case 'boolean': return true; case 'array': return []; case 'object': return {}; default: return 'x' }
}
function paramsFor(op) {
  const p = {}; const req = op.inputSchema?.required || []
  for (const k of req) p[k] = dummy(op.inputSchema?.properties?.[k])
  return p
}

test('contract(structural): 全部 178 项具备三元组/effect/权限/表单 Schema', () => {
  assert.equal(qqOps.length, 178, '应有 178 个 NapCat 基础操作')
  for (const { op } of qqOps) {
    assert.ok(op.meta && op.meta.canonicalAction, op.id + ' 缺 canonicalAction')
    assert.ok(op.inputSchema && op.inputSchema.type === 'object', op.id + ' 缺 inputSchema')
    assert.ok(op.outputSchema && op.outputSchema.type === 'object', op.id + ' 缺 outputSchema')
    assert.ok(Array.isArray(op.ui?.fields), op.id + ' 缺 ui.fields')
    assert.ok(['pure', 'read', 'write', 'send', 'admin'].includes(op.effect), op.id + ' effect 非法')
    assert.ok(Array.isArray(op.requiredCapabilities), op.id + ' 缺 requiredCapabilities')
    assert.equal(typeof op.execute, 'function', op.id + ' 缺 execute')
  }
})

test('contract(executable): 全部 178 项可在模拟模式编译并执行（qq.action 拦截）', async () => {
  const services = svc()
  let ok = 0; const failures = []
  for (const { fam, op } of qqOps) {
    const doc = {
      id: 'c_' + op.id,
      nodes: [
        { id: 'tr', type: 'core.trigger', operation: 'message', params: {}, bindings: {} },
        { id: 'n1', type: fam.type, operation: op.id, params: paramsFor(op), bindings: {} },
      ],
      controlEdges: [{ from: { nodeId: 'tr', port: 'next' }, to: { nodeId: 'n1', port: 'in' } }],
    }
    const c = compile(doc, registry)
    if (!c.ok) { failures.push(op.id + ':compile:' + (c.errors[0]?.code || '')); continue }
    try {
      const run = await runWorkflow({ workflow: doc, registry, services, mode: 'simulate', event: { eventId: 'e_' + op.id, chat: { type: 'group', id: 'g' }, sender: { nickname: 'x', userId: '1' }, message: { text: 'y' } }, seenEvents: new Set() })
      if (run.status === 'succeeded') ok++; else failures.push(op.id + ':' + run.status)
    } catch (e) { failures.push(op.id + ':throw:' + e.message) }
  }
  assert.equal(failures.length, 0, '全部应可执行；失败项: ' + failures.slice(0, 20).join(', '))
  assert.equal(ok, 178)
})
