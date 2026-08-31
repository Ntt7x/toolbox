# 调研：服务端微服务化（2026-08-31 完成）

> 状态：**调研完成，结论＝不拆分微服务**（维持单进程 + 模块化 + 旁路进程按需）
> 来源：memo `mtakjbnn-ek0rzb` · 对话 `https://chat.deepseek.com/share/chae7zuoon2ajgslfp`

## 原始诉求

"服务端越来越复杂，需要引入多种后端技术，计划用微服务架构组织和拆分后端服务，选什么工具技术能简单、方便、快捷、全面、稳定？"

## 外部方案要点（对话结论，三阶段收敛）

1. **起步建议（重方案）**：NestJS 做服务框架 + Docker Compose 编排 + API 网关（Octopus/自建）+ Consul 服务发现 + Redis/RabbitMQ 消息队列。
2. **克制收敛（推荐）**：只引入 **2 个 npm 包**——`concurrently`（多进程并行与日志分色、`--kill-others` 联动）与 `http-proxy-middleware`（TS 主服务兼任网关，20 行转发）；契约**手工维护** `shared/api.types.ts`（服务数 < 5 时比代码生成更可靠）；共享同一 DB 实例，按 Schema 逻辑隔离（TS=public / Go=go_schema / C#=cs_schema）。
3. **极简终态**：TS 主服务**唯一数据写入方**（SQLite 单文件）+ 旁路进程只做只读/计算；异步任务用基于 SQLite 的队列（`lite-q`）替代 Redis——"基础设施就是一个 SQLite 文件"。

**关键共识**：
- 不引入：独立网关进程、服务注册中心、消息队列、分布式事务框架（< 5 个服务时全是净成本）。
- 基础设施（DB/缓存）**值得容器化**（环境纯净、即抛即用）；**应用服务不容器化**（Windows/macOS 卷挂载导致热重载失效、断点调试复杂）。
- 进程管理选 `concurrently` 而非 PM2（生产级过重）/Overmind（强依赖 tmux）。

## 对照 Toolbox 现状

| 维度 | 现状 | 评估 |
|---|---|---|
| 进程 | 单进程 Hono server + vite web，由 `scripts/dev-utils/dev.mjs` supervisor 统一管理（含端口占用清理） | 已具备 `concurrently` 的核心能力，无需引入 |
| 契约 | `packages/shared` 单一契约层（前后端共享类型） | 与"手工契约"建议完全一致，且已落地 |
| 数据 | `node:sqlite` 单文件 `.file/toolbox.db`（kvStore + tableStore），零依赖 | 与极简终态一致；跨进程写同一 SQLite 需注意 WAL + `busy_timeout`（已开） |
| 异步 | `core/data-infra/` 调度器-任务-消息-FaaS 统一链路 | 已替代"引入 MQ"的需求 |
| 编排 | features → core 单向分层，feature 注册表挂载 | 模块化拆分已就位，拆进程收益极低 |

## 结论

**不拆分微服务。** 当前复杂度（约 20 个 feature + 约 30 个 core 模块）在单进程内完全可控，拆进程会立即付出：跨进程调试、契约双份维护、部署与端口管理、故障面扩大——收益（语言异构）尚未出现。

**保留的演进路径（按需触发，勿提前做）**：

1. **旁路进程（最可能先发生）**：当某个能力必须换语言实现（如 Python 数值计算/Rust 高性能指标），新建独立进程（监听独立端口），由 server 侧 `http-proxy-middleware` 风格转发；**约定旁路进程只读/计算，数据写入仍由 TS 主服务负责**（多进程写 SQLite 是主要风险点）。
2. **进程编排**：如需同时起多个进程，先扩展 `dev.mjs` 的进程表（已有 supervisor 与端口管理），不引入 `concurrently`。
3. **网关/注册中心**：服务数 > 5 且出现多实例需求时再评估（KrakenD/Envoy）。

## 触发重新评估的信号

- 某个 feature 必须换语言实现且无法通过子进程脚本解决
- 单进程内存/CPU 成为瓶颈（日志与 data-infra 任务已能观测）
- 需要独立扩缩容或独立发布周期

## 教训沉淀

- **"引入架构"前先核对已有能力**：本次调研的 3 个推荐件（进程管理/契约层/任务队列）Toolbox 已全部具备自研等价物，差点重复造轮子。
- **Windows 是容器化的硬约束**：本机开发（win32）容器化应用服务会直接废掉热重载，本地微服务方案应默认排除容器化应用进程。
