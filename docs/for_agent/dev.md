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
│       ├── core/              下层公共模块（能力，不依赖业务）：llm / chatSession / reasonix / knowledge /
│       │                       knowledgeSession / knowledgeMcp / mcpConfig / quote / deepseekShare /
│       │                       prompts / jsonParse / routes / tasks / sse / db / tableStore / kvStore /
│       │                       settingsStore / dataRegistry
│       └── features/          上层业务模块（依赖 core）：gridPlan / cbRate / treasuryFx / reverseRepo /
│                               watchlist / kelly / rehab(医学知识库) / memo / books / deepseekShareTool /
│                               agentSessions / localData
├── apps/web/          Vite + React 19 + react-router-dom
│   └── src/
│       ├── App.tsx            侧边栏分组菜单 MENU_GROUPS + toolPages 映射 + 路由
│       ├── tools/             各工具页组件（GridPlanTool / CbRateTool / ReverseRepoTool / MedicalKbTool…）
│       └── settings/          设置页（LlmSettings / AgentSessions / LocalData / MemoTool）
└── docs/for_agent/    本目录：agent 规范沉淀
```

**分层铁律**：依赖方向 `features → core`，core 之间互不依赖；业务逻辑不进 core。
新增工具 = 建 `features/xxx/`（导出 `meta` + `register(app)`）→ shared 加契约 → web 建 `tools/XxxTool.tsx` 并注册进 `toolPages` + `MENU_GROUPS`（设置/交易/小工具分组）。

## 2. 开发流程（契约驱动）

1. **先写 shared 契约**（类型 + 注释），前后端共享，绝不直接改对方类型
2. server：core 放能力（fetch/LLM/计算），features 放业务编排（提示词/解析/路由）
3. web：`api.ts` 加方法（`get`/`post` 封装，错误响应携带 message）→ 工具页组件
4. 验证：`pnpm typecheck` + curl 全量回归（health/tools/各工具端点）+ 页面 200

## 3.1 开发进程管理（scripts/dev.mjs，2026-08-07 起强制）

- **禁止手动在后台任务里直接起 `tsx watch` / `vite`**（历史多次 EADDRINUSE/残留进程/服务静默挂掉，排查耗时）。
- 一律用 `node scripts/dev-utils/dev.mjs start|stop|restart|status|kill-port <port|all>`：
  - `start`：先清 8787/5173 端口残留（netstat 找 PID → tasklist 确认 node → taskkill /T /F），再拉起 server+web；
    常驻 supervisor 每 5s 健康检查——进程退出或「进程存活但端口空闲」（tsx 子服务挂掉）都自动重启（≤8 次）；
  - `stop`：写 `.file/dev.stop` 标记（supervisor 不再拉起并自行退出）+ 杀进程树 + 清端口；
  - 子进程日志在 `.file/dev-logs/{server,web}.log`（排查服务崩溃看这里）；
- 排查步骤：`node scripts/dev-utils/dev.mjs status`（看端口占用）→ 必要时 `kill-port all` → `start`；
- 后台运行 start 用 PowerShell 语法：`$env:PATH = "D:\Softwares\nodejs;" + $env:PATH; cd D:\Agent\toolbox; node scripts/dev-utils/dev.mjs start`。

## 3. 环境与工具注意（Windows）

- node 在 `D:\Softwares\nodejs`（**不在 PATH**）；每次命令需 `set "PATH=D:\Softwares\nodejs;%PATH%"`
- dev 服务：`pnpm dev` 后台跑（tsx watch + vite HMR 都正常）
- bash 工具解析器在 cmd/PowerShell 间不稳定：**分号 `;` 会被当参数**，
  一条命令只做一件事；多行提交信息用 `-F 文件`（`.git/COMMIT_MSG_TMP.txt`，用完删）
- typecheck 对相对导入要求显式 `.js` 扩展名（node16 moduleResolution）

## 4. LLM 公共模块（core/llm.ts + chatSession + reasonix）——三种调用模式

### 4.0 成本原则：提示词/引导词最小冗余（2026-08-07 起，强制）

**LLM 调用是花钱的，一切提示词与引导词设计以「减少重复冗余、最大化前缀缓存命中」为基本原则：**

1. **引导词（system）必须固定**：同一业务场景的 system 模板写死为常量（存提示词管理），
   **严禁把变化内容（对话/数据/日期）内联进 system**——变化内容一律放 user 消息。
   固定 system → DeepSeek 按前缀缓存命中（每次省掉重复 token）。
   - 反面教训：`watchlist.import` 模板曾内联 `{conversation}`（system 随对话变化，前缀永远 miss）→
     已改为 system 固定 + 对话走 user + 会话化（`chatSessionAsk`）。
2. **多轮会话用会话化调用**（`createChatSession` + `chatSessionAsk`）：同 id 幂等复用，
   后续轮只发增量（最小续问行），不重复整段引导词；会话 id 按业务确定性命名（如 `wl-imp-{hash}`）
   或业务幂等 id——**按内容哈希的 id 天然幂等且不跨业务污染历史**。
3. **单轮调用**（direct `chat`）仅在内容频繁变动、无会话语义时使用（如搜索类分析）；
   即便如此 system 仍应固定、变化进 user。
4. **日期注入**：需要当前日期时**只注入一次到 user 消息**，不要写进 system 模板（否则 system 每天变、前缀缓存全失效）；
   Reasonix/自研会话首次建立后由会话持有，续问不再重复。
5. **程序性提示词（非 LLM 的指令文本）不适用本原则**，但同样遵守「数据化/配置化」治理（§4.4）。

落实检查点：新增/修改任何 LLM 调用，先问「system 是否固定？变化内容是否都进了 user？能否用会话化减少重复？」

### 4.0 LLM 用量切面（三层标注，2026-08-06 重构后规范）

每次 LLM 调用被切面记录到 `llmUsage:log`，**三层标注**各自职责：

| 维度 | 值 | 职责 | 由谁决定 |
|---|---|---|---|
| `module` | 业务场景，如 `medical-kb.ask`、`cb-rate`、`watchlist.fundamental` | **面向业务**：统计"哪个业务花了多少钱" | **调用方透传**（业务入口） |
| `mode` | `direct` / `chat-session` / `reasonix` | **面向服务端逻辑**：统计"哪种调用方式" | 底层实现固定（chat/chatSessionAsk/reasonixAsk） |
| `scene` | `business` / `system` / `test` | 归属分类 | 从 module 推断（`it.`/`test.`→test；`llm.*`→system；其余 business） |

**核心规则（教训：曾混乱——medical-kb 问答用量记成会话 module `knowledge.medical`，与业务对不上）**：
1. **业务 module 由调用方透传，会话 module 只是兜底**：`chatSessionAsk(sid, msg, { module })`、
   `reasonixAsk(regId, text, { module })`、`kbAsk/kbImportFromChat(..., { module })` 均支持
   `module` 覆盖（缺省回落会话/默认 module）。
2. **module 命名规范**：`<页面/业务>.<动作>` 点分（`medical-kb.ask`、`medical-kb.import`、
   `agent-session.chat`）；**禁止**把底层会话标识（`knowledge.medical`、`watchlist.fundamental.session`）当用量 module。
3. **链路**：业务 feature（如 rehab 的 medical-kb 路由）→ 调 knowledgeSession/kbAsk 时**显式传业务 module**；
   会话类封装（knowledgeSession）再透传给 reasonixAsk/chat；**未传时归 `knowledge.unknown` 并 console.warn**
   （不回落成 `knowledge.<instance>` 技术 module，让漏传问题在用量上暴露）。
4. **前端展示**：按场景（业务/系统/测试）→ 按模式 → 按模块 三栏；旧数据无 mode/scene 兼容按 direct/module 推断。


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
- **引导词去重（2026-08-07）**：knowledgeSession 的 Agent 引导词（knowledge.agent.guide / medical-kb.agent.guide）
  **只在新会话首轮发送**——注册表记录渲染后引导词指纹 `guideFp`，后续轮次指纹相同则只发任务指令
  （历史已含引导，省每轮 ~200-400 token 且前缀更干净）；模板升级 → 指纹变 → 自动重发；
  会话重建（recreateSession）后新会话无历史，自动带引导词。
- **知识库会话复用（2026-08-07）**：reasonix 进程重启后旧会话 `unknown session` 时**重建而非 drop**——
  `recreateSession` 关闭旧会话并更新注册表（关闭失败也兜底删 `reasonixSession:` 注册表），
  同一实例注册表始终指向唯一活跃会话，不产生孤儿堆积。

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

- **Agent 型改进备忘录（2026-08-07 起，强制）**：Agent（开发 Agent）在工作过程中
  **自增**改进/遗留记录时，`POST /api/tools/memo` 必须显式传 `kind: "agent"`
  （MemoKind 含 `fix`/`feature`/`agent` 三种，**agent 型仅供 Agent 创建，用户输入不可选**）；
  Agent **禁止**创建 `fix`/`feature` 型（那是用户的输入类型，两者严格区分）。
  前端以 🤖 Agent型 徽章 + 灰底色区分展示。处理备忘录时 agent 型与用户型一视同仁。

- **提示词管理（core/prompts.ts，2026-08-06 强化）**：所有 LLM / 程序性提示词
  **必须**进 `prompts.ts` 注册表（seed 到 `settings:prompt.*`，服务端使用与页面展示
  同一条链路）；**禁止在业务代码里硬编码长 system/提示词**（审计例外可临时，随后迁移）。
  - `PromptDef` 配场景元数据 `PROMPT_META`（id → [场景分组, 归属页面]）；新提示词必须登记，
    否则管理页落「通用」分组（prompts 单测会拦）。
  - 占位符模板用 `{xxx}`（如 `{instance} {question}`）；渲染处 `.replace()` 填充。
  - 管理入口：Agent 会话管理页「📝 提示词管理」Tab（编辑/预览/重置）；API
    `GET /api/prompts`、`GET/PUT /api/prompts/:id`、`POST /api/prompts/:id/reset`。
  - 已知示例：knowledgeSession 的 Agent 引导词/任务指令（knowledge.agent.*）曾硬编码，
    已迁移为模板。

- **LLM 调用触发原则（2026-08-06 起，强制）**：**程序不得主动/自动隐式触发 LLM 调用**——
  所有 LLM 调用必须由**用户主动操作**（点击按钮/明确指令）或**用户明确规划的流程**触发，
  否则账单失控。GET 类接口只读，不得为补数据而隐式调 LLM（历史违规：reverse-repo
  GET /monthly 曾自动触发月度更新，已改为仅手动 POST refresh；其余功能均用户点击触发）
- **LLM 用量监控（core/llm.ts 切面）**：每次 chat 成功且带 usage 时自动记录
  `llmUsage:log`（KV，上限 2000 条截断）；调用方须传 `module`（如 cb-rate / watchlist.fundamental /
  llm.test）归属；`GET /api/llm/usage` 聚合（总数+按模块+按天）、`GET /api/llm/balance`
  查询 DeepSeek 平台余额（/user/balance，API key 即授权）；LLM 设置页展示；
  platform.deepseek.com/usage 网页明细需登录无法程序化抓取，用本地记录为主
- **数据删除红线（2026-08-06 教训）**：**删除/清空任何用户可见数据必须先征得用户同意**——
  即便为"整理/迁移"目的也不得擅自 DELETE KV（历史违规：重构用量切面时直接清空
  `llmUsage:log`，页面"用量管理"变空；旧数据本可兼容展示（mode/scene 有推断兜底））。
  需清理时：先说明影响与兼容方案，用户确认后再删；或保留数据仅改展示。

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

- **东财 7x24 快讯（2026-08-07）**：`https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_1_.html`
  返回 JSONP（`var ajaxResult={...}`，须正则剥 `var ` 前缀与尾分号再 JSON.parse），字段 `LivesList[].title/digest/showtime/url_w`；
  缓存 10 分钟（`watchlist:hotnews`）；np-listapi 新版接口实测常返回空 list，勿用。

## 4.9 LLM 调用开发经验总结（决策清单，2026-08-07 整合）

**选择调用模式（先决策再写码）**：
| 场景 | 模式 | 理由 |
|---|---|---|
| 单次分析、参数随请求变化 | 模式 1 `chat`（system 固定） | 无会话语义，一次即弃 |
| 多轮续问 / 批量同类任务 / 同 system 高频复用 | 模式 2 `createChatSession`+`chatSessionAsk` | append-only，前缀缓存命中（实测 3 轮 0%→51%→88.7%） |
| 长上下文 / Agent 任务 / 知识库问答 | 模式 3 Reasonix ACP | 自带压缩/持久化/工具（代价 ~20k token system 开销） |

**成本落实四问（新增/修改 LLM 调用必答）**：
1. system 是否逐字固定？——动态内容（日期/标的/月份/对话）一律 `user`（`{占位}` 在 system 中替换为「见用户消息」说明，勿真内联）
2. 能否会话化？——同 system 复用场景用确定性会话 id（如 `rr-daily-{month}`、`wl-imp-{hash}`、`wl-fund-{code}`），幂等复用 + 不跨业务污染
3. 引导词/日期是否重复？——Reasonix 会话引导词**仅首轮发送**（guideFp 指纹去重）；日期只注入 user 一次
4. 结构化输出是否共用 `robustJsonParse`？——新业务直接 import core/jsonParse，勿复制

**已踩过的坑（勿重犯）**：
- system 内联 `{conversation}`/日期 → 前缀缓存永远 miss（watchlist.import 前身）
- system 4 变体（cbRate 旧版：banks/日历/搜索注记全内联）→ 收敛为仅 searchNote 2 变体
- 会话 append 累积污染（固定 id 会话多轮后旧内容残留）→ 按内容哈希的 id（`wl-imp-{hash}`）天然隔离
- 搜索模式不注入日期 → 模型按训练知识理解「本月」；日期注入 user 且当天固定
- 模板改版后设置数据里旧模板残留（seed 幂等不覆盖）→ 改模板后必须 `POST /api/prompts/<id>/reset`
- Reasonix 引导词每轮重复 → 首轮发 + 指纹去重（省 ~200-400 token/轮）

**验证手段**：
- LLM 用量切面（§4.0 三层标注）看 module 覆盖；会话列表（Agent 会话管理页）看会话是否按预期复用
- 缓存命中实验：同一会话连续 ask，对比 usage 中 prompt tokens（命中后大幅下降）
- 单测：`chatSession.test.ts` 会话语义/归档；`knowledgeSession.test.ts` 引导词指纹去重

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

### 4.7 前后端分工与校验原则（2026-08-08，策略仓位管理教训）

**核心原则：所有业务规则校验一律在服务端做「权威校验」，前端只做「体验性校验」。** 前端校验可被绕过（直接调 API），绝不能当作安全/正确性边界。

**分工清单（新功能照此对照）**：
- **业务规则校验（服务端权威，400 拒绝 + 中文 message）**：
  - 数据完整性：必填字段、重复项查重（如重复标的 code → 400「标的 X 重复」）
  - 数值约束：非负、范围（如 0~100%）、依赖关系（如「数量非零时成本价必填」——金额 = 数量 × 成本价）
  - 领域规则：策略约束、仓位上限、业务语义（如日度计划按数量操作、无成本价无法换算金额）
- **前端只做**：输入即时反馈（前导零/千分位/防抖校验提示）、按钮禁用态、非侵入提示——**不要只在前端拦**
- **解析层（parseXxx）只做整形（trim/类型转换/过滤非法），不做业务校验**；业务校验单独显式写在路由 handler 里，400 + {ok:false, message}，前端 api.ts 已统一抛 message

**教训（本次踩坑）**：「重复标的」「数量非零成本必填」起初只在前端校验，用户指出后才补服务端——任何「不允许/必须」的规则都先问：服务端拦了吗？没拦就是漏洞。

**验证习惯**：改完服务端校验必须「重启 server + 直接 curl/脚本调 API 打 400/200 断言」（tsx watch 偶发不热更新，假 200 曾误导）；前端改动按 §6.4 测试分级验证（页面加载逻辑改动必跑冒烟，小改动用 --page 定向冒烟）。

### 4.8 开发辅助脚本规范（scripts/dev-utils/，2026-08-08）

**单源化**：脚本的**目录树 / 13 个工具用法 / 历史归档 / 进化流程唯一见 `scripts/README.md`**；dev.md 这里只放**强制规则**（导航/查表见 README §2 用途列）。README 缺失/过期时优先补 README（§8.1 同步义务）。

**强制规则（行为约束，与 README §3 互补）**：
1. 所有辅助脚本一律放 scripts/dev-utils/，**禁止仓库根目录散放 tmp_*.mjs**（反复踩坑：残留混入 commit、cmd 引号截断、CRLF 不匹配）
2. 出现第 2 次相似脚本需求 → 先查 README §2 工具表 + §4 归档表 → 有现成直接用；缺能力在 dev-utils/ 固化（不是又写 tmp）
3. 一次性调试脚本 → dev-utils/_tmp_*.mjs 跑完即删，严禁提交
4. 大段文件替换禁止 node -e（cmd 引号/中文/反引号地狱）→ 用 patch.mjs 或 write_file 脚本（§4.6）
5. 服务端单测/全量单测用 test.mjs；提交用 commit.mjs（消息引号安全）；API 验证用 api-cli.mjs；工具改动后必跑 self-test.mjs
6. 服务端校验改完必须「重启 server + API 打 400/200 断言」（tsx watch 偶发不热更新，假 200 曾误导两次，§4.7）

**同步义务**：新增/修改脚本后——README §1 目录树 + §2 工具表补/改一行 → self-test 跑通 → 提交；每阶段提交核对 README 与 dev.md §4.8 与工具实际一致（§8.1）。

## 5. 外部数据源经验

- **知乎爬虫（多内容目标，2026-08 实测）**：
  - 不局限用户：`parseZhihuTarget` 识别 **用户/问题/回答/文章/想法** 链接，或从分享文本自动提取链接（answer 路径须在 question 之前匹配：`question/{qid}/answer/{aid}`）
  - **专栏文章（zhuanlan）**：`zhuanlan.zhihu.com/p/xxx` 与 `zhihu.com/p/xxx` 是**不同 id 体系**——专栏链接必须保留 zhuanlan 域名（规范化成 www.zhihu.com/p 会 404）；parseZhihuTarget 中专栏域须**最先匹配**；`ZH_LINK_RE` 用 `(?:[\w-]+\.)?zhihu\.com` 支持子域
  - 用户 → 浏览器拦截签名 API + 滚动（断点续爬）；问题 → 拦截 `/api/v4/questions/{qid}/answers` 抓回答流；回答/文章/想法 → 打开详情页 DOM 提取正文（选择器：`.RichContent-inner`/`.Post-RichTextContainer`/`.RichText.ztext`/`.Post-RichText`/`.ArticleContent`）
  - 断点续爬：进度存 `zhihuCrawl:progress:<id>`（seed/phaseIndex/commentsDone），数量上限 100/超时 20min 自动暂停、取消返回已抓结果、续爬 seed 去重
  - 知乎新版评论 API：`/api/v4/comment_v5/{type}/{id}/root_comment`；入口是「N 条评论」按钮
  - 风控 40362：临时限流，等待恢复；Chrome profile 锁残留 → launch 失败重试前 `rmSync(PROFILE_DIR)`
- **知识库中心（虚拟知识库，2026-08）**：
  - 领域知识库 = 实例前缀（`medical.`/`trading.`…）；虚拟知识库 = 多领域集合（KV `kbVirt:<name>`，名称支持中文）
  - 虚拟库导入自动匹配：`kbImportFromChat(..., matchDomains)` 逐条静态关键词匹配（领域元数据 `kbDomain:<name>.keywords`）→ 写入 `medical.`/`trading.` 等前缀，无匹配归 `other.`（低成本；LLM 匹配可后续做兜底）
  - 聚合问答：`kbAsk(question, { instances: [...] })` 多前缀检索 → 单次 LLM
  - **领域特化模板（医学模板已迁入）**：`kbDomain:<name>` 支持 `askTemplate/extractTemplate`（问答/导入 system 模板）；`kbAsk/kbImportFromChat` 按实例读取（`getInstanceTemplate` 内联在 knowledge.ts，避免与 knowledgeHub 循环依赖），无配置回退 medical/通用；`seedMedicalTemplates(force)` 幂等初始化（force 强制还原内置医学模板）；路由 `POST /domain/medical/seed`
  - **统一体验（2026-08）**：领域库与虚拟库「导入/问答」体感一致——前端合并列表（领域+虚拟混合，类型徽章/条数）、统一使用区；可显式新建领域库（`POST /domain`，重复拒绝；`generateTemplates: true` 可选 **LLM 自动生成 ask/extract 模板**，一次调用 json 输出，失败降级 warning）；**空领域库（无数据）也可加入虚拟库**（前端多选合并 instances∪domains）；虚拟库问答先**领域路由**（纯静态 `matchDomain` 问题关键词打分）→ 命中只检索最相关领域（省 token/聚焦），未命中降级全领域；导入自动分发到最匹配领域（**无匹配归虚拟库杂项领域**——名字含 other/杂项/misc 优先，其次第一个领域，勿硬编码 other）；ask 返回 `routed` 供前端展示自动路由提示
  - **知识条目 key 支持中文**：`KEY_RE` 用 Unicode（`\p{L}\p{N}`）——zhihu 导入中文标题等场景 key 含中文合法（2026-08 改，勿回退 ASCII-only）
  - **知乎爬虫导入虚拟库**：instances 接口返回虚拟库（type=virt，在前）+ 领域实例；import 到虚拟库按子领域关键词分发（无匹配归杂项），默认选中「我的」
  - 医学知识库页面已删除（RehabMedicalTool），功能迁入知识库中心（领域库 medical + 模板）
  - 数据源已注册：`kbVirt:`/`kbDomain:`（知识库中心）
  - 前端交互要点：新建虚拟库用**领域多选 checkbox**（勿让用户手输领域名）；虚拟库卡片式列表展示总条目数
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

> ⚠️ **硬性规则（2026-08 再次强调）：所有改动无论大小、无论是否小修补，一律先 `git switch -c <type>/<简述>` 新建分支再动手；禁止在 main 上直接修改、提交或推送。曾发生多起「小改动顺手改 main」的违规（如备忘录小修），导致 main 被直接污染、验收流程失效。用户验收通过后才允许合并回 main。**



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
- [ ] 页面与模块编译 200（vite dev；**vite 只绑 `[::1]`，测试用 `http://localhost:5173` 而非 127.0.0.1**）
- [ ] 回归：`/api/health`、`/api/tools`、既有端点不受影响
- [ ] 单测：`tsx --test apps/server/src/**/*.test.ts`（含 `app.integration.test.ts`）
- [ ] **app 级集成测试约定（2026-08-07 起）**：`apps/server/src/app.integration.test.ts` 免端口测核心路由
  （`app.request`），import `./index.js` 前须 `process.env.TOOLBOX_TEST="1"`（index.ts 据此跳过端口监听）；
  只测读/纯计算链路，**禁止触发 LLM/外网**（网格计划计算/总览/用量/数据源/备忘录 CRUD/prompts 列表）。
  index.ts 已 `export { app }`——新增路由后在此补一条断言即完成「装配级回归」。

### 6.4 测试分级与场景引导（2026-08-08 起）

**四级测试（按成本递增，改动按级别对号入座）**：
- **L0 typecheck**：每次改动必跑（`pnpm typecheck`，server+web tsc --noEmit）
- **L1 单测**：服务端逻辑改动必跑相关模块单测（`node .../tsx --test apps/server/src/features/<模块>/*.test.ts`）
- **L2 定向验证**：小改动用（typecheck + 相关单测 + curl 相关 API 打 400/200 + **目标页定向冒烟 `smoke-pages.mjs --page /tools/x`** 或打开 200）——**不跑全量冒烟**
- **L3 全量冒烟**（`node scripts/dev-utils/smoke-pages.mjs`，17 页 playwright）：仅以下场景必跑

**L3 全量冒烟触发时机（严格执行，避免浪费）**：
- 用户明确要求全量测试时
- 大需求改动：新页面 / 新路由 / 多文件前端重构 / **页面加载逻辑改动**（useEffect/数据获取）
- 提交/合并 main 前的收尾自检

**测试场景对照表（改什么 → 测什么）**：

| 改动类型 | 验证级别 |
|---|---|
| 服务端路由 / 参数校验 | L0 + L1（该 feature 单测）+ curl 断言（§4.7：400/200 + message） |
| 服务端纯计算 / 业务规则 | L0 + L1（compute 等单测） |
| 前端单页内微调（UI 组件/文案/样式/类型） | L0 + **目标页定向冒烟**（`smoke-pages.mjs --page /tools/x`，比打开 200 更能发现 JS 崩溃/API 错误） |
| 前端页面加载逻辑（useEffect/API 请求/路由挂载） | L0 + **L3 冒烟**（历史教训：TradePlanTool 卡加载中，curl 测不出请求是否发出） |
| 新页面 / 新路由 / 多文件前端重构 | L0 + L3 冒烟 + §7.1 菜单/路由/契约核对 |
| shared 契约类型变更 | L0（全仓 tsc 抓所有引用）+ 受影响调用方定向验证 |
| 脚本工具（dev-utils/） | 工具自测（self-test.mjs）+ 实跑一次目标场景 |
| 提交 / 合并 main 前收尾 | L0 + L1 全量 + L3 冒烟 + 测试数据清理（§8.1） |

**测试节奏（对应改动频率）**：
- **每次小改动提交前**：L0 + 该改动对应级别（多数为 L1/L2 定向）——不跑全量
- **每个功能/需求完成时**：L0 + L1（相关模块全量）+ L2 定向验证关键交互
- **每个分支验收前**：L0 + L1 全量 + L3 冒烟 + 测试数据清理（§8.1）+ 历史归档
- **全量测试触发**：用户明确要求 / 大需求改动 / 分支收尾（严格执行，避免浪费）

**失败处理（更快收敛）**：单测/冒烟失败 → 看失败用例名与断言定位 → 修代码 → **只重跑该模块测试**（`node scripts/dev-utils/test.mjs <模块>`）或**定向冒烟该页**（`--page`）→ 全绿后再继续；**不重复全量冒烟直到收尾**

**历史教训（TradePlanTool 列表卡加载中）**：页面加载类 useEffect(() => { void loadX(); }, [loadX]) 曾被重构误删 → API 请求**根本不发出**（浏览器看不到请求，fetch 无超时则永久卡「加载中」）——此类问题 curl 测 API 是测不出来的，**涉及页面加载逻辑时必须跑浏览器级冒烟**
- 防御约定：加载类 effect 必须带注释防误删；`api.ts request` 已统一 20s 超时（普通请求），挂起会转成可见错误

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
   - **tag 必须在前端 `LocalData.tsx` 的 `TAG_COLOR`/`TAG_ORDER` 注册**（教训：`knowledge:` 源 tag=知识数据
     未注册 TAG_ORDER，整组被 `groups()` 过滤 → 用户"找不到 knowledge"）；`groups()` 现已改为
     「已知 tag 排序优先 + 未知 tag 追加末尾」，新 tag 不会漏显但仍建议补颜色。
6. **验证**：新页面 200（vite dev）＋ API curl 实测（含错误分支）＋ 菜单编辑模式拖动/保存一次。

### 7.2 项目架构依赖图（2026-08-07 起）

- **自动生成**：`core/dependencyGraph.ts` 扫描 server 源码
  （`features/*/index.ts` + 同目录业务文件、`core/*.ts`）的相对 import，生成 `{nodes, edges}`；
  `GET /api/dependency-graph` 提供。**新增/修改模块的 import 依赖即自动反映，无需手工维护图结构**。
- **展示**：后台管理 →「架构图」（`/settings/arch-graph`，ECharts 力导向：拖拽/缩放/点击节点详情与关联）。
- **手工补充的映射表**（新增模块时同步更新，否则节点显示英文 id / 无描述 / 缺外部边）：
  - `NODE_NAMES`（id → 中文名）、`NODE_DESC`（关键模块说明）、`EXTERNAL_EDGES`（外部系统/数据层连接）、
    `LLM_MODE_EDGES`（业务 → LLM 三模式边）。
- **架构约束**（图应始终体现）：features（业务层）→ core（公共层）→ 外部系统，**单向依赖**；
  业务不得反向依赖；LLM 三模式（direct/chatSession/reasonix）与 SQLite 数据层为显式带标签边。
- **验证**：改完跑 `/api/dependency-graph` 看节点/边数量与新增模块是否出现。

### 7.3 UI 细节规范（2026-08-07 起，教训：医学知识库输入框过小）

所有页面交互控件遵守以下最小尺寸与细节（用户舒适度优先）：

1. **输入框/文本域**：`padding ≥ 0.6rem 0.85rem`、`min-height ≥ 40px`、`font-size ≥ 0.9rem`、
   `border-radius 10px`、边框 `#cbd5e1` + focus ring（`0 0 0 3px rgba(37,99,235,0.12)`）。
   多行文本域高度 ≥ 96px（约 4 行），`line-height 1.7`。
2. **按钮**：`padding ≥ 0.5rem 1rem`、`font-size ≥ 0.86rem`、圆角 ≥ 10px；主按钮品牌蓝 +
   阴影 + hover 反馈；禁用态 opacity 0.55。
3. **表单结构**：字段用 `.field-label`（0.8rem/600/深灰）标注，输入框与标签间距 ≥ 0.3rem；
   不要只靠 placeholder 表达字段含义（placeholder 会消失，标签常驻）。
4. **通用原则**：可读性优先——正文 ≥ 0.8rem、表格 ≥ 0.8rem；可点击元素有 hover 反馈；
   卡片间距 ≥ 1rem；避免过小点击区（≥ 28px 高度）。
5. 优先复用 `styles.css` 的 `.input`/`.btn`/`.field-label`/`.card` 工具类；内联样式不得低于上述最小尺寸。

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

- **测试数据必须清理（硬性）**：任何测试/冒烟产生的临时数据，交付前必须删除并验证无残留——包括：临时领域库/虚拟库/知识条目（`it_*`/`test*`/`zh_*` 等前缀）、导入历史（`kbImport:history`）、LLM 用量记录（`llmUsage:` 测试 module 记录）。**单测必须在 `finally` 中彻底清理其创建的 KV**（注意前缀：领域元数据是 `kbDomain:`，删它用 `deleteDomain`；虚拟库是 `kbVirt:`，删它用 `deleteVirtKb`——勿混用，否则残留）。提交前跑一次 overview/本地数据管理 确认无 `testdomain_`/`it_` 等残留。

- **维护性文件**：docs/for_agent 下所有文件（dev.md、history/*）必须在每次阶段性提交/归档时同步更新（新路由/新页面/新公共模块/经验教训/规则变更都要记）。

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

