// ============================================================================
// 文件：index.js — 插件宿主导入入口（docs §21）
// 职责：仅做生命周期桥接：在真实云崽宿主中注册插件，再由宿主启动 src/server.mjs 的控制 API。
// 架构位置：Host load entry，是被宿主 require/import 的最外层；本身不含业务逻辑。
// 主要导出：默认导出类 YunzaiFlowPlugin（name / version / init / dispose）。
// 说明：独立 MVP 运行时直接 `npm start`（node src/server.mjs），不经过本文件。
// ============================================================================
export default class YunzaiFlowPlugin {
  constructor() { this.name = 'yunzai-flow-plugin'; this.version = '0.1.0' }
  async init() { console.log('[yunzai-flow] plugin init — start standalone: node src/server.mjs') }
  async dispose() {}
}
