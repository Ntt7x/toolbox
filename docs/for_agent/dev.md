# Toolbox 开发指南（Agent 经验沉淀）

> 本文件由实际开发会话沉淀而来，是后续所有 agent 对话的**强制开发规范**。
> 由项目根 `AGENTS.md` 自动加载（常驻指令）。新会话请先通读全文再动手。

## 1. 项目架构（不可破坏）

```
toolbox/  (pnpm workspace, TypeScript 全栈)
├── packages/shared/   API 契约层：前后端共享的类型 + API_PREFIX 常量
├── apps/server/       Hono 后端（Node 24 + tsx watch）
│   └── src/
│       ├── index.ts           装配层：cors + health + tools 收集 + 挂载路由 + 启动
│       ├── core/              下层公共模块（能力，不依赖业务）：llm / quote / deepseekShare / routes
│       │                       / tasks / sse / db / tableStore / kvStore / settingsStore / dataRegistry
│       └── features/          上层业务模块（依赖 core）：gridPlan / cbRate / deepseekShareTool / localData
├── apps/web/          Vite + React 19 + react-router-dom
│   └── src/
│       ├── App.tsx            侧边栏分组菜单 MENU_GROUPS + toolPages 映射 + 路由
│       ├── tools/             各工具页组件（GridPlanTool / CbRateTool / DeepSeekShareTool）
│       └── settings/          设置页（LlmSettings）
└── docs/for_agent/    本目录：agent 规范沉淀
```

**分层铁律**：依赖方向 `features → core`，core 之间互不依赖；业务逻辑不进 core。
新增工具 = 建 `features/xxx/`（导出 `meta` + `register(app)`）→ shared 加契约 → web 建 `tools/XxxTool.tsx` 并注册进 `toolPages` + `MENU_GROUPS`（设置/交易/小工具分组）。

## 2. 开发流程（契约驱动）

1. **先写 shared 契约**（类型 + 注释），前后端共享，绝不直接改对方类型
2. server：core 放能力（fetch/LLM/计算），features 放业务编排（提示词/解析/路由）
3. web：`api.ts` 加方法（`get`/`post` 封装，错误响应携带 message）→ 工具页组件
4. 验证：`pnpm typecheck` + curl 全量回归（health/tools/各工具端点）+ 页面 200

## 3. 环境与工具注意（Windows）

- node 在 `D:\Softwares\nodejs`（**不在 PATH**）；每次命令需 `set "PATH=D:\Softwares\nodejs;%PATH%"`
- dev 服务：`pnpm dev` 后台跑（tsx watch + vite HMR 都正常）
- bash 工具解析器在 cmd/PowerShell 间不稳定：**分号 `;` 会被当参数**，
  一条命令只做一件事；多行提交信息用 `-F 文件`（`.git/COMMIT_MSG_TMP.txt`，用完删）
- typecheck 对相对导入要求显式 `.js` 扩展名（node16 moduleResolution）

## 4. LLM 公共模块（core/llm.ts + chatSession + reasonix）——三种调用模式

### 模式 1：直接调用 `chat(messages, { search?, json?, module? })`（core/llm.ts）
- search=联网搜索（Responses API + web_search，服务端执行，仅 deepseek-v4-flash）；json=response_format json_object
- **前缀稳定化约定**：system 保持逐字稳定（动态日期/标的/月份移到 user 消息），以命中 DeepSeek 前缀缓存（价 ~1/50）

### 模式 2：自研 Cache 会话 `createChatSession / chatSessionAsk`（core/chatSession.ts）
- 借鉴 Reasonix "append-only context"：system 固定 + 每轮 append user/assistant；同会话连续调用前缀命中缓存
- KV 持久化（chatSession:<id>），TTL 30 分钟；历史超长自动压缩（保留 system + 最近 6 轮）
- 注意：`createChatSession` 返回对象，传给 `chatSessionAsk` 须用 `.id`
- 实测：3 轮命中率 0% → 51% → 88.7%；适合批量/长任务（单次分析仍用模式 1）

### 模式 3：Reasonix ACP `createReasonixSession / reasonixAsk / closeReasonixSession`（core/reasonix.ts）
- 启动官方 reasonix 二进制（v1.20.0+）ACP 服务（stdio NDJSON JSON-RPC），享受其会话持久化/压缩/前缀稳定
- 二进制：`llm.reasonixBin` 配置或 npm 包 `@reasonix/cli-<platform>-<arch>`（node_modules 内）
- **协议要点（实测）**：`session/prompt` 参数 = `{ sessionId, prompt: [{type:"text",text}] }`（非标准 message）；
  回答文本必须从 **`session/update` 通知的 `agent_message_chunk`** 收集（transcript .jsonl 不实时更新，勿读）
- 同会话多轮实测会话保持正常（第 2 轮引用第 1 轮上下文）；reasonix 自带 system 开销大（~20k tokens）
- 会话生命周期：创建→多轮 ask→close（释放资源）；进程惰性单例，shutdownReasonix() 回收
- **显式进程管理（2026-08-06）**：`getAcpStatus`（PID/启动时间/未决请求）、`ensureAcpRunning`、`stopAcp`
  （taskkill /T /F 进程树，连带 MCP 子进程；注册表保留，续问自动重启+resume）；shutdownReasonix = stopAcp
- **MCP 配置（2026-08-06）**：`core/mcpConfig` 存 `settings:mcp.servers`（本地设置数据）；
  默认 seed 内置知识库 kb（node+tsx+knowledgeMcp.ts，正斜杠路径——Windows 反斜杠会被 ESM loader
  误判为 d: 协议、file:// URL 被 tsx 拼接错乱）；`enabledMcpServers` 供会话挂载；
  **空数组=用户清空**（getMcpServers 只在从未配置/损坏时回退 seed）
- **对话数据服务端托管（2026-08-06）**：reasonixAsk 成功即写 `reasonixHistory:<regId>`（user/assistant 成对，上限 300 条）；
  `getReasonixHistory` / `deleteReasonixHistory`（随 closeReasonixSession 清理）；
  `backfillReasonixHistory` 从 `%APPDATA%/reasonix/sessions/<sid>.jsonl` 回填存量会话历史
  （幂等：已有托管数据跳过；user 消息剥离注入引导词提取真实问题）；详情路由惰性触发

- 搜索模式**必须在提示词注入当前日期**（否则模型按训练知识理解"本月"）
- **LLM JSON 容错解析在 core/jsonParse.ts**（robustJsonParse/fixJsonQuotes/extractOuterJson），
  所有 LLM 结构化输出业务（cbRate / treasuryFx）共用——新业务直接 import，不要复制
- **DeepSeek 联网搜索（Responses API + web_search）耗时 8~10 分钟是常态**（多步搜索），
  后台任务超时需留足（≥10 分钟）；前端「停止分析」可随时中断；长超时在此环境
  （Node 24 + tsx watch）偶发不触发（任务最终 done/TTL 清理兜底），属已知现象
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
- **提示词统一存储于「本地设置数据」**（`settings:prompt.*`，经 `core/prompts.ts` 注册表）：
  默认值在 `core/prompts.ts` 集中 seed，运行时存 SQLite 可编辑可重置；
  服务端实际使用（cb-rate 拼 LLM 请求）与 web 页面「查看/复制程序性提示词」展示
  走**同一条链路**（`GET /api/prompts/:id` 返回 template + rendered）——改提示词
  改数据库即生效（或 API/本地数据管理页编辑），页面与实发永不失步；占位符式模板
  （如 cb-rate.system 的 {banksText}/{calendarJson}/{searchNote}/{calendarRule}）
  支持 search/日历组合，grid-plan 为无占位符全文；
  **注记也可编辑**：cb-rate.note.search / cb-rate.note.knowledge 是独立设置项，
  service 与渲染预览均从库读取 {searchNote} 替换文本——服务端对 LLM 的使用 100% 走同一链路
- API key 存服务端本地设置库（`settings:llm.apiKey`，SQLite `.file/`，已 gitignore）；旧 `.env` 仅一次性迁移
- 结构化工具（如 cb-rate）用 search 默认开 + JSON 输出 + 提示词给出严格 JSON schema，
  解析容忍杂质包裹；失败时保留 raw 兜底展示
- **LLM JSON 输出必须多层容错解析**（`robustJsonParse`，cbRate/service.ts）：
  LLM 常在字符串值内插未转义半角引号（如 `"summary": "2026年7月呈现"xxx"yyy"`）导致
  JSON.parse 失败。解析链：直接 parse → 栈匹配提取最外层 JSON（跳过字符串内 { }）→
  修复值内裸引号 → parse。
  `fixJsonQuotes` 为两遍扫描：定位所有"内容引号/结束候选"，最后一个结束候选作字符串结束，
  其余全部转义（内容引号成对 + 与结束重叠的 LLM 畸形模式如 `"高"}` 也能恢复合法 JSON）。
  注意 extractOuterJson 遇裸引号会因栈不平衡返回 null，故 fix 后须对整体再试 parse。

## 4.4 本地数据治理原则（禁止硬编码）

- **LLM 调用触发原则（2026-08-06 起，强制）**：**程序不得主动/自动隐式触发 LLM 调用**——
  所有 LLM 调用必须由**用户主动操作**（点击按钮/明确指令）或**用户明确规划的流程**触发，
  否则账单失控。GET 类接口只读，不得为补数据而隐式调 LLM（历史违规：reverse-repo
  GET /monthly 曾自动触发月度更新，已改为仅手动 POST refresh；其余功能均用户点击触发）
- **LLM 用量监控（core/llm.ts 切面）**：每次 chat 成功且带 usage 时自动记录
  `llmUsage:log`（KV，上限 2000 条截断）；调用方须传 `module`（如 cb-rate / watchlist.fundamental /
  llm.test）归属；`GET /api/llm/usage` 聚合（总数+按模块+按天）、`GET /api/llm/balance`
  查询 DeepSeek 平台余额（/user/balance，API key 即授权）；LLM 设置页展示；
  platform.deepseek.com/usage 网页明细需登录无法程序化抓取，用本地记录为主

- **业务数据一律进「本地数据管理」**（SQLite KV/表，`core/kvStore`/`tableStore`），
  运行时从库里读取；**禁止在代码中硬编码运行时数据**（表格、流水、配置、分析/探查结果等）
- **代码内常量只允许作为「工厂默认值」**，通过**幂等 seed** 写入（KV 已有该 key 则跳过，
  绝不覆盖用户编辑）；用户可在「本地数据管理」页查看/编辑/删除，删除后下次访问自动重新 seed
  （= 重置为默认）
- 现有落点：提示词默认值（`core/prompts.ts` seed `settings:prompt.*`）、逆回购存量数据
  （`features/reverseRepo/monthlyData.ts` 默认值 → `seedMonthlyData()` seed `reverseRepo:monthly`）、
  LLM 设置（`settings:llm.*`）、分析/探查结果缓存（`cbRate:`/`treasuryFx:`/`reverseRepo:daily`，TTL 2 年）
- **不属于本地数据的例外**：UI 文案、菜单结构（MENU_GROUPS）、功能元信息（tools meta）、
  纯计算参数/公式（gridPlan compute）
- 新功能落地检查：数据是否可被用户编辑？可编辑即应入库；入库后立即 `registerDataSource` 打页面 tag

## 4.5 数据可信度（cb-rate 等 LLM 结构化输出）

- 响应带 `dataMode: search|knowledge`：search=联网实时；knowledge=模型训练知识（**可能过时/幻觉**）
- **知识模式提示词必须防幻觉**：注入今天日期 + 明确"训练知识截止约 2025 年中，严禁编造今天之后
  的会议与决策，拿不准用不确定/省略，asOf 用知识最新日期"；输出 knowledgeCutoff 字段
- 不静默篡改 LLM 数据：action 非法 → 降级 hold 展示但加 bank.flags 标记；缺失央行 → missingBanks
- **缓存 schema 升级必须改 key 版本**（如 cbRate: → cbRate:v2:），否则旧契约缓存被命中
  返回污染数据（防幻觉前的编造内容还在 TTL 内）
- **任务超时终态保护**（core/tasks）：fn 在超时后迟到返回不得覆盖 error/cancelled 终态
  （DeepSeek search abort 无响应时尤其会触发，否则"卡死"后仍显示 running/done）

## 4.6 前端异步任务（useAsyncTask，切页不丢状态的正确姿势）

- **结果必须持久化**：taskId 存 sessionStorage 只解决"进行中任务"的恢复；**任务完成后的成果
  也要存 sessionStorage（`:result` 键）**，否则切页（组件卸载）后成果丢失，返回页面空白
- **初始响应即终态要直落**：缓存命中路径返回 `cache-xxx` 假 taskId + done + 完整 result，
  必须 `task.watch(taskId, initialResponse)` 直接落地展示，**绝不能**对假 taskId 再连 SSE
  （否则显示"任务不存在"）
- **SSE error 事件必须区分传输错误与服务端 error 帧**：传输层错误 `ev.data` 为空串，
  应交给 onerror 降级轮询；只有带 JSON data 的 error 帧才算"任务不存在"。两者混在一起会
  导致网络抖动时误清状态、降级轮询永不生效
- **终态防重复**：settledRef 标记——error 帧/迟到轮询结果不得重复处理（防止 onerror 与
  error 帧双路径互相覆盖）

## 5. 外部数据源经验

- **A/H 股行情（多源，2026-08 实测选型）**：`core/quote.ts` 提供两个能力——
  - `getQuoteSnapshot(code)`：**实时快照**（现价/涨跌/换手/PE/PB/市值/52周区间/币种），
    腾讯 `qt.gtimg.cn` 主源（A/H 一体、字段最全、GBK 需 TextDecoder('gbk') 转码），
    东财 `push2.eastmoney.com`（JSON 干净，secid=1.600519/0.000858/116.00700）与新浪
    `hq.sinajs.cn`（需 Referer，字段贫乏）自动降级；KV 缓存 `quote:s:` 5 分钟（行情时效短）
  - `queryMonthlyBoll(code)`：月 K → 月线 BOLL（网格计划用，腾讯 `web.ifzq.gtimg.cn` qfqmonth，
    排除未完成当月）
  - **腾讯快照字段表**（~ 分隔，A/H 前段同构）：3=价 4=昨收 5=开 31=涨跌 32=涨跌幅 33=高
    34=低 36=量 37=额（A 股万元/港股元，均转亿）39=PE 45=总市值；**A 股** 38=换手 46=PB
    47/48=52周高低；**港股** 46=TENCENT 占位 → PB=47、52周=48/49
- **DeepSeek 分享提取**：`GET https://chat.deepseek.com/api/v0/share/content?share_id={id}`
  （UA + Accept: application/json），消息含 role/content/thinking/inserted_at/accumulated_token_usage
- 测试用真实分享 id：`u5myqtvktzo5gal4qi`；测试行情：`600519` / `hk00700`
- 测试命令：`node "node_modules\.pnpm\tsx@4.23.5\node_modules\tsx\dist\cli.mjs" --test
  apps/server/src/features/cbRate/cbRate.test.ts apps/server/src/core/tasks.test.ts`
  （cbRate 单测 14 项 + tasks 单测 6 项，共 20 项，均须全绿）

## 6. git 规范

### 6.1 分支工作流（强制，2026-08-05 起）

- **每次修改（功能/修复/重构/文档）都必须新建 Git 分支**，禁止直接在 main 上开发：
  `git switch -c <type>/<简述>`（type：feat / fix / refactor / chore / docs）
- 在分支上完成改动 + **本地验证通过**（typecheck / 单测 / API 回归 / 页面 200）→ commit → `git push -u origin <分支>`
- **必须等待用户验收通过后**才能合并到 main：`git switch main && git merge <分支>` → `git push origin main`
- 合并后删除远程分支（`git push origin --delete <分支>`）与本地分支（可选）
- 用户明确要求直接改 main 的情况（如紧急修复）除外
- 新 Agent 开工前：`git status` / `git branch -a` 确认当前分支与是否有待验收分支

### 6.2 提交与推送

- 身份：`kk <kk@localhost>`（全局已配）
- 提交信息：`feat(scope): 摘要` + 空行 + 要点列表；中文
- 每完成一个功能批提交一次；`.env`、`.vscode/`、`.file/` 不入库（已 gitignore）
- 提交前 `git status` 确认无测试残留（`$null` 之类的垃圾文件）
- **每次阶段性提交前，必须同步更新 `docs/for_agent/` 下全部维护性文件**（见 §8）：
  本会话若产生了新的经验/约定/架构变化/文件改名，先更新 dev.md 再提交，
  提交信息中注明文档同步（如 `docs(agent): …`）；禁止只改代码不落文档。
- **每次 commit 后必须自动 push 到 origin**（提交即推送）：
  - 远程已配置：`origin = https://github.com/Ntt7x/toolbox.git`，本地凭证可用；
  - 分支上：`git add -A` → `git commit` → `git push -u origin <分支>`（一条龙）；
  - push 失败（认证/网络）时：保留本地提交、报告失败原因，下次可重推，不得丢弃提交；
  - push 成功后确认 `git status --short --branch` 显示 `## <分支>...origin/<分支>`（无 ahead/behind）。

## 7. 验证清单（每功能必过）

- [ ] `pnpm typecheck` 全绿
- [ ] 新 API 用 curl 实测（含错误分支：非法参数/未配置/上游失败）
- [ ] 页面与模块编译 200（vite dev）
- [ ] 回归：`/api/health`、`/api/tools`、既有端点不受影响

### 7.1 新页面 / 新路由 / 新菜单注意事项（2026-08-06 起，教训：agent-sessions）

新增任何页面/路由/菜单项后，必须逐项核对：

1. **前端菜单注册三件套**（`apps/web/src/App.tsx`）：`MENU_GROUPS` 加分组项
   （staticItems 用 `{name, path, icon}`，工具页用 `toolIds`）＋ `<Route>` 映射 ＋ 组件 import。
2. **菜单编辑模式兼容**（教训：`/settings/agent-sessions` 曾因旧 `settings:menu.order`
   未含新项而"显示在组末尾但拖不动、保存不进顺序"）：
   - 新增菜单项后，先查服务端 `settings:menu.order` 现值（`sqlite3` 或本地数据管理页）；
     若该组已有保存顺序且不含新 key，新项会靠 `resolveGroupItems` 的 rest 补显示，
     但编辑模式草稿不包含它 → 不可拖、保存丢失（startEdit 已修复：进入编辑模式时
     将未列出的默认项合并进草稿）。
   - 规则：**新菜单项 key 必须能被 `defaultOrder` 覆盖**（staticItems 的 key=path，
     toolIds 的 key=tool id），且改动后建议清一次该组顺序或验证编辑模式可拖动。
3. **服务端注册**：新 feature 必须在 `apps/server/src/index.ts` 加 import + `register(app)`；
   feature 的 `meta.path` 必须与前端路由一致（`/tools/x` 或 `/settings/x`）。
4. **shared 契约**：请求/响应类型放 `packages/shared/src/index.ts`，服务端与前端共用；
   前端 `api.ts` 同步加方法（`jsonInit`，DELETE 用 `jsonInit("DELETE", {})`）。
5. **持久化数据**：新数据源（KV 前缀/表）必须 `registerDataSource`（本地数据管理可见），
   否则落入"未标记"。
6. **验证**：新页面 200（vite dev）＋ API curl 实测（含错误分支）＋ 菜单编辑模式拖动/保存一次。

## 8. 历史进度记录（必须遵守）

`docs/for_agent/history/` 目录记录**每个时间点 + Agent 对话的修改总结**，供后续 Agent 获取历史进度。

- **新 Agent 开工前**：先读最近一份 history（`ls docs/for_agent/history/` 取最新），了解已完成/遗留，避免重复开发
- **每个 Agent 会话结束时**：在 `docs/for_agent/history/` 追加一份总结，命名 `YYYY-MM-DD-NN.md`（NN 为当日序号）
- 总结格式：时间、会话主题、按序完成的功能（含文件/API）、git commit、**遗留/规划事项**（🔮 未实现 🚧 未提交）
- 历史文件只增不改（除非事实错误），保持时间线完整

### 8.0 改进备忘录分类规则（2026-08-06 起）

「改进备忘录」（/settings/memo）区分两类改进记录：

- **🔧 修复型（kind=fix）**：简短的改进要求（一句话能说清的问题/优化点）
- **🧩 需求型（kind=feature）**：详细的需求描述（涉及多文件/新页面/新数据模型的大需求）

**开发者驱动 Agent 的默认行为**：
- 用户说"处理备忘录"时，**默认只完成「修复型」改进**（fix），不擅自实现需求型
- **需求型（feature）改进**必须等待用户显式确认（用户明确点名实现或说"全部处理"）后才做
- 处理完的条目在 memo:items 里标记 status=done；类型字段 `kind`（缺省 fix，旧数据兼容）

## 8.1 维护性文件同步规则（每次提交/归档必做）

`docs/for_agent/` 下所有文件均为**维护性文件**，每次**阶段性提交**与**归档**后必须整体同步，不允许只更新其中一部分：

1. **维护性文件清单**：
   - `docs/for_agent/dev.md`——常驻开发规范（架构/经验/约定），后续 Agent 的主依据；
   - `docs/for_agent/history/*.md`——时间线记录（会话总结，只增不改）；
   - 根目录 `AGENTS.md`——强制加载入口（若 dev.md 目录结构/引用路径变化需同步）。
2. **每次阶段性 git commit 前**（§6）：检查本次改动是否影响任何经验/约定/结构，
   受影响则先更新 dev.md（新增节/条目或修订过时内容），把文档更新一起提交。
3. **每次归档 history 后**：立即对照本次会话改动核对 dev.md——新增的经验/教训必须
   已固化进 dev.md（历史记录 ≠ 常驻规范，只有 dev.md 会被自动加载）；
   若 dev.md 有目录/编号变化，同步检查 AGENTS.md 的引用与导入仍正确。
4. **检查方法**：`git status` 查看 `docs/for_agent/` 与 `AGENTS.md` 的变更，
   确认本次会话的 dev.md 更新 + history 归档两者都在（提交或工作区中）。
5. **反例（禁止）**：只写 history 不更新 dev.md（新 Agent 看不到经验）；
   只改代码不改文档；归档后 dev.md 与代码事实不符（如存储位置/API 已变但文档仍旧）。

