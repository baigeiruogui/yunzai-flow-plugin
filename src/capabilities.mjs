/**
 * capabilities.mjs — 能力服务层 + 每次运行的 capability 客户端。
 *
 * 职责：
 * 1. 提供各“能力”的底层服务实现：SecretService（密钥/凭据存储）、CacheService（内存缓存）、
 *    CryptoService（加解密/签名）、HttpService（HTTP 请求 + mock 拦截）、QQService（模拟 OneBot 发送）、
 *    RenderService（文本渲染成 SVG 资源）、DataSourceService（数据源调用）。
 * 2. createCapabilityClient 把上述服务按能力名（http.request / cache.get / crypto.encrypt / qq.send 等）
 *    编排成工作流节点可调用的统一入口，并负责：
 *    - simulate 模拟模式：缓存操作落到克隆实例、有副作用的调用只记账不真正执行；
 *    - effect ledger 记账：把每次调用的输入/结果脱敏后写入 ledger（effectId 唯一）。
 *
 * 在架构中的位置：位于 registry（注册表）/runtime（运行时）之下、具体 API server 之上；
 * 工作流节点执行时通过 capability client 间接访问外部能力，便于模拟、记账与权限控制。
 *
 * 主要导出：
 * - SecretService / CacheService / CryptoService / HttpService / QQService /
 *   RenderService / DataSourceService
 * - createCapabilityClient({ mode, services, runId, botId, workflowId, scopeIdentity, ledger, logger })
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { newId, nowIso } from './lib.mjs'

/**
 * 把任意形态的密钥输入规范化为 32 字节 Buffer（AES-256 密钥）。
 * 规则：Buffer 32 字节直接使用；64 位 hex 字符串按 hex 解码；32 字节 base64 按 base64 解码；
 * 其余输入统一 sha256 后作为 32 字节密钥。这样既支持显式主密钥，也支持任意口令派生。
 */
function toKey(k) {
  if (Buffer.isBuffer(k)) return k.length === 32 ? k : crypto.createHash('sha256').update(k).digest()
  const str = String(k).trim()
  if (/^[0-9a-fA-F]{64}$/.test(str)) return Buffer.from(str, 'hex')
  try { const b = Buffer.from(str, 'base64'); if (b.length === 32) return b } catch {}
  return crypto.createHash('sha256').update(str).digest()
}

// ---------------- SecretService ----------------
/**
 * 密钥/凭据存储服务。
 * 内存中保存“alias → 明文值 + 元信息”，持久化到 JSON 文件时用 AES-256-GCM 信封加密，
 * 因此快照/API 永远只暴露 secretRef 引用（id + version），不暴露明文正文。
 * @param {object} [opts]
 * @param {string|null} [opts.filePath=null] 密文持久化文件；为 null 时仅内存（不落盘）。
 * @param {string|Buffer|null} [opts.masterKey=null] 主密钥；省略时按 YF_SECRET_KEY → .secret.key → 自动生成 的优先级取得。
 */
export class SecretService {
  constructor({ filePath = null, masterKey = null } = {}) {
    this._store = new Map(); this._ed = new Map()
    this.filePath = filePath
    if (filePath) {
      this._keyDir = path.dirname(filePath)
      this._master = masterKey ? toKey(masterKey) : this._loadOrCreateMaster()
      this._loadFile()
    }
  }
  /**
   * 加载或创建主密钥：优先取环境变量 YF_SECRET_KEY；其次读取 <filePath 同目录>/.secret.key；
   * 都没有则生成 32 字节随机密钥并写入 .secret.key（权限 0600）。仅内部使用。
   * @returns {Buffer} 32 字节主密钥
   */
  _loadOrCreateMaster() {
    const env = process.env.YF_SECRET_KEY
    if (env) return toKey(env)
    const kf = path.join(this._keyDir, '.secret.key')
    if (fs.existsSync(kf)) return toKey(fs.readFileSync(kf, 'utf8'))
    const k = crypto.randomBytes(32)
    fs.mkdirSync(this._keyDir, { recursive: true })
    fs.writeFileSync(kf, k.toString('base64'))
    try { fs.chmodSync(kf, 0o600) } catch {}
    console.warn('[secret] 生成主密钥 .secret.key（生产请用 YF_SECRET_KEY 或 OS 密钥库，勿与密文同存默认配置）')
    return k
  }
  /**
   * 加密单个值，返回信封对象 { kind, iv, tag, ct }。
   * 信封字段：kind='bytes'|'utf8' 表示明文类型；iv=随机 12 字节 GCM nonce（base64）；
   * tag=16 字节认证标签（base64）；ct=密文（base64）。算法固定 aes-256-gcm。
   * @param {Buffer|string} value 明文
   * @returns {{kind:string,iv:string,tag:string,ct:string}} 加密信封
   */
  _encVal(value) {
    const isBuf = Buffer.isBuffer(value)
    const bytes = isBuf ? value : Buffer.from(String(value), 'utf8')
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', this._master, iv, { authTagLength: 16 })
    const ct = Buffer.concat([c.update(bytes), c.final()])
    return { kind: isBuf ? 'bytes' : 'utf8', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') }
  }
  /**
   * 解密 _encVal 生成的信封；GCM 认证失败会抛异常（由 _loadFile 捕获）。
   * @param {{kind:string,iv:string,tag:string,ct:string}} e 加密信封
   * @returns {Buffer|string} 按 kind 还原为 Buffer 或 utf8 字符串
   */
  _decVal(e) {
    const d = crypto.createDecipheriv('aes-256-gcm', this._master, Buffer.from(e.iv, 'base64'), { authTagLength: 16 })
    d.setAuthTag(Buffer.from(e.tag, 'base64'))
    const buf = Buffer.concat([d.update(Buffer.from(e.ct, 'base64')), d.final()])
    return e.kind === 'bytes' ? buf : buf.toString('utf8')
  }
  /**
   * 从磁盘加载密文文件：逐个 alias 解密；单个条目密钥不匹配时仅告警并跳过，不中断整个服务。
   */
  _loadFile() {
    try {
      if (!fs.existsSync(this.filePath)) return
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      for (const [alias, e] of Object.entries(data.entries || {})) {
        try { this._store.set(alias, { value: this._decVal(e.enc), ...e.meta }) } catch { console.warn('[secret] 解密失败(密钥不匹配?):', alias) }
      }
    } catch (err) { console.warn('[secret] 加载失败:', err.message) }
  }
  _persist() {
    if (!this.filePath) return
    const entries = {}
    for (const [alias, rec] of this._store) entries[alias] = { meta: { type: rec.type, version: rec.version, owner: rec.owner, uses: rec.uses }, enc: this._encVal(rec.value) }
    const tmp = this.filePath + '.tmp'
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2))
    fs.renameSync(tmp, this.filePath)
  }
  /**
   * 写入或覆盖一个秘密。value 支持字符串或 Buffer；meta 携带类型/版本/属主/允许用途。
   * 返回的 secretRef（{kind:'secretRef', id:alias, version}）是唯一对外暴露的“密钥句柄”，
   * 工作流图中只保存该引用，不保存正文。
   * @param {string} alias 秘密别名（密钥句柄 id）
   * @param {string|Buffer} value 明文正文
   * @param {{type?:string,version?:number,owner?:string,uses?:string[]}} [meta]
   * @returns {{kind:string,id:string,version:number}} secretRef 引用
   */
  put(alias, value, meta = {}) {
    this._store.set(alias, { value, type: meta.type || 'opaque', version: meta.version || 1, owner: meta.owner || 'owner', uses: meta.uses || ['*'] })
    this._persist()
    return { kind: 'secretRef', id: alias, version: meta.version || 1 }
  }
  /**
   * 判断别名是否存在。
   * @param {string} alias
   * @returns {boolean}
   */
  has(alias) { return this._store.has(alias) }
  // internal only — never serialized to snapshots/API
  /**
   * 解析 secretRef 为内部记录（含明文 value）。仅供内部服务（如 CryptoService）使用，
   * 绝不能序列化进快照或 API 响应。未找到时抛 code='SECRET_NOT_FOUND'。
   * @param {string|{id?:string}} ref secretRef 或别名
   * @returns {{value:*,type:string,version:number,owner:string,uses:string[]}} 内部记录
   */
  resolve(ref) {
    const alias = typeof ref === 'string' ? ref : ref?.id
    const rec = this._store.get(alias)
    if (!rec) { const e = new Error(`secret not found: ${alias}`); e.code = 'SECRET_NOT_FOUND'; throw e }
    return rec
  }
  /**
   * 返回不含正文的安全元信息（id/type/version/owner），可安全用于 API 响应。
   * @param {string|{id?:string}} ref
   * @returns {{id:string,type:string,version:number,owner:string}}
   */
  meta(ref) { const r = this.resolve(ref); return { id: typeof ref === 'string' ? ref : ref.id, type: r.type, version: r.version, owner: r.owner } }
  /** 列出所有别名的安全元信息。 */
  list() { return [...this._store.keys()].map((k) => this.meta(k)) }
  /**
   * 按别名懒生成/复用 Ed25519 密钥对（用于 CryptoService 的 sign/verify）。
   * 仅存内存，不落盘；进程重启后密钥对会重新生成，验证需在同一进程内完成。
   * @param {string} alias
   * @returns {{privateKey:*,publicKey:*}} 密钥对
   */
  _keyPair(alias) {
    if (!this._ed.has(alias)) this._ed.set(alias, crypto.generateKeyPairSync('ed25519'))
    return this._ed.get(alias)
  }
}

// ---------------- CacheService (host-Redis-like, namespaced, atomic incr, TTL) ----------------
/**
 * 内存缓存服务：模仿 Redis 的 get/set/del/incr，带可选 TTL。
 * 单进程内存实现，Key 由调用方（capability client）用前缀命名空间隔离。
 */
export class CacheService {
  constructor() { this._m = new Map() } // key -> {v, exp}
  /** 内部读取并处理过期清理：返回 {found, value?}。 */
  _get(key) {
    const e = this._m.get(key)
    if (!e) return { found: false }
    if (e.exp && Date.now() > e.exp) { this._m.delete(key); return { found: false } }
    return { found: true, value: e.v }
  }
  get(key) { const r = this._get(key); return r.found ? { found: true, value: r.value } : { found: false } }
  /**
   * 写入缓存。ttlSec>0 时设置过期时间，否则永不过期（exp=0）。
   * @param {string} key
   * @param {*} value
   * @param {number} [ttlSec] 秒级 TTL
   * @returns {{ok:boolean}}
   */
  set(key, value, ttlSec) {
    this._m.set(key, { v: value, exp: ttlSec && ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0 })
    return { ok: true }
  }
  /** 删除 key，返回是否真的删除了条目。 */
  del(key) { const had = this._m.delete(key); return { deleted: had } }
  /**
   * 原子自增：先读当前值（过期/不存在视为 0），+1 后写回并沿用 TTL。
   * JS 单线程同步代码中一次调用内完成读改写，天然原子。
   * @param {string} key
   * @param {number} [ttlSec]
   * @returns {{value:number,first:boolean}} value=自增后的值，first=是否首次创建
   */
  incr(key, ttlSec) {
    // atomic in single-threaded JS: read-modify-write in one turn
    const r = this._get(key)
    const next = (r.found ? Number(r.value) || 0 : 0) + 1
    this.set(key, next, ttlSec)
    return { value: next, first: !r.found }
  }
  /** 列出当前所有 key（用于调试/快照）。 */
  snapshot() { return [...this._m.keys()] }
  /**
   * 克隆一份独立缓存（含当前值与过期时间）。模拟模式下 capability client 用它隔离副作用，
   * 保证模拟运行不会污染真实缓存。
   * @returns {CacheService}
   */
  clone() { const c = new CacheService(); for (const [k, v] of this._m) c._m.set(k, { ...v }); return c }
}

// ---------------- CryptoService (real, versioned envelopes per §12.2) ----------------
/**
 * 构造 AEAD 的附加认证数据（AAD）：把 format/alg/kid/userAad 按“YF-AEAD\0 + 4 字节长度 + 内容”拼接，
 * 使密文与信封格式、算法、密钥句柄、业务 AAD 绑定，防篡改/防混用。仅内部使用。
 */
function aadFor(format, alg, kid, userAad) {
  const segs = [Buffer.from(format, 'utf8'), Buffer.from(alg, 'utf8'), Buffer.from(kid, 'utf8'), Buffer.from(userAad || '')]
  const parts = [Buffer.from('YF-AEAD\0', 'latin1')]
  for (const s of segs) { const len = Buffer.alloc(4); len.writeUInt32BE(s.length, 0); parts.push(len, s) }
  return Buffer.concat(parts)
}
/**
 * 加解密/签名服务。加解密使用带版本号的信封（format='yf.crypto.aead.v1'，算法 A256GCM），
 * 签名/验签使用 SecretService 按密钥句柄懒生成的 Ed25519 密钥对。
 */
export class CryptoService {
  constructor(secrets) { this.secrets = secrets }
  /** 由 secretRef 解析出 32 字节密钥：Buffer 恰好 32 字节直接用，否则 sha256 派生。 */
  _key(secretRef) {
    const rec = this.secrets.resolve(secretRef)
    const raw = Buffer.isBuffer(rec.value) ? rec.value : Buffer.from(String(rec.value), 'utf8')
    return raw.length === 32 ? raw : crypto.createHash('sha256').update(raw).digest()
  }
  /**
   * 加密明文，返回自描述信封：{format, alg, kid, iv, tag, ciphertext, aad}。
   * iv 每次随机（12 字节 base64）；kid 默认取 secretRef id（密钥句柄）；AAD 包含 format/alg/kid/aad。
   * @param {string} plaintext 明文
   * @param {{secretRef:string|{id?:string},aad?:string,kid?:string}} opts
   * @returns {{format:string,alg:string,kid:string,iv:string,tag:string,ciphertext:string,aad:string}} 加密信封
   */
  encrypt(plaintext, { secretRef, aad = '', kid }) {
    const key = this._key(secretRef)
    const iv = crypto.randomBytes(12)
    const alg = 'A256GCM'
    const k = kid || (typeof secretRef === 'string' ? secretRef : secretRef.id)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    cipher.setAAD(aadFor('yf.crypto.aead.v1', alg, k, aad))
    const ct = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()])
    const tag = cipher.getAuthTag()
    return { format: 'yf.crypto.aead.v1', alg, kid: k, iv: iv.toString('base64'), tag: tag.toString('base64'), ciphertext: ct.toString('base64'), aad: Buffer.from(aad || '').toString('base64') }
  }
  /**
   * 解密 encrypt 生成的信封。格式不符抛 CRYPTO_FORMAT；GCM 认证失败统一抛 CRYPTO_AUTH。
   * @param {object} env 加密信封
   * @param {{secretRef:string|{id?:string}}} opts
   * @returns {{plaintext:string}} 明文
   */
  decrypt(env, { secretRef }) {
    if (!env || env.format !== 'yf.crypto.aead.v1') { const e = new Error('unsupported envelope'); e.code = 'CRYPTO_FORMAT'; throw e }
    const key = this._key(secretRef)
    const iv = Buffer.from(env.iv, 'base64'); const tag = Buffer.from(env.tag, 'base64'); const ct = Buffer.from(env.ciphertext, 'base64')
    const aad = Buffer.from(env.aad || '', 'base64').toString('utf8')
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    d.setAAD(aadFor(env.format, env.alg, env.kid, aad))
    d.setAuthTag(tag)
    try { return { plaintext: Buffer.concat([d.update(ct), d.final()]).toString('utf8') } }
    catch (e) { const err = new Error('authentication failed'); err.code = 'CRYPTO_AUTH'; throw err }
  }
  /**
   * 用 secretRef 对应密钥对的私钥做 Ed25519 签名，返回 {format, alg, kid, messageEncoding, signatureEncoding, signature}。
   * 注意：密钥对由 SecretService 按 alias 内存懒生成，进程重启后不保留。
   */
  sign(message, { secretRef }) {
    const { privateKey } = this.secrets._keyPair(typeof secretRef === 'string' ? secretRef : secretRef.id)
    const sig = crypto.sign(null, Buffer.from(message, 'utf8'), privateKey)
    return { format: 'yf.crypto.signature.v1', alg: 'Ed25519', kid: typeof secretRef === 'string' ? secretRef : secretRef.id, messageEncoding: 'utf8', signatureEncoding: 'base64', signature: sig.toString('base64') }
  }
  /** 校验 sign 生成的签名，返回 {valid}。 */
  verify(message, env, { secretRef }) {
    const { publicKey } = this.secrets._keyPair(typeof secretRef === 'string' ? secretRef : secretRef.id)
    const ok = crypto.verify(null, Buffer.from(message, 'utf8'), publicKey, Buffer.from(env.signature, 'base64'))
    return { valid: ok }
  }
}

// ---------------- HttpService (mock:// + real fetch with timeout) ----------------
/**
 * HTTP 请求服务。
 * - mock(url, response)：注册 mock 响应；response 可为对象或函数。
 * - 请求 mock://xxx 会直接返回模拟响应（不真实发网络），供工作流调试/回放。
 * - 也支持前缀匹配：注册 http(s) URL 后，以该 URL 为前缀的真实请求同样走 mock。
 * - 真实请求用 fetch + AbortController 实现 timeoutMs 超时；响应体尝试 JSON.parse，失败则返回原文。
 */
export class HttpService {
  constructor() { this.mocks = new Map(); this.calls = 0 }
  /**
   * 注册一个 mock 响应。
   * @param {string} url 精确匹配或前缀匹配的 URL（mock:// 或 http(s)）
   * @param {object|Function} response 固定响应对象，或 ({url,method,headers,body})=>响应 的函数
   */
  mock(url, response) { this.mocks.set(url, response) }
  /**
   * 执行请求。命中 mock 时不联网、不产生真实副作用；未命中则真实 fetch。
   * @param {{url:string,method?:string,headers?:object,body?:*,timeoutMs?:number}} opts
   * @returns {Promise<{status:number,ok:boolean,headers:object,body:*,finalUrl:string,attempts:number}>}
   */
  async request({ url, method = 'GET', headers = {}, body, timeoutMs = 10000 }) {
    this.calls++
    if (!url) { const e = new Error('url required'); e.code = 'HTTP_INVALID_INPUT'; throw e }
    let r = this.mocks.get(url)
    if (!r && !url.startsWith('mock://')) for (const [k, v] of this.mocks) { if (k.startsWith('http') && url.startsWith(k)) { r = v; break } }
    if (url.startsWith('mock://') || r !== undefined) {
      r = r || { status: 200, body: { ok: true, url } }
      if (typeof r === 'function') r = r({ url, method, headers, body }) || {}
      return { status: r.status ?? 200, ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300, headers: { 'content-type': 'application/json' }, body: r.body, finalUrl: url, attempts: 1 }
    }
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal })
      const text = await res.text()
      let parsed; try { parsed = JSON.parse(text) } catch { parsed = text }
      return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers), body: parsed, finalUrl: res.url || url, attempts: 1 }
    } finally { clearTimeout(t) }
  }
}

// ---------------- QQService (simulated OneBot) ----------------
/**
 * 模拟 OneBot 的 QQ 发送服务：不真正连机器人，仅把消息/动作记入内存。
 * 当没有真实 napcat 客户端时，capability client 用它作为降级实现，便于演示与测试。
 */
export class QQService {
  constructor() { this.sent = []; this.actions = [] }
  /** 模拟发送消息：生成 message_id 并记录到 sent，返回 {message_id, receipt}。 */
  send({ target, message, botId }) {
    const id = `msg_${crypto.randomBytes(4).toString('hex')}`
    const rec = { message_id: id, target, botId, message, at: nowIso(), simulated: false }
    this.sent.push(rec)
    return { message_id: id, receipt: rec }
  }
  /** 模拟执行动作：仅记录到 actions，返回 {ok:true, action, data:null}。 */
  action(name, params) { this.actions.push({ name, params, at: nowIso() }); return { ok: true, action: name, data: null } }
}

// ---------------- RenderService ----------------
/**
 * 渲染服务：把文本渲染成 SVG 图片资源，落盘到资源目录，返回 resourceRef。
 * 资源经 URL /api/flow/v1/resources/{id} 对外访问。
 */
export class RenderService {
  constructor(resourcesDir) { this.dir = resourcesDir; fs.mkdirSync(this.dir, { recursive: true }) }
  /**
   * 渲染单行文本 SVG（深底 + 蓝色文字），写入 <dir>/<id>.svg。
   * @param {{text?:string,width?:number,height?:number}} [opts]
   * @returns {{kind:string,id:string,owner:string,mime:string,size:number,sha256:string,url:string}} 资源引用（含内容 sha256，便于完整性校验）
   */
  textImage({ text = '', width = 600, height = 240 }) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#15171C"/><text x="32" y="${height / 2}" fill="#7C9CFF" font-family="sans-serif" font-size="28">${escapeXml(text)}</text></svg>`
    const id = newId('res')
    const file = path.join(this.dir, `${id}.svg`)
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(file, svg)
    const sha256 = crypto.createHash('sha256').update(svg).digest('hex')
    return { kind: 'resourceRef', id, owner: 'local', mime: 'image/svg+xml', size: Buffer.byteLength(svg), sha256, url: `/api/flow/v1/resources/${id}` }
  }
}
/** 转义 SVG 文本中的 < > &，防止注入破坏 SVG 结构。 */
function escapeXml(s) { return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) }

// ---------------- DataSource (declaration runtime, mocked backend) ----------------
/**
 * 数据源服务（模拟后端）：按 pkg/version/op 调用数据源。
 * 目前仅内置 demo.user-profile#getProfile 演示实现；未命中抛 DATASOURCE_NOT_FOUND。
 */
export class DataSourceService {
  /**
   * 调用数据源操作。
   * @param {string} pkg 数据源包名
   * @param {string} version 数据源版本
   * @param {string} op 操作名
   * @param {*} input 输入参数
   * @returns {Promise<*>} 操作结果
   */
  async call(pkg, version, op, input) {
    if (pkg === 'demo.user-profile' && op === 'getProfile') {
      const uid = input?.uid || 'unknown'
      return { name: `玩家${String(uid).slice(-3)}`, level: 42, uid }
    }
    const e = new Error(`unknown datasource ${pkg}/${op}`); e.code = 'DATASOURCE_NOT_FOUND'; throw e
  }
}

// ---------------- Capability client (per run) ----------------
/**
 * 为一次工作流运行创建 capability 客户端：把底层服务按能力名编排成统一 invoke(capability, input) 入口。
 *
 * 关键语义：
 * - 返回对象含 invoke(capability, input) 与 resolveSecret(ref) 两个方法。
 * - 模拟模式（mode==='simulate'）：
 *   · 缓存读写/删除全部落到 services.cache.clone() 的克隆实例上，不污染真实缓存；
 *   · qq.send / qq.action 只记账不真正发送，返回 simulated 标记；
 *   · 所有记录到 ledger 的 effect 带 simulated:true 且 effectState='none'（无真实副作用）。
 * - 非模拟模式：真实执行并把效果记入 ledger（effectId 唯一，输入/结果经 redact 脱敏）。
 * - cacheKey 统一用 yf:v1:{workflowId}:{botId}:{scopeIdentity}:{businessKey} 做命名空间隔离。
 *
 * @param {object} opts
 * @param {'simulate'|string} opts.mode 运行模式，'simulate' 表示模拟执行
 * @param {object} opts.services 底层服务集合：{cache, http, crypto, render, qq, napcat?, datasource, secrets}
 * @param {string} opts.runId 本次运行 ID（写入 effect 记录）
 * @param {string} opts.botId 机器人 ID（参与缓存键前缀）
 * @param {string} opts.workflowId 工作流 ID（参与缓存键前缀）
 * @param {string} [opts.scopeIdentity] 作用域身份，默认 'conversation'（参与缓存键前缀）
 * @param {Array} opts.ledger effect 账本数组，本客户端直接 push 记录
 * @param {object} [opts.logger] 日志器（保留参数，供扩展使用）
 * @returns {{invoke:(capability:string,input:object)=>Promise<*>, resolveSecret:(ref:object|string)=>object}} capability 客户端
 */
export function createCapabilityClient({ mode, services, runId, botId, workflowId, scopeIdentity, ledger, logger }) {
  const simulate = mode === 'simulate'
  const cache = simulate ? services.cache.clone() : services.cache
  const recordEffect = (kind, input, result, extra = {}) => {
    const intent = { effectId: newId('eff'), runId, kind, input: redact(input), at: nowIso() }
    ledger.push({ ...intent, status: 'confirmed', result: redact(result), simulated: simulate, effectState: simulate ? 'none' : 'confirmed', ...extra })
  }
  return {
    async invoke(capability, input) {
      switch (capability) {
        case 'http.request': {
          const out = await services.http.request(input)
          if (!simulate) recordEffect('http', input, { status: out.status })
          return out
        }
        case 'cache.get': return cache.get(cacheKey(input))
        case 'cache.set': {
          if (simulate) return { ok: true, simulated: true }
          const r = cache.set(cacheKey(input), input.value, input.ttlSec)
          recordEffect('redis.set', { key: input.businessKey }, r); return r
        }
        case 'cache.incr': {
          if (simulate) return { value: 1, first: true, simulated: true }
          const r = cache.incr(cacheKey(input), input.ttlSec)
          recordEffect('redis.incr', { key: input.businessKey }, r); return r
        }
        case 'cache.del': {
          if (simulate) return { deleted: true, simulated: true }
          const r = cache.del(cacheKey(input)); recordEffect('redis.del', { key: input.businessKey }, r); return r
        }
        case 'crypto.encrypt': return services.crypto.encrypt(input.plaintext, input)
        case 'crypto.decrypt': return services.crypto.decrypt(input.envelope, input)
        case 'crypto.sign': return services.crypto.sign(input.message, input)
        case 'crypto.verify': return services.crypto.verify(input.message, input.envelope, input)
        case 'render.textImage': {
          const r = services.render.textImage(input); if (!simulate) recordEffect('render', { text: input.text }, { id: r.id }); return r
        }
        case 'qq.send': {
          if (simulate) { const rid = `sim_${newId('msg')}`; recordEffect('qq.send', input, { message_id: rid }, { effectState: 'none' }); return { message_id: rid, receipt: { message_id: rid, target: input.target, simulated: true }, simulated: true } }
          if (services.napcat) {
            const t = input.target || { type: 'group', id: 'unknown' }
            const params = { message_type: t.type === 'private' ? 'private' : 'group', message: input.message }
            if (t.type === 'private') params.user_id = t.id; else params.group_id = t.id
            const r = await services.napcat.call('send_msg', params)
            recordEffect('qq.send', input, { message_id: r.data?.message_id })
            return { message_id: r.data?.message_id, receipt: { message_id: r.data?.message_id, target: input.target, echo: r.echo, simulated: false }, data: r.data }
          }
          const r = services.qq.send({ ...input, botId }); recordEffect('qq.send', input, { message_id: r.message_id }); return r
        }
        case 'qq.action': {
          if (simulate) { recordEffect('qq.action', input, {}, { effectState: 'none' }); return { ok: true, simulated: true } }
          if (services.napcat) { const r = await services.napcat.call(input.name, input.params); recordEffect('qq.action', input, { retcode: r.retcode }); return { ok: true, retcode: r.retcode, data: r.data, raw: r.raw } }
          const r = services.qq.action(input.name, input.params); recordEffect('qq.action', input, r); return r
        }
        case 'datasource.call': return services.datasource.call(input.pkg, input.version, input.op, input.input)
        default: { const e = new Error(`unknown capability: ${capability}`); e.code = 'CAPABILITY_UNKNOWN'; throw e }
      }
    },
    resolveSecret: (ref) => services.secrets.meta(ref),
  }
  /**
   * 组装缓存键：yf:v1:{workflowId}:{botId}:{scopeIdentity}:{businessKey}。
   * businessKey 优先取 input.businessKey，其次 input.key，都没有用 'k'。
   */
  function cacheKey(inp) {
    const b = inp?.businessKey || inp?.key || 'k'
    return `yf:v1:${workflowId}:${botId}:${scopeIdentity || 'conversation'}:${b}`
  }
}
/**
 * 深拷贝并脱敏：敏感键名（secret/token/cookie/password/privatekey/clientkey/rkey）的值替换为 '[REDACTED]'；
 * secretRef 对象只保留 {kind,id,version}。用于 effect ledger 记录，避免把凭据写入账本/快照。
 */
function redact(obj) {
  if (obj == null) return obj
  const clone = JSON.parse(JSON.stringify(obj, (k, v) => {
    if (/secret|token|cookie|password|privatekey|clientkey|rkey/i.test(k)) return '[REDACTED]'
    if (v && v.kind === 'secretRef') return { kind: 'secretRef', id: v.id, version: v.version }
    return v
  }))
  return clone
}
