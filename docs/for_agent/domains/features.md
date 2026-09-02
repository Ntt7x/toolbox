# 领域经验：业务模块实现（按需加载）

> 由 dev.md 拆出的业务模块实现细节。仅当改动对应模块时阅读。
> 目录：浏览器自动化 / 策略仓位管理 / cbRate 数据可信度 / 逆回购数据 / watchlist / 东财快讯。

## 浏览器自动化（core/browser.ts + features/browserChat）

### 4.5 浏览器自动化（LLM 网页版/Chat 操作，2026-08-07 起）—— core/browser.ts + features/browserChat

本机浏览器自动化（playwright-core + 系统 Chrome/Edge，不下载浏览器）：
- **能力**：core/browser 提供 findBrowser / sleep / launchPersistentContext（持久化 profile + 指纹伪装 + 启动失败按 profile 杀残留进程自愈，杀进程不删数据保留登录态 cookie）
- **业务**：features/browserChat 一键「去 Chat」——打开 chat.deepseek.com → 开深度思考/智能搜索开关 → 填入提示词 → 自动发送
- **踩坑经验（均为实测）**：
  - DeepSeek 网页版**不支持 URL 预填**；未登录跳 /sign_in 且无输入框 → 必须登录态（持久化 profile 登录一次即记住）
  - 输入框是 **React 受控组件**：fill() 直接设值不触发受控更新（静默失败）；keyboard.type 逐字符长文本会丢字；**正解 keyboard.insertText 整段插入**（走输入管线触发 onChange），填入后读回 inputValue 校验完整性
  - 开关（深度思考/智能搜索）是 div.ds-toggle-button，**状态属性是 aria-pressed**（不是 aria-checked，后者恒 null）；点击后读回确认、未切换重试一次
  - **顺序陷阱**：先开开关 → 再填入 → 发送前**重新点击输入框聚焦**（点开关会抢走焦点，Enter 会发给开关而不发送）→ 再 Enter
  - **窗口焦点**：headful 启动后 page.bringToFront() 置前
  - **profile 锁**：窗口未关/ctx.close 后进程未退出 → 同 profile 再启动失败（Target page, context or browser has been closed）→ 重试时按 --user-data-dir 匹配杀残留 Chrome 进程（仅 Windows，wmic/taskkill）
  - 页面 URL 读取用安全包装（页面关闭时 page.url() 抛错）


## 策略仓位管理（trade-plan）

### 4.6 策略仓位管理（trade-plan，2026-08）
- 多策略持久化：单 KV 文档 `tradePlan:config` → `{ strategies: [{ id, name, totalCapital, dailyAddLimit, stocks: [{ code, name, maxWeightPct, initShares, initCost }] }] }`；日度计划 `tradePlan:day:<策略id>:<YYYY-MM-DD>`，日期即 id（一策略一天一份）
- 校验纯服务端（无 LLM）：`checkTradePlan` 规则——标的必须∈策略、当日加仓≤日限、单标的上限%、总市值≤总仓位、减仓≤当前持仓、同 code 同日多操作→error「请合并为一个交易操作」；告警三级 error→warn→info 排序
- 前端自动校验：600ms debounce（输入停止后自动跑 check，**不设手动校验按钮**）；save 被 error 阻断并弹错误级 alert
- 标的搜索补全：复用 `watchlistSearchStock`；StockCodeInput 输入框内显示「名称 代码」（有名称时），用户手动输入自动清空名称（视为更换标的）——**只显示代码可读性差（备忘录教训）**
- 类表单校验依赖：判定已配置用「存在有 code 的标的行」而非 `totalCapital !== undefined`（数字默认 0 恒非 undefined，曾导致提示永不出现）
- 页面级冒烟：TradePlanTool 曾出现卡加载中（mount useEffect 被重构误删，curl 测 API 测不出）——凡改页面加载逻辑必须跑 `node scripts/dev-utils/smoke-pages.mjs`
- **v2（2026-08-08）配置/当前仓位拆分**：`strategy.stocks` 只存标的与上限%（配置），`strategy.positions`（当前数量 quantity + 成本价 avgCost）独立管理——不再用「起始数量」概念；旧数据 getStrategy 时幂等迁移（initShares→positions，清内联字段）
- 日度计划「保存即应用」：保存自动按计划更新 positions（加仓重算均价、减仓只减数量成本不变——`applyItems` 纯函数）；**同日覆盖**先按该日 `before` 快照回滚再重应用（幂等）；**删除已应用计划**自动回滚仓位——一致性由 before/after 快照保证
- 大改前端组件慎用 node -e 字符串替换（CRLF/中文/反引号反复踩坑）——**直接 write_file 全量重写整个组件文件**更可靠
- **v3（2026-08-08）日度计划按数量（股）操作**：`TradePlanItem.amount` 语义从金额改为股数，金额 = 股数 × 成本价（当前仓位 positions.avgCost）；未设成本价的标的直接 error「无法换算金额」；applyItems 数量直接加减（成本价不变）；单测/E2E 同步（加仓 4 股→addTotal 5600、覆盖/删除回滚）
- 列表编辑/删除**用 code 定位而非 index**（排序视图/重渲染下 index 会错位导致按钮失效——备忘录教训）；排序视图仍禁用编辑防串改
- **v4（2026-08-08）多日链一致性**：日度计划「应用/删除」从简单回滚 before 改为**基线（basePositions）+ 按日期升序重放**——删除中间某日后其余计划按序重算（旧实现回滚导致后续日结果丢失）；手动保存仓位 → 固化基线；同日覆盖 = 剔除该日重放 + 重应用（幂等）
- 日度计划加仓支持**本次 cost**（可选，缺省用当前均价）：金额 = 数量 × cost，均价 = 重算（(旧量×旧价+量×价)/新量）
- **v5（2026-08-10）负成本盈亏展示**：avgCost<0（成本已回本/做空记账）——**显示盈亏金额、不显示盈亏比例**（负成本比例无意义；金额 = 市值−成本 数学一致展示）——服务端 `attachPnl` 负成本标的返回 `pnl`（金额）+ `costNegative:true`（无 pnlPct），计入 totalPnl/totalMv、`negCount` 计数、不参与 totalCost；`totalPnlPct` 存在负成本标的一律 undefined（前端显示—）；前端三处（列表卡/概览卡/持仓行）显示「盈/亏 ¥X（—）」
- **v6（2026-08-10）买入价/卖出价必填 + 交易复盘（Deal）**：
  - 加仓输入**买入价**、减仓输入**卖出价**（`TradePlanItem.cost` = 本次交易价 >0，路由层 `itemsPriceError` 权威校验；纯函数层保留三源兜底兼容存量）；金额 = 数量 × 本次价格；`realizedPnl` = (卖出价−当前均价)×减仓数量
  - **交易复盘（学习自 profitmaker Deals）**：`buildDeals`（compute.ts 纯函数）把已应用日度计划按**标的×交易段**配对成完整交易（零仓位建仓 entry → 加仓/减仓 → 数量归零清仓 exit），平均成本法归因（段内 buyAmount vs sellAmount），closed 笔统计 **pnl/持仓天数/胜率/已实现盈亏/平均持仓**；详情接口附 `deals`，前端「📈 交易复盘」卡（6 指标 + 可展开明细）；未应用计划不计入
  - 当日减仓回款 `reduceTotal`（卖出价×数量，profitmaker credited 口径）进 totals 与 ResultView 卡
  - **错漏修复**：① rebasePositions 提交中删除的标的从基线移除（防已删标的重放复活）；② createDay 同日覆盖清理 DAY_LIST 死 id；③ 列表 positionPct 改最新价市值口径（与详情一致）；④ parseItems 数量必须正整数、非法条目**整批拒绝**（不再静默丢条目）；⑤ maxWeightPct 越界服务端 400（此前静默丢弃）
- **v6b（2026-08-10）重刷/覆盖语义修复（S7/S8，重刷日度计划暴露）**：
  - **S8 [严重]** 覆盖（重刷）历史日计划时旧实现 `replayPositions(st, date)` 只剔除该日、**把该日之后已应用计划也重放进 before** → 校验持仓被未来计划污染（减仓误拦 400）、before/after 快照错误 → 新增 `replayBefore(st, date)`（仅 < date），覆盖路由用它做 before/校验基础；应用后 positions 用**全量重放** `replayPositions(st)`（含后续日，不丢链）
  - **S7 [静默截断]** 覆盖/删除中间日后，后续日计划减仓超持仓被 applyItems clamp 截断但无提示 → 新增 `appliedDayWarnings(st, excludeDate)`（全量重放逐日 checkTradePlan 收集 error 级），覆盖/删除响应附 `chainWarnings`，前端保存/删除后提示「⚠️ X 日计划无法完整执行：…」
  - 验证：三日链（base100 +D1+10 +D2+10 −D3−20）重刷 D2 减 95——修复前误拦 400（持仓被污染成 90），修复后通过（before=110）且 chainWarnings 提示 D3 超出 5 股

## 数据可信度（cbRate 等 LLM 结构化输出）

## 4.5 数据可信度（cb-rate 等 LLM 结构化输出）

- 响应带 `dataMode: search|knowledge`：search=联网实时；knowledge=模型训练知识（**可能过时/幻觉**）
- **知识模式提示词必须防幻觉**：注入今天日期 + 明确"训练知识截止约 2025 年中，严禁编造今天之后
  的会议与决策，拿不准用不确定/省略，asOf 用知识最新日期"；输出 knowledgeCutoff 字段
- 不静默篡改 LLM 数据：action 非法 → 降级 hold 展示但加 bank.flags 标记；缺失央行 → missingBanks
- **缓存 schema 升级必须改 key 版本**（如 cbRate: → cbRate:v2:），否则旧契约缓存被命中
  返回污染数据（防幻觉前的编造内容还在 TTL 内）
- **任务超时终态保护**（core/tasks）：fn 在超时后迟到返回不得覆盖 error/cancelled 终态
  （DeepSeek search abort 无响应时尤其会触发，否则"卡死"后仍显示 running/done）

## 逆回购数据（reverse-repo）

- **逆回购余额（reverse-repo）存量部分用默认种子 + KV seed**（`features/reverseRepo/monthlyData.ts`
  默认值 → `seedMonthlyData()` 幂等 seed 进 `reverseRepo:monthly`，运行时从 KV 读）：
  页面仅关注「买断式逆回购」；数据结构 = 逐笔操作流水（精确到年月日，41 笔）+ 月度汇总
  （投放/净投放/累计净投放，每日经济新闻口径推算补充）；**存量余额 = 累计净投放**
  （2026-03 锚点 7.2 万亿元，与对话中存量 6.3 万亿口径一致）；数据经用户多轮修订
  （2025-10/11/12 原误记"无操作"已修正、2026-07 期限构成已修正）
- **余额曲线高级加工（`deriveBalanceSeries`，连续不断档）**：2025-02~2026-02 无权威累计净投放，
  **口径陷阱**：用户第一版"月末余额"实为**累计投放**（Σ投放，2025-02=58000），第三版"累计净投放"
  才是真实存量（含到期）——两者混用会导致曲线断层/假值；统一口径后，缺失月份用
  **模型推算**（逐月余额 = 上月 + Σ月度投放 − Σ逐笔到期，到期日 = 投放日 + 3/6 自然月），
  推算点 `estimated:true`（前端空心灰点 + tooltip「模型推算」），权威锚点实心蓝点并**重置推算基线**
  （防漂移累积）；输出截断到最新数据月（不展示未来推算）
- **逆回购数据规整约定**：逐笔 operations（公告口径）与月度 rows（媒体口径）并行，个别月有差异
  （如 2025-11 公告 8000 vs 媒体 15000）——**推算投放以 rows 为权威**（月度表一致），差异在
  operations.source 标注；日期格式统一 YYYY-MM-DD / YYYY-MM（前端显示「月内」）；
  无权威披露的 netChange/cumulativeNet 填 null 不编造；UpdateState 带 taskId 且 running
  超 15 分钟降级 failed（防进程残留卡死）；数据源注册齐备（monthly/daily/monthlyUpdate 三 key）
- **自选股（watchlist，2026-09-01 重构，原「专题自选股」）**：**以「标的」为跟踪主体、以「分组」为组织单元**
  —— 每个分组一个 KV 文档 `watchlist:<id>`（items 含 code/name/kind/reason/expectation/targetPrice/addedAt）；
  分组分**基础分组**（自有 items）与**聚合分组**（`aggSources` 指向多个基础分组，标的 = 源分组 items 并集按 code 去重，
  **不落库存储并集**——单一数据源，改源分组即实时反映）。
  概念映射：旧「专题」→ 新「分组」；旧「专题内个股」→ 新「标的」；旧「专题 group 标签」→ `legacyGroup`（仅归档，由聚合分组承担）。
  技术标识沿用 `watchlist`（API 路径与 KV 前缀不变），历史数据 **读取时升级**（store.normalizeGroup：`stocks`→`items`、`group`→`legacyGroup`），零迁移脚本。
  数据源：`watchlist:` / `watchlist:alert:` / `watchlist:alertHit:` / `watchlist:logic:`（自选数据）+ `watchlist:fundamental:` / `watchlist:extend:`（分析数据）。
  数据分层（数据工程观点）：**源**（tencent.quote 快照 / tencent.kline 日 K / eastmoney.news 快讯 / llm.search）
  → **采集**（features/watchlist/track.ts 批量取数 + 降级标注）→ **加工**（periodStats.ts 周期聚合、alerts.ts 提醒判定，均为**纯函数 + 单测 29 例**）
  → **服务**（features/watchlist/index.ts 路由 + 编排）；血缘与质量随结果下沉前端（`WatchDataMeta.sources/fromCache/degraded/caveats`，**缺失即标注**不静默留空）。
  路由分层：`store.ts`（KV + 规范化）/ `track.ts`（采集编排）/ `periodStats.ts`（周期聚合纯函数）/ `alerts.ts`（提醒判定纯函数）/
  `logic.ts`（逻辑复核编排）/ `news.ts`（新闻关联）/ `service.ts`（财报 LLM + Chat 导入）；
  **Hono 静态路由必须注册在 `/:id` 参数路由之前**（否则被当 id 吞掉）。
  ⚠️ 坑（2026-09-01）：`kvListRaw` 返回的是**原始 JSON 字符串**，必须自行 `JSON.parse`（与 `kvGet` 不同），
  直接交给 normalize* 会静默返回全空列表。
- **分组列表统计（2026-08-10 引入，2026-09-01 扩展）**：`GET /tools/watchlist` 为 async，附
  `avgPct/avgCount`（组内有行情标的的涨跌幅**算术平均**；行情分 40 只一批批量拉取，复用
  quote:s: 5 分钟缓存，不与详情页重复拉取；索引 normCode+裸码双键兼容用户任意代码写法）、
  `reviewCount`（待复核 / 逻辑动摇的标的数）、`alertCount`（当前已触发提醒数）；
  前端分组切换条展示红涨绿跌徽章 + 🧭/🔔 计数；全部无行情 → avgPct 缺省不展示
- **四个功能面（2026-09-01 新增，横向 Tab，与仓位管理 v2 同布局范式）**：
  ① **行情跟踪** —— `GET /:id/track?period=day|week|month`，日 K 按自然周/自然月分桶聚合（周一为周起点，UTC 计算防时区漂移），
  产 OHLC/涨跌幅/振幅/交易日数 + 分组等权走势（SVG 折线，无第三方图表依赖）；
  ② **下沉分析** —— 财报（LLM，以**标的**为维度缓存，跨分组复用）+ 新闻（**确定性关键词匹配**，零 LLM 零额外请求）；
  ③ **提醒设置** —— 券商式（标的 + 条件 + 阈值 + 方向 + 周期 + 一次/每次），服务端权威校验（标的须在分组内、阈值 > 0），
  按 `ruleId + 交易日` 去重落库，`once` 规则命中后自动停用；
  ④ **逻辑确认** —— 入选理由（前提）+ 预期随时间是否成立：**确定性锚**（基准价/入选以来涨跌幅/目标达成度/相关新闻条数，
  非 LLM，防「裁判兼运动员」假收敛）+ LLM 仅做定性判定（输入为服务端真实采集事实，禁止自造数据）；
  每次复核落库形成**时间序列**，同日同标的复用结论（可强制复核，省成本）
- **行情多源兜底（2026-08-10）**：quote.ts 腾讯批量**逐行容错**（单只解析失败只跳过该只，
  不再拖垮整批，坏代码走单源降级）+ 批量命中**无价降级**（price 缺失/为 0 也降级东财/新浪补价）；
  fund.ts 场外基金天天基金主源失败自动降级**新浪**（`hq.sinajs.cn/list=of{code}`）；
  行情失败项前端显示「⚠️ 无行情」+ title 展示失败原因（不再静默「—」）
- **逆回购月度数据触发式更新**（服务端自动，前端零改动）：`GET /tools/reverse-repo/monthly`
  返回时计算 `missingMonths(rows)`——最新数据月 < 上个月 → 响应带 `stale/staleMonths` 并
  自动 `createTask` 后台跑 `runMonthlyUpdate`（LLM 搜索补全缺失月份，`reverse-repo.monthly-update`
  提示词）；防重（`reverseRepo:monthlyUpdate` KV 记 running，running 中不重复触发）；进度查
  `GET /tools/reverse-repo/monthly/update-status`，手动触发 `POST .../refresh`；
  **合并校验**：LLM 返回的月份必须 > 现有最大月且 ∈ expected，否则跳过（防乱序/重复/污染），
  无有效写入 → failed 且不动 KV（幂等安全）
## 仓位管理 v2（trade-v2，2026-08-15）

> **能力速览（改动 trade-v2 前先读本块，按需深入下方小节）**：
> 数据：逐笔账本 TradeV2Entry（增）→ 仓位/复盘/收益全由重放纯派生（单一数据源）→ 分组约束 TradeV2Group
> 模型：加权平均成本（含费）+ 负成本统一（V1 对齐）+ 组合净值曲线（现金+市值）+ 融资/做空（负持仓 allowShort）+ 收益曲线历史价口径（core/kline 日 K）
> 接口：/tools/trade-v2（组 CRUD / 条目 CRUD / entries/check / entries/batch(preview) / analysis / import/v1）
> 前端：📊收益分析（三视图+净值+月度）📈仓位明细（排序/导出/下钻）💼交易单（Enter流/⚡现价/归并预览/校验禁提交）💹交易流水（筛选/分页/sticky）
> 验证：单测 38/38（tradeV2）+ 集成 + L3 冒烟；V1 导入幂等（同名跳过）
> 关键坑：buildPositions 漏已清仓已实现（须从重放累计）；TS 自引用窄化 never；CRLF 行级替换；SectionTitle 统一卡片标题

- **核心模型（用户需求三要素）**：
  1. **一笔笔交易（增量）** = 账本 TradeV2Entry（日期/标的/买/卖/数量/价格/手续费/期初建仓/备注，归属分组）
  2. **仓位明细（存量）** = 由账本按（date,createdAt）升序重放、加权平均成本（含手续费）**纯派生**
     ——**单一数据源**：改/删任一笔交易 → 全部派生自动重算（根治 v1 基线+重放一致性问题）
  3. **分组（tag 组织 + 限制）** = TradeV2Group（总仓位上限 / 单日加仓上限 / 单标的上限%）
- **Cordis 服务化**（todoV3/docs 同模式）：services.ts（TradeV2Group/Ledger/Analysis 三 Service）
  + plugin.ts + context.ts（异步单例）+ index.ts（Hono 薄壳）；存储 tradeV2:group:/tradeV2:trade: + 列表键
- **服务端权威校验**（§6.7）：卖出超持仓 / 超单日加仓 / 超单标的上限 / 超总仓位 → 400 + rejectReason；
  **期初建仓（initial）不参与限额校验**（存量起点）；删除交易后剩余条目需自洽（卖出须有买入支撑）；
  校验用市值口径：最新价（行情 KV 缓存） ?? 加权均价；行情不可得按成本估算
- **已实现盈亏口径**：卖出时按摊余成本（加权均价）结算，含手续费；**已清仓标的的已实现必须从
  重放状态累计**（buildPositions 只含 qty>0，会漏掉清仓标的历史已实现——单测抓到的坑）
- **交易复盘（Deal）**：逐 code 按「零持仓建仓 → 数量归零清仓」配对成段；closed pnl = sellAmount − buyAmount − feeTotal；
  胜率/平均持仓天数/已实现盈亏；在途段 status=open 不结算
- **分析展示**：统计卡 + ECharts（仓位分布饼图 / 分组盈亏对比柱图 / 累计已实现盈亏曲线，按清仓日累计）+
  交易复盘表 + 流水筛选（分组/操作/代码/日期范围）；标的名称搜索补全复用 watchlistSearchStock
- **V1（trade-plan）导入（2026-08-15 补）**：TradeV2ImportService（Cordis 第 4 服务）直读 V1 KV
  （tradePlan:strategy:<id> + tradePlan:strategies:list，**不跨 feature import** 保持 features→core 单向依赖）；
  每个策略 → 同名分组（总仓位/日限/单标的上限迁移），当前持仓 → 期初建仓（initial=true，价格=均价，日期可选默认今天）；
  **同名冲突跳过（幂等可重复导入）**；负成本/无有效成本持仓无法为期初建仓（V2 要求价格>0）→ 跳过并逐条报告；
  旧数据兼容（positions 缺失 → initialPositions → stocks 内联 initShares/initCost——注意必须从**原始 stocks** 读取，
  归一化会剥离内联字段，单测抓到的坑）；GET /import/v1-preview + POST /import/v1（strategyIds 过滤）
- **导入实际执行**：5 个 V1 策略 → 5 分组 + 94 笔期初建仓（2026-08-15），9 个负成本持仓跳过（600938/002063/600219/
  159866/515220/512000/588860/512800/517380）——V1 原数据未动（15 键完好）

### 收益分析（补 2：时间性/空间/每日动态）

- **收益·时间性**：buildDailySeries（每日买入/卖出回款/当日已实现/收盘市值（成本口径 Σqty×avgCost，无行情依赖）/持仓标数）
  + buildMonthlySeries（按月聚合，月末市值 = 当月最后交易日）；前端规模曲线（市值 + 累计已实现双线）、月度柱状图
  + 每日动态表/月度收益表（客户端累计已实现列）
- **收益·空间（结构）**：buildPnlAttribution（按标的 已实现 + 未实现 + 合计 + 贡献度%，含已清仓标的的已实现——
  从重放状态累计）；前端收益构成环图（已实现 vs 未实现，绝对值占比 + tooltip 带符号金额）+ 收益归因 Top10 横向条形（红涨绿跌）
- **每日交易单**：POST /entries/batch（preview=true 只校验不入库 / 提交整批入库）：
  整批 parseEntryInput → 服务端权威 checkEntry（超卖/超日限/超单标的上限/超总仓位 → 400 整批拒绝）→
  summarizeOrder 逐标的净归并（净买/净卖/持平 + 净金额 + 当日已实现）→ 入库（**createdAt 阶梯化保持行内顺序**，
  同日期先买后卖不误判超卖）→ 仓位自动重算；前端「💼 交易单」Tab：多行标的/操作/数量/价格/手续费 + 校验 + 提交
- **可读性参考 v1**：左侧分组卡片栏（名称/在途数/市值/红涨绿跌盈亏徽章/仓位占比）+ 主区统计卡 + 4 Tab
  （📊收益分析 / 📈仓位明细 / 💼交易单 / 💹交易流水；全部视图显示全局图表 + 仓位明细/流水）
- **前端 TS 陷阱**：TS 对 `let last = {...last...}` 自引用赋值窄化为 never → 用 index 访问（rows[rows.length-1]）
  或先取 prev 变量；ECharts formatter 参数需 `as` 断言
- 单测 26/26（新增：每日动态/月度汇总/收益归因/归并汇总/三序列入分析）；全量 175/175；batch API in-process 16/16

### 页面逻辑深化（补 12+13：资金逻辑链 + 交易绩效 + 冗余清理）

- **统计盒重组为资金逻辑链**（交易员天然心智模型）：
  📦 持仓：市值 / 成本 / **浮动盈亏（金额 + 浮动率副标）**——盈亏额紧挨市值成本（市值−成本=浮动盈亏）；
  💰 盈亏：已实现 / 未实现 / 总盈亏 **各带「率 对持仓成本」副标**（已实现+未实现=总盈亏）；
  📊 交易：在途/已完结/胜率；🏦 仓位：今日加仓/剩余可用/累计净投入
  🧩 组合整体（全部视图）：组合盈亏金额 + 盈亏率成对
- **「资金概览」区标题**：以公式点明逻辑链（市值 − 成本 = 浮动盈亏；已实现 + 未实现 = 总盈亏），让四个统计盒的因果一目了然
- **🧠 交易绩效卡（复盘深度）**：基于已完结交易计算 平均盈利 / 平均亏损 / 盈亏比（均盈÷均亏）/
  单笔期望 / 盈利笔平均持仓 vs 亏损笔平均持仓——自动提示「✅ 盈利笔持得更久（让利润奔跑）」或
  「⚠️ 亏损笔持得更久（截断亏损？）」；无已完结交易时不渲染
- **冗余清理**：TradeV2EntryInput（services）与 TradeV2OrderItem（compute）两份同形接口 → 统一为
  shared 的 TradeV2EntryDraft（别名导出，单一数据源）；移除 web 未用的 TradeV2BatchResult 导入；
  确认 pnlRate/pnlRateDiff/groupName 无残留
- 验证：单测 29/29 → 全量 178/178；web/server tsc 全绿；Playwright 无 JS 错误

### 日回看/风险徽章/月收益率（补 8）

- **交易单 Tab「本日已提交」回看区**：提交后立即可见该组当日已入账条目（标的/操作/数量/价格/金额/手续费/
  备注 + 编辑/删除快捷修正）——每日工作流闭环（提交 → 回看 → 修正）
- **组合规模曲线（全部视图）**：全局分析新增 dailySeries（跨组合按日合并市值/买入/卖出/已实现/持仓数，
  成本口径）；全部视图新增「组合市值(成本) + 累计已实现」双线图
- **分组风险徽章 ⚠️**：服务端 buildGroupSummary 附 riskCount（checkEntry error 级计数：超总仓位/
  超单标的上限/超日限/卖出超持仓）；分组 Tab 与分组贡献表显示 ⚠️N（实测：个股-投机降本 ⚠️2 正确检出）
- **月度收益率**：buildMonthlySeries 附 pnlPct（成本口径：月PnL = 已实现 + 市值变动 − 净流入，÷ 月初市值；
  首月缺省）；月度收益表新增「月收益率」列（红涨绿跌）
- 单测 29/29（新增：月收益率/组合日序列/riskCount）→ 全量 178/178；web/server tsc 全绿

### 组合净值曲线（补 17）

- **净值口径（现金+市值）**：净值_t = 期初本金 P0 + (成本口径市值 − 累计净投入)；恒等 P0 + 已实现累计 + 未实现——卖出回款落袋为现金计入净值，追加投入不改变净值
- 期初本金 P0 = 首日净投入（V1 导入期初建仓成本，真实数据 783910.4）
- 全部视图「组合净值曲线（现金+市值口径）」+ 分组视图「组合净值曲线（时间性）」：净值主曲线（实线）+ 持仓市值参考线（灰虚线）+ 累计已实现参考线（绿点线）
- 纯前端派生（dailySeries 滚动 buyAmount−sellAmount），不改 server 契约/测试
- 验证：单日数据净值 = P0（盈亏 0，恒等成立）；web tsc 绿；Playwright 全部/分组两视图渲染正常
- **流水复核**：103 笔分页正常（显示更多 100/103，点击后 103 行展开、按钮消失）；此前 Playwright FAIL 系检查脚本断言写反（105 行 = 5 行分组风险表 + 100 行流水，非 bug）


### 融资/做空（补 18）

- **组级开关**：`allowShort`（分组设置勾选）；默认 false：卖出超持仓 = 异常被拒（与旧行为一致）
- **重放模型扩展**（applyEntry 共享）：卖出超持仓 → 负持仓（空头）；成本基数为负 = 空头占用；回补买入向 0 收敛
- **空头数学自洽**：avgCost = 开空均价（正）；未实现 = qty×(现价 − 开空均价)，价格下跌为正盈利；已实现 = (开空均价 − 回补价)×数量 − 费
- **负成本口径复用**：空头 costValue 负 → negCount 计入、盈亏率 —（守卫生效）、totalCost 只计正成本持仓、trueCost 含空头占用
- **复盘段仅多头**：开空/加空不建段；回补不建段、超过空头部分开多才建段（避免假 open 段）
- **校验守卫**：checkEntry 超卖检查按 allowShort 决定；开空组接受超卖、禁空组 400
- **前端**：仓位明细「空头」橙徽章 + 数量显示卖出股数（附「卖」标记）；交易单顶部做空状态提示；分组设置开关；全部视图合并仓位同步做空语义
- 验证：单测 +7 → 38/38，全量 59/59；E2E 实测空头数学（真实行情茅台 1341.99：qty=-5 → mv=-6709.95、未实现 -6059.95 价格暴涨亏损）正确；UI 渲染正常


### 负成本统一模型（补 15）

- **模型扩展**：期初建仓（initial）允许负价/零价 = 负成本基点（已回本/做空记账）；
  重放模型（加权平均成本）数学上天然支持负成本基数——成本基数为负时：
  浮动盈亏 = 市值 − 负成本（金额正确，例：600938 成本基数 −5542 → 市值 3267 → 浮动盈亏 8810）
- **盈亏率守卫**（V1 惯例）：存在负成本标的时 浮动率/总率/已实现率/未实现率 一律 undefined（显示 —，
  比例分母为负无意义）；单标的 unrealizedPnlPct 仅正成本显示
- **校验市值口径**：负成本标的无行情时按 0 计（成本口径为负会虚低总市值），有行情用最新价
- **普通交易仍拒绝负价**（买/卖价必须 > 0）；仅期初建仓可负——语义清晰
- **导入不再跳过**：V1 负成本/零成本持仓 → 负价期初建仓；已幂等补齐真实数据 9 个
  （600938/-55.425、002063/-1.691、600219/-2.329、159866/-0.117、515220/-0.852、512000/-8.683、
  588860/-0.185、512800/-2.872、517380/-0.398）
- 前端：仓位表负成本标的显示「负成本」徽章（紫）；交易单价格预填守卫（负成本不预填负价）
- 单测 30/30（tradeV2，新增负成本统一模型 3 条：负价重放/校验口径/parse 守卫）→ 全量 182/182；
  Playwright 负成本组渲染无 JS 错误


### 负成本数据对齐 V1（补 16）

- **V1 负成本口径全对齐**：
  ① 负成本标的显示盈亏金额、盈亏率 —（已对齐）；② **totalCost 只计正成本**（负成本已回本
  不计入占用成本——此前 V2 把负成本也算进 totalCost，持仓成本显示被拉低/变负，已修正）；
  ③ negCount 计数（组 + 全局）；④ 存在负成本时 浮动率/总率/已实现率/未实现率 一律 —
- **数学仍正确**：unrealizedPnl = totalMv − Σ(全部成本)（含负成本，真数学）；
  展示的 持仓成本 与 浮动盈亏 在负成本存在时按 V1 口径并注明（成本副标「不含 N 个负成本（已回本）」）
- 真实数据验证：个股-持有投资 totalCost 正成本口径 118064（修复前含负成本 112119）、negCount 3；全局 negCount 9
- 单测 31/31（tradeV2，新增混合正负成本口径测试）→ 全量 183/183；web/server tsc 全绿


### 前端体验（补 3：名称可读/统计合并/录入体验）

- **布局：全横向 Tab**：分组切换（全部 + 各分组）为横向胶囊 Tab，功能区（收益分析/仓位明细/交易单/交易流水）为横向 Tab——去掉左栏
- **名称可读（代码辅助）**：服务端三处补名称——① compute 派生层（buildPositions/buildDeals/buildPnlAttribution 从账本取名称，
  此前仓位/复盘/归因全是裸代码）；② 读路径 enrichNames（LedgerService：分组上限配置 → core/quote 行情 name，进程内缓存）；
  ③ 写路径（create/batch 入库时解析名称）；前端 NameCode 组件（名称加粗 + 代码灰字）
- **统计合并**：StatGroup 分组盒——📦持仓（市值/成本/盈亏率）、💰盈亏（已实现/未实现/总盈亏）、📊交易（在途/已完结/胜率）、🏦仓位（今日加仓/剩余可用/累计净投入）
- **友好配色**：统一 C 调色板（盈利玫红 #e11d48 / 亏损翠绿 #059669 / 主蓝 #2563eb + 浅底色）；pnlText（▲/▼ 带符号金额）
- **交易单录入体验**：Enter 流式跳转（标的→数量→价格→手续费→备注→下一行/自动加行，refs Map）；
  选标的后自动预填价格（该组持仓 最新价??均价）；📋复制上一交易日（模板）；🧹清空；实时净归并预览（客户端）；
  日限进度条（日限/今日已用/本单/剩余，超限标红）
- 单测 175/175；web/server tsc 全绿；in-process UX 冒烟 6/6（总览/名称/序列/批处理全流程）

### 横向布局 + 全部=组合整体（补 4）

- **功能区横向布局**：功能 Tab 改通栏横向分段控件（TabsList width 100% + 等宽 trigger）；
  收益分析内表格区横向双列（每日动态通栏 → 月度收益|收益归因 并排 → 交易复盘通栏）
- **全部 = 组合整体**：「全部组合」视为一个整体分组，新增 🧩 组合整体统计盒
  （组合数 / 组合盈亏率 = 总盈亏÷总成本 / 集中度 = 最大分组市值占比 + 名称）；
  新增 GroupContributionTable 分组贡献表（每组的 在途/市值/占总组合%/已实现/未实现/总盈亏/盈亏率，
  点击行跳转该组）——整体统计信息一目了然

### 导出/排序/标的交易历史（补 5）

- **CSV 导出**（UTF-8 BOM，Excel 中文兼容）：交易流水（按当前筛选）、仓位明细、分组贡献表——
  downloadCSV 客户端生成（Blob + 下载），无需服务端
- **仓位明细排序**：点击表头按 数量/均价/市值/占总仓位/已实现/未实现 升降序（▲▼ 指示）
- **标的交易历史下钻**：仓位明细/收益归因点击行 → StockHistoryDialog（当前持仓摘要 + 交易段复盘 +
  该标的全部交易明细）；分组视图范围 = 该组，全部视图 = 全部组合
- 前端转义陷阱（本次踩坑）：正则 `\s` 经模板字符串会退化成字面 `s`；`/[",\n]/` 里的 `\n` 变真换行截断

### 功能 Tab 上移（补 6）

- **功能 Tab 置于具体功能区上方**：收益分析/仓位明细/交易单/交易流水 横向分段条移到统计卡与图表之前
  （分组 Tab 行之下、内容之上）；统计分组盒/组合整体/全局图表移入 Tab 内（Tab 条下、内容上，始终可见）
- 布局：分组 Tab → 功能 Tab（通栏等宽）→ 共享统计区 → 当前功能内容

### Tabs 侧栏根因修复（补 7）

- **根因（用户反馈「不要做成侧栏」）**：`components/ui/tabs.tsx`（shadcn Base UI 模板）的 Tailwind 变体
  用的是 `data-horizontal:`/`data-vertical:`，但 Base UI 的 Tabs 根元素实际渲染 `data-orientation="horizontal|vertical"`
  ——变体永不匹配 → `data-horizontal:flex-col` 不生效 → Tabs 根保持 `flex gap-2`（row）→
  **Tab 列表与内容左右并排 = 侧栏效果**
- **修复**：全部改为 `data-[orientation=horizontal]:flex-col` / `group-data-[orientation=horizontal]/tabs:h-8` 等
  任意值变体；功能 Tab 恢复为横排（List 在上、内容在下）
- 教训：**Base UI 组件用 `data-orientation`（非 data-horizontal/data-vertical）**；引 shadcn 组件后必须

### CSS 审美对齐 V1（补 9）

- **调色板对齐 V1**：slate 灰系（主文字 slate-800/slate-500/slate-400）+ 柔和 tint（red-50/emerald-50/
  blue-50/indigo-50/amber-50 + 对应 100 边框）；盈利 red-600 / 亏损 emerald-600（A股红涨绿跌）
- **V1 签名元素**：① SectionTitle 彩色竖条小节标题（图表卡/表格标题统一）；② StatGroup 彩色图标徽章
  （持仓蓝/盈亏红/交易靛/仓位翠/组合整体琥珀）；③ 页面标题（text-lg 加粗 + slate-500 副标题）；
  ④ 消息横幅（圆角+红/绿 tint 边框）；⑤ 分组 Tab 胶囊（1.5px 边框 + 选中蓝底蓝边 + 轻阴影 + hover 过渡）
- 面板色统一 C.panel（slate-50）；删除全部旧玫红/硬黑（#e11d48/#fff1f2/#0f172a 零残留）
- 教训：**大范围样式统一用 fs 字符串替换（split/join）而非模板数组**（含 JSX 花括号/引号的行数组

### 细节打磨（补 10：键盘导航/现价/分页/盈亏率）

- **标的搜索键盘导航**：↑↓ 选择建议（高亮）、Enter 确认（无建议时交给行内跳格）、Esc 关闭——
  批量录入全程键盘不碰鼠标
- **交易单 ⚡ 现价**：行内一键取行情最新价填入（复用 watchlistQuotes；有持仓时仍优先持仓价预填）
- **流水表 sticky 表头 + 滚动容器**：长流水滚动不丢表头（maxHeight 520 + sticky thead）
- **流水分页**：每页 100 + 「显示更多」按钮（几百笔不卡顿）
- **盈亏率 ± 号**：pctSigned（+12.5% / −3.2%），用于 持仓盈亏率/月收益率/贡献表盈亏率
- 教训：含 JSX 花括号的长字符串替换逐个拆小步做（大块数组/模板再次触发解析错）；

### Playwright 自测（补 11）

- **自测可行**：run_code 可 spawn 子进程（沙盒 pipe 限制只在 pwsh 侧）→ 自起 tsx server + vite web
  （detached）→ playwright-core（apps/server/node_modules）+ 本机 Chrome 实测
- **实测通过 22 项**：横向功能 Tab（全部/分组视图，x 递增 y 相同）、统计盒徽章、标题竖条、收益分析图表/表格、
  键盘选标的（600519→Enter→贵州茅台）、⚡现价（真实行情 1341.99）、净归并预览、日限进度、校验提示、
  下钻弹窗、分组贡献表点击跳转、风险徽章、无水平溢出、无 API 404
- **自测抓到的 bug**：V1 风格化时 h1 被改成固定「仓位管理 v2」，丢失当前分组名——修复为
  `📋 {分组名/仓位管理 v2}`（分组视图显示组名）
- 技巧：playwright 需要设置 process.env.TMP/TEMP（worker 无默认临时目录，否则 mkdtemp 失败）；

## memo 处理（2026-08-15，2 条 fix 全部完成）

- **[仓位管理 v2] 资金概览去掉 交易/投入 盒**：资金概览收敛为纯资金逻辑链（📦持仓 + 💰盈亏；
  分组视图 + 🏦仓位控制盒；全部视图 + 🧩组合整体），交易信息并入组合整体盒副标（在途）；
  收益分析 Tab 的交易绩效/复盘表已覆盖 在途/已完结/胜率/平均持仓（不丢信息）
- **[待办事项 v3] closed todo 归档**：TodoItemV3.archivedAt；手动归档（仅已完成，否则 400）+
  到期自动归档（非周期已完成超 3 天保留期，读时幂等执行；周期项不自动归档——跨期自重置）；
  归档区 GET /todo-v3/archive + POST /:id/archive + /:id/restore；clearDone 不清归档；
  web：已完成项 🗄 按钮 + 统计行 🗄归档(N) 切换区 + ↩ 恢复
- 验证：todoV3 单测 7/7（新增 3 条归档用例）→ 全量 181/181；web/server tsc 全绿；
  in-process API 归档全流程 7/7；Playwright 待办页/仓位页无回归
- 教训：仓库原文件 CRLF，fs 替换必须行级（按原换行符 split/join），`\n` 直配会 MISS；
  含 JSX 花括号/反引号的大段文本用直接行数组操作（模板/注释再触发解析错）

### 开发教训汇总（trade-v2 期间积累，跨模块适用）

- **Base UI 组件**：Tabs 根元素渲染 `data-orientation`（非 data-horizontal/data-vertical）——引 shadcn 组件后必须核对属性变体与真实 DOM 属性一致（本项目仅 trade-v2 使用 Tabs，影响面单一）
- **Base UI Select**：onValueChange 签名是 (value: string | null, eventDetails) => void——直接传 setState 或 (v: string) => void 会类型报错，须显式 (v: string | null) => setX(v ?? "")
- **TS 类型陷阱**：`let last = {...last...}` 自引用赋值窄化为 never → 用 index 访问；ECharts formatter 参数需 as 断言；`??`/`||` 混用需加括号（TS5076）
- **正则/字符串替换**：含反斜杠的正则必须用单引号字符串 + 双反斜杠，勿放模板字符串（`\s` 会退化、`\n` 变真换行）；含 JSX 花括号/反引号的大段文本用直接行数组操作（模板/注释再触发解析错）；统一用 fs 读-改-写 + 精确计数（split().length−1 断言唯一）；replace_all 用逐处 split-join 精确计数
- **CRLF**：仓库原文件 CRLF，fs 替换必须行级（按原换行符 split/join），`\n` 直配会 MISS
- **沙盒环境（2026-08-16 实测修正）**：workspace-write 禁 pipe 模式 spawn（node:test 子进程隔离/捕获输出的 spawn → EPERM），但 inherit 模式 spawn 可用（dev.mjs 的 vite/tsx watch 本就可跑）；FullAccess（danger-full-access）解锁 pipe spawn（node:test 默认隔离可直跑）；浏览器冒烟须设 TMP/TEMP；截图存 .file/（模型不支持读图时用 DOM/计算样式断言）；验证优先 `toolbox test`（自动探测回退 resolve hook）+ app.request 免端口跑 API 冒烟
- **页面加载逻辑**：凡改页面加载逻辑必须跑 `node scripts/dev-utils/smoke-pages.mjs`（mount useEffect 被重构误删、curl 测 API 测不出）
