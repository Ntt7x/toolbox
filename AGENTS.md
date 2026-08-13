# Toolbox — Agent 常驻指令（启动仪表盘）

> 本文件自动加载，对所有新 agent 会话生效。**第 1 步先读文档地图**，再按任务类型按需加载（规范层必读、领域层按需、历史层检索）。

## 第 1 步：读文档地图

@docs/for_agent/README.md   ← 文档分层 + 新会话 5 步开工清单 + 按任务类型该读什么

## 新会话 5 步开工清单

1. 读本仪表盘 + 文档地图（上面）
2. `git status` / `git branch -a` —— 当前分支 + 待验收分支
3. `docs/for_agent/history/INDEX.md` 或最近一篇 history —— 了解已完成/遗留
4. `node scripts/dev-utils/toolbox.mjs memo stats` + `list` —— 处理 open 改进项
5. 需要改动一律 `git switch -c <type>/<简述>` 建分支（禁止 main 直改）

## 铁律速查（详细规范以 dev.md 为准）

- **分层**：`features → core` 单向依赖；公共能力进 `core/`，业务编排进 `features/`
- **契约驱动**：先改 `packages/shared` 类型，再实现 server 与 web
- **验证底线**（按影响面分级）：L0 `toolbox typecheck` → L1 `toolbox test` → L2 `toolbox api` + `toolbox smoke --page` → L3 全量 `toolbox smoke`
- **git**：改前建分支；分支内不自动提交，用户确认后才提交+推送（dev.md §4）
- **成本**：LLM 调用只由用户操作触发；system 固定、动态内容进 user（dev.md §6）
- **数据**：运行时数据一律进本地数据管理（KV/表）并注册数据源，禁止代码硬编码（dev.md §6.5）

## 工具入口

- 统一脚本入口：`node scripts/dev-utils/toolbox.mjs list`（枚举）/ `help <cmd>` / `<cmd> ...`（执行）
- 命令速查：`docs/for_agent/commands.md`；脚本全表与规范：`scripts/README.md`
- 环境注意：node 在 `D:\Softwares\nodejs`（不在 PATH）；bash 工具按 cmd 语法（无 `;`、无 PowerShell 语法），见 dev.md §3

## 沙盒约定

本目录是 AI Agent 沙盒，可自由重构，但必须保持 shared 契约层不被业务逻辑污染。
