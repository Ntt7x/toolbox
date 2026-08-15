# Toolbox 开发指南（Agent 经验沉淀）

> 本文件由实际开发会话沉淀而来，是后续所有 agent 对话的**强制开发规范**。
> 由项目根 `AGENTS.md` 自动加载（常驻指令）。
>
> **📖 导读**：先读 `docs/for_agent/README.md`（文档地图）再动手；本文件按需加载——
> - **必读**：§0 开工清单、§1 架构、§3 环境、§4 git、§5 验证清单、§6 核心原则
> - **按需**：§7 领域索引（涉足对应领域时）、§8 历史/备忘录（新会话查进度时）
> - **命令速查**：`docs/for_agent/commands.md`（toolbox 统一入口）

## 0. 开工清单（每个新会话必走）

1. **加载规范**：读 `docs/for_agent/README.md`（文档地图）定位本次任务涉及的文档；本文件（dev.md）§0-§5 + §6.1/6.5/6.7 为常驻核心规范（§6 其余小节涉足 LLM/脚本时按需）；涉足专业领域（Reasonix / 行情 / 知乎 / 知识库 / trade-plan / 浏览器自动化）时按 §7 索引**按需加载**对应 domains 文档。
2. **查状态**：`git status` / `git branch -a`——当前分支 + 是否有待验收分支（§4）。
3. **读历史**：先看 `docs/for_agent/history/INDEX.md`（主题索引）或最近一份归档，了解已完成/遗留（§8）。
4. **读备忘录**：`toolbox memo stats` + `list`——处理 open 改进备忘录（§8.0）。
5. **建分支**：需要改动一律 `git switch -c <type>/<简述>`（§4.1，禁止 main 直改）。
6. **验证→报告→等确认后提交**：L0 typecheck → 按 §5.1 分级验证 → **报告给用户（不自动提交）** → 用户确认分支处理正确后 → `toolbox commit "msg"`（自动 add+commit+push）→ 等用户验收再合并 main（§4）。

**常用命令（统一入口 `node scripts/dev-utils/toolbox.mjs <cmd>`，底层脚本可直调；完整速查见 `docs/for_agent/commands.md` + scripts/README.md）**：
| 用途 | 命令 |
|---|---|
| 类型检查（L0） | `toolbox typecheck`（全仓）/ `toolbox typecheck --app server|web` |
| 模块/全量单测 | `toolbox test <模块>` / 空=全量 |
| 重启 dev 环境 | `toolbox dev restart` |
| 提交+推送 | `toolbox commit "feat(x): ..."` |
| 备忘录 | `toolbox memo list / stats / done <id>` |
| 页面定向/全量冒烟 | `toolbox smoke --page /tools/x` / 无参全量 |
| API 断言 | `toolbox api GET /health` |
| 查数据残留 | `toolbox kv list/count <前缀>` |
| 改动健康检查 | `toolbox check`（提交前） |

---

## 0.5 省 Token 指导思想（2026-08-16 用户确立，强制）

**LLM 交互每一步都消耗 token；Agent 与用户的协作以「省 token、少往返、一次到位」为最高原则之一。**
任何「可以少做就少做、可以合并就合并、可以精简就精简」的机会都要主动抓住：

1. **合并提交**：一个验收周期内的全部改动**默认合并为一个 commit**（除非用户明确要拆）——
   少一次提交就少一轮确认/汇报/推送；拆分提交仅在用户主动要求时做（§4.2 已更新）。
2. **精简输出**：向用户报告用「要点式」而非流水账；同一轮内能汇总的验证结果（tsc/单测/冒烟）
   一次报告，不逐项刷屏；已确认的事项不重复陈述。
3. **减少往返**：能在同一轮完成的验证（typecheck + 单测 + 冒烟）合并执行；
   需要用户决策的点一次性列全（含默认建议），不挤牙膏式逐问。
4. **复用沉淀**：反复出现的手写模式先沉淀为脚本/组件（§6.8）再继续——脚本省的不只是时间，
   还有每次重复手写的 token；本迭代已沉淀 `_lib`/`ts-resolve-hook`/`browser-run`（见 history 补 20-21）。
5. **避免冗余验证**：验证按 §5.1 分级最小化——单文件改动跑定向而非全量；
   已全绿的全量结果在同批次后续提交中不重复跑（除非触及相同代码）。
6. **文档同步一次到位**：阶段性收尾时文档更新与代码提交同批完成（§4.2），不另起一轮补文档。

反面案例（2026-08-16 确立）：多轮迭代积累了 24 文件改动，逐主题拆分需 5 次提交 + 5 轮确认；
用户指示「合并提交省点 token」→ 一次提交 + 一次确认完成，省掉 8+ 轮往返。

---

## 1. 项目架构（不可破坏）

```
toolbox/  (pnpm workspace, TypeScript 全栈)
├── packages/shared/   API 契约层：前后端共享的类型 + API_PREFIX 常量
├── apps/server/       Hono 后端（Node 24 + tsx watch）
│   └── src/
│       ├── index.ts           装配层：cors + health + tools 收集 + 挂载路由 + 启动
│       ├── core/              下层公共模块（能力，不依赖业务）：llm / chatSession / reasonix / knowledge /
│       │                       knowledgeSession / knowledgeMcp / mcpConfig / prompts / jsonParse / quote /
│       │                       deepseekShare / browser / fund / httpProxy / dependencyGraph / routes / tasks /
│       │                       sse / db / tableStore / kvStore / settingsStore / dataRegistry
│       └── features/          上层业务模块（依赖 core）：gridPlan / cbRate / treasuryFx / reverseRepo /
│                               watchlist / kelly / tradePlan / knowledgeHub / newsCenter / browserChat /
│                               zhihuCrawler / books / memo / deepseekShareTool / agentSessions / localData /
│                               tradeV2
├── apps/web/          Vite + React 19 + react-router-dom
│   └── src/
│       ├── App.tsx            侧边栏分组菜单 MENU_GROUPS + toolPages 映射 + 路由
│       ├── tools/             各工具页组件（GridPlanTool / CbRateTool / ReverseRepoTool / KnowledgeHubTool…）
│       └── settings/          设置页（LlmSettings / AgentSessions / LocalData / MemoTool / ArchGraph）
└── docs/for_agent/    本目录：agent 规范沉淀
    ├── dev.md                总纲（AGENTS.md 强制加载）：架构/流程/强制规则/验证/历史
    └── domains/              专业领域经验（按需加载，dev.md 内指针）：reasonix / features / data-sources
```

**分层铁律**：依赖方向 `features → core`，core 之间互不依赖；业务逻辑不进 core。
新增工具 = 建 `features/xxx/`（导出 `meta` + `register(app)`）→ shared 加契约 → web 建 `tools/XxxTool.tsx` 并注册进 `toolPages` + `MENU_GROUPS`（分组：后台 / 交易 / 工具，见 §5.2 菜单三件套）。
前端 UI 组件：复杂交互优先用 shadcn/ui（§5.4 组件库选型），简单元素用现有样式体系。
**外部 RPC 接入形态（2026-08-10 起）**：服务端架构支持 `api(ts) → api/rpc`——TS api 层（Hono 路由）经 RPC 调用独立的外部 RPC 服务（如 C# 服务）。RPC 服务一律按「外部系统」接入：在 features 层包装调用（遵守 `features → core → 外部系统` 单向依赖铁律），并在 dependencyGraph 的 `EXTERNAL_EDGES` 登记；传输/协议形态（HTTP/JSON、gRPC 等）**未定，只记方向不写死实现**。TS 契约（packages/shared）与 RPC 侧类型无直接共享，双端契约需经 OpenAPI 生成或手工对齐。

## 2. 开发流程（契约驱动）

**0. 先规划，后实现（硬性，2026-08-10 港股 Chat 补充教训）**——编程新手常见错误：**规划不足就急于上手**。本次修复连环返工 6 轮，根因是没先做需求分析就改代码。任何**非平凡改动**（LLM 解析、多市场数据、新流程、前后端接口）动手前先写出**实现方案**，至少覆盖：
   - **输入 → 处理 → 输出**：数据从哪来、怎么校验/规范化、产出什么结构
   - **边界与异常**：LLM 输出为空/格式不符怎么办？多市场代码格式？用户输入异常？
   - **兜底策略**：确定性兜底（正则/行情工具）> 依赖 LLM 稳定性
   - **验证路径**：怎么测（API/页面/真实数据），先 curl 再写前端
   - 参考：§7.4 港股 Chat 补充 6 条教训（模板与校验对齐 / LLM 稳定空输出兜底 / 结构化字段用确定性 API / 诊断信息 / 新路由 curl 验证 / 服务端重启验证）
   规划成本远低于返工成本；写完方案再进 §1 契约 → 实现。

1. **先写 shared 契约**（类型 + 注释），前后端共享，绝不直接改对方类型
2. server：core 放能力（fetch/LLM/计算），features 放业务编排（提示词/解析/路由）
3. web：`api.ts` 加方法（`get`/`post` 封装，错误响应携带 message）→ 工具页组件
4. 验证：`pnpm typecheck` + api-cli 全量回归（health/tools/各工具端点，§6.8）+ 页面 200

## 3. 环境与工具注意（Windows）

- node 在 `D:\Softwares\nodejs`（**不在 PATH**）；命令前设 PATH（bash 工具按 cmd 语法）：`set "PATH=D:\Softwares\nodejs;%PATH%"`
- dev 服务：`pnpm dev` 后台跑（tsx watch + vite HMR 都正常）
- **bash 工具执行层 = cmd.exe（实测 2026-08-10）**：环境说明虽声称 PowerShell，实际命令由 cmd.exe 执行——`echo %COMSPEC%` 展开正常，而 `$PSVersionTable` / `Get-Date` 等 PowerShell 语法报「不是内部或外部命令」。因此（硬性规则）：
  1. **命令中禁止出现 `;`**：cmd 中它不是分隔符，整串会被拼成单个参数（例：`git status --short --branch; git branch -a` 报 `unknown option 'branch;'`）
  2. **禁止 PowerShell 专用语法**：`$env:...` / `Get-Date` / `Select-Object` 等在 bash 工具内一律不可用（仅 cmd 语法 + 现有工具可用）
  3. **一条命令只做一件事**；多命令拆成多次工具调用，勿用 `&` / `&&` 拼接（同样会被截断/拼接为参数）
  4. 需要日期用 `echo %DATE%`（或 `git log -1 --format=%ad --date=short`）；取目录最新文件用专用 ls 工具或 `dir /b`（cmd 无 Select-Object/tail）
  - 例外：给用户在**真实 PowerShell 终端**手动执行的说明（§3.1 等标注「终端手动」处）不受此限；bash 工具内一律按 cmd 写
  - 根因在宿主工具层（bash 工具由 cmd 解析），仓库内无法根治，只能统一规避；违反会浪费多轮排查，故列为硬性
- 提交用 `commit.mjs`（消息引号安全，自动 add+commit+push，§6.8）
- typecheck 对相对导入要求显式 `.js` 扩展名（node16 moduleResolution）

### 3.1 开发进程管理（scripts/dev-utils/dev.mjs，2026-08-07 起强制）

- **禁止手动在后台任务里直接起 `tsx watch` / `vite`**（历史多次 EADDRINUSE/残留进程/服务静默挂掉，排查耗时）。
- 一律用 `node scripts/dev-utils/dev.mjs start|stop|restart|status|kill-port <port|all>`：
  - `start`：先清 8787/5173 端口残留（netstat 找 PID → tasklist 确认 node → taskkill /T /F），再拉起 server+web；
    常驻 supervisor 每 5s 健康检查——进程退出或「进程存活但端口空闲」（tsx 子服务挂掉）都自动重启（≤8 次）；
  - `stop`：写 `.file/dev.stop` 标记（supervisor 不再拉起并自行退出）+ 杀进程树 + 清端口；
  - 子进程日志在 `.file/dev-logs/{server,web}.log`（排查服务崩溃看这里）；
- 排查步骤：`node scripts/dev-utils/dev.mjs status`（看端口占用）→ 必要时 `kill-port all` → `start`；
- 后台运行 start（bash 工具内按 cmd 语法，终端手动可换 PowerShell）：`set "PATH=D:\Softwares\nodejs;%PATH%" && cd /d D:\Agent\toolbox && node scripts/dev-utils/dev.mjs start`
- **detached 常驻（2026-08-14 起）**：`dev start` 立即返回，supervisor 以独立进程组后台常驻（脱离调用者生命周期——调用方退出/被超时杀死不再连带杀掉 tsx/vite）；状态用 `dev status`，停止用 `dev stop`（杀 supervisor 树 + 清端口）
- **tsx watch 端口竞态（2026-08-14 根治）**：源码变更时 tsx 重启子进程，旧子进程端口未释放会 EADDRINUSE 崩溃——server 入口已加监听自动重试（1.5s×10 次自愈）；supervisor 重启前也会强清端口；若仍异常查看 `.file/dev-logs/server.log`


## 4. git 规范
### 4.1 分支工作流（强制，2026-08-05 起）

> ⚠️ **硬性规则（2026-08 再次强调）：所有改动无论大小、无论是否小修补，一律先 `git switch -c <type>/<简述>` 新建分支再动手；禁止在 main 上直接修改、提交或推送。曾发生多起「小改动顺手改 main」的违规（如备忘录小修），导致 main 被直接污染、验收流程失效。用户验收通过后才允许合并回 main。**



- **每次修改（功能/修复/重构/文档）都必须新建 Git 分支**，禁止直接在 main 上开发：
  `git switch -c <type>/<简述>`（type：feat / fix / refactor / chore / docs）
- 在分支上完成改动 + **本地验证通过**（typecheck / 单测 / API 回归 / 页面 200）
- ⚠️ **分支内工作默认不提交（2026-08-10 用户规则）**：改动在工作区保留、**不自动 commit/push**；
  提交时机 = **用户确认分支正确处理问题后**（用户说"提交"/"可以了"/"验收通过"等）——
  Agent 与用户之间是**反复改进循环**：改 → 报告 → 用户测试反馈 → 再改 → …… → 用户确认 → 才提交；
  禁止"改完即自动提交到分支"（曾因自动提交让用户失去对分支内容的控制与检查窗口）
- **必须等待用户验收通过后**才能合并到 main：`git switch main` → `git merge <分支>` → `git push origin main`（PowerShell 不支持 `&&`，分步执行）
- 合并后删除远程分支（`git push origin --delete <分支>`）与本地分支（可选）
- 用户明确要求直接改 main 的情况（如紧急修复）除外
- 开工状态检查已在 §0 开工清单（步骤 2-4），此处不重复

### 4.2 提交与推送

- 身份：`kk <kk@localhost>`（全局已配）
- 提交信息：`feat(scope): 摘要` + 空行 + 要点列表；中文
- **提交时机由用户确认触发**（§4.1 规则）：分支内工作不自动提交；用户确认后提交——**默认合并为一个 commit（§0.5 省 Token 指导思想），拆分仅在用户明确要求时**
- 每完成一个功能批提交一次；`.env`、`.vscode/`、`.file/` 不入库（已 gitignore）
- 提交前 `git status` 确认无测试残留（`$null` 之类的垃圾文件）
- **每次阶段性提交前，必须同步更新 `docs/for_agent/` 下全部维护性文件**（见 §8）：
  本会话若产生了新的经验/约定/架构变化/文件改名，先更新 dev.md 再提交，
  提交信息中注明文档同步（如 `docs(agent): …`）；禁止只改代码不落文档。
- **每次 commit 后必须自动 push 到 origin**（提交即推送）：
  - 远程已配置：`origin = https://github.com/Ntt7x/toolbox.git`，本地凭证可用；
  - 分支上：推荐 `node scripts/dev-utils/commit.mjs "msg"`（自动 add+commit+push）；或手写 `git add -A` → `git commit` → `git push -u origin <分支>`；
  - push 失败（认证/网络）时：保留本地提交、报告失败原因，下次可重推，不得丢弃提交；
  - push 成功后确认 `git status --short --branch` 显示 `## <分支>...origin/<分支>`（无 ahead/behind）。

## 5. 验证清单（每功能必过）
### 5.0 设计前置（2026-08-16 文档中心反思，新页面/大改造写代码前必做）

写代码前先产出《设计说明》并自答五问（答不了说明没想清楚，不许动手）：

1. **定位**：这个页面在用户工作流里是什么？在 toolbox 生态里是**采集/沉淀/应用**哪一层？和相邻模块（知识库/爬虫/交易）的关系与数据流转？
2. **范式**：成熟工具领域有没有已验证的交互范式可复用（vscode 目录+编辑器、资源管理器）？**禁止自创更差的范式**。
3. **规模**：数据量增长到 100/1000 时还成立吗？**搜索/缓存/层级这些"规模性能力"是否一开始就有**，而不是等崩了再补？
4. **消费 vs 管理**：内容型页面以**消费**（读/搜/改/用内容）为核心，管理功能（组织/回收站/标签）是手段不是目的——别本末倒置。
5. **验收 = 用户旅程**：从进页面到完成核心任务（找到→打开→读完→改完）每一步是否顺手？用**用户旅程走查**代替"功能存在性"验收。

**反面案例（文档中心初版）**：弹窗预览、树无叶子、无编辑、无全文搜索、无缓存——全是被用户 memo 一条条点破后才补（数学公式→tab→树叶子→编辑器布局）。根因是"先实现后设计、被动修补"，本节省作为设计前置强制项。

## 5. 验证清单（每功能必过）
### 5.1 测试分级与场景引导（2026-08-08 起）

**四级测试（按成本递增，改动按级别对号入座）**：
- **L0 typecheck**：每次改动必跑（`pnpm typecheck`，server+web tsc --noEmit）
- **L1 单测**：服务端逻辑改动必跑相关模块单测（`node scripts/dev-utils/test.mjs <模块>`，自动定位 .test.ts；空参数=全量串行）
- **L2 定向验证**：小改动用（typecheck + 相关单测 + curl 相关 API 打 400/200 + **目标页定向冒烟 `smoke-pages.mjs --page /tools/x`** 或打开 200）——**不跑全量冒烟**
- **L3 全量冒烟**（`node scripts/dev-utils/smoke-pages.mjs`，19 页 playwright，含页面内容断言）：仅以下场景必跑

**影响面判定（2026-08-10 起，先判影响面再选级别——核心原则）**：
> **按「哪些页面实际受影响」定级，不是按「改了多少文件」定级。** 多文件改动若只影响单个页面，仍属定向冒烟范围。

| 影响面 | 判定方法 | 验证级别 |
|---|---|---|
| **页面级**：单页内改动（tools/XxxTool.tsx 内部） | 改动文件只有该页 | L0 + 该页定向冒烟（`--page /tools/x`） |
| **组件/共享层级**：`components/ui/*.tsx`、`lib/`、hooks | **先 `grep` 使用方**（`grep -rl "@/components/ui/xxx" apps/web/src` 或全局搜组件名）→ 冒烟**所有使用方页面**（通常 1-2 个，与全量等价） | L0 + 使用方页面定向冒烟——**不因组件文件多而升 L3** |
| **全局级**：`index.css` 主题层、`main.tsx`、`App.tsx` 布局/路由表、`api.ts` | 改动影响所有页面渲染/请求 | 才考虑 L3 |

**L3 全量冒烟触发时机（严格执行，避免浪费）**：
- 用户明确要求全量测试时
- **影响面覆盖多数页面的**前端重构：布局/路由表/全局样式/全局请求层
- 页面加载逻辑改动（useEffect/数据获取）**且该页属高频核心页**（或改的是通用加载 hook）
- 提交/合并 main 前的收尾自检

**测试场景对照表（改什么 → 测什么）**：

| 改动类型 | 验证级别 |
|---|---|
| 服务端路由 / 参数校验 | L0 + L1（该 feature 单测）+ API 断言（api-cli，§6.7：400/200 + message） |
| 服务端纯计算 / 业务规则 | L0 + L1（compute 等单测） |
| 前端单页内微调（UI 组件/文案/样式/类型） | L0 + **目标页定向冒烟**（`smoke-pages.mjs --page /tools/x`，比打开 200 更能发现 JS 崩溃/API 错误） |
| 组件库改动（`components/ui/*.tsx`、shadcn 底层切换、lib/） | L0 + **grep 使用方 → 使用方页面定向冒烟**（不因组件文件多而升 L3；见上「影响面判定」） |
| 前端页面加载逻辑（useEffect/API 请求/路由挂载） | L0 + **L3 冒烟**（历史教训：TradePlanTool 卡加载中，curl 测不出请求是否发出） |
| 新页面 / 新路由 / 布局 / 路由表 / 全局样式重构 | L0 + L3 冒烟 + §5.2 菜单/路由/契约核对 |
| shared 契约类型变更 | L0（全仓 tsc 抓所有引用）+ 受影响调用方定向验证 |
| 脚本工具（dev-utils/） | 工具自测（self-test.mjs）+ 实跑一次目标场景 |
| 提交 / 合并 main 前收尾 | L0 + L1 全量 + L3 冒烟 + 测试数据清理（§8.1） |

**测试节奏（对应改动频率）**：
- **每次小改动提交前**：L0 + 该改动对应级别（多数为 L1/L2 定向）——不跑全量
- **每个功能/需求完成时**：L0 + L1（相关模块全量）+ L2 定向验证关键交互
- **每个分支验收前**：L0 + L1 全量 + L3 冒烟 + 测试数据清理（§8.1）+ 历史归档
- **全量测试触发**：用户明确要求 / 大需求改动 / 分支收尾（严格执行，避免浪费）

**收敛信号（2026-08-09 起，启发自 Agent Loop Engineering 停时设计）**：会话/分支是否可提请验收，不靠 Agent 自报"完成了"，用**可观测信号**判断：
- 连续最近 3 次提交均 L0 + L1 全绿（无回归）
- 最近 diff 增量递减（改动越改越小，而非越改越大）
- 无 open 改进备忘录；L3 冒烟全绿；`check-change.mjs` 无 FAIL
满足以上 → 向用户主动提示"疑似收敛，可提请验收"（验收仍是人拍板——评估器是人工，停时信号只做建议）。

**失败处理（更快收敛）**：单测/冒烟失败 → 看失败用例名与断言定位 → 修代码 → **只重跑该模块测试**（`node scripts/dev-utils/test.mjs <模块>`）或**定向冒烟该页**（`--page`）→ 全绿后再继续；**不重复全量冒烟直到收尾**

**历史教训（TradePlanTool 列表卡加载中）**：页面加载类 useEffect(() => { void loadX(); }, [loadX]) 曾被重构误删 → API 请求**根本不发出**（浏览器看不到请求，fetch 无超时则永久卡「加载中」）——此类问题 curl 测 API 是测不出来的，**涉及页面加载逻辑时必须跑浏览器级冒烟**
- 防御约定：加载类 effect 必须带注释防误删；`api.ts request` 已统一 20s 超时（普通请求），挂起会转成可见错误
- **冒烟必须断言页面内容（2026-08-09 教训）**：旧版 smoke-pages 只查 API 状态与 JS 崩溃——`/admin/deps`（不存在路由）404 占位页因无 API 错误而 PASS，**静默放行**；现已升级为**每页 expect 标志词 + 「页面不存在」反断言**（19 页）。新增页面必须同步 smoke-pages 的 PAGES（含 expect 词），改页面标题时同步更新 expect。

### 5.2 新页面 / 新路由 / 新菜单注意事项（2026-08-06 起，教训：agent-sessions）

新增任何页面/路由/菜单项后，必须逐项核对：

1. **前端菜单注册三件套**（`apps/web/src/App.tsx`）：`MENU_GROUPS` 加分组项
   （staticItems 用 `{name, path, icon}`，工具页用 `toolIds`）＋ `<Route>` 映射 ＋ 组件 import。
2. **菜单编辑模式兼容**（教训：`/settings/agent-sessions` 曾因旧 `settings:menu.order`
   未含新项而"显示在组末尾但拖不动、保存不进顺序"）：
   - 新增菜单项后，先查服务端 `settings:menu.order` 现值（`node scripts/dev-utils/kv.mjs get settings:menu.order` 或本地数据管理页）；
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

### 5.3 项目架构依赖图（2026-08-07 起）

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

### 5.4 UI 细节规范（2026-08-07 起，教训：医学知识库输入框过小）

**组件库选型（2026-08-09 起，2026-08-10 底层切 Base UI）：新前端组件优先采用成熟组件库 `shadcn/ui`**
- 官方安装文档：https://ui.shadcn.com/docs/installation/vite（React 19 + Vite 兼容）
- 定位：shadcn/ui 是**复制式**组件库（无头组件 + Tailwind 样式），组件源码复制进 `apps/web/src/components/ui/`，**可完全定制、无运行时包锁定**——适合"个人工具集 + 频繁迭代"
- **底层（2026-08-10 切换）：Base UI（`@base-ui/react`）**，非 Radix——shadcn 官网 2026-07 起新项目默认 Base UI；切换/API 差异/踩坑**见 `docs/for_agent/domains/shadcn.md`**（Slider 单值/Seclet null/placeholder/自定义易被覆盖）
- **适用范围**：复杂交互组件（对话框/下拉/开关/标签页/表格/表单/弹窗）优先 shadcn；**简单元素**（按钮/输入框/卡片）继续用现有 `styles.css` 工具类或内联样式——**存量页面渐进迁移，不强制重写**
- **引入前提（已落地 2026-08-09，TradePlanTool 重写时）**：`tailwindcss` v4（`@tailwindcss/vite` 插件）+ `cn` 工具（clsx + tailwind-merge，`src/lib/utils.ts`）+ `components.json` + `@/` path alias（vite resolve.alias + tsconfig paths）+ CSS 变量 token（`src/index.css`，主色对齐 #2563eb）
- **shadcn 使用经验（TradePlanTool 重写实践沉淀）**：
  - **初始化**：`npx shadcn@latest add <组件...>`（在 apps/web 下跑，读 components.json）；Radix 现在统一为 `radix-ui` 单包（非散装 @radix-ui/react-*）
  - **Select**：`<Select value onValueChange>` 的 value 是 string，`onValueChange(v: string)`；**value 不允许空串**（初始无值用 `SelectValue placeholder` 而不是 value=""）；`SelectItem` 支持 `disabled`
  - **Slider**：值是**数组**（`value={[n]}` + `onValueChange={(v) => set(v[0])}`），与原生 `<input type=range>` 不同
  - **Button**：variant（default/secondary/outline/ghost/destructive）+ size（default/sm/lg/icon）；小按钮用 `size="icon"` + className 微调
  - **Input 半受控**（数字输入）：shadcn Input 的 onChange 正常转发，半受控模式（本地 text 态 + blur 提交）可用——**但注意**：受控组件 onChange 立即回写会吞中间态（"1."），数字输入必须半受控（见 §6.8 前 TradePlanTool StepInput 教训）
  - **tailwind preflight 无破坏**：现有页面内联样式自给自足，preflight 重置被显式样式覆盖——19 页冒烟确认无回归
  - **@theme inline 映射必配（大坑）**：tailwind v4 的 `bg-primary`/`bg-secondary` 等类依赖
    `@theme inline { --color-primary: var(--primary); ... }` 映射（shadcn init 标准产物）。
    若只写 `:root { --primary: 217 91% 60% }`（HSL 三段式）且无映射 → `bg-primary` 输出无效颜色，
    **按钮/滑块轨道全部透明/白（"按钮看不见"根因）**。修复：变量用完整色值（hex/oklch）+
    @theme inline 全量映射。自检：`getComputedStyle(button).backgroundColor` 应为 `rgb(37,99,235)` 而非 transparent
  - **组件染色按逻辑**：危险操作（删除 ✕）`hover:bg-red-50 hover:text-red-600`；Slider 轨道 `bg-slate-200/90`
    （默认 bg-muted 太浅）+ 填充 primary；outline 按钮边框加深 `border-slate-300`；提示条用色底+文字色双通道
  - **重写策略**：大组件重写保留业务逻辑层（状态/回调/计算），只换 JSX 渲染层（Card/Button/Input/Select/Table/Badge 等）——逻辑零回归
- **约束**：引入 shadcn 组件后仍需满足下方细节（可读性/最小尺寸/hover 反馈）；新组件必须过定向冒烟（smoke-pages --page）

**通用细节（所有页面交互控件，含 shadcn 组件）**：

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

**弹层/右键菜单规范（2026-08-16 文档中心"菜单太远"反复排查教训，强制）**：

1. **一律 `createPortal` 渲染到 `document.body`**——`position: fixed` 视口定位不受任何容器干扰（flex 链 / overflow 滚动 / transform 祖先）；antd/mui 成熟方案均如此，不要渲染在组件树内层
2. **定位 = 鼠标视口坐标（clientX/Y）+ 4px 偏移**，从鼠标点右下方展开；**空间不足翻转到另一侧**（菜单底缘/右缘贴鼠标点）。
   ❌ 禁止 `Math.min(鼠标, 窗口边缘)` "压边"——会把菜单推到窗口边缘，离鼠标几百 px（**"菜单太远"根因**，msuzjelj 两轮未修的教训）
3. **必须支持 Escape 关闭**（菜单打开时挂 window keydown 监听、关闭时卸载）——否则遮罩（inset:0）残留挡住后续交互，表现为"点了没反应"
4. **验证脚本陷阱**：菜单本体是遮罩（z-index:90）的**子级**（z-index:95）——`body > div` 选择器只匹配遮罩会**误报"菜单未出现"**；验证必须用匹配真实 DOM 结构的选择器（`querySelectorAll("div")` 找 z95），或直接断言菜单文本存在
5. **用户反馈与实测矛盾时**（实测贴近但用户说远/说没生效）按序怀疑：① 验证脚本选择器/等待/状态是否错了 ② 用户浏览器是否 HMR 未生效（旧代码仍在跑，需硬刷新 Ctrl+F5）③ 窗口尺寸/DPI/浏览器缩放差异 —— **不要急着否定用户，先自查测试链路**


## 6. LLM 公共模块（core/llm.ts + chatSession + reasonix）——三种调用模式

> **阅读导航（省 Token）**：§6.1（成本原则）/ §6.5（数据治理）/ §6.7（校验分工）为**全局必读**；
> §6.2/6.3/6.4/6.6/6.8 仅在**改动 LLM 调用 / 前端异步 / 开发脚本**时阅读。
### 6.1 成本原则：提示词/引导词最小冗余（2026-08-07 起，强制）

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
5. **程序性提示词（非 LLM 的指令文本）不适用本原则**，但同样遵守「数据化/配置化」治理（§6.5）。

落实检查点：新增/修改任何 LLM 调用，先问「system 是否固定？变化内容是否都进了 user？能否用会话化减少重复？」

### 6.2 LLM 用量切面（三层标注，2026-08-06 重构后规范）

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


### 6.3 三种调用模式（direct / 自研会话 / Reasonix）

#### 模式 1：直接调用 `chat(messages, { search?, json?, module? })`（core/llm.ts）
- search=联网搜索（Responses API + web_search，服务端执行，仅 deepseek-v4-flash）；json=response_format json_object
- **前缀稳定化约定**：system 保持逐字稳定（动态日期/标的/月份移到 user 消息），以命中 DeepSeek 前缀缓存（价 ~1/50）

#### 模式 2：自研 Cache 会话 `createChatSession / chatSessionAsk`（core/chatSession.ts）
- 借鉴 Reasonix "append-only context"：system 固定 + 每轮 append user/assistant；同会话连续调用前缀命中缓存
- KV 持久化（chatSession:<id>），TTL 30 分钟；历史超长自动压缩（保留 system + 最近 6 轮）
- 注意：`createChatSession` 返回对象，传给 `chatSessionAsk` 须用 `.id`
- 实测：3 轮命中率 0% → 51% → 88.7%；适合批量/长任务（单次分析仍用模式 1）

#### 模式 3：Reasonix ACP

- **专业领域文档**：Reasonix ACP 全部细节（协议要点 / 会话生命周期 / 进程管理 / MCP 配置 / 对话托管 / 引导词去重 / 会话复用）**见 `docs/for_agent/domains/reasonix.md`**——涉足 Reasonix 时按需加载。

#### 通用细节（三种模式共用）

- 搜索模式**必须在提示词注入当前日期**（否则模型按训练知识理解"本月"）
- **LLM JSON 容错解析在 core/jsonParse.ts**（robustJsonParse/fixJsonQuotes/extractOuterJson），
  所有 LLM 结构化输出业务（cbRate / treasuryFx）共用——新业务直接 import，不要复制
- **DeepSeek 联网搜索（Responses API + web_search）耗时 8~10 分钟是常态**（多步搜索），
- **搜索任务超时对齐（2026-08-14 教训）**：联网搜索类后台任务超时须 ≥10 分钟（cbRate/treasuryFx/reverseRepo 已统一）；core/llm 内部硬超时（chatSearch 600s）不得短于任务超时，否则任务被 llm 层提前 abort
  后台任务超时需留足（≥10 分钟）；前端「停止分析」可随时中断；长超时在此环境
  （Node 24 + tsx watch）偶发不触发（任务最终 done/TTL 清理兜底），属已知现象
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

### 6.4 LLM 调用开发经验总结（决策清单，2026-08-07 整合）

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
5. **LLM 自评必配非 LLM 锚（2026-08-09 起，启发自 Agent Loop Engineering）**：凡引入「LLM 评估/自评」类功能（语义相似度、质量打分、内容审核），**必须混入一个确定性、非 LLM 的锚度量**（编译/测试通过、编辑距离、压缩增量、字段结构校验）——LLM 评估自己生成的输出存在「裁判兼运动员」偏差，单靠自评会假收敛；混合锚至少提供一个独立信号。现有范例：robustJsonParse（结构校验）+ 测试套件（行为校验）+ smoke-pages 内容断言（渲染校验）。

**已踩过的坑（勿重犯）**：
- system 内联 `{conversation}`/日期 → 前缀缓存永远 miss（watchlist.import 前身）
- system 4 变体（cbRate 旧版：banks/日历/搜索注记全内联）→ 收敛为仅 searchNote 2 变体
- 会话 append 累积污染（固定 id 会话多轮后旧内容残留）→ 按内容哈希的 id（`wl-imp-{hash}`）天然隔离
- 搜索模式不注入日期 → 模型按训练知识理解「本月」；日期注入 user 且当天固定
- 模板改版后设置数据里旧模板残留（seed 幂等不覆盖）→ 改模板后必须 `POST /api/prompts/<id>/reset`
- Reasonix 引导词每轮重复 → 首轮发 + 指纹去重（省 ~200-400 token/轮）

**验证手段**：
- LLM 用量切面（§6.2 三层标注）看 module 覆盖；会话列表（Agent 会话管理页）看会话是否按预期复用
- 缓存命中实验：同一会话连续 ask，对比 usage 中 prompt tokens（命中后大幅下降）
- 单测：`chatSession.test.ts` 会话语义/归档；`knowledgeSession.test.ts` 引导词指纹去重

### 6.5 本地数据治理原则（禁止硬编码）

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
- **缓存 key 设计（2026-08-14 教训）**：①「截至今天」类进行时数据（本月以来/今年以来）必须把查询日纳入 key（跨天自动失效），不能只按月/年（treasuryFx 按日 v2 先例 → cbRate v4 跟进）；②内容会变化的缓存（如按专题生成的提示词）把内容版本（updatedAt/哈希）纳入 key，否则增删后仍命中旧缓存；③LLM 输出数组根要用 robustJsonParse 的数组提取（对象/数组按首次括号类型分流），否则被降级为第一个元素对象静默 0 条
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

### 6.6 前端异步任务（useAsyncTask，切页不丢状态的正确姿势）

- **结果必须持久化**：taskId 存 sessionStorage 只解决"进行中任务"的恢复；**任务完成后的成果
  也要存 sessionStorage（`:result` 键）**，否则切页（组件卸载）后成果丢失，返回页面空白
- **初始响应即终态要直落**：缓存命中路径返回 `cache-xxx` 假 taskId + done + 完整 result，
  必须 `task.watch(taskId, initialResponse)` 直接落地展示，**绝不能**对假 taskId 再连 SSE
  （否则显示"任务不存在"）
- **SSE error 事件必须区分传输错误与服务端 error 帧**：传输层错误 `ev.data` 为空串，
  应交给 onerror 降级轮询；只有带 JSON data 的 error 帧才算"任务不存在"。两者混在一起会
  导致网络抖动时误清状态、降级轮询永不生效
- **任务身份校验（2026-08-14 教训）**：轮询/SSE 的迟到响应必须校验 `tid === taskIdRef.current`（ref 同步赋值，勿依赖 useEffect 延迟），否则旧任务 A 的迟到结果会覆盖新任务 B 的状态、杀掉 B 的监听；含轮询 in-flight 请求（stop 只清定时器不取消 fetch）
- **终态防重复**：settledRef 标记——error 帧/迟到轮询结果不得重复处理（防止 onerror 与
  error 帧双路径互相覆盖）

### 6.7 前后端分工与校验原则（2026-08-08，策略仓位管理教训）

**核心原则：所有业务规则校验一律在服务端做「权威校验」，前端只做「体验性校验」。** 前端校验可被绕过（直接调 API），绝不能当作安全/正确性边界。

**破坏性操作语义（2026-08-14 教训）**：删除/清空类接口必须严格区分「无参数 = 全部」与「非法参数」（books DELETE /favorites 曾因 `Number('abc')` 为 NaN 触发清空全部收藏 → 改为仅不传 id 才清空、非法 id 400）；跨源读删须校验 key 归属（localData 单条 GET/DELETE 曾漏校验）。

**会话/长任务并发（2026-08-14 教训）**：读-await-写 的共享状态操作（chatSession/reasonixAsk 追加历史）必须按 key 加内存串行队列（同 knowledgeSession enqueue 模式），否则并发 ask 静默丢一轮数据。

**分工清单（新功能照此对照）**：
- **业务规则校验（服务端权威，400 拒绝 + 中文 message）**：
  - 数据完整性：必填字段、重复项查重（如重复标的 code → 400「标的 X 重复」）
  - 数值约束：非负、范围（如 0~100%）、依赖关系（如「数量非零时成本价必填」——金额 = 数量 × 成本价）
  - 领域规则：策略约束、仓位上限、业务语义（如日度计划按数量操作、无成本价无法换算金额）
- **前端只做**：输入即时反馈（前导零/千分位/防抖校验提示）、按钮禁用态、非侵入提示——**不要只在前端拦**
- **解析层（parseXxx）只做整形（trim/类型转换/过滤非法），不做业务校验**；业务校验单独显式写在路由 handler 里，400 + {ok:false, message}，前端 api.ts 已统一抛 message

**教训（本次踩坑）**：「重复标的」「数量非零成本必填」起初只在前端校验，用户指出后才补服务端——任何「不允许/必须」的规则都先问：服务端拦了吗？没拦就是漏洞。

**验证习惯**：改完服务端校验必须「重启 server + 用 api-cli 打 400/200 断言」（tsx watch 偶发不热更新，假 200 曾误导）；前端改动按 §5.1 测试分级验证（页面加载逻辑改动必跑冒烟，小改动用 --page 定向冒烟）。

### 6.8 开发辅助脚本规范（scripts/dev-utils/，2026-08-08）

**单源化**：脚本的**目录树 / 全部工具用法（统一入口 `toolbox.mjs`）/ 历史归档 / 进化流程唯一见 `scripts/README.md`**；dev.md 这里只放**强制规则**（导航/查表见 README §2 用途列）。README 缺失/过期时优先补 README（§8.1 同步义务）。新增脚本必须三同步（toolbox.mjs TOOLS 表 + scripts/README §2 + commands.md）。

**强制规则（行为约束，与 README §3 互补）**：
1. 所有辅助脚本一律放 scripts/dev-utils/，**禁止仓库根目录散放 tmp_*.mjs**（反复踩坑：残留混入 commit、cmd 引号截断、CRLF 不匹配）
2. 出现第 2 次相似脚本需求 → 先查 README §2 工具表 + §4 归档表 → 有现成直接用；缺能力在 dev-utils/ 固化（不是又写 tmp）
3. 一次性调试脚本 → dev-utils/_tmp_*.mjs 跑完即删，严禁提交
4. 大段文件替换禁止 node -e（cmd 引号/中文/反引号地狱）→ 用 patch.mjs 或 write_file 脚本（§7.3 教训）
   **强化（2026-08-10 教训）**：手写替换脚本也禁止用 JS 模板字符串拼 old/new（含 `${}`/反引号/中文时匹配必失败——
   本次 _tmp_feat.mjs 因此整脚本未写入）。含这类字符的替换**一律 patch.mjs（patch.json 驱动，纯 JSON 无转义问题）**；
   手写脚本只用普通字符串 `'...'` + `\n` 拼接
5. 服务端单测/全量单测用 test.mjs；提交用 commit.mjs（消息引号安全）；API 验证用 api-cli.mjs；工具改动后必跑 self-test.mjs
6. 服务端校验改完必须「重启 server + API 打 400/200 断言」（tsx watch 偶发不热更新，假 200 曾误导两次，§6.7）
7. **CLI/安装命令前台直接跑**（2026-08-10 教训）：npx/pnpm 等交互或长输出命令不要 `node -e execSync(...)` 吞输出——
   init 卡在交互确认但 execSync 返回 0 = 假成功。前台跑看真实输出/退出码
8. **临时替换脚本 writeFileSync 放最后**（原子性，2026-08-10 惯例固化）：所有匹配断言通过后才写盘，
   任一步失败 exit(1) 不污染文件（本次 _tmp_feat.mjs 靠此避免半写入）

**同步义务**：新增/修改脚本后——README §1 目录树 + §2 工具表补/改一行 → self-test 跑通 → 提交；每阶段提交核对 README 与 dev.md §6.8 与工具实际一致（§8.1）。

**控制效率算账（2026-08-09 起，启发自 Agent Loop Engineering）**：任何新增的过滤/监控/控制机制，先估 `η = 被拦截的坏改动的修复成本 / 控制器自身成本`——**只有 η > 1 才值得做**。判断标准：被拦截的错误是否高频且修复贵（如 PowerShell 引号/CRLF/残留文件），控制器是否廉价（脚本化极廉、人工审查贵）。**提示型检查（如 check-change.mjs）成本近零、永远值得；拦截型控制（自动拒绝/概率接受）须算清账再上**——对高通过率场景，控制可能是净亏损。**提交前跑一次 `node scripts/dev-utils/check-change.mjs`（改动健康检查：文件数/行数/触及分层 → 建议验证级别）。**

## 7. 领域经验索引（按需加载）

> 各业务/技术领域细节在 `docs/for_agent/domains/`，仅涉足时加载（AGENTS.md 只强制加载本文件）。

| 领域 | 文档 | 何时看 |
|---|---|---|
| Reasonix ACP（协议/会话/进程/MCP/托管/引导词去重） | `domains/reasonix.md` | 涉足 Reasonix 会话/知识库会话复用 |
| shadcn/ui 组件（Base UI 底层/API 差异/主题映射） | `domains/shadcn.md` | 涉足前端组件/页面 UI（新增组件、组件库维护） |
| 浏览器自动化（DeepSeek 网页版 Chat） | `domains/features.md` | 改 browserChat / 网页自动化 |
| 策略仓位管理（trade-plan / trade-v2） | `domains/features.md` | 改 trade-plan / trade-v2（仓位管理 v2） |
| 数据可信度（cbRate 结构化输出） | `domains/features.md` | 改 LLM 结构化输出业务 |
| 外部数据源（知乎/知识库中心/行情/分享/快讯） | `domains/data-sources.md` | 涉足外部数据源 |

### 7.1 Reasonix ACP
- **专业领域文档**：Reasonix ACP 全部细节（协议要点 / 会话生命周期 / 进程管理 / MCP 配置 / 对话托管 / 引导词去重 / 会话复用）**见 `docs/for_agent/domains/reasonix.md`**——涉足 Reasonix 时按需加载。

### 7.2 浏览器自动化（core/browser.ts + features/browserChat）

- **专业领域文档**：浏览器自动化经验（DeepSeek 网页版 Chat 操作、受控输入 insertText、aria-pressed、profile 锁）**见 `docs/for_agent/domains/features.md`**。

### 7.3 策略仓位管理（trade-plan / 仓位管理 v2）

- **专业领域文档**：策略仓位管理实现经验（配置/仓位拆分、日度计划按数量、保存即应用、基线+重放、校验分工）**见 `docs/for_agent/domains/features.md`**；通用原则见 §6.7（前后端分工）。
- **仓位管理 v2（2026-08-15，features/tradeV2 + tools/TradeV2Tool）**：逐笔交易账本（增量）→ 仓位明细（存量，由账本重放**纯派生**，单一数据源——改/删任一笔交易自动重算，无 v1 基线/重放一致性问题）+ 分组（tag）约束（总仓位/单日加仓/单标的上限）+ 分析复盘（统计卡/ECharts/Deal 配对）；Cordis 服务化（todoV3/docs 同模式）；服务端权威校验（§6.7），期初建仓 initial 不参与限额；细节见 domains/features.md「仓位管理 v2」节。

### 7.4 数据可信度（cbRate 等 LLM 结构化输出）

- **专业领域文档**：数据可信度经验（dataMode、防幻觉、缓存 schema 版本、任务终态保护）**见 `docs/for_agent/domains/features.md`**。

**2026-08-10 港股 Chat 补充修复经验（watchlist.import）**——LLM 解析多市场代码 + 空输出兜底的教训（本次连环踩坑）：
1. **模板输出格式与 normalize 校验必须严格对齐**：模板写"6 位数字、港股不用"而 normalize 只收 `/^\d{6}$/` → 港股 5 位（01763）被全过滤 → "未识别到个股"。多市场支持时**模板与校验同步改**（A股 6 位 / 港股 5 位含前导 0 / `.HK` 后缀 / `HK` 前缀容错）。
2. **LLM 可能稳定输出空 stocks（即使模板强调"候选导向/必须收录"）**：单只个股、非"选股组合"语义的对话，LLM 保守拒绝（实测 4 次空）。**不能只靠提示词**，要有**确定性兜底**（正则从对话文本提取带市场后缀的代码，如 `\d{3,6}\.(HK|SH|SZ|BJ)`）。
3. **正则提取名称不可靠**：中文名与代码间隔/贪婪匹配会误取"港股代码""助手"等 → **结构化信息（名称）用行情工具（确定性 API）补全**（`resolveStockName`，confirm 时补）；非结构化（理由）用**代码后文关键词句提取**（龙头/市占率等），清理代码前缀/引用标记。
4. **错误消息带 LLM 原始输出**（原始 stocks/内容片段）→ 快速定位是"LLM 空输出"还是"代码被过滤"（本次靠它确认根因）。
5. **新路由先 curl 验证**：前端 `watchlistAppendPreviewStatus` 路径漏 `:id` 段 → 404 后 `.catch(()=>null)` 静默轮询 120 次（6 分钟）"卡死"——与 §5.2 同源教训，本次再次发生；**前端调新接口必须先 curl 打一遍确认路径匹配**。
6. **服务端改动重启验证**（tsx watch 热更新不可靠，本次 5+ 次假成功）——dev.md §3/§6.8 反复强调，务必遵守。

### 7.5 外部数据源经验

- **专业领域文档**：外部数据源（知乎爬虫 / 知识库中心 / A-H 行情多源 / DeepSeek 分享提取 / 东财快讯）经验**见 `docs/for_agent/domains/data-sources.md`**——涉足外部数据源时按需加载。
- 测试资源：分享 id `u5myqtvktzo5gal4qi`；测试行情 `600519` / `hk00700`。

### 7.6 Cordis 框架（@deepseek-ai/cordis）

- **专业领域文档**：Cordis 框架实践（Service 类 / declare module / 异步 plugin 集成 Hono / 踩坑 / 数据安全）**见 `docs/for_agent/domains/cordis.md`**——涉足 Cordis 或新框架集成时按需加载。
- **todo 演进**：v1（树状 parentId）→ v2（自研 Cordis 风格 DAG）→ v3（真 Cordis 框架 + 分解树 × 依赖正交合并）——最终统一为 v3（`features/todoV3/`，数据 `todoV3:items`）；v1/v2 已清理。
- **数据安全铁律（2026-08-14 事故）**：单测操作真实 KV **禁止 finally 清空**（曾清掉用户全部待办）——必须 beforeEach 备份 / afterEach 恢复（见 domains/cordis.md §5）。
- **数据安全铁律 2（2026-08-16 事故）**：**「写操作类」UI 验证（编辑/保存/更新）严禁直接作用在真实用户文档上**——曾用 playwright 编辑测试「货币周期策略v1.md」导致原文被覆盖（仅能从 archive 恢复开头 176 字符）。**必须**：① 先用 KV 备份（`kv.mjs backup <key>`）或 ② 上传一个专属测试文档（如 `_测试.md`）并测试后彻底删除，或 ③ 保存前先读原文并验证可恢复。任何会写 KV 的自动化验证，先确认「写的是什么、能否回滚」。

## 8. 历史进度记录（必须遵守）

`docs/for_agent/history/` 目录记录**每个时间点 + Agent 对话的修改总结**，供后续 Agent 获取历史进度。

- **新 Agent 开工前**：先读最近一份 history（用 ls 工具列 `docs/for_agent/history/`，取文件名日期序号最大的一篇；命名 `YYYY-MM-DD-NN.md`，NN 越大越新；cmd 下无 Select-Object/tail），了解已完成/遗留，避免重复开发
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
- **处理完的条目必须当场标记 status=done（硬性，勿遗漏）**：
  每条 fix 处理并验证通过后**立即**执行 `node scripts/dev-utils/memo.mjs done <id>`（可多个 id 一起）；
  收尾前 `memo.mjs list` 确认 open=0；曾发生「改完忘标记 done」导致用户重复催促，
  处理与标记 done 视为同一动作、不可拆分
- 处理完的条目在 memo:items 里标记 status=done；类型字段 `kind`（缺省 fix，旧数据兼容）

**memo 复用脚本指引（2026-08-10 强化）**——处理 memo 全流程用 `scripts/dev-utils/memo.mjs`：
- **开工感知**：`memo.mjs stats`（open/doing/done 统计 + 未完成按页面分组）→ `memo.mjs list` 看明细
- **聚焦**：`memo.mjs bypage <页面关键词>`（如 `bypage 策略仓位管理`）——只列某页面未完成，避免 200 条全量刷屏
- **进度**：`memo.mjs recent [N]`（默认 5）——了解最近已处理，避免重复开发
- **批量 done**：`memo.mjs done <id>...`（多 id 空格分隔；cmd 分号防御已内置）

**memo 指令感知（新会话/用户说"memo"时）**：
- 用户说「处理备忘录」/「处理 memo」→ 先 `memo.mjs stats` + `list` → **逐条先理解业务概念与逻辑**（不要拿到就改）→ 建分支 → 实现 → 验证 → **当场 `done`**
- 用户说「其中较早的 X 已经完成了」→ **先核实**（grep 代码/查 API/看页面）功能是否已实现 → **已实现则直接标记 done，不重复实现**（曾发生：财报分析会话复用早已实现，memo 是旧反馈）
- Agent 主动新增 memo 只能用 agent 型且严格区分（见上）；不得替用户新增 fix/feature 型

### 8.1 维护性文件同步规则（每次提交/归档必做）

- **测试数据必须清理（硬性）**：任何测试/冒烟产生的临时数据，交付前必须删除并验证无残留——包括：临时领域库/虚拟库/知识条目（`it_*`/`test*`/`zh_*` 等前缀）、导入历史（`kbImport:history`）、LLM 用量记录（`llmUsage:` 测试 module 记录）。**单测必须在 `finally` 中彻底清理其创建的 KV**（注意前缀：领域元数据是 `kbDomain:`，删它用 `deleteDomain`；虚拟库是 `kbVirt:`，删它用 `deleteVirtKb`——勿混用，否则残留）。提交前跑 `node scripts/dev-utils/api-cli.mjs GET /tools/overview` 或本地数据管理页确认无 `testdomain_`/`it_` 等残留。

- **维护性文件**：docs/for_agent 下所有文件（dev.md、history/*）必须在每次阶段性提交/归档时同步更新（新路由/新页面/新公共模块/经验教训/规则变更都要记）。

`docs/for_agent/` 下所有文件均为**维护性文件**，每次**阶段性提交**与**归档**后必须整体同步，不允许只更新其中一部分：

1. **维护性文件清单**：
   - `docs/for_agent/dev.md`——常驻开发规范（架构/流程/强制规则/决策），后续 Agent 的主依据；
   - `docs/for_agent/README.md`——文档地图（分层索引 + 新会话开工清单，新文档先在此登记）；
   - `docs/for_agent/commands.md`——命令速查（与 toolbox list / scripts/README §2 三处同步）；
   - `docs/for_agent/history/INDEX.md`——历史归档索引（新增 history 后同步「最新进展/主题索引」）；
   - `docs/for_agent/domains/*.md`——专业领域经验（reasonix / features / data-sources），**按需加载**：涉足对应领域时阅读并更新；
   - `docs/for_agent/history/*.md`——时间线记录（会话总结，只增不改）；
   - 根目录 `AGENTS.md`——强制加载入口（若 dev.md 目录结构/引用路径变化需同步）。
2. **每次阶段性 git commit 前**（§4）：检查本次改动是否影响任何经验/约定/结构，
   受影响则先更新 dev.md（新增节/条目或修订过时内容），把文档更新一起提交。
3. **每次归档 history 后**：立即对照本次会话改动核对 dev.md——新增的经验/教训必须
   已固化进 dev.md（历史记录 ≠ 常驻规范，只有 dev.md 会被自动加载）；
   若 dev.md 有目录/编号变化，同步检查 AGENTS.md 的引用与导入仍正确。
4. **检查方法**：`git status` 查看 `docs/for_agent/` 与 `AGENTS.md` 的变更，
   确认本次会话的 dev.md 更新 + history 归档两者都在（提交或工作区中）。
5. **反例（禁止）**：只写 history 不更新 dev.md（新 Agent 看不到经验）；
   只改代码不改文档；归档后 dev.md 与代码事实不符（如存储位置/API 已变但文档仍旧）。

