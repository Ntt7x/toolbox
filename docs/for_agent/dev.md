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

## 4. LLM 公共模块（core/llm.ts）

- `chat(messages, { search?, json? })`：search=联网搜索（Responses API + web_search，服务端执行，
  仅 deepseek-v4-flash）；json=response_format json_object；两者可组合
- 搜索模式**必须在提示词注入当前日期**（否则模型按训练知识理解"本月"）
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

- **A/H 股行情**：腾讯 `web.ifzq.gtimg.cn`（param=sh600519,month,,,60,qfq），前复权月 K，
  排除未完成当月；**东财 push2his 不稳（TLS 断开）已弃用**
- **DeepSeek 分享提取**：`GET https://chat.deepseek.com/api/v0/share/content?share_id={id}`
  （UA + Accept: application/json），消息含 role/content/thinking/inserted_at/accumulated_token_usage
- 测试用真实分享 id：`u5myqtvktzo5gal4qi`；测试行情：`600519` / `hk00700`
- 测试命令：`node "node_modules\.pnpm\tsx@4.23.5\node_modules\tsx\dist\cli.mjs" --test
  apps/server/src/features/cbRate/cbRate.test.ts apps/server/src/core/tasks.test.ts`
  （cbRate 单测 14 项 + tasks 单测 6 项，共 20 项，均须全绿）

## 6. git 规范

- 身份：`kk <kk@localhost>`（全局已配）
- 提交信息：`feat(scope): 摘要` + 空行 + 要点列表；中文
- 每完成一个功能批提交一次；`.env`、`.vscode/`、`.file/` 不入库（已 gitignore）
- 提交前 `git status` 确认无测试残留（`$null` 之类的垃圾文件）
- **每次阶段性提交前，必须同步更新 `docs/for_agent/` 下全部维护性文件**（见 §8）：
  本会话若产生了新的经验/约定/架构变化/文件改名，先更新 dev.md 再提交，
  提交信息中注明文档同步（如 `docs(agent): …`）；禁止只改代码不落文档。
- **每次 commit 后必须自动 push 到 origin**（提交即推送，保持 origin/main 同步）：
  - 远程已配置：`origin = https://github.com/Ntt7x/toolbox.git`，本地凭证可用；
  - 流程固定为：`git add -A` → `git commit` → `git push`（一条龙，commit 后立即执行 push）；
  - push 失败（认证/网络）时：保留本地提交、报告失败原因，下次可重推，不得丢弃提交；
  - push 成功后确认 `git status --short --branch` 显示 `## main...origin/main`（无 ahead/behind）。

## 7. 验证清单（每功能必过）

- [ ] `pnpm typecheck` 全绿
- [ ] 新 API 用 curl 实测（含错误分支：非法参数/未配置/上游失败）
- [ ] 页面与模块编译 200（vite dev）
- [ ] 回归：`/api/health`、`/api/tools`、既有端点不受影响

## 8. 历史进度记录（必须遵守）

`docs/for_agent/history/` 目录记录**每个时间点 + Agent 对话的修改总结**，供后续 Agent 获取历史进度。

- **新 Agent 开工前**：先读最近一份 history（`ls docs/for_agent/history/` 取最新），了解已完成/遗留，避免重复开发
- **每个 Agent 会话结束时**：在 `docs/for_agent/history/` 追加一份总结，命名 `YYYY-MM-DD-NN.md`（NN 为当日序号）
- 总结格式：时间、会话主题、按序完成的功能（含文件/API）、git commit、**遗留/规划事项**（🔮 未实现 🚧 未提交）
- 历史文件只增不改（除非事实错误），保持时间线完整

### 8.1 维护性文件同步规则（每次提交/归档必做）

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

