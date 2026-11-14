// ============================================================================
// 文件：src/datasource.mjs — 数据源声明 + 统一执行器 + AI 工具描述（§15）
// 职责：加载 datasources/*.json 声明（DataSourceRegistry）；按声明发起 HTTP 请求、
//   做字段映射与缓存（DataSourceRuntime.call）；对外暴露 AI 工具（tools()）。
// 架构位置：画布节点 / SDK / AI 工具三入口共用同一 DataSourceRuntime；由 server.mjs 装配注入。
// 主要导出：DataSourceRegistry、DataSourceRuntime。
// 安全约定：只把读操作导出为 AI 工具，write / send / admin 默认不导出（§15.3）。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { getPointer, setPointer } from './lib.mjs'

// DataSourceRegistry：扫描 datasources/ 目录加载声明包（按 id@version 索引）；
// list/get 查询声明，tools/toolByName 产出可供 AI 调用的只读工具描述。
export class DataSourceRegistry {
  constructor(dir) { this.dir = dir; this.packages = new Map(); this._load() }
  _load() {
    if (!fs.existsSync(this.dir)) return
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const m = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'))
        if (!m.id || !Array.isArray(m.operations)) continue
        m.specVersion = m.specVersion || '1.0'
        const key = `${m.id}@${m.version || '1.0.0'}`
        this.packages.set(key, m)
      } catch (e) { console.error('[datasource] load failed', f, e.message) }
    }
  }
  list() { return [...this.packages.values()].map((m) => ({ id: m.id, version: m.version, title: m.title, operations: m.operations.map((o) => ({ id: o.id, title: o.title, effect: o.effect, tool: o.tool })) })) }
  get(pkg, version) {
    if (version) return this.packages.get(`${pkg}@${version}`) || null
    for (const [k, m] of this.packages) if (m.id === pkg) return m
    return null
  }
  // 三入口之一：AI 工具描述。写/管理操作默认不导出（§15.3）。
  tools() {
    const out = []
    for (const m of this.packages.values()) for (const op of m.operations) {
      if (!op.tool || !op.tool.enabled) continue
      if (['write', 'send', 'admin'].includes(op.effect)) continue
      out.push({
        name: op.tool.name || `${m.id.replace(/[^a-z0-9]+/gi, '_')}_${op.id}`,
        description: `${m.title || m.id} · ${op.title || op.id}`,
        inputSchema: op.inputSchema || { type: 'object' },
        outputSchema: op.outputSchema || { type: 'object' },
        effect: op.effect || 'read',
        requiredCapabilities: op.requiredCapabilities || [],
        pkg: m.id, version: m.version, op: op.id,
      })
    }
    return out
  }
  toolByName(name) { return this.tools().find((t) => t.name === name) || null }
}

// DataSourceRuntime：声明驱动的统一执行器。三入口（画布节点 / SDK / AI 工具）最终都走 call()。
// call() 按声明拼 URL/鉴权/查询串、发起请求、按 response.mapping 映射输出，并按操作声明的 TTL 缓存。
// callTool() 是以导出工具名调用的便捷入口（仅对已导出为 AI 工具的操作生效）。
export class DataSourceRuntime {
  constructor({ http, secrets, cache, registry }) { this.http = http; this.secrets = secrets; this.cache = cache; this.registry = registry }
  async call(pkg, version, op, input = {}, opts = {}) {
    const man = this.registry.get(pkg, version)
    if (!man) throw Object.assign(new Error(`数据源包不存在: ${pkg}@${version}`), { code: 'DATASOURCE_NOT_FOUND' })
    const operation = man.operations.find((o) => o.id === op)
    if (!operation) throw Object.assign(new Error(`数据源操作不存在: ${pkg}/${op}`), { code: 'DATASOURCE_OP_NOT_FOUND' })
    const ckey = `ds:${pkg}@${man.version}:${op}:${JSON.stringify(input)}`
    if (operation.cache?.ttlSeconds) { const c = this.cache.get(ckey); if (c.found) return { ...c.value, _cached: true } }

    let url = (man.connection?.baseUrl || '') + (operation.request?.path || '')
    const q = {}
    for (const [k, m] of Object.entries(operation.request?.query || {})) {
      if (m.source === 'input') { const v = getPointer(input, m.pointer); if (v !== undefined) q[k] = v }
    }
    if (Object.keys(q).length) url += '?' + new URLSearchParams(q).toString()

    const headers = {}
    const conn = man.connection || {}
    if (conn.authProfile === 'bearer' && conn.secretAlias) {
      try { const sec = this.secrets.resolve(conn.secretAlias); headers['authorization'] = 'Bearer ' + (typeof sec.value === 'string' ? sec.value : String(sec.value)) } catch { /* no secret bound → unauthenticated in demo */ }
    }
    const res = await this.http.request({ url, method: operation.request?.method || 'GET', headers, body: operation.request?.body })
    const okStatuses = operation.response?.success?.httpStatus || [200]
    if (!okStatuses.includes(res.status)) throw Object.assign(new Error(`数据源 HTTP ${res.status}`), { code: 'DATASOURCE_HTTP', status: res.status })

    const out = {}
    for (const [target, m] of Object.entries(operation.response?.mapping || {})) {
      const v = m.source === 'response' ? getPointer({ status: res.status, body: res.body, headers: res.headers }, m.pointer) : undefined
      try { setPointer(out, target, v) } catch {}
    }
    if (operation.cache?.ttlSeconds) this.cache.set(ckey, out, operation.cache.ttlSeconds)
    return out
  }
  async callTool(name, args = {}) {
    const t = this.registry.toolByName(name)
    if (!t) throw Object.assign(new Error(`工具不存在或未导出: ${name}`), { code: 'TOOL_NOT_FOUND' })
    return this.call(t.pkg, t.version, t.op, args)
  }
}
