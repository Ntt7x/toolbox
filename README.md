# Toolbox · 个人小工具集

本地网页项目：给自己用的各种小工具的集合（LLM 分析、交易规划、知识库、爬虫、书籍下载…）。

## 快速开始（人类）

```bash
pnpm install
pnpm dev        # 前端 http://localhost:5173  后端 http://localhost:8787
```

## 架构

- **apps/web** — Vite + React + TypeScript 前端，唯一入口访问后端（`/api` 代理）。
- **apps/server** — TypeScript 后端（Hono），实现 `/api` 契约；`core/`（公共能力）+ `features/`（业务）分层。
- **packages/shared** — **API 契约层**：前后端共享的类型定义（契约驱动，先改 shared 再实现两端）。

> 后端无关性：前端只通过 `shared` 中定义的契约 + `fetch("/api/*")` 通信；将来可换 Go 实现而不动契约。

## 目录导航

| 路径 | 内容 |
|---|---|
| `apps/web/src/tools/` | 工具页组件（GridPlanTool / CbRateTool / TradePlanTool / WatchlistTool…） |
| `apps/server/src/features/` | 业务模块（每个工具：`meta` + `register(app)`） |
| `apps/server/src/core/` | 公共能力（llm / chatSession / reasonix / quote / kvStore / tasks…） |
| `docs/for_agent/` | **Agent 常驻知识库**（开发规范 + 领域经验 + 历史归档） |
| `scripts/dev-utils/` | 开发辅助脚本（**统一入口 `toolbox.mjs`**） |

## Agent / Vibe Coding 入口

> 本目录是 AI Agent 沙盒，可自由重构，但必须保持 shared 契约层不被业务逻辑污染。

1. **先读文档地图**：`docs/for_agent/README.md`（分层：规范必读 / 领域按需 / 历史检索），规范总纲 `docs/for_agent/dev.md`。
2. **统一脚本入口**：`node scripts/dev-utils/toolbox.mjs list`（枚举全部工具）/ `help <cmd>`（用法）/ `<cmd> ...`（执行）。
3. **命令速查**：`docs/for_agent/commands.md`（typecheck / test / api / smoke / memo / commit / patch…）。
4. **强制规则速览**：分层依赖（features → core）、契约驱动、验证分级（L0 typecheck → L1 单测 → L2 定向 → L3 冒烟）、改前建分支、提交时机由用户确认。

## 添加一个小工具

1. `packages/shared/src/index.ts` 加契约类型；
2. `apps/server/src/features/<name>/` 建模块（导出 `meta` + `register(app)`），在 `apps/server/src/index.ts` 注册；
3. `apps/web/src/tools/<Name>Tool.tsx` 实现页面，注册进 `App.tsx` 的 `toolPages` + `MENU_GROUPS`；
4. 核对：数据源 `registerDataSource`、菜单三件套、页面冒烟（详见 dev.md §5.2）。
