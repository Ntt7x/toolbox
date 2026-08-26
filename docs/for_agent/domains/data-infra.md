# 数据工程基础设施（data-infra）

> 架构：基于 SQLite 的稳定可用的数据工程基础能力（数据存储、消息队列、定时任务），具体需求作为能力的集成、运用与适配。
> 实现位置：`apps/server/src/core/data-infra/`（队列/任务/调度/派生器/消费者）+ 现有 `kvStore/tableStore`（存储）。

## 一、四层生命周期（核心认识）

数据/消息/任务/调度是**同一条数据流的不同抽象层**，统一在**可观测、可回溯、幂等**三原则下：

| 层 | 含义 | 生命周期 | 关键属性 |
|---|---|---|---|
| **数据 Data** | 被加工对象（账本/行情/快照） | 采集→存储→加工→归档 | 可持久化、可幂等重建 |
| **消息 Message** | 数据变化信号（事件） | 产生→传递→消费→ack→TTL | 至少一次投递 + 幂等消费 |
| **任务 Task** | 加工动作（有状态机实体） | 定义→调度→执行→完成/失败→历史→重试/回溯 | 幂等是第一原则 |
| **调度器 Scheduler** | "何时"触发 | 注册→触发→分发→优雅退出 | 只回答何时；触发=定时/手动/回溯 |

## 二、模块划分

- `queue.ts`（消息层）：`enqueue/dequeue/ack/queueStats/listQueues`——KV 持久化，至少一次投递 + 幂等消费；失败重投（attempts），超最大尝试丢弃；TTL 过期不投递
- `taskRegistry.ts`（任务层）：`registerTask/runTask/listTasks/listTaskHistory/setTaskStatus/deleteTask`——生命周期状态机（queued→running→done/failed→history）；并发防重；执行历史归档（上限 50）
- `scheduler.ts`（调度层）：`cron-parser`（纯 JS）+ 自研调度循环（setTimeout 到下一触发点）；启动时 missed 检测补跑；优雅退出
- `index.ts`：统一出口 + 数据源注册（本地数据管理可见 `dataInfra:*`）

## 三、选型决策与 trade-off（2026-08-26）

- **对话调研**推荐 `@km-dev/lite-q`（一站式队列+调度），但其**硬依赖 `better-sqlite3`（原生模块）**——Windows+node24 存在预编译缺失/需 node-gyp 编译风险
- **决策**：**自研轻量队列+调度（node:sqlite + cron-parser 纯 JS）**——零原生依赖、统一存储（toolbox.db）、无编译风险；`cron-parser` 为唯一新增依赖
- 备选记录：lite-q（若未来需求重可引入，接受 better-sqlite3）；DuckDB（数据分析列为未来演进，本期 SQLite 轻量查询）

## 四、运管与回溯

- 运管 API（`/api/data-infra/*`）：任务清单/历史/触发/暂停/恢复/删除/回溯/队列统计
- 前端「设置-数据基础设施」：任务状态/执行历史/队列积压/调度计划 + 操作按钮
- **回溯（backfill）**：`POST /api/data-infra/backfill {task, range?, force}`——幂等重跑重建派生数据（handler 必须幂等）

## 五、集成运用：净值快照（trade-v2）

- **buildDailySeries 按日展开**（compute.ts）：首笔交易日起**每天一行**（自然日）；无交易日持仓延续、买卖 0；市值=持仓×当日收盘价（无当日行情 forward-fill 前值、无行情标的后退成本口径）；`addDays` 用本地日期运算（避免 toISOString UTC 偏移死循环）
- **快照任务**（snapshotTask.ts）：cron 每日 16:30 调度 → 重放账本+行情 → 日终快照序列 → KV `tradeV2:snapshot:<groupId>`；可手动触发/回溯
- 效果：「配置长持」从 08-15 单点 → 逐日延伸 12 天（08-15~08-26，市值按日重估）

## 六、消息驱动工作流（derivator + consumer，2026-08-26）

两种组合工作流统一为六层引擎：
`调度器-任务-消息-FaaS` / `数据-任务-衍生数据-消息-FaaS`

| 层 | 模块 | 职责 |
|---|---|---|
| 派生层 Derivator | `derivator.ts` | 源事件（任务 done/failed、cron、手动）→ 派生消息入队；`when` 声明触发点，`derive` 声明派生逻辑（可重放） |
| 执行层 Consumer | `consumer.ts` | 消息 → FaaS 执行：持续 dequeue → handler → ack；失败自动重投；并发控制；幂等消费 |

- **任务完成钩子**：`taskRegistry.onTaskFinished`（done/failed 均触发）——派生器订阅它实现"任务完成 → 自动派生消息"
- **派生器 cron**：统一注册为调度任务（调度层只认任务；missed 补跑/运管可见/执行历史自动获得）
- **崩溃恢复（至少一次投递语义）**：`QueueMessage.processedAt` + `requeueStale`——启动时把"处理超时/无 processedAt（旧版残留）"的 processing 消息恢复为 pending；否则进程崩溃会导致消息永久卡 processing（真实事故教训）
- **失败自动重试**：`runTask(id, { maxRetries })`——幂等任务可设（快照/采集类），失败自动重试，历史记录每次尝试（第 N 次尝试，将重试）；LLM 任务谨慎（成本）
- **消费者统计**：`processedCount`/`lastConsumedAt`（进程内）——运管页展示"已处理 N · 最近 xx:xx"
- **健康检查**：`GET /data-infra/health` 一键体检——任务失败/队列积压/孤儿队列/消费者未运行/派生失败/未标记 KV，返回 `healthy` + `problems` 列表 + summary——前端顶部健康卡片（✅/⚠️）
- **运管**：overview/derivators/consumers/queues 端点 + 前端「数据基础设施」页（任务/派生器/消费者/队列/孤儿队列诊断）；`DELETE /data-infra/queues/:name` 清空；`GET .../messages` peek；`POST .../requeue-stale` 恢复

### 集成示例：知乎爬虫（features/zhihuCrawler）
- `finishCrawl` 完整结果 → `enqueue("zhihuCrawl:done", {...})`（源数据 → 衍生消息）
- 消费者 `zhihuCrawl:done` → `deriveZhihuStats` 聚合统计（类型分布/平均长度/日期范围）→ `zhihuCrawl:stats:<resultId>`（幂等按 resultId）
- 验证链路：造 result → enqueue → 消费者处理 → stats 生成 → ack 移除 ✅

### 集成示例：净值快照摘要（features/tradeV2/snapshotTask）
- 派生器 `tradeV2-snapshot-done`（taskDone 钩子）→ derive 读快照 KV 汇总各分组最新市值/日变化 → 消息
- 消费者 → `tradeV2:snapshot:summary`（幂等：消息内容即最终数据）
- 实测：触发快照任务 → 派生器 runs 1 → 消费者消费 → 摘要含 5 分组真实市值；**通过真实业务发现 series 字段为 marketValue 而非 nav（已修）**

## 七、爬虫可靠性（知乎，2026-08-26）

`apps/server/src/core/zhihuRateLimit.ts`（纯逻辑可单测）：
- **令牌桶限速**：全局共享（多任务/多类型间也限速）；"人类频率"= 桶速率而非固定 sleep
- **分级退避**：40362→长停 30min / 403→短停 5min / 429+timeout→指数退避（逐级加时）；连续成功 5 次降级
- **接入点**：humanDelay（令牌桶）、滚动翻页/评论（recordBlocked/recordSuccess）、fetchPinsApi（403/429 分类）
- **内容级指纹去重**：URL + content hash 双集合（seed 跨次去重，翻页重复兜底）
- **原子进度**：emitProgress 5s 节流持久化（崩溃最多丢 5s 增量；暂停/取消无条件持久化）
- 经验：TS parameter property（构造函数参数属性）strip-only 模式不支持 → 显式字段赋值

## 八、测试与测试环境约定（2026-08-26）

- **集成测试**（workflow.integration.test.ts）：调度→任务→派生器→消息→消费者全链路、missed 补跑、消费者并发、ack 幂等——测试进程内 start/stop 自管理
- **测试环境（TOOLBOX_TEST=1）**：`initDataInfra()`（数据源注册）**无条件执行**（app.integration 断言"未标记应为 0"依赖注册表完整）；`startDataInfraRuntime()`（调度器/消费者）**不启动**；`registerScheduledTask` **不挂定时器**——否则模块顶层注册的任务定时器卡测试进程（曾导致 app.integration 2min 超时）
- **测试残留治理**：测试文件用唯一 id + `beforeEach` + `after` 清理（最后一个测试后也清）；`kvListRaw` 默认 limit=200（全量扫描须传 200000）
- **数据源治理**：新 KV 前缀必须注册（未标记归零断言会拦）——本轮补 `experiment:window:`、`zhihuCrawl:` 的 stats 描述

## 九、业务接入规范与决策树（2026-08-26 沉淀）

> 目的：新需求/改造先判断是否该用数据工程，避免两极端——"全部套数据工程"（过度）或"继续手写 Ad-hoc"（重复轮子）。

### 9.1 接入决策树（按需求特征选层）

| 需求特征 | 用哪层 | 反例（不要） |
|---|---|---|
| "某数据要每日/定时更新" | 任务（cron）+ 派生器（完成后发消息） | 手动接口触发 + 无人管 |
| "某动作要定期检查/补跑/可回溯" | 任务（backfill/手动触发） | 一次性脚本手动跑 |
| "A 完成时要自动触发 B"（解耦） | 派生器（taskDone）+ 消息 + 消费者 | A 直接调 B 的函数 |
| "大量小任务要排队/限速/重试" | 队列 + 消费者（concurrency） | 并发 Promise.all 裸跑 |
| "过程数据要崩溃可恢复" | 队列（至少一次 + requeueStale） | 内存变量 + 启动丢 |
| "结果要聚合/衍生" | 消费者（幂等写衍生 KV） | 请求时实时重算 |
| 用户交互的实时进度任务 | 前台 SSE 任务（core/tasks）+ **登记** data-infra | 纯后台任务伪装 SSE |

### 9.2 注册范式（三件套）

业务方只声明三样，引擎执行：

```ts
// 1. 任务（何时跑 + 干什么）——可 cron/手动/回溯
registerScheduledTask({ id: "x-daily", type: "x", name: "X 每日更新", cron: "0 30 16 * * *", handler: async () => {...} });
// 2. 派生器（源事件 → 衍生消息）
registerDerivator({ id: "x-done", when: { taskDone: ["x-daily"] }, queue: "x:derived", derive: () => [{ type: "done", payload: {...} }] });
// 3. 消费者（消息 → 执行/衍生，必须幂等）
registerConsumer({ queue: "x:derived", name: "X 衍生", handler: async (msg) => {...} });
```

原则：
- **handler/derive 必须幂等**（重放安全——backfill/崩溃恢复依赖）
- **derive 只读持久化数据**（无副作用——可重放）
- **消费者消息内容即最终数据**（重复消费结果一致）或按业务键幂等
- 新 KV 前缀**必须 registerDataSource**（未标记归零断言拦截）
- 注册位置：feature 模块顶层（import 时）或 feature 注册函数内（两者均幂等安全）

### 9.3 前台 SSE 任务 vs data-infra 任务（双轨不互斥）

- 用户交互实时进度 → **core/tasks（SSE）**：进度实时推送给前端
- 后台生命周期 → **data-infra**：调度/历史/回溯/运管可见
- **登记模式（已实现，2026-08-26）**：`core/tasks.createTask` 传 `module` 时**自动** `registerExternalTask`（data-infra 记录生命周期：running→done/failed + lastResult + 历史）——业务零改动即获得运管可见；watchlist/bmpi 等缺 module 的 createTask 已补齐（watchlist.import/fundamental、experiment.bmpi）
- **统一模式**（未来可选）：分析任务全走 data-infra runTask，前端轮询任务状态——涉及前端 useAsyncTask 改造，分阶段做

### 9.4 统一模式（2026-08-26 落地）——分析任务一条链路

**原则**：所有"用户触发 → 后台分析 → 看进度/结果"的任务走同一条链路（data-infra），不再有第二套任务系统。

**服务端三件套**（ephemeral 一次性任务——每次请求动态 id，终态后自动清定义、KV 记录保留运管可见）：

```ts
const id = newTaskId("cb-rate"); // 业务前缀
registerTask({
  id, type: "cb-rate", name: taskName,
  handler: async (ctx) => {
    const r = await analyze(req, ctx.signal ?? new AbortController().signal);
    return { ok: true, message: "分析完成", result: r }; // result 挂任务记录
  },
}, { ephemeral: true }); // 终态后自动清 defs（KV 保留）
startTask(id, { trigger: "manual" }); // fire-and-forget
return c.json({ ok: true, taskId: id }, 202);
```

任务状态路由统一读 data-infra 详情（done → result；failed/cancelled/未完成 → 400 带 message）。

**基础设施**（taskRegistry 已支持）：
- `TaskRunOptions`：`signal`（runTask 自动注入 AbortController）/`progress`（进度快照 KV）/`taskId`
- `TaskHandlerResult.result`：结构化结果挂任务记录（前端 done 后经详情 API 读取）
- `cancelTask(id)`：abort 运行中任务 → 终态 `cancelled`（handler 内 LLM/IO 收到 signal）
- `startTask(id, opts)`：异步启动（fire-and-forget）
- `getTaskProgress(id)` + SSE `GET /api/data-infra/tasks/:id/stream`（status 事件：running/progress/done/failed/cancelled/notfound）
- `GET /api/data-infra/tasks/:id`：任务详情（状态 + 进度 + result）

**前端统一 hook** `useDataInfraTask<T>`（apps/web/src/hooks/useDataInfraTask.ts）：
- `create` 返回 `{ taskId }` 或 `{ result }`（缓存命中直接落地——cbRate/treasuryFx 缓存短路）
- SSE 优先 → onerror 一次降级轮询（不依赖 EventSource 自动重连）
- `fetchResult(taskId)` 业务注入（done 后调）；`cancel` 业务注入（缺省调 data-infra cancel）
- sessionStorage 跨页恢复（`resumeIfPending`）
- 已迁移：experiment（framework/ec/bmpi）、cbRate、treasuryFx——watchlist 前端手动轮询保留（服务端已统一）

**保留 core/tasks 的场景**（特殊交互流程，已登记 data-infra）：~~reverseRepo 手动入口、zhihuCrawler（浏览器自动化）、agentSessions（会话状态）~~ —— **2026-08-26 已全部迁移，core/tasks 退役**（tasks.ts/sse.ts/useAsyncTask.ts 已删除）：
- reverseRepo 手动入口 → 统一触发调度任务（startTask("reverseRepo-monthly")，状态锁防并发）；daily 探查 → ephemeral
- zhihuCrawler（auth/crawl/resume）→ ephemeral（onProgress 上报 SSE 进度）
- agentSessions（chat/reasonix ask）→ ephemeral
- 前端 `api.taskStatus/cancelTask/taskHistoryList/Entry` 全部映射 data-infra（兼容 AsyncTaskResult 契约）；TaskHistory 组件读 data-infra 任务记录（按 type 过滤）
- 旧 `taskHistory:` KV 数据已备份清理（`.file/kv-backup/`），数据源注册移除

### 9.7 统一模式整合（2026-08-26 P0+P1+P2）——去重与彻底统一

- **服务端 `taskResultOrError(c, taskId)` 公共 helper**（core/data-infra/taskResult.ts）：统一 404/400/200 三段式——9 处 feature 任务结果路由（cbRate/treasuryFx/experiment×3/reverseRepo/watchlist×3）全部改为调用——状态消息文案统一（"任务失败/已取消/未完成"）
- **业务结果路由退役**：`/tools/cb-rate/task/:id` 等 9 个业务 GET 路由删除——前端统一经 `GET /api/data-infra/tasks/:id`（详情）+ `api.dataInfraResult(taskId)` 读取结果（done → result；未完成抛错）
- **前端 fetchResult 统一**：7 个页面 `fetchResult` 一行化（`api.dataInfraResult<T>(taskId)`）——api.ts 死方法（cbRateTaskStatus 等 6 个）删除
- **ephemeral trim 加固**：`registerTask(ephemeral)` 注册时即触发裁剪（不只 cleanupRun——防连续运行永不触发）
- **P1-4 评估后不做**：`useAnalysisTask` 包装 hook 边际收益低（fetchResult/cancel 已一行化），避免过度抽象

### 9.8 兼容层全清除（2026-08-26 收尾）——不留 AsyncTaskResult 兼容

用户要求"别兼容了，都一块改了/重写"——彻底清除 core/tasks 时代遗留的所有兼容层：

- **api.ts 兼容方法全删**：`taskStatus`/`taskHistoryList`/`taskHistoryEntry`/`watchlistImportTaskStatus`/`watchlistFundamentalTaskStatus`/`watchlistAppendPreviewStatus` 全部移除——前端改用：
  - `dataInfraTask(taskId)`（data-infra 详情原始：状态/进度/result）
  - `dataInfraResult<T>(taskId)`（done 后取 result）
  - `dataInfraTasks()`（任务列表，TaskHistory 数据源）
- **创建方法类型精确化**：`request<AsyncTaskResult<T>>` → 本地 `TaskCreateResult<T>`（`{ ok, taskId?, result?, message? }`）——缓存命中直接 `{ ok, result }`（无 taskId 假前缀）
- **TaskHistory 组件重写**：读 data-infra 任务列表（按 type 过滤）+ result 展开（不再依赖 taskHistory KV/AsyncTaskResult 契约）
- **调用方改原生**：AgentSessions waitTask、ZhihuCrawler auth 轮询、WatchlistTool 3 处轮询（import/preview/fundamental）全部改 `dataInfraTask` 详情直读
- **shared 类型清除**：`AsyncTaskResult`/`AsyncTaskStatus`/`AsyncTaskResponse`/`AsyncTaskErrorResponse`/`TaskHistoryEntry`/`TaskHistoryListResponse` 全部删除（全库零引用）
- **服务端缓存命中**：cbRate/treasuryFx/reverseRepo 缓存命中改 `{ ok, result }`（去掉 AsyncTaskResult 包装）

### 9.5 全项目改造梳理（2026-08-26 检查）

**已接入 data-infra**：tradeV2-snapshot（任务+派生器+消费者）、reverseRepo-monthly（调度任务）、zhihuCrawler（消费者+衍生）；**登记模式已全覆盖**（cbRate/treasuryFx/watchlist/experiment/agentSessions/zhihuCrawler 的 createTask 均自动登记，运管页可见分析任务状态与历史）

**强候选（前台 createTask → 登记/统一）**：~~cbRate 分析、watchlist、treasuryFx、experiment~~ → **登记已自动完成**；统一模式（前端轮询改造）留作未来

**中候选**：~~reverseRepo 手动入口与调度任务双轨整合~~ → **已完成（2026-08-26）**：调度 handler 与手动入口共用 `getUpdateState` 状态锁防并发（running 时跳过，避免重复 LLM）；业务缓存失效 → 消息通知（低价值，暂缓）

**弱候选/不建议**：agentSessions（会话管理业务特殊）、newsCenter/books/todoV3（同步或已有机制）、爬虫 setTimeout（业务内延迟非调度）

### 9.6 ephemeral 治理与自愈（2026-08-26 强化）

- **一次性任务保留上限**：`EPHEMERAL_LIMIT = 100`——ephemeral 任务（分析请求）终态后 KV 记录保留（运管可见 + 历史），但超 100 条时自动裁剪最旧终态记录（running/queued 不裁剪）——防分析请求长期累积失控
- **孤儿进度快照自愈**：`initDataInfra` 启动时清理全部 `dataInfra:taskProg:`（进程崩溃残留——启动后无 running 任务，进度快照均为孤儿）
- **任务状态标记**：`RegisteredTask.ephemeral?`（注册时写入）——trimEphemeral 按标记识别，不依赖 type 推断
- **cron 任务被 paused 的静默风险**：窗口/快照调度任务若被暂停，每日刷新静默失效——健康检查 `pausedTasks` 指标暴露（运管页健康卡片 ⚠️）——恢复用 `POST /data-infra/tasks/:id/resume`

## 十、DDIA 对照：数据工程理念落地（2026-08-26 阅读《数据密集型应用系统设计》）

> 依据 https://ddia.vonng.com/toc/ 核心章节，对照本项目 data-infra 与业务实践——**理念已落地/可借鉴/明确不引入** 三档。

### 10.1 事件溯源与 CQRS（第 3 章）——✅ 已落地（tradeV2）
- **不可变事件日志作为权威源** → 本项目 tradeV2 账本（entries 追加不可变，交易即事件）
- **从事件派生物化视图（CQRS 读模型）** → `buildDailySeries`/快照/分析 = 重放账本派生；`tradeV2:snapshot:*` = 物化视图；**回溯重建** = 重放重算
- 借鉴点：派生数据可丢弃重建，记录系统不可变——数据源治理红线

### 10.2 批处理（第 11 章）——✅ 已落地（data-infra 任务）
- 批处理 = **有界输入 → 输出即数据**（Unix 哲学/MapReduce）→ 本项目任务（快照/月度更新/回溯）即批处理；输出落 KV（物化）
- **幂等重跑**（批处理核心）→ `runTask`/`backfill` 幂等前提

### 10.3 流处理（第 12 章）——✅ 已落地 + 本轮补强
- **事件流传递**（生产/消费解耦）→ 队列 + 消费者
- **消费者崩溃重投**（图 12-2：m3 崩溃后重投）→ `requeueStale`（processing 超时恢复 pending——至少一次投递）
- **日志压实**（图 12-6：只保留每个键最新值）→ **本轮新增消费审计** `dataInfra:qAudit:*`（ack 时记录 done/failed + type + 时间，上限 200/队列——消息处理可追溯，运管页"消费记录"）
- 借鉴点：**事件时间 vs 处理时间**——消息带 `enqueuedAt`（事件时间），消费者按业务需要区分

### 10.4 记录系统 vs 派生数据（第 13 章）——✅ 已落地
- **分拆数据库/记录系统权威** → 各业务 KV 记录系统 + 派生数据（缓存/快照/摘要）显式分层
- **数据集成/血缘** → `dataRegistry.registerDataSource` 的 `deps`（源→采集→指标→页面）
- **追求正确性** → 幂等消费 + 终态保护（超时/取消不被迟到结果覆盖）

### 10.5 明确不引入（个人规模权衡）
- 分布式复制/分片/共识（第 6/7/10 章）——单机 node:sqlite 足够，避免复杂度
- 事务隔离级别（第 8 章）——单写进程 + WAL，应用层幂等兜底
- 编码模式演进（第 5 章 Avro/Protobuf）——KV JSON + 字段可扩展，够用
- 外部流处理框架（Kafka/Flink）——自研 queue/consumer 已覆盖个人规模
