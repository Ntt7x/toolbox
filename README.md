# Toolbox · 个人小工具集

本地网页项目：给自己用的各种小工具的集合。

## 架构

- **apps/web** — Vite + React + TypeScript 前端，唯一入口访问后端（`/api` 代理）。
- **apps/server** — TypeScript 后端（Hono），实现 `/api` 契约。
- **packages/shared** — **API 契约层**：前后端共享的类型定义。

> 后端无关性：前端只通过 `shared` 中定义的契约 + `fetch("/api/*")` 通信。
> 将来可把 server 换成 Go 实现，保持 `shared` 契约与路由不变即可无缝切换。

## 快速开始

```bash
pnpm install
pnpm dev          # 前端 http://localhost:5173  后端 http://localhost:8787
```

## 添加一个小工具

1. 在 `packages/shared/src/index.ts` 的 `tools` 注册表加一条 `ToolMeta`。
2. 前端 `apps/web/src/App.tsx` 加一个入口卡片，`src/tools/` 下实现工具页。

## vibe coding 约定

- 本目录是 AI Agent 沙盒，可自由重构。
- 保持 `shared` 契约层不被业务逻辑污染。
