/**
 * storage.mjs — 持久化层。
 *
 * 职责：
 * 1. Store：JSON 文件驱动（dataDir 下 workflows/ runs/ versions/ 三个目录），
 *    通过 atomicWrite（临时文件 + rename）保证写入原子性。
 * 2. SqliteStore：SQLite 驱动（node:sqlite），与 Store 暴露同一接口，
 *    由配置 config.storage.driver === 'sqlite' 选择；初始化失败时自动回退 JSON。
 * 3. SubgraphStore：子图定义的版本化存储，contentHash 由内容锁定，防止内容被篡改后仍被引用。
 *
 * 在架构中的位置：被 server（API）/registry（注册表）/runtime（运行时）/portability（导入导出）共用，
 * 是工作流、运行记录、发布版本、子图定义的唯一落盘通道。
 *
 * 主要导出：
 * - Store（JSON 驱动）· SqliteStore（SQLite 驱动，同接口）· createStore（按配置选驱动）
 * - SubgraphStore（版本化子图存储，contentHash 锁定）
 * - toRunnable（把 graph 展平为 compiler/runtime 需要的 nodes/controlEdges）
 */
// StorageAdapter (JSON file driver, atomic temp+rename). SQLite driver can slot in behind same interface (§18.2).
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { deepClone, nowIso } from './lib.mjs'

/**
 * 原子写：先创建父目录，写入 <file>.<pid>.tmp 临时文件，再 rename 覆盖目标文件。
 * 同一文件系统内 rename 是原子的，可避免写一半损坏（进程崩溃时最多丢失、不会损坏）。
 * @param {string} file 目标文件绝对路径
 * @param {string|Buffer} data 完整文件内容
 */
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

/**
 * JSON 文件存储：每个工作流/运行记录/发布版本一个 JSON 文件，文件名即主键。
 * 注意：写路径全部经过 atomicWrite；读路径同步读文件。SQLite 驱动（SqliteStore）与它同接口。
 */
export class Store {
  /**
   * @param {string} dataDir 数据根目录；会自动创建 workflows/ runs/ versions/ 三个子目录
   */
  constructor(dataDir) {
    this.dir = dataDir
    this.wfDir = path.join(dataDir, 'workflows')
    this.runDir = path.join(dataDir, 'runs')
    this.verDir = path.join(dataDir, 'versions')
    fs.mkdirSync(this.wfDir, { recursive: true })
    fs.mkdirSync(this.runDir, { recursive: true })
    fs.mkdirSync(this.verDir, { recursive: true })
  }
  // ---- workflows ----
  /**
   * 列出所有工作流的摘要（id/title/revision/workflowVersion/enabled/updatedAt），按 id 排序。
   * @returns {Array<{id:string,title:string,revision:number,workflowVersion:number,enabled:boolean,updatedAt:string}>}
   */
  listWorkflows() {
    return fs.readdirSync(this.wfDir).filter((f) => f.endsWith('.json')).map((f) => {
      const d = JSON.parse(fs.readFileSync(path.join(this.wfDir, f), 'utf8'))
      return { id: d.id, title: d.title, revision: d.revision, workflowVersion: d.workflowVersion ?? 0, enabled: !!d.enabled, updatedAt: d.updatedAt }
    }).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  }
  /** 读取完整工作流文档；不存在返回 null。 */
  getWorkflow(id) {
    const f = path.join(this.wfDir, `${id}.json`)
    if (!fs.existsSync(f)) return null
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  }
  /** 删除工作流文件；删除成功返回 true，不存在返回 false。 */
  deleteWorkflow(id) {
    const f = path.join(this.wfDir, `${id}.json`)
    if (fs.existsSync(f)) { fs.unlinkSync(f); return true }
    return false
  }
  /** 保存（覆盖）工作流文档：刷新 updatedAt 后原子写入，返回带新 updatedAt 的 doc。 */
  saveWorkflow(doc) {
    doc.updatedAt = nowIso()
    atomicWrite(path.join(this.wfDir, `${doc.id}.json`), JSON.stringify(doc, null, 2))
    return doc
  }
  /**
   * 创建新工作流：填充 schemaVersion/revision/workflowVersion/权限/空图/UI 视口等默认字段，
   * 初始 enabled=false。返回保存后的文档。
   * @param {{id:string,title:string,graph?:object,permissions?:object}} opts
   */
  createWorkflow({ id, title, graph, permissions }) {
    const doc = {
      workflowSchemaVersion: 1, id, title, revision: 1, workflowVersion: 0, enabled: false,
      permissions: permissions || { bots: ['bot_demo'], groups: [], capabilities: [] },
      graph: graph || { nodes: [], controlEdges: [] }, dependencies: [],
      ui: { viewport: { x: 0, y: 0, zoom: 1 }, groups: [], notes: [] },
      createdAt: nowIso(), updatedAt: nowIso(),
    }
    return this.saveWorkflow(doc)
  }
  // ---- versions (immutable snapshots, §18.3) ----
  /**
   * 发布工作流版本：深拷贝 doc → 写入递增的 workflowVersion → 另存为不可变快照 <id>__v<ver>.json。
   * 返回快照；原工作流文档不会被修改（publishedAt 只加在快照上）。
   * @param {object} doc 当前工作流文档
   * @returns {object} 已加 workflowVersion/publishedAt 的快照
   */
  publishWorkflow(doc) {
    const ver = (this._latestVersion(doc.id) || 0) + 1
    const snap = deepClone(doc)
    snap.workflowVersion = ver
    snap.publishedAt = nowIso()
    atomicWrite(path.join(this.verDir, `${doc.id}__v${ver}.json`), JSON.stringify(snap, null, 2))
    return snap
  }
  /** 读取某工作流已发布的最大版本号（从文件名解析），无版本返回 0。 */
  _latestVersion(id) {
    if (!fs.existsSync(this.verDir)) return 0
    const vs = fs.readdirSync(this.verDir).filter((f) => f.startsWith(`${id}__v`)).map((f) => Number(f.replace(`${id}__v`, '').replace('.json', ''))).filter((n) => !Number.isNaN(n))
    return vs.length ? Math.max(...vs) : 0
  }
  /** 读取指定版本的不可变快照；不存在返回 null。 */
  getVersion(id, ver) {
    const f = path.join(this.verDir, `${id}__v${ver}.json`)
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
  }
  // ---- runs ----
  /** 保存（覆盖）一条运行记录（按 runId 原子写文件），返回 run。 */
  saveRun(run) { atomicWrite(path.join(this.runDir, `${run.runId}.json`), JSON.stringify(run, null, 2)); return run }
  /** 读取单条运行记录；不存在返回 null。 */
  getRun(runId) { const f = path.join(this.runDir, `${runId}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null }
  /**
   * 列出运行记录：可按 workflowId 过滤，按 startedAt 降序，最多返回 50 条。
   * @param {string} [workflowId] 为空则列出全部
   */
  listRuns(workflowId) {
    return fs.readdirSync(this.runDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(this.runDir, f), 'utf8')))
      .filter((r) => !workflowId || r.workflowId === workflowId).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 50)
  }
}

// flatten nested graph for compiler/runtime
/**
 * 把工作流文档展平为可执行结构：将嵌套的 doc.graph 提升为顶层 nodes/controlEdges，
 * 供 compiler/runtime 直接消费。不修改原文档（浅展开 + 默认空数组）。
 * @param {object} doc 工作流文档
 * @returns {{nodes:Array,controlEdges:Array}} 展平后的文档副本
 */
export function toRunnable(doc) {
  return { ...doc, nodes: doc.graph?.nodes || [], controlEdges: doc.graph?.controlEdges || [] }
}

// ---------------- SQLite driver (node:sqlite, §18.2) ----------------
// Same interface as Store; selected by config.storage.driver === 'sqlite'.
import { DatabaseSync } from 'node:sqlite'

/**
 * SQLite 存储：与 Store（JSON 驱动）暴露完全相同的方法与返回结构，
 * 由 createStore 根据配置选择。表结构：workflows / versions / runs / meta。
 */
export class SqliteStore {
  /**
   * @param {string} dataDir 数据根目录（用于推导默认 db 文件位置）
   * @param {string} [dbFile] SQLite 文件路径；缺省为 <dataDir>/flow.sqlite
   */
  constructor(dataDir, dbFile) {
    const file = dbFile || path.join(dataDir, 'flow.sqlite')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY, json TEXT NOT NULL, updatedAt TEXT);
      CREATE TABLE IF NOT EXISTS versions(id TEXT, ver INTEGER, json TEXT NOT NULL, publishedAt TEXT, PRIMARY KEY(id, ver));
      CREATE TABLE IF NOT EXISTS runs(runId TEXT PRIMARY KEY, workflowId TEXT, json TEXT NOT NULL, startedAt TEXT);
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    `)
    this._q = {
      upsertWf: this.db.prepare('INSERT INTO workflows(id,json,updatedAt) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, updatedAt=excluded.updatedAt'),
      getWf: this.db.prepare('SELECT json FROM workflows WHERE id=?'),
      delWf: this.db.prepare('DELETE FROM workflows WHERE id=?'),
      allWf: this.db.prepare('SELECT json FROM workflows'),
      maxVer: this.db.prepare('SELECT COALESCE(MAX(ver),0) AS m FROM versions WHERE id=?'),
      insVer: this.db.prepare('INSERT INTO versions(id,ver,json,publishedAt) VALUES(?,?,?,?)'),
      getVer: this.db.prepare('SELECT json FROM versions WHERE id=? AND ver=?'),
      upsertRun: this.db.prepare('INSERT INTO runs(runId,workflowId,json,startedAt) VALUES(?,?,?,?) ON CONFLICT(runId) DO UPDATE SET json=excluded.json'),
      getRun: this.db.prepare('SELECT json FROM runs WHERE runId=?'),
      listRuns: this.db.prepare('SELECT json FROM runs ORDER BY startedAt DESC LIMIT 50'),
      listRunsWf: this.db.prepare('SELECT json FROM runs WHERE workflowId=? ORDER BY startedAt DESC LIMIT 50'),
    }
  }
  /** 列出所有工作流摘要（同 Store.listWorkflows），按 id 排序。 */
  listWorkflows() {
    return this._q.allWf.all().map((r) => { const d = JSON.parse(r.json); return { id: d.id, title: d.title, revision: d.revision, workflowVersion: d.workflowVersion ?? 0, enabled: !!d.enabled, updatedAt: d.updatedAt } }).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  }
  /** 读取完整工作流文档；不存在返回 null。 */
  getWorkflow(id) { const r = this._q.getWf.get(id); return r ? JSON.parse(r.json) : null }
  /** 删除工作流行；删除成功返回 true，不存在返回 false。 */
  deleteWorkflow(id) { const r = this._q.getWf.get(id); if (!r) return false; this._q.delWf.run(id); return true }
  /** 保存（覆盖）工作流：刷新 updatedAt 后 upsert，返回带新 updatedAt 的 doc。 */
  saveWorkflow(doc) { doc.updatedAt = nowIso(); this._q.upsertWf.run(doc.id, JSON.stringify(doc), doc.updatedAt); return doc }
  /** 创建新工作流（默认字段与 Store.createWorkflow 一致，初始 enabled=false）。 */
  createWorkflow({ id, title, graph, permissions }) {
    const doc = { workflowSchemaVersion: 1, id, title, revision: 1, workflowVersion: 0, enabled: false, permissions: permissions || { bots: ['bot_demo'], groups: [], capabilities: [] }, graph: graph || { nodes: [], controlEdges: [] }, dependencies: [], ui: { viewport: { x: 0, y: 0, zoom: 1 }, groups: [], notes: [] }, createdAt: nowIso(), updatedAt: nowIso() }
    return this.saveWorkflow(doc)
  }
  /** 读取某工作流已发布的最大版本号（SQL 聚合），无版本返回 0。 */
  _latestVersion(id) { return this._q.maxVer.get(id).m }
  /**
   * 发布工作流版本：深拷贝 + 递增 workflowVersion + publishedAt，插入 versions 表（不可变快照）。
   * @param {object} doc 当前工作流文档
   * @returns {object} 已加 workflowVersion/publishedAt 的快照
   */
  publishWorkflow(doc) {
    const ver = this._latestVersion(doc.id) + 1
    const snap = deepClone(doc); snap.workflowVersion = ver; snap.publishedAt = nowIso()
    this._q.insVer.run(doc.id, ver, JSON.stringify(snap), snap.publishedAt)
    return snap
  }
  /** 读取指定版本的不可变快照；不存在返回 null。 */
  getVersion(id, ver) { const r = this._q.getVer.get(id, ver); return r ? JSON.parse(r.json) : null }
  /** 保存（upsert）一条运行记录，返回 run。 */
  saveRun(run) { this._q.upsertRun.run(run.runId, run.workflowId, JSON.stringify(run), run.startedAt); return run }
  /** 读取单条运行记录；不存在返回 null。 */
  getRun(runId) { const r = this._q.getRun.get(runId); return r ? JSON.parse(r.json) : null }
  /** 列出运行记录：可按 workflowId 过滤，按 startedAt 降序，最多 50 条。 */
  listRuns(workflowId) { const rows = workflowId ? this._q.listRunsWf.all(workflowId) : this._q.listRuns.all(); return rows.map((r) => JSON.parse(r.json)) }
}

/**
 * 按配置创建存储实例：driver==='sqlite' 时尝试 SQLite，初始化失败自动回退 JSON 驱动。
 * @param {{dataDir:string,driver?:string,dbFile?:string}} opts
 * @returns {Store|SqliteStore}
 */
export function createStore({ dataDir, driver = 'json', dbFile }) {
  if (driver === 'sqlite') { try { return new SqliteStore(dataDir, dbFile) } catch (e) { console.error('[storage] sqlite init failed, fallback json:', e.message) } }
  return new Store(dataDir)
}


// ---------------- Subgraph store (§17): versioned composite definitions, contentHash locked ----------------
/**
 * 子图（复合节点定义）版本化存储。
 * - 文件按 <id>__v<version>.json 存放，latest/get 支持按版本读取。
 * - save 时计算 contentHash 并写回 def：哈希只覆盖 {graph, publicInputs, publicOutputs}，
 *   即“结构内容锁定”——引用方靠 contentHash 校验子图内容未被篡改/不一致。
 */
export class SubgraphStore {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }) }
  /** 子图版本文件路径。 */
  _file(id, ver) { return path.join(this.dir, `${id}__v${ver}.json`) }
  /**
   * 计算内容哈希（sha256）：只对 graph + publicInputs + publicOutputs 计算，
   * 不含名称/描述等元数据，保证“同结构同哈希”。
   * @param {object} def 子图定义
   * @returns {string} 64 位 hex 哈希
   */
  _hash(def) { return crypto.createHash('sha256').update(JSON.stringify({ graph: def.graph, pi: def.publicInputs || [], po: def.publicOutputs || [] })).digest('hex') }
  /**
   * 保存子图定义：写回 contentHash、补 createdAt，原子写文件。返回带 contentHash 的 def。
   * @param {object} def 子图定义（需含 id 与 version）
   */
  save(def) {
    def.contentHash = this._hash(def)
    def.createdAt = def.createdAt || nowIso()
    atomicWrite(this._file(def.id, def.version), JSON.stringify(def, null, 2))
    return def
  }
  /** 列出某子图全部已存版本号（升序）。 */
  _versions(id) {
    if (!fs.existsSync(this.dir)) return []
    return fs.readdirSync(this.dir).filter((f) => f.startsWith(`${id}__v`) && f.endsWith('.json')).map((f) => Number(f.replace(`${id}__v`, '').replace('.json', ''))).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b)
  }
  /** 读取某子图的最新版本；无任何版本返回 null。 */
  latest(id) { const vs = this._versions(id); return vs.length ? this.get(id, vs[vs.length - 1]) : null }
  /**
   * 读取指定版本子图；ver 为空时等价 latest(id)。不存在返回 null。
   * @param {string} id 子图 id
   * @param {number|null} [ver] 版本号
   */
  get(id, ver) { if (ver == null) return this.latest(id); const f = this._file(id, ver); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null }
  /** 列出全部子图版本摘要：{id, version, name, contentHash}。 */
  list() { if (!fs.existsSync(this.dir)) return []; return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => { const d = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')); return { id: d.id, version: d.version, name: d.name, contentHash: d.contentHash } }) }
}
