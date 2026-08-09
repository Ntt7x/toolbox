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
- **专题自选股（watchlist）**：每专题一个 KV 文档 `watchlist:<id>`（stocks 含 code/name/reason），
  数据源 `watchlist:`（自选数据）+ `watchlist:fundamental:`（分析数据，TTL 2 年）；
  个股名称解析复用 core/quote（标准行情工具）；财报分析 = LLM（watchlist.fundamental 提示词，
  默认联网搜索 + robustJsonParse + KV 缓存）；**Hono 静态路由必须注册在 `/:id` 参数路由之前**
  （否则被当 id 吞掉）
- **逆回购月度数据触发式更新**（服务端自动，前端零改动）：`GET /tools/reverse-repo/monthly`
  返回时计算 `missingMonths(rows)`——最新数据月 < 上个月 → 响应带 `stale/staleMonths` 并
  自动 `createTask` 后台跑 `runMonthlyUpdate`（LLM 搜索补全缺失月份，`reverse-repo.monthly-update`
  提示词）；防重（`reverseRepo:monthlyUpdate` KV 记 running，running 中不重复触发）；进度查
  `GET /tools/reverse-repo/monthly/update-status`，手动触发 `POST .../refresh`；
  **合并校验**：LLM 返回的月份必须 > 现有最大月且 ∈ expected，否则跳过（防乱序/重复/污染），
  无有效写入 → failed 且不动 KV（幂等安全）
