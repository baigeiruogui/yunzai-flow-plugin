// ============================================================================
// 文件：src/code/worker.mjs — 代码节点执行子进程（§16.3/§16.4）
// 职责：在独立子进程中运行用户代码（async 函数体，入参 (input, sdk)）；
//   从 stdin 读取 {code, input, mode, timeoutMs}，把结果以 stdout 的 sentinel 行回传给 supervisor。
// 架构位置：只由 supervisor.mjs spawn，不与主进程共享内存/句柄（故障隔离，不是安全沙箱）。
// 主要导出：无（脚本型子进程入口，完全靠 stdin/stdout sentinel 协议通信）。
// 说明：模拟模式禁网（CODE_NET_BLOCKED）；返回值必须可 JSON 序列化。
// ============================================================================
import crypto from 'node:crypto'

// 与 supervisor.mjs 约定的结果哨兵前缀：结果 JSON 以该前缀单行写到 stdout 末尾。
const SENTINEL = '__YF_RESULT__'
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

let raw = ''
process.stdin.on('data', (d) => (raw += d))
process.stdin.on('end', async () => {
  let payload = {}
  try { payload = JSON.parse(raw || '{}') } catch { payload = {} }
  const { code = 'return {}', input = {}, mode = 'simulate' } = payload
  const logs = []
  console.log = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : safe(x))).join(' '))

  const sdk = {
    log: (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : safe(x))).join(' ')),
    uuid: () => crypto.randomUUID(),
    base64: { encode: (s) => Buffer.from(String(s)).toString('base64'), decode: (s) => Buffer.from(String(s), 'base64').toString('utf8') },
    hash: { sha256: (s) => crypto.createHash('sha256').update(String(s)).digest('hex') },
    json: { parse: JSON.parse, stringify: JSON.stringify },
    http: {
      async request(o = {}) {
        if (mode !== 'real') { const e = new Error('模拟模式禁止代码节点网络访问'); e.code = 'CODE_NET_BLOCKED'; throw e }
        const r = await fetch(o.url, { method: o.method || 'GET', headers: o.headers })
        const text = await r.text(); let body; try { body = JSON.parse(text) } catch { body = text }
        return { status: r.status, ok: r.ok, body }
      },
    },
    env: { mode },
  }

  let out
  try {
    const fn = new AsyncFunction('input', 'sdk', code)
    const result = await fn(input, sdk)
    out = { ok: true, result: typeof result === 'undefined' ? null : result, logs }
  } catch (e) {
    out = { ok: false, error: { code: e.code || 'CODE_RUNTIME', message: e.message }, logs }
  }
  // serialization guard
  try { JSON.stringify(out) } catch (e) { out = { ok: false, error: { code: 'CODE_UNSERIALIZABLE', message: '返回值不可序列化为 JSON' }, logs } }
  process.stdout.write('\n' + SENTINEL + JSON.stringify(out) + '\n')
})

function safe(x) { try { return JSON.stringify(x) } catch { return String(x) } }
