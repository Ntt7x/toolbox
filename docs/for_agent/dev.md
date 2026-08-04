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
│       └── features/          上层业务模块（依赖 core）：gridPlan / cbRate / deepseekShareTool
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
- API key 存 `apps/server/.env`（`DEEPSEEK_API_KEY`，已 gitignore），`/api/llm/*` 管理
- 结构化工具（如 cb-rate）用 search 默认开 + JSON 输出 + 提示词给出严格 JSON schema，
  解析容忍杂质包裹；失败时保留 raw 兜底展示

## 5. 外部数据源经验

- **A/H 股行情**：腾讯 `web.ifzq.gtimg.cn`（param=sh600519,month,,,60,qfq），前复权月 K，
  排除未完成当月；**东财 push2his 不稳（TLS 断开）已弃用**
- **DeepSeek 分享提取**：`GET https://chat.deepseek.com/api/v0/share/content?share_id={id}`
  （UA + Accept: application/json），消息含 role/content/thinking/inserted_at/accumulated_token_usage
- 测试用真实分享 id：`u5myqtvktzo5gal4qi`；测试行情：`600519` / `hk00700`

## 6. git 规范

- 身份：`kk <kk@localhost>`（全局已配）
- 提交信息：`feat(scope): 摘要` + 空行 + 要点列表；中文
- 每完成一个功能批提交一次；`.env`、`.vscode/` 不入库（已 gitignore）
- 提交前 `git status` 确认无测试残留（`$null` 之类的垃圾文件）

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

