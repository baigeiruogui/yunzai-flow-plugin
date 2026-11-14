// ============================================================================
// 文件：src/host/adapter.mjs — 宿主适配与探测（§8.1）
// 职责：优先复用真实云崽宿主（global.Bot / global.redis）；探测不到时进入“诊断模式”并如实标注。
// 架构位置：服务端启动时装配；bootstrap 端点通过 detect() 输出宿主/运行模式报告。
// 主要导出：HostAdapter（detect 探测、hostRedis 复用宿主 Redis、pickBot 选机器人）。
// 原则：不假设各云崽分支都有同名方法（§8.3）：只探测存在的入口，探测结果对外可见。
// ============================================================================
export class HostAdapter {
  constructor({ config, logger = console } = {}) { this.config = config || {}; this.log = logger; this.host = null; this.mode = 'diagnostic' }

  async detect() {
    const report = { adapter: this.config.host?.adapter || 'unknown', detected: [], missing: [], mode: 'diagnostic', features: {} }
    // 1) 真实云崽宿主：通过 global.Bot / global.redis / 事件总线探测
    const g = globalThis
    if (g.Bot && typeof g.Bot === 'object') { report.detected.push('global.Bot'); report.features.bot = true }
    else report.missing.push('global.Bot')
    if (g.redis && typeof g.redis.get === 'function') { report.detected.push('global.redis'); report.features.redis = true }
    else report.missing.push('global.redis')
    const ver = g.Bot?.version || g.Bot?.uin || null
    if (ver) { report.version = String(ver); report.detected.push('bot.version') }

    // 2) 版本/特征输出
    if (report.features.bot && report.features.redis) { this.mode = 'host'; report.mode = 'host' }
    else { this.mode = 'diagnostic'; report.mode = 'diagnostic'; report.note = '未探测到真实云崽宿主（global.Bot/global.redis）。当前为诊断模式：NapCat 直连与模拟传输可用，宿主 Redis 复用不可用。' }
    this.host = report
    return report
  }

  // 宿主 Redis 适配：有则复用宿主实例，无则明确报错而不是偷偷换内存缓存（§11.4）
  async hostRedis() {
    const g = globalThis
    if (g.redis && typeof g.redis.get === 'function') return g.redis
    const e = new Error('宿主 Redis 不可用（诊断模式）'); e.code = 'HOST_REDIS_UNAVAILABLE'; throw e
  }

  async pickBot() {
    const g = globalThis
    if (Array.isArray(g.Bot?.uin)) return { uin: g.Bot.uin[0], source: 'global.Bot.uin' }
    return { uin: null, source: 'none' }
  }
}
