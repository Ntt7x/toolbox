# Toolbox — Agent 常驻指令

本文件是 Reasonix 自动加载的常驻指令（`AGENTS.md`），对所有新 agent 会话生效。
**任何任务开始前必须完整加载并遵守下面导入的开发指南。**

## 强制规则

0. 开发前先完整加载本项目开发规范与经验沉淀：
@docs/for_agent/dev.md
1. 遵循分层架构：`features → core` 单向依赖，公共能力进 `core/`，业务编排进 `features/`
2. 契约驱动：先改 `packages/shared` 类型，再实现 server 与 web
3. 验证底线：改动后必须跑 `pnpm typecheck` + 相关 API curl 回归
4. git 提交规范见 dev.md §6；环境注意（node 路径 / shell 分号陷阱）见 dev.md §3

## 项目速览

- pnpm workspace：`apps/web`（Vite+React）、`apps/server`（Hono）、`packages/shared`（契约层）
- 服务端分层：`core/`（llm 能力 / 行情 / 分享提取）、`features/`（gridPlan / cbRate / deepseekShareTool）
- 前端：侧边栏分组菜单（设置 / 交易 / 小工具），工具页注册于 `toolPages` + `MENU_GROUPS`
- 详细架构、数据源、验证清单 → `docs/for_agent/dev.md`

## 沙盒约定

本目录是 AI Agent 沙盒，可自由重构，但必须保持 shared 契约层不被业务逻辑污染。
