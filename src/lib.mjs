// ============================================================================
// lib.mjs — 共享基础工具库（无业务依赖的纯函数层）
// 架构位置：最底层基础模块，被 compiler / runtime / scheduler 等上层复用。
// 主要导出：
//   - 标识与时间：newId、nowIso
//   - RFC 6901 JSON Pointer：encodePointerToken、decodePointerToken、getPointer、setPointer
//   - 轻量 JSON Schema 校验（2020-12 子集）：validateSchema
//   - 数据安全：deepClone、redactDeep
// ============================================================================
import { randomUUID } from 'node:crypto'

/**
 * 生成带前缀的短随机 id：取随机 UUID 前 8 位，兼顾唯一性与可读长度。
 * @param {string} prefix id 前缀（如 'run'、'node'）
 * @returns {string} 形如 `${prefix}_xxxxxxxx` 的 id
 */
export const newId = (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`
/**
 * 当前 UTC 时间的 ISO 8601 字符串，用于统一时间戳格式。
 * @returns {string} ISO 时间串，如 2026-11-14T07:08:31.000Z
 */
export const nowIso = () => new Date().toISOString()

// --- RFC 6901 JSON Pointer：读写嵌套对象字段的通用路径工具 ---
/**
 * 按 RFC 6901 转义单个 Pointer token：先 ~ → ~0，再 / → ~1（顺序不可颠倒）。
 * @param {*} t 原始 token
 * @returns {string} 转义后的 token
 */
export function encodePointerToken(t) {
  return String(t).replace(/~/g, '~0').replace(/\//g, '~1')
}
/**
 * 按 RFC 6901 反转义单个 Pointer token：先 / 后 ~，与 encodePointerToken 互逆。
 * @param {*} t 已转义的 token
 * @returns {string} 还原后的 token
 */
export function decodePointerToken(t) {
  return String(t).replace(/~1/g, '/').replace(/~0/g, '~')
}
/**
 * 按 JSON Pointer 读取值：空指针返回整个对象；路径不存在或类型不符时返回 undefined（不抛错，方便上游按“缺失”处理）。
 * @param {object|Array} obj 根数据
 * @param {string|undefined|null} pointer 形如 /a/b/0 的 JSON Pointer
 * @returns {*} 指向的值；路径无法解析时为 undefined
 */
export function getPointer(obj, pointer) {
  if (pointer === '' || pointer === undefined || pointer === null) return obj
  if (!pointer.startsWith('/')) throw new Error(`invalid JSON Pointer: ${pointer}`)
  const parts = pointer.slice(1).split('/').map(decodePointerToken)
  let cur = obj
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    if (Array.isArray(cur)) {
      const idx = Number(p)
      if (!Number.isInteger(idx)) return undefined
      cur = cur[idx]
    } else {
      cur = cur[p]
    }
    if (cur === undefined) return undefined
  }
  return cur
}
/**
 * 按 JSON Pointer 就地写入值并返回原对象引用；中间路径不存在时自动补空对象/数组。
 * @param {object|Array} obj 根数据
 * @param {string} pointer 形如 /a/b/0 的 JSON Pointer，必须以 / 开头
 * @param {*} value 要写入的值
 * @returns {object|Array} 修改后的原对象引用
 */
export function setPointer(obj, pointer, value) {
  if (!pointer.startsWith('/')) throw new Error(`invalid JSON Pointer: ${pointer}`)
  const parts = pointer.slice(1).split('/').map(decodePointerToken)
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (Array.isArray(cur)) {
      const idx = Number(p)
      if (!Number.isInteger(idx)) throw new Error('non-numeric array token')
      if (cur[idx] == null) cur[idx] = {}
      cur = cur[idx]
    } else {
      // 下一级 token 是数字则补数组、否则补对象，保证数组下标路径可继续写入
      if (cur[p] == null) cur[p] = /^\d+$/.test(parts[i + 1]) ? [] : {}
      cur = cur[p]
    }
  }
  const last = parts[parts.length - 1]
  if (Array.isArray(cur)) cur[Number(last)] = value
  else cur[last] = value
  return obj
}

// --- 轻量 JSON Schema 校验器（仅实现 2020-12 子集，覆盖插件自校验所需） ---
// 支持的 keyword：type、properties、required、additionalProperties、items、enum、minLength、minimum、maximum、oneOf(lite)
// 各 type 的谓词统一抽成函数，便于 type 数组按 anyOf 语义做“任一命中即通过”
const TYPES = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
}
/**
 * 递归校验 value 是否符合 schema，返回错误数组（空数组 = 通过）。
 * 设计为“收集全部错误”而非遇到首个就抛，便于一次性展示完整校验结果。
 * @param {*} value 待校验值
 * @param {object} schema JSON Schema 片段（2020-12 子集）
 * @param {string} [path=''] 当前 JSON Pointer 路径，用于错误定位
 * @returns {Array<{path:string,message:string,value?:*}>} 错误列表；无错误时为空数组
 */
export function validateSchema(value, schema, path = '') {
  const errors = []
  if (!schema || typeof schema !== 'object') return errors
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const ok = types.some((t) => (TYPES[t] ? TYPES[t](value) : true))
    if (!ok) {
      errors.push({ path: path || '/', message: `expected ${types.join('|')}`, value })
      return errors
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path: path || '/', message: `must be one of ${JSON.stringify(schema.enum)}` })
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength)
      errors.push({ path: path || '/', message: `minLength ${schema.minLength}` })
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum)
      errors.push({ path: path || '/', message: `minimum ${schema.minimum}` })
    if (schema.maximum != null && value > schema.maximum)
      errors.push({ path: path || '/', message: `maximum ${schema.maximum}` })
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errors.push(...validateSchema(v, schema.items, `${path}/${i}`)))
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties || {}
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push({ path: `${path}/${req}`, message: 'required' })
    }
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errors.push(...validateSchema(v, props[k], `${path}/${k}`))
      else if (schema.additionalProperties === false)
        errors.push({ path: `${path}/${k}`, message: 'additional property not allowed' })
    }
  }
  return errors
}

/**
 * 通过 JSON 序列化做深拷贝（仅支持 JSON-safe 数据；undefined 原样返回）。
 * @param {*} o 任意 JSON-safe 值
 * @returns {*} 深拷贝结果
 */
export function deepClone(o) {
  return o === undefined ? undefined : JSON.parse(JSON.stringify(o))
}


// 敏感键名正则：命中即整体打码，避免密钥/口令随快照与 API 输出泄漏
const SENSITIVE_KEY = /(^|_)(cookie|cookies|token|access_token|refresh_token|rkey|clientkey|csrf|csrf_token|password|passwd|secret|authorization|privatekey|private_key)$/i
/**
 * 深拷贝并打码：敏感键替换为 [REDACTED]、secretRef 只留引用元数据、Buffer 转 '[binary]'、超长字符串截断。
 * 用于运行快照 / API 输出；不改动内存中的原始执行数据（§12.3 / §20.4）。
 * @param {*} value 任意运行数据
 * @returns {*} 打码后的深拷贝
 */
export function redactDeep(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 4000) return value.slice(0, 4000) + '…[truncated]'
    return value
  }
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value.kind === 'secretRef') return { kind: 'secretRef', id: value.id, version: value.version }
  if (Buffer.isBuffer(value)) return '[binary]'
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (v && typeof v === 'object' && v.kind === 'secretRef') { out[k] = { kind: 'secretRef', id: v.id, version: v.version }; continue }
    if (SENSITIVE_KEY.test(k)) { out[k] = '[REDACTED]'; continue }
    out[k] = redactDeep(v)
  }
  return out
}
