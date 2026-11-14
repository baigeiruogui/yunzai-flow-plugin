// ============================================================================
// 文件：src/code/supervisor.mjs — 代码节点监督器（§16.3）
// 职责：为每次代码执行 spawn 一个独立 Node 子进程（worker.mjs），施加超时与堆上限，
//   超时对子进程 SIGKILL；通过 stdin 下发任务，从 stdout 的 sentinel 行取回结构化结果。
// 架构位置：core.code/js 节点的执行实现，被运行时调用。
// 主要导出：runCode(code, input, { timeoutMs, memoryMb, mode }) → Promise<结果>。
// 重要边界：独立子进程 = 故障隔离，不是安全沙箱；只能称“故障隔离/可信代码模式”（§16.3）。
// ============================================================================
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(__dirname, 'worker.mjs')
// 结果哨兵：worker 在 stdout 末尾输出以该前缀开头的单行 JSON；supervisor 逆序找该行解析为结果。
const SENTINEL = '__YF_RESULT__'

export function runCode(code, input = {}, { timeoutMs = 3000, memoryMb = 128, mode = 'simulate' } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    let child
    try {
      child = spawn(process.execPath, ['--no-warnings', `--max-old-space-size=${memoryMb}`, WORKER], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) { return done({ ok: false, error: { code: 'CODE_SPAWN', message: e.message }, logs: [] }) }
    let out = '', err = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      done({ ok: false, error: { code: 'CODE_TIMEOUT', message: `代码超时（>${timeoutMs}ms），已终止进程` }, logs: [] })
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: { code: 'CODE_SPAWN', message: e.message }, logs: [] }) })
    child.on('close', () => {
      clearTimeout(timer)
      const line = out.split('\n').reverse().find((l) => l.startsWith(SENTINEL))
      if (!line) return done({ ok: false, error: { code: 'CODE_NO_RESULT', message: (err || '进程无结果输出').slice(0, 500) }, logs: [] })
      try { done(JSON.parse(line.slice(SENTINEL.length))) } catch (e) { done({ ok: false, error: { code: 'CODE_BAD_RESULT', message: e.message }, logs: [] }) }
    })
    try { child.stdin.write(JSON.stringify({ code, input, mode, timeoutMs })); child.stdin.end() } catch (e) { clearTimeout(timer); done({ ok: false, error: { code: 'CODE_STDIN', message: e.message }, logs: [] }) }
  })
}
