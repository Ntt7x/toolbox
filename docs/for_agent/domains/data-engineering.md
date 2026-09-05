# 数据工程（Data Engineering）领域文档

> 面向 Agent 的架构指引：本项目"以数据为核心"的统一数据层设计、模式与红线。
> 2026-08-16 调研（medallion / Airbyte source / Dagster asset / RFC 5861）后沉淀。
> 相关代码：`apps/server/src/core/{cache,datasource}.ts`、`datahub.ts`（experiment 样板）、`dataRegistry.ts`。

## 0. 为什么需要统一数据层

分析类页面（央行利率/国债汇率/逆回购/实验/自选股/新闻）的数据流现状（2026-08 盘点，2026-09 更新）：

| 共性问题 | 说明 |
|---|---|
| 无统一缓存抽象 | TTL/force/key 版本化在 6 个 feature 里重复手写（cbRate v4、treasuryFx v2、bmpi v2…） |
| 数据源三通道混合 | 外部 fetch（腾讯/东财/新浪/天天基金）+ LLM 联网搜索 + 本地 KV 存量——各 feature 手工编排 |
| force 参数风格不一 | `useCache:false` / `force=1` / `force:true` / 无 force |
| 血缘/质量标注缺失 | 用户补全 vs API 直采不区分；降级无标记 |
| 加工纯函数仅 experiment 达标 | cbRate/treasuryFx/reverseRepo 规范化内联在 service，无单测 |

**目标**：统一"源→采集→加工→存储→服务"的数据管道基元，新分析页按模板接入；旧页面逐步迁移（不强推）。

## 1. 数据分层（medallion 落地，不建三套物理拷贝）

| 层 | 职责 | 本项目落地 |
|---|---|---|
| bronze（原始） | 原始保真、可重放 | **仅按需**：外部源（行情 API/LLM 搜索）需要审计时保留原始响应 JSON 快照；无消费者就删 |
| silver（主库） | 清洗/规范化/校验 | **主库即 silver**：KV（`kvStore`）存规范化领域数据（窗口/缓存/历史/存量） |
| gold（消费） | 面向展示的聚合 | SQLite `VIEW`/聚合函数 或 服务端计算函数，**不物化** |

红线：gold 用视图/计算，别物化；bronze 无消费者就删。

## 2. 统一数据源抽象（core/datasource.ts）

```ts
interface DataSource<T, P> {
  id: string;                    // 如 "tencent.quote" / "llm.search" / "user.supplement"
  kind: "api" | "llm" | "user" | "kv";
  name: string;                  // 中文名（展示/血缘）
  ttlMs?: number;                // 默认 TTL（选 TTL 分级档位）
  fetch(params, signal?): Promise<T>;          // 主取数
  normalize?(raw, params): T;                  // 原始 → 统一结构
  fallback?(params, signal?): Promise<T>;      // 降级源（failover 链）
}
```

- **注册**：`registerDataSource(ds)`（id 全局唯一）；`listDataSources()` 供目录/血缘展示。
- **取数**：`fetchWithMeta(id, params, {useCache, ttlMs, force, signal})` → `Result{ data, meta }`。
- **血缘 meta**（随数据流动）：`{ source, kind, name, fetchedAt, ttlMs, degraded? }`——落到每条数据。
- **已注册源**：`tencent.quote`（A/H 快照）、`tencent.fx`（外汇）——**新外部源必须注册**，禁止裸 fetch 散落 feature。

红线：不抄 Airbyte catalog/sync-mode/多租户连接管理全套；一个接口 + 每源一个文件足够。

## 3. 统一缓存（core/cache.ts，RFC 5861）

```ts
TTL = {
  REALTIME: 60s,     // 行情实时（外汇即时报）
  MARKET: 5min,      // 行情快照（A/H 股价/PB）
  DAILY: 24h,        // 日频（新闻/日 K）
  WEEKLY: 7d,        // 周频（宏观周度）
  ANALYSIS: 1y,      // 分析类（月/季频，手动失效为主）
  STATIC: 2y,        // 静态知识（仅手动/版本失效）
}
cachedFetch(key, ttlMs, fetcher, {force, staleIfError}) → {data, fromCache, cachedAt, degraded?}
```

- **KV 缓存值结构**：`{ value, cachedAt }`——**新鲜度唯一依据 cachedAt**（写入时刻），不信任外部时间戳。
- **RFC 5861**：`max-age`（新鲜期=TTL）+ `stale-if-error`（fetcher 失败时降级返回旧缓存并标注 `degraded:true`）。
- **force**：显式旁路缓存（必然重取写回）——统一命名 `force`（**禁止再引入 useCache/force=1 等风格**）。
- **缓存 key**：`前缀:版本:参数段`（版本化 + 参数隔离——沿用现状 cbRate:v4 / bmpi:v2 模式）。

红线：不做 LRU 淘汰（个人库全量保留 + 定期清理）；新鲜度一律比较 cachedAt。

## 4. 采集管道（fetch → transform → load）

每数据域一个 async 函数链，统一 loader 写 KV：

```
数据源(DataSource.fetch) → 规范化(normalize) → 指标纯函数(加工) → 存储(窗口/缓存/历史) → 服务(路由)
```

- **窗口数据**：`refreshWindow(page)`（行情快照 + 用户补全合并）→ `experiment:window:<page>`——分析前懒更新。
- **每日结果**：`saveDailyResult(page, result)` → `experiment:<page>:history:<date>`——每次分析成功自动存档。
- **回测序列**：`runBmpiBacktest()` 用日 K 回算指标 → 单 key 保存（今年起）。
- 样板：`apps/server/src/features/experiment/datahub.ts`（**新分析页照此模板**）。

红线：不引入队列/编排器/增量状态机；不做分区回填；调度用 `setInterval`/懒更新即可。

## 5. 数据血缘与目录（dataRegistry.ts + deps）

- `registerDataSource({kind, name, page, tag, description, deps})`——**deps: string[]** 表达上游依赖链
  （如 `["tencent.quote", "user.supplement"]` → 采集 → 指标 → 页面）。
- 本地数据管理页展示：源列表 + deps 血缘。
- 四层链：**数据源 → 采集 → 指标 → 页面**——足够，不做列级/字段级血缘。

红线：不引入 OpenMetadata/DataHub（个人项目过重）；四层血缘足够。

## 6. 数据质量与来源标注

- 每条数据带 `meta.source`（api/llm/user/kv）+ `meta.degraded`（降级）。
- **用户补全 = `kind:"user"`**（可覆盖 API 值，但保留原始值 + updatedAt）；**API 直采 = `kind:"api"`**。
- **缺失 vs 降级**：缺失（null）+ caveats 说明；降级（stale/degraded）标注而非删数据。
- 读取侧轻量断言（缺字段/类型/范围）即可，不引入 Great Expectations/Soda。

## 7. 新分析页接入模板（checklist）

1. **数据源**：外部 API → 注册 `DataSource`（core/datasource.ts）；LLM 搜索 → `chat(search:true)` + 注入日期；用户补全 → `userSupplement`。
2. **缓存**：`cachedFetch(key, TTL 档位, fetcher, {force})`——统一 key 版本化。
3. **加工**：指标纯函数独立模块 + 单测（如 indicators.ts）。
4. **持久化**：窗口 + 每日结果（datahub 三件套）；需要历史曲线再加回测。
5. **注册**：dataRegistry 注册（name 前缀 + page/tag + deps 血缘）。
6. **force 统一**：`{force: boolean}` 参数。
7. **服务**：后台任务 createTask + 轮询/SSE（唯一强一致模式，沿用）。

## 8. 现状对照（迁移进度）

| 页面 | 数据源注册 | 统一缓存 | 纯函数加工 | 窗口/历史 | 状态 |
|---|---|---|---|---|---|
| experiment（ec/bmpi） | ✅ tencent.quote/fx + user | ✅ cachedFetch | ✅ indicators.ts | ✅ datahub 三件套 | **样板（已完成）** |
| cbRate / treasuryFx | ✅ 注册（无 deps） | ⏳ 手写（可迁 cachedFetch） | ❌ 内联 | ❌ | 待迁移 |
| reverseRepo | ✅ 注册 | ⏳ 手写 | ❌ 内联 | ⏳ 月度即历史 | 待迁移 |
| watchlist（自选股，2026-09-01 重构） | ✅ 6 个（`watchlist:` / `:alert:` / `:alertHit:` / `:logic:` / `:fundamental:` / `:extend:`） | ✅ cachedFetch（财报/提示词，stale-if-error 降级；失败不落缓存） | ✅ periodStats.ts + alerts.ts（纯函数，单测 29 例） | ✅ `watchlist:logic:<组>:<代码>` 复核时间序列 | **样板（已完成）** |
| newsCenter | ✅ 注册 | ⏳ 手写（10 分钟） | — | ❌ | 待迁移 |

迁移原则：新页面必须按模板；旧页面在改动时顺手迁移（不强推全量重构）。

## 7. 波动率流水线（增量状态机模式）——2026-08-22 沉淀

需求背景：仓位管理"无信息策略低波/高波"提醒需要标的市场波动率。**教训：波动率是市场/标的的客观属性（价格波动），与用户交易无关**——初版误用"持仓市值序列"（buildDailySeries.marketValue）算波动，被资金进出污染且依赖交易窗口，方向错误后修正。

### 模式：KV 持久化 + 纯函数增量状态机

```
core/volatility.ts        —— 纯函数（零 I/O）：滑动窗口增量（sum/sumsq O(1)）+ 历史σ分级
core/volatilityStore.ts   —— 副作用（KV + 行情）：读状态 → 每日增量更新 → 写回；首次全量初始化
features/tradeV2          —— 专业组装：分析后批量附加 positions.volatility/volLevel
```

要点：
1. **流水线增量**：状态存 KV（`quote:v:<code>`）：closes 定长窗口 + sum/sumsq + 历史波动序列。每日推入新收盘价 = push/shift + sum/sumsq 调整（O(1)），不重拉不重算。同日幂等（lastDate 去重）。
2. **纯/副作用分离**：核心算法纯函数（可单测 7 项：窗口/增量一致性/幂等/分级边界），I/O 只留在 store 层。
3. **波动分级用标准差（金融口径）**：不拍绝对阈值——当前波动相对**该标的历史波动分布**的 z-score（历史滚动波动序列 μ/σ）：z<0 低波 / 0~1 中波 / 1~1.5 高波 / >1.5 极波。比固定 15%/30% 更贴合"相对自身常态"的风险判断。**风险语义**（2026-08-22 用户确认）：无信息策略高波 = 环境错配（规律被冲散，降仓仍亏，应**暂停交易**）；有信息策略高波 = 信息优势仍在只是信噪比稀释（应**降仓**而非清仓）。
4. **与交易解耦**：新分组/无交易标的也能算（纯行情驱动）——市场属性不依赖用户行为。
5. **数据源注册**：`quote:v:` 注册（本地数据管理可见），避免"未标记"。

### 复用指引
- 其他功能要"标的市场波动/波动环境"（网格计划/实验/新闻）→ 直接用 `getStockVolatility(code)`（行情日K 流水线，缓存命中即 O(1)）。
- 新增行情派生指标（如 beta/相关性）→ 沿用此模式：纯函数（增量状态）+ store（KV+行情）+ feature 组装。

## 9. Effect-TS + RxJS 重构行情数据链路 ——2026-09-06 沉淀

背景：自选股原本是 `Promise + 手写 mapLimit + 裸 fetch + 各面板各自 setInterval 轮询`，带来三类问题——取数无统一超时/重试、并发实现双轨（既有 `mapLimit` 又有内联串行）、N 个面板 = N 条重复取数链路且刷新节奏不一致。引入 **Effect-TS（取数编排/类型化错误/结构化并发）** 与 **RxJS（事件流编排/多播/单飞）**，分工严格按"副作用归属"切：

### 9.1 分工铁律（最重要，避免混用）
| 关注点 | 用谁 | 理由 |
|---|---|---|
| 取数本身（超时/重试/错误/并发/缓存） | **Effect** | 结构化并发、类型化错误、可中断、可测试 |
| 事件流编排（何时取、取完怎么分发、多播/退订/重连） | **RxJS** | Effect 不擅长"热流/多播/背压/生命周期"，强做反而绕 |

落地：`core/effect/*`（runtime / errors / http / concurrency）是 Effect 内核；`features/watchlist/pipeline/*` 是取数编排；`features/watchlist/stream/*` 是 RxJS 流（只调 pipeline 的 Effect，自己不 fetch）。

### 9.2 Effect 内核收口（core/effect）
- `http.ts`：`requestText/Json/Buffer`，统一**超时真中断 + 指数退避重试**。重试**只覆盖可重试错误**（超时/网络/5xx/429），4xx 与解析失败不重试（放大延迟无意义）。
- `errors.ts`：`FetchError` 类型化（`Timeout/Transport/HttpStatus/Parse/SourceUnavailable`），`describeError` **一处收口中文文案**——前端/日志不再散落 `e.message` 拼凑。
- `concurrency.ts`：`allOrdered`（保序 + 有界并发 + 任一失败整体中断、兄弟任务被中断）/ `allSettled`（逐项容错、失败转 note）。批量场景用 `allSettled`，单标的场景用 `allOrdered`。
- `runtime.ts`：`runEffect`（失败抛，带可读文案）/ `runEffectOrMessage`（失败降级为 `{ok,message}`，给旁路取数）。Promise 门面层统一经此落地，调用方零 Effect 知识也能用。
- `interruptOn(signal)`：把 `AbortSignal` 桥进 Effect，请求随客户端断开而中断（避免悬空请求）。

### 9.3 RxJS 流设计（features/watchlist/stream）
- **多播共享**：`shareReplay({refCount:true})` + 引用计数（`acquire/release`）——相同代码集合的多个订阅者共用一条取数链路；最后一个退订 → 自动停轮询，不留后台定时器。
- **单飞/防抖**：`exhaustMap`（取数进行中的触发被丢弃，不堆积成请求风暴）+ `throttleTime(leading+trailing)`（立即响应交互，窗口内合并为窗口末补一次）。
- **节奏统一**：所有订阅者共用一个 `interval(15s)`——解决"各面板节奏不一致、数字对不上"。
- **错误就地收敛**：流的 `fetchTick` 把取数异常转成 `notes` 返回，**不让流 error**（否则所有订阅者一起掉线）。
- **消费者模式**（提醒判定）：`quoteStream(codes).pipe(map(consumeTick), distinctUntilChanged)`，把"被动触发"变"常驻消费"——页面没开也能按流节奏判定并落库（重构前只能靠打开页面触发）。

### 9.4 前端 RxJS（面板加载竞态）
- **问题**：旧写法 `useEffect(() => void load(), [code])` 直接 `setState`，快速切标的时旧请求后返回会覆盖新结果（只在网络抖动时复现，极难排查）。
- **改法**：`useAsyncData(fetcher, deps)` 用 `switchMap` 建模"依赖变化→取数→落地"，**只有最后一次触发的结果会被应用**，旧请求自动作废。已覆盖 TrackPanel / AlertsPanel / DeepDivePanel（news 部分）。
- **实时行情**：`useQuoteStream(codes)` 订阅 SSE，多面板共享一条连接；`mergeLiveQuotes(items, live)` 把实时价/涨跌合入列表（实时值优先，列表自带值兜底）。切 tag 自动换代码集合、旧集合随引用计数归零停推。

### 9.5 实测收益（L2 已验证）
- SSE `/stream?codes=sh600519` → `text/event-stream`，每 15s 一帧 `tick`，首帧即带真实快照（source:tencent）；多面板不重复取数。
- `/tags` 接口从"两次全量快照"改为"单次取数，rows + pctByCode 复用"——首屏最重开销减半。
- 结构化并发：批量取数任一源失败即中断兄弟任务，不残留悬空请求。

### 9.6 迁移原则
- **新取数一律经 Effect**（`core/effect/http` 的 `requestX`），禁止裸 `fetch` + `AbortSignal.timeout` 散落 feature。
- **新"持续推送/多消费者"需求一律经 RxJS 流**，不要各组件自己 `setInterval`/`new EventSource`。
- **失败语义先定**：批量场景逐项容错（标注而非中断）；单标的场景才整体失败。统一用 `describeError` 出文案。
- 纯函数（加工/判定）与副作用（取数/存储）分离到不同文件，纯函数必须带单测。
