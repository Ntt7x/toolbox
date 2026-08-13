# 模块化改造 · 阶段性规划（存档）

> **状态：束之高阁**（2026-08-14 暂缓，留档供未来参考）
> 触发来源：用户提出「对本项目进行模块化改造」，附 DeepSeek 分享方案
> （https://chat.deepseek.com/share/skp5em7wxt25lfmpuy，微前端 qiankun + 全栈模块拆分 + 公共库 + 微服务 DI）。
> 经可行性调研与裁剪讨论后，决定**暂缓实施**，本文档沉淀调研结论与裁剪后的分期规划，
> 未来条件成熟（见 §6 触发条件）时按此重启。

---

## 1. 背景与需求

用户希望按分享方案对 toolbox 进行模块化改造：

1. 使用微前端技术（qiankun）增加基座入口
2. 把独立页面逻辑拆成独立的前后端（全栈），形成可拔插、可配置的模块
3. 拆分过程中抽象公共前端库
4. 拆分过程中抽象公共后端库
5. 分离公共后端微服务，使用微服务化/依赖注入框架

## 2. 可行性调研结论（2026-08-14，已含来源）

### 2.1 qiankun × 本项目（Vite 6）——不兼容，不引入

- **qiankun 2.x（npm latest = 2.10.16，2023-11 后基本停更）不支持 Vite 原生 ESM**——基于
  import-html-entry + UMD 约定，Vite 默认产出 ESM。
- **官方 Vite 支持在 3.0（仍 rc）**：3.0.0-rc.21（2026-02），README 明确 "v3 ships under the
  rc tag while latest still points at 2.x"；官方 `@qiankunjs/bundler-plugin` 支持 Vite，
  但 3.0 从未发 stable 且有 breaking changes。
- **社区插件均已失效**：`vite-plugin-qiankun` 2025-02 归档只读（ESM 无沙箱、HMR 冲突）；
  `vite-plugin-legacy-qiankun` 2023-05 停更（需 legacy 降级，dev 沙箱标注"测试中"）。
- **场景不匹配**：微前端的价值 = 多团队独立开发/独立部署/技术栈异构/故障隔离——本项目
  （个人单机、17 页、单仓库、单端口 dev）一条都不占；qiankun 反而引入 Proxy 沙箱开销、
  HTML-entry 加载、跨应用通信协议、多 dev server 调试等复杂度。
- **结论**：不引入 qiankun。**单应用 + workspace 包边界 + React.lazy 路由懒加载**即可覆盖
  "按需加载"诉求，未来若有子应用诉求等 qiankun 3.0 stable 后走官方 bundler-plugin。

### 2.2 后端微服务化——单机场景不拆进程

- 分享方案的 Spring Cloud / Quarkus / gRPC + Istio / 服务注册中心 / API 网关 / 消息队列
  均为**多机分布式**设计——本项目单机本地运行，拆分独立进程微服务纯增复杂度无收益。
- 本项目已有**依赖注入基础**：`@deepseek-ai/cordis`（todoV3 已验证 Service/ctx 注入模式），
  单进程内服务可插拔即可达成 DI 目标。

## 3. 裁剪后的目标架构（未来重启时落地）

```
toolbox/  (pnpm workspace，单仓库单进程)
├── apps/
│   ├── web/                    # 基座应用（路由懒加载各模块页面）
│   └── server/                 # 单进程 Hono（feature 可插拔注册）
├── packages/
│   ├── shared/                 # （已有）前后端共享契约
│   ├── ui/                     # 【新】前端公共组件库（shadcn 组件 + 业务组件）
│   ├── utils/                  # 【新】前端公共工具（请求/格式化/剪贴板等）
│   └── server-core/            # 【新】后端公共库（core/ 提升：db/kv/llm/tasks/sse/quote…）
└── docs/for_agent/
    ├── plans/                  # 【新】本目录：规划/路线图存档
    └── ...
```

**模块化三原则**（对应分享方案可落地部分）：
1. **可拔插**：前端页面按 tool id 注册（App.tsx toolPages 已如此）；后端 feature 自含
   meta + register（index.ts 装配层已如此）——保持并强化
2. **可配置**：模块开关/配置走本地设置数据（已有 settingsStore）
3. **公共库分层**：前端 UI/工具、后端 core 从业务中抽离，版本化管理

## 4. 分期规划（按依赖顺序）

### Phase 1：公共库抽象（收益最高、风险最低）
- **前端**：`packages/ui`（从 apps/web/src/components/ui 提升 shadcn 组件 + cn 工具）+
  `packages/utils`（api 请求封装、金额/百分比格式化、剪贴板、日期工具）
  ——web 改造为引用公共包，删除本地副本
- **后端**：`packages/server-core`（apps/server/src/core 提升：db/kvStore/tableStore/llm/
  tasks/sse/quote/jsonParse/chatSession/reasonix…），server 改引用
- **验收**：typecheck + 全量单测 + 全站冒烟不回归

### Phase 2：模块边界强化（可拔插/可配置落地）
- 前端路由级 `React.lazy` 懒加载（17 页面按需分包）
- 后端 feature 自省（`/api/tools` 已返回 meta）→ 前端动态菜单（当前静态 MENU_GROUPS 改造）
- 模块级开关：设置页管理每个工具启用/停用（前端隐藏 + 后端 404）

### Phase 3：服务 DI 规范化（复用 Cordis）
- 公共能力（llm/quote/kv 等）逐步 Cordis Service 化（todoV3 模式推广）
- 服务依赖声明 + 可替换（配置可换实现，如行情数据源）

### Phase 4：微前端评估（仅当出现多应用诉求）
- 触发后优先等 qiankun 3.0 stable → 官方 `@qiankunjs/bundler-plugin`
- 或评估 Module Federation（Rspack/Vite 生态）作为备选

## 5. 明确裁剪（不做）

| 分享方案项 | 裁剪原因 |
|---|---|
| qiankun 基座 + 子应用拆分 | Vite 6 无成熟支持 + 单机场景无隔离需求（§2.1） |
| 独立代码仓库 / 独立 CI/CD | 个人单仓库，无多团队协作 |
| 独立数据库 per 服务 | 单机 SQLite 单库足够 |
| API 网关 / 服务注册中心 / 消息队列 | 单进程无服务间网络通信 |
| Spring Cloud / Quarkus / gRPC + Istio | TS 技术栈，单进程 Hono + Cordis DI 替代 |

## 6. 触发条件（何时重启本规划）

- [ ] 页面数量显著增长（>30）或单页体积影响首屏，懒加载不足以覆盖
- [ ] 出现"同页多版本并存/独立部署"诉求（如对外提供某个工具）
- [ ] qiankun 3.0 发布 stable 且验证 Vite 6 子应用全链路（dev/HMR/沙箱）
- [ ] 多开发者协作需要模块级所有权边界

## 7. 关联现状（2026-08-14 基线）

- 前端：React + Vite 6 + shadcn（Base UI 底）；17 个工具页；App.tsx MENU_GROUPS 分组菜单
- 后端：Hono 单进程（8787）；features/（业务）→ core/（公共）单向依赖；
  feature 自含 meta + register；SQLite KV/表双模型（.file/toolbox.db）
- 公共库现状：packages/shared（TS 契约）；前端 components/ui 在 apps/web 内
  （尚未提升为独立包）
- DI 基础：@deepseek-ai/cordis 4.0.1（todoV3 实践，见 domains/cordis.md）
