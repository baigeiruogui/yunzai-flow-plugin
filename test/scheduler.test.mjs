import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RunLimiter } from '../src/scheduler.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('RunLimiter: 全局并发上限不被突破 (§7.4)', async () => {
  const l = new RunLimiter({ maxActive: 2, perConversation: 99, queueLimit: 10 })
  let cur = 0, max = 0
  await Promise.all([1, 2, 3, 4, 5].map(() => l.run('k', async () => { cur++; max = Math.max(max, cur); await sleep(40); cur-- })))
  assert.ok(max <= 2, '并发峰值应 <=2，实际 ' + max)
  assert.equal(l.snapshot().active, 0)
})

test('RunLimiter: 同一会话串行，不同会话并行 (§7.4)', async () => {
  const l = new RunLimiter({ maxActive: 5, perConversation: 1, queueLimit: 10 })
  let a = 0, b = 0, overlapSame = false
  await Promise.all([
    l.run('A', async () => { a++; await sleep(40); a-- }),
    l.run('A', async () => { if (a > 0) overlapSame = true; a++; await sleep(20); a-- }),
    l.run('B', async () => { b++; await sleep(40); b-- }),
  ])
  assert.equal(overlapSame, false, '同一会话不应并发')
})

test('RunLimiter: 队列满返回 QUEUE_FULL 背压 (§7.4)', async () => {
  const l = new RunLimiter({ maxActive: 1, perConversation: 1, queueLimit: 1 })
  const p1 = l.run('k', () => sleep(80))
  const p2 = l.run('k', () => sleep(10)) // 占满 1 个排队位
  await assert.rejects(l.run('k', () => sleep(10)), (e) => e.code === 'QUEUE_FULL')
  await p1; await p2
})
