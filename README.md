# 云崽可视化工作流插件（MVP）

按照 `云崽可视化工作流插件_开发文档_v1.0.md` 落地的 **M0 契约 + M1 真实纵向切片** 的可运行实现。
零外部依赖（Node 内置模块 + 原生前端），无构建步骤，`node src/server.mjs` 即跑。

> 这不是 178 项 NapCat 全覆盖成品（那是 M3 路线图）。目标是把文档里最核心、最能证明架构成立的一条链路做成**可点、可连、可跑、有测试**的东西。

## 快速开始

```bash
cd plugins/yunzai-flow-plugin
node src/server.mjs            # 默认 127.0.0.1:5088
# 或对外可访问：
HOST=0.0.0.0 PORT=5088 node src/server.mjs
npm test                       # 12 个引擎测试
```

打开 `http://<host>:5088/`。文档根即编辑器。

## 已实现（对照文档）

| 文档章节 | 实现 |
| --- | --- |
| §3 Web 画布 | 深色无限画布、家族库、节点卡片、端口连线（控制实线/数据虚线）、选择、拖拽、删除、缩放平移、适应视图 |
| §6 节点三元组 | `src/registry.mjs`：13 家族 / 21 操作的 `inputSchema / outputSchema / effect / requiredCapabilities / execute` |
| §6.2 绑定 | `bindings`（JSON Pointer，RFC 6901）+ 编译期来源校验；前端由 bindings 重建数据边 |
| §7 执行/分支/去重 | `src/runtime.mjs`：控制流激活、条件 true/false 分支（未选分支标 skipped）、按 `botId+eventId+workflow+trigger` 去重、effect ledger、节点状态机 |
| §7.5 幂等/副作用 | `src/capabilities.mjs`：send/write/admin 登记 effect；模拟模式拦截副作用（写 Redis/发送不进真实态） |
| §10 HTTP | `core.http.request`（mock:// 与真实 fetch 带超时/大小语义） |
| §11 Redis | `core.cache` get/set/incr/del，宿主式命名空间 `yf:v1:<wf>:<bot>:<scope>:<key>`，原子 incr + TTL，false/0 保真 |
| §12 加解密 | `core.crypto`：AES-256-GCM 版本化信封 `yf.crypto.aead.v1`（协议 AAD 按 §12.2 构造）、Ed25519 签名 `yf.crypto.signature.v1`；密钥全程 secretRef |
| §12.3 密钥 | `SecretService`，运行快照/日志不含明文（有测试） |
| §13.4 生成链思想 | registry 是唯一真源，前端表单/引擎执行同一 Schema |
| §18 持久化/发布 | `src/storage.mjs`：草稿 revision 并发控制、不可变发布快照（version）、原子写；`§18.3` 发布后改草稿不影响旧版 |
| §19 控制 API | `src/server.mjs`：`/bootstrap /registry /workflows /validate /publish /runs /coverage /resources` 等 |
| §20 安全边界 | 密钥句柄、effect 拦截、敏感字段 redact；默认 loopback（演示可 0.0.0.0） |
| §22.1 端到端示例 | `wf_hello` 群欢迎；另附 `wf_checkin`（原子签到+分支）、`wf_crypto`、`wf_http` |
| §24 验收矩阵（子集） | 12 个 `node:test` 覆盖 RUN-02 去重、GRAPH-01/04、CRYPTO-01/02、SECRET-01、REDIS-02/03、STORAGE/VERSION、HTTP-01 等 |

## 目录

```
index.js                宿主加载入口（桥接占位）
src/lib.mjs             JSON Pointer / 微型 JSON Schema 校验
src/registry.mjs        13 家族 / 21 操作（唯一真源）
src/compiler.mjs        DAG/端口/绑定/权限校验 → 执行计划
src/runtime.mjs         调度器：控制流、绑定求值、去重、effect、状态
src/capabilities.mjs    Secret/Cache/Crypto/Http/QQ/Render/DataSource + 能力客户端
src/storage.mjs         工作流/版本/运行的原子 JSON 存储
src/seed.mjs            4 个示例流程
src/server.mjs          控制 API + 静态 Web
web/                    原生画布编辑器（index.html / style.css / app.js）
test/engine.test.mjs    12 个引擎测试
config/config.json      部署配置（§21.1）
```

## 诚实的范围声明（覆盖率分轴，不混算）

- **MVP：13 家族 / 21 操作**，全部可运行、有测试。
- **NapCat 178 基础操作：全部已生成映射元数据（178/178，家族/operation/effect/权限）**，其中 4 项结构化专用表单、174 项通用 JSON 表单；契约测试 2 项（send_msg / set_group_add_request）；**实机验证 0**（无真实 NapCat 连接，执行走模拟适配器）。清单由 `scripts/generate-napcat.mjs` 从文档附录 §26.1 生成到 `schemas/napcat/4.18.38/actions.json`。
- **事件**：`message.group / message.private / timer / raw` 归一化信封；全事件族为路线图。
- **消息段**：仅 `text`；23 类为路线图。
- **未实现**：真实宿主 TRSS-Yunzai 挂载、真实 NapCat 实例联调（HTTP/WS 传输与 retcode/echo 契约已实现并有 mock 契约测试，填入 `config.napcat.httpUrl/wsUrl/accessToken` 即切直连）、公共节点商店。
- **配对鉴权**：已实现单次配对码→会话 token（默认 `web.requireAuth=false` 便于演示；置 true 即保护全部业务接口）。
- **代码节点**：owner-trusted-process 模式（独立子进程 + 超时 SIGKILL + 内存上限 + 模拟禁网），属**故障隔离**而非安全沙箱——不可信导入代码仍需 OS/容器级隔离，见 §16.3。
- **循环**：`core.loop.forEach` 为真实控制流（body 子图按 item 逐次执行，有测试 3 次发送）；`forEachTemplate` 为数据级简化保留。

> 依据文档 §24.2：本仓库不会用“节点数量”或“一个原始调用入口”冒充全覆盖。


## 更新（Round 2）

- **NapCat 178 全覆盖映射**：`scripts/generate-napcat.mjs` 从文档附录 §26.1 机械生成 178 项 action 清单；`src/integrations/napcat/manifest.mjs` 为每项生成家族/操作/effect/权限元数据与通用表单，覆盖率**分轴**报告（映射 178 / 结构化表单 4 / 通用 174 / 契约 2 / 实机 0），不混算。
- **真实控制流循环** `core.loop.forEach`：`body`/`done` 双端口，runtime 逐 item 执行 body 子图；示例 `wf_loop`「批量」→ 3 条发送（有测试）。
- **JSON 点选建绑定（§3.3）**：检查器里每个可绑定口有「选择来源」，弹出的字段树来自上游节点 outputSchema + 最近一次运行的真实 JSON，点字段即建绑定并画出数据虚线。


## 更新（Round 3）

- **SQLite 存储驱动**（§18.2）：`src/storage.mjs` 新增 `SqliteStore`（`node:sqlite`，表 workflows/versions/runs），`createStore()` 按 `config.storage.driver` 选择，默认已切到 `sqlite`（`data/flow.sqlite`）；JSON 驱动保留为兜底。测试覆盖工作流/版本/运行 round-trip。
- **SSE 实时运行事件流**（§19）：`POST /workflows/:id/runs/stream` 以 `text/event-stream` 推送 `run.start / node.start / node.ok / node.fail / loop.iteration / run.end / done`；runtime 增加 `onEvent` 事件钩子（有测试校验事件序列）。前端「运行」已改为消费该流，节点状态实时点亮（实测请求命中 `/runs/stream`）。


## 更新（Round 4）

- **代码节点沙箱（§16）**：`src/code/supervisor.mjs` 为每个任务 `spawn` 独立 Node 进程（`--max-old-space-size`），超时 `SIGKILL` 回收；`worker.mjs` 用 AsyncFunction 执行（**不在主进程 eval**），提供受限 `sdk`（log/uuid/base64/hash/http），模拟模式禁网。节点 `core.code/js` 接入画布/画布运行/流式。示例 `wf_code`「/算」→ 代码节点 → 模板 → 发送。测试：正常执行注入下游、超时终止返回 `CODE_TIMEOUT`、抛错 `CODE_RUNTIME`、模拟禁网 `CODE_NET_BLOCKED`。
- **移动端响应式（§3.5）**：`<768px` 侧栏变抽屉（汉堡 `☰` 唤出）、检查器变底部面板、运行面板单列、隐藏 HUD；经 390px 视口实测 `matchMedia` 命中、抽屉 `translateX(-248px)`、无横向溢出。


## 更新（Round 5）

- **配对鉴权（§20）**：`src/auth.mjs` 一次性配对码（6位、限时、单次）→ Bearer 会话 token（可撤销/过期）；服务启动打印配对码，`/auth/pair` `/auth/status` `/auth/logout`；`web.requireAuth=true` 时中间件保护所有 `/api/flow/v1/*`（health/pair/status 除外）。测试覆盖：正确兑换、重复使用拒绝、错误码拒绝、过期拒绝、撤销、会话过期。
- **事件全族规范化（§8.2 / §26.2）**：`src/events.mjs` 把 OneBot 原始事件（message/message_sent/request/meta_event/notice 各子类型/未知）规范化为统一信封（category/subtype/chat/sender/message/request/notice + 保留 raw）；新增 `core.trigger/event`「高级事件匹配」操作；事件目录 38 条分状态（supported 26 / opt-in 2 / conditional 9 / preserve 1）。示例 `wf_event`「入群申请自动通过」：`request.group.add` → set_group_add_request → 发送。测试覆盖规范化与事件触发命中/不命中。


## 更新（Round 6）

- **子图封装与版本引用（§17）**：`SubgraphStore` 保存版本化子图定义（`id__v<ver>.json`），`contentHash` 锁定（graph+公开输入/输出摘要）。`core.subgraph/call` 节点按 `subgraphId+version` 加载并对 `contentHash` 校验；runtime 以嵌套 run 执行内部图（伪节点 `__input__` 注入公开输入，`publicOutputs` 回传），递归深度上限 6。示例子图 `sg_greet@1`「打招呼卡片」+ 父流程 `wf_subgraph`「/子图」→ 调用子图 → 发送。测试覆盖：输入注入/输出回传、contentHash 不匹配拒绝。


## 更新（Round 7）

- **流程导入/导出（§18.4）**：`src/portability.mjs` `exportWorkflow` 生成 `yf.workflow.bundle.v1`（自动携带被引用的子图定义 + secretAliases，**不含凭据正文**）；`importBundle` 导入为新草稿、**默认停用**、子图随包带入。前端顶栏「导出 / 导入 / 备份」。
- **备份/恢复（§18.4）**：`createBackup` 汇总全部工作流 + 子图（`yf.backup.v1`，无凭据）；`restoreBackup` 恢复后**所有流程强制停用**，避免"恢复即群发"。接口 `/backup` `/restore`。测试覆盖：导出不含凭据、导入到空环境可编译、备份计数、恢复后全停用。


## 更新（Round 8）

- **数据源声明 + 三入口共用执行（§15）**：`src/datasource.mjs` `DataSourceRegistry` 加载 `datasources/*.json`（§15.2 格式：connection/request/response.mapping/pagination/cache/rateLimit/effect/tool）；`DataSourceRuntime` 统一执行输入映射→鉴权(secretRef)→HTTP→响应映射→缓存。三入口：画布节点 `integration.datasource`、REST `/tools/call`、AI 工具描述 `/tools`（**写/管理操作默认不导出**）。示例 `demo.user-profile`（getProfile 读 + setNick 写）+ 流程 `wf_ds`「/资料」→ 数据源→模板→发送。测试覆盖声明执行、工具过滤、端到端。


## 更新（Round 9）

- **结构化表单生成器（§13.4 步骤4 overlay）**：`overlays/napcat/4.18.38/actions.overlay.json` 手维护 26 个高频 NapCat 操作的真实 input/output Schema + 表单字段 + effect/权限/标题；`manifest.mjs` 加载 overlay，把对应操作从通用 JSON 表单**升级为结构化表单**。覆盖率随之更新：178 映射 / **结构化表单 30**（4 手写 + 26 overlay）/ 通用表单 148 / 契约测试 2 / 实机 0。示例：`qq.member/set_group_kick` 现在有「群号/QQ/拒绝再申请」三个真实字段。


## 更新（Round 10）

- **结构化表单扩到 65**：overlay 从 26 → 61 条（file/album/voice/social/utility/credentials/system/user/request 等），覆盖率更新为 **结构化 65 / 通用 113**。
- **OneBot 传输适配（§8.3/§13.6）**：`src/integrations/napcat/transport.mjs` 实现 `OneBotHttpTransport`（echo 关联、access_token、`status+retcode` 判定：HTTP 200 但 retcode 失败→业务失败）与 `OneBotWsTransport`（全局 WebSocket、echo 队列、超时）；`NapCatAdapter` 统一入口。能力客户端：配置了 `services.napcat` 且 real 模式时，`qq.send`/`qq.action` 走真实传输，否则回落模拟。`config.napcat.httpUrl/wsUrl/accessToken` 就绪。契约测试用本地 mock OneBot 服务器覆盖：成功/业务失败/HTTP 错误/token 头/echo。


## 更新（Round 11）

- **宿主探测 HostAdapter（§8.1）**：`src/host/adapter.mjs` 探测 `global.Bot` / `global.redis`；探测到 → host 模式，否则 → **诊断模式**并在 UI 标注「宿主 trss-yunzai (诊断)」。`hostRedis()` 无宿主时明确报错（不偷偷换内存缓存）；`pickBot()` 探测 uin。测试覆盖两种探测结果。
- **直连 OneBot 真链路 + 运行时切换（§8.3）**：`scripts/mock-onebot.mjs` 是本地 OneBot 11 HTTP 协议服务器（实现 send_msg/get_group_info/set_group_ban… + `/status` 调用日志页）。新增 `POST /transport` 运行时切换传输（连接时先 `get_login_info` 探测）；UI 顶部「传输」徽标显示 `🟢 OneBot · direct-onebot-http` 并可点开配置。实测：连上本地 OneBot 后，`wf_hello` real 运行 → mock 真实收到 `send_msg`，回执 `message_id:1001, simulated:false`。
- 说明：这是对**真实 OneBot 协议端点**的直连验证；换成你的 NapCat（`httpUrl`+token）即可同一路径接真机。


## 更新（Round 12）

- **节点帮助内容（§2）**：`src/help.mjs` 为 22 个核心操作手写「作用/何时用/输入/输出/示例/常见错误」，其余按 Schema 回退；`registry.toJSON` 注入 `op.help`，检查器新增「帮助」栏。
- **公共节点目录（§4.3）**：`GET /catalog` + 前端「帮助」按钮，弹出 25 家族/199 操作的可搜索目录，每项显示一句话作用 + 结构化/通用表单标签。
- **首次使用引导（§2）**：首次打开弹三步上手引导（拖节点→配参数→运行），可关闭（localStorage 记住）。


---

## 交付文档

- [质量加固报告](docs/质量报告.md)：12 轮加固的护栏体系、已修缺陷、已知限制与 `npm run check`。

- [总交付报告](docs/交付报告.md)：一页汇总能力矩阵、证据、运行方式与缺口。

- [实现对照报告](docs/实现对照报告.md)：逐章对照文档 §1–§26 的实现状态与缺口。
- [验收报告](docs/ACCEPTANCE.md)：由 `npm run verify` 生成的真数据（测试/能力统计）。


## 更新（Round 14）

- **工作流新建/删除（§19）**：`POST /workflows`（新草稿）、`DELETE /workflows/:id`；存储层 JSON/SQLite 均支持。
- **画布编辑补齐（§3.2）**：撤销/重做（Ctrl+Z / Ctrl+Shift+Z，快照栈 60 步）、点击控制连线选中并按 Delete 删除、复制节点（Ctrl+D）、顶栏「＋新建」「↶」「↷」。实测：加节点 7→8、撤销→7、重做→8；删连线 6→5；新建标签 9→10。


## 更新（Round 15）

- **画布交互补齐（§3.2）**：Shift+点击多选、Shift+拖拽框选、Ctrl+C/V 复制粘贴（含内部连线重映射）、Ctrl+D 复制、Delete 删除多选、多选后「▦分组」画分组框（可删）。实测：多选选中 2、复制粘贴 7→9、框选选中 5、分组框 1、删除选中 9→4。


## 更新（Round 16）

- **运行历史面板（§3.1）**：底部新增「历史运行」列，列出当前流程最近运行（状态/模式/时间），点击载入该次运行的节点轨迹与日志（`GET /workflows/:id/runs` + `GET /runs/:id`）。
- **工作流管理（§19）**：流程标签带 ✕ 删除（DELETE）、双击标签重命名（PUT title）。实测：跑一次后历史 4 条、点击载回 `成功·3ms` 轨迹 3 节点、标签删除按钮就位。


## 更新（Round 17）

- **执行目录补齐（§9）**：新增 `core.regex`（提取/替换/拆分）、`core.wait`（延时，上限 2000ms）、`core.data` 数组变换（filter/sort/unique/mapField）。家族 25→27、操作 199→207。测试：正则提取/替换/拆分、数组过滤/排序/去重/抽字段、延时等待，37/37 通过。


## 更新（Round 18）

- **控制节点（§7.2/§9）**：新增 `core.control`：`merge`（合流，取实际到达分支的值；编译器允许多控制输入）、`stop`（终止分支）。示例 `wf_merge`「/评分」：条件两分支 → Merge → 发送。家族 27→28、操作 207→209。测试：Merge 合流（true 分支到达、false 分支 skipped、下游取对值）+ Stop 终止。


## 更新（Round 19）

- **Switch 多路分支（§7.2）**：`core.control/switch`（2 路 + 默认），只走匹配分支，其余 skipped。测试覆盖。
- **第二个数据源包（§15）**：`datasources/demo.weather.json`（getWeather，声明驱动 + 缓存 + AI 工具 `demo_get_weather`）。现共 2 个数据源包 / 2 个 AI 工具。
- 家族 28 / 操作 210。测试 41/41。


## 更新（Round 20）

- **Try/Catch 错误域（§7.2）**：`core.control/tryCatch`（body/catch/done 三出口），runtime 引入 try 栈：body 子图内节点失败被捕获（`st.status=failed` 但不中止整轮），转入 catch 分支，再走 done。示例 `wf_try`「/试」：body 内代码节点抛错 → catch → 发送「已捕获错误，流程继续 ✅」。家族 28/操作 211，测试 42/42。


## 更新（Round 21）

- **性能与健壮性（§3.5/§24）**：`scripts/bench.mjs` 合成大图基准——501 节点 compile 3.6ms / 模拟运行 7.7ms；前端 500 节点整图重建 ~394ms（camofox 实测）；编译器 fuzz 300 随机畸形图不抛异常。详见 [docs/PERFORMANCE.md](docs/PERFORMANCE.md)。测试 43/43。


## 更新（Round 22）

- **结构化表单 65 → 154（源码 TypeBox 提取）**：`scripts/gen-forms-from-source.mjs` 解析 NapCatQQ@bbd0d2ac 各 action 类的 `PayloadSchema = Type.Object({...})`（字段名/类型/描述/enum/必填），生成 `overlays/napcat/4.18.38/actions.generated.json`（147 项，126 项含真实字段）；manifest 合并生成 overlay（手写 overlay 优先）。结果：**结构化 154 / 通用 24**（61 手写 + 89 源码提取 + 4 原始手写），generic 仅剩 24。
- 说明：字段来自真实源码 TypeBox 定义（非臆造），但为启发式解析（复杂嵌套类型降级为 object/string）；实机验证仍为 0，契约测试 2。


## 更新（Round 23）

- **结构化表单 154 → 178 / 通用 0**：为剩余 24 个操作补手写 overlay（转发/私聊/戳一戳/相册/Ark/自定义表情/群待办/精华/打卡等）。**NapCat 178 项：映射 178、结构化表单 178、通用 0**。契约测试仍 2、实机仍 0（需真实实例）。


## 更新（Round 24）

- **全量契约测试（§24.2）**：`test/contract.test.mjs` 对全部 178 项做「结构契约」（三元组/effect/权限/表单 Schema）与「可执行性契约」（每项编译成 trigger→节点 的流程、模拟模式执行成功）——**结构 178 / 可执行 178**；行为契约仍 2（send_msg、set_group_add_request），实机 0。覆盖率报告新增 `结构/可执行/行为` 三轴。测试总数 43→45。


## 质量加固（"弄完美"第 1 轮）

- **静态资源不再缓存**：`html/js/css` 响应加 `Cache-Control: no-store`——彻底避免"改了代码/样式但浏览器用旧缓存"导致的界面错乱（正是之前"卡住点不动"的根因类别）。
- **UI 冒烟回归** `scripts/ui-smoke.mjs`（`npm run smoke:ui`）：用 camofox 真开页面，断言「遮罩默认隐藏 / 引导可关 / 关键按钮齐全 / 可加节点 / 可运行且完成 / 覆盖率弹窗可开关 / 无横向溢出」。8 项全过。
- **运行限额调度** `src/scheduler.mjs`（§7.4）：全局并发、**每会话串行**、排队上限与 `QUEUE_FULL` 背压真正落地（此前仅 config 有、运行时不生效）；单测覆盖并发上限/串行/背压。
- **行为契约补充**：qq.send 经适配器把 target 转 message_type/group_id 的行为测试；传输 retcode/echo/token 已有。
- 全部校验：`node --check` 全通过 · `npm test` **49/49** · `npm run verify` ok · `npm run smoke:ui` 全过。


## 质量加固（"弄完美"第 2 轮）

- **密钥持久化 + 加密落盘（§12.3）**：`SecretService` 支持 `filePath`，密钥值以 **AES-256-GCM** 加密写入 `data/secrets.json`（0600），主密钥来自 `YF_SECRET_KEY` 或 `data/.secret.key`（0600，首次生成并告警"生产请用环境/OS 密钥库"）。重启后自动解密加载（实测：重启前后文件哈希不变、`wf_crypto` 仍能加密成功）；文件**不含明文**（`grep sk-demo-9f8e7d` = 0）；API 只暴露 `{id,type,version,owner}`。
- **OneBot 行为契约补充**：审批成功→运行 succeeded；踢人 retcode 102→节点 `ONEBOT_BUSINESS`、运行 failed（错误从传输层正确冒泡）。
- 校验：`npm test` **51/51** · `npm run smoke:ui` 全过。


## 质量加固（"弄完美"第 3 轮）

- **UI 冒烟扩到 14 项**：新增覆盖 加节点/撤销/重做、节点长文本不溢出、Shift 多选、检查器帮助、运行历史有记录且可载回、无 JS 错误；`npm run smoke:ui` 全过。
- **冒烟当场抓到并修掉一个真 bug**：`core.trigger/event` 的字段标签过长，会把节点里的参数值挤出卡片——已缩短标签 + `.bd/.kv` 溢出约束 + 标签省略号。现在 textNoSpill 通过。
- 校验：`npm test` **51/51** · `npm run smoke:ui` **14/14** · `npm run verify` ok。


## 质量加固（"弄完美"第 4 轮）

- **API 冒烟回归** `scripts/api-smoke.mjs`（`npm run smoke:api`）：21 项正/负例——健康、registry、流程 CRUD、校验、运行、历史、导出/备份、工具、数据源、子图、覆盖、鉴权；负例 404/400（未知流程/非法导入/非法恢复/未知工具）。
- **冒烟抓到并修掉真 bug**：`DELETE /workflows/:id` 删除不存在的流程返回 200（SQLite 驱动未判存在性）→ 已修（返回 404）。
- **前端全局错误可见化**：`window error / unhandledrejection` 统一弹 toast，避免"点了没反应却不知道原因"；并加**过期请求丢弃**（快速切换流程不会被旧响应覆盖）。
- 校验：`npm test` **51/51** · `npm run smoke:api` **全过** · `npm run smoke:ui` **14/14** · `npm run verify` ok。


## 质量加固（"弄完美"第 5 轮）

- **脱敏审计（§12.3/§20.4）**：新增 `lib.redactDeep`，对**运行快照/API/持久化**统一处理——敏感键（cookie/token/rkey/clientkey/csrf/password/secret/authorization…）一律打码，`secretRef` 保留引用、二进制转 `[binary]`、超长文本截断；`sanitizeRun` 用于 `/runs`、`/runs/:id`、SSE done 与落库，内存执行数据不受影响（普通输出如模板文本原样返回）。测试覆盖嵌套/数组/secretRef/二进制。
- 校验：`npm test` **52/52** · `smoke:api` 全过 · `smoke:ui` 14/14 · `verify` ok。


## 质量加固（"弄完美"第 6 轮）

- **恢复前自动备份（§18.4）**：`restoreBackup` 支持 `backupDir`，恢复前先把当前数据写到 `data/backups/pre-restore-<ts>.json`，避免误恢复丢数据；接口实测 `preBackup:true`、文件已生成。
- **UI 冒烟新增「导入弹窗可开」**（现 15 项）；**聚合校验命令 `npm run check`** = `node --test` + `smoke:api` + `smoke:ui` 一次跑全绿。
- 校验：`npm run check` → 53/53 + API 全过 + UI 全过。


## 质量加固（"弄完美"第 7 轮）

- **画布增量渲染**：`renderNodes` 改为按 `id` 复用 DOM——只新增/删除/变更的节点重建，不再每次 `innerHTML=''` 整块重绘。分组框拆到独立 `#groups` 层。效果：500 节点图**单个节点增删/参数变更**只更新该节点（~30–90ms），大幅减少重绘抖动与卡顿；首次加载仍整图构建。
- 检查器改参数时节点卡片**即时刷新**（之前要等下一次重绘）。
- 校验：`npm run check` 全绿（53/53 + API + UI 15 项）。


## 质量加固（"弄完美"第 8 轮）

- **运行时重试策略（§7.6）**：节点 `policy.maxAttempts`（默认 1，上限 5）对**可重试失败**（`error.retryable`）生效，带退避；不可重试错误只调用一次。`st.attempts` 记录实际尝试次数。测试覆盖：可重试 3 次后成功、不可重试仅 1 次即失败。
- **未保存改动提醒**：改动（加删节点/连线/改参数）标记 dirty，离开页面触发 `beforeunload` 确认，避免误关丢改动；保存后清除。
- 校验：`npm run check` → 54/54 + API 全过 + UI 全过。


## 质量加固（"弄完美"第 9 轮）

- **移动端修复**：两行顶栏在 390px 上曾被按钮换行撑到 **159px** 高——已改窄屏工具栏为**单行横向滚动 + 按钮不收缩 + 隐藏次要信息**，实测顶栏降到 **79px**、无横向溢出；侧栏抽屉、检查器底部面板、☰ 菜单按钮均正常。
- **移动端冒烟 `npm run smoke:mobile`（8 项）**：390px 断点命中 / 顶栏不过高 / 侧栏抽屉 / 抽屉默认收起 / 检查器底部面板 / 菜单按钮 / 无横向溢出 / 有节点。
- **`npm run check` 现含四套**：`node --test` + `smoke:api` + `smoke:ui` + `smoke:mobile`，全绿（54/54 + 三套冒烟）。


## 质量加固（"弄完美"第 10 轮）

- **黄金流程回归**：新增测试把**全部 11 个预置流程**逐个编译并模拟运行，断言"不失败"（`wf_event` 事件触发用消息事件应 `skipped`，其余 ≥9 成功）。防止某个内置示例/节点悄悄坏掉。
- 校验：`npm run check` → **55/55** + API + UI(15) + Mobile(8) 全绿。


## 质量加固（"弄完美"第 11 轮）

- **API 冒烟扩到 27 项**：新增负例/边界——未知运行 404、导出未知流程 404、空图校验 `ok:false`、工具调用缺 name 400、静态首页 200 且含入口脚本。全部通过（本轮未发现新 bug，护栏更密）。
- 校验：`npm run check` 全绿（55/55 + API27 + UI15 + Mobile8）。
