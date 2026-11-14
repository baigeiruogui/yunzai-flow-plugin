// ============================================================================
// scheduler.mjs — 运行限额调度器：并发与背压控制
// 架构位置：runtime 之外的限流层；多个会话并发触发工作流时统一经 RunLimiter 排队。
// 职责：全局并发上限（maxActive）、每会话串行（perConversation）、队列上限与排队超时。
// 主要导出：RunLimiter
// 规范依据：§7.4（去重与运行限额）
// ============================================================================
/**
 * 运行限额调度器：全局最多 maxActive 个并发，每个 key（通常为会话 id）最多 perConversation 个并发。
 * 超限任务排队等待；队列满直接拒绝（QUEUE_FULL），排队超过 30s 拒绝（QUEUE_TIMEOUT）。
 * 纯逻辑类，无 IO 依赖，可直接单测。
 */
export class RunLimiter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxActive=8] 全局最大并发运行数
   * @param {number} [opts.perConversation=1] 每个 key 的最大并发（=1 即每会话串行）
   * @param {number} [opts.queueLimit=100] 排队上限，超出即背压拒绝
   */
  constructor({ maxActive = 8, perConversation = 1, queueLimit = 100 } = {}) {
    this.maxActive = maxActive
    this.perConversation = perConversation
    this.queueLimit = queueLimit
    this.active = 0
    this.per = new Map() // key -> 该 key 当前占用的并发数
    this.waiting = []
    this.stats = { started: 0, rejected: 0, queued: 0 }
  }
  /**
   * 判断指定 key 是否可启动：全局并发未满且该 key 的并发未满。
   * @param {string} key 会话/分组键
   * @returns {boolean}
   */
  _canStart(key) {
    return this.active < this.maxActive && (this.per.get(key) || 0) < this.perConversation
  }
  /**
   * 在限额内执行 fn：满足条件立即执行，否则排队等待；返回 fn 的结果，或抛出背压/超时错误。
   * @param {string} [key='default'] 会话/分组键（不同 key 互不占用对方的 perConversation 配额）
   * @param {Function} fn 要执行的异步任务
   * @returns {Promise<*>} fn 的返回值
   */
  async run(key = 'default', fn) {
    // 队列已满直接拒绝（背压），防止无界排队拖垮内存
    if (this.waiting.length >= this.queueLimit) { this.stats.rejected++; const e = new Error('队列已满，背压拒绝'); e.code = 'QUEUE_FULL'; throw e }
    if (!this._canStart(key)) {
      this.stats.queued++
      await new Promise((resolve, reject) => {
        const item = { key, resolve, reject }
        // 排队超时保护：30s 内未被唤醒就从队列移除并拒绝，避免任务永远卡住
        item.timer = setTimeout(() => { const i = this.waiting.indexOf(item); if (i >= 0) this.waiting.splice(i, 1); const e = new Error('排队超时'); e.code = 'QUEUE_TIMEOUT'; reject(e) }, 30000)
        this.waiting.push(item)
      })
    }
    this.active++; this.per.set(key, (this.per.get(key) || 0) + 1); this.stats.started++
    try { return await fn() }
    finally {
      // 释放配额：key 计数归零时删除条目，保持 per 表干净
      this.active--; const n = (this.per.get(key) || 1) - 1; if (n <= 0) this.per.delete(key); else this.per.set(key, n)
      this._drain()
    }
  }
  /**
   * 释放名额后唤醒等待队列中第一个可启动的任务（FIFO）。
   * 一次只唤醒一个：唤醒后名额即被占用，需等下一次释放再继续。
   */
  _drain() {
    for (let i = 0; i < this.waiting.length; i++) {
      const it = this.waiting[i]
      if (this._canStart(it.key)) { this.waiting.splice(i, 1); clearTimeout(it.timer); it.resolve(); return }
    }
  }
  /**
   * 当前调度状态快照。
   * @returns {{active:number, waiting:number, per:object, stats:object}}
   */
  snapshot() { return { active: this.active, waiting: this.waiting.length, per: Object.fromEntries(this.per), stats: { ...this.stats } } }
}
