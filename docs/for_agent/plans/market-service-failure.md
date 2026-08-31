# 失败复盘：market-service（Python akshare 行情微服务）接入

> 状态：**已放弃（2026-08-31）**——分支 `feat/market-service` 已删除，源码已清理（仅保留 `services/market-service/.venv` 可复用环境，已被 .gitignore 忽略）。
> 来源：用户诉求「Python akshare 统一行情微服务 + 微服务化联调 + 作为 api-service 第一优先源」。
> 结论：**技术方案可行但本环境落地受阻，且验证环节出现严重乌龙，判定不值得继续投入，回退。**

## 一、做了什么（已落地但放弃的部分）

1. `services/market-service/`：FastAPI + akshare，路由 `/health` `/quote` `/quotes` `/kline` `/fx` `/boll`，Pydantic 契约对齐 `packages/shared.QuoteSnapshot`。
2. `core/marketService.ts`（TS 网关客户端）+ `core/quote.ts` 把 market-service 置于 failover 链最前。
3. `dev.mjs` supervisor 扩 `market(8899)` 进程表。
4. 实跑验证 market-service 自身可用：`/quote?600519`→ 贵州茅台 1299.52（source `akshare.sina`）、`/kline` 5994 日线、`/boll` 正常。

## 二、致命问题（导致放弃）

### 2.1 api-service 实际未走 market-service（第一优先源未生效）
- 通过 `api-service`（`GET /api/quote?code=600519&force=1`）实测，`source` 始终为 `tencent`，而非预期的 `market-service:akshare.sina`。
- 直接 `fetch('http://127.0.0.1:8899/quote?code=600519')` 能拿到 `akshare.sina` 数据 → 证明 market-service 本身正常、端口可达。
- 但 server 进程内 `fetchFromMarketService` 实际返回 null（已加 `console.error` 调试日志准备定位，未及读取即被叫停放弃）。
- **根因未定位**，候选：① server 内 `fetch` 到 `127.0.0.1:8899` 在 tsx 运行时抛错被静默吞掉；② `marketServiceBase()` 读取 `settings` 异常；③ IPv6/IPv4 解析差异（`dev` 日志显示 server 监听 `:::8787` 即 IPv6）。**不论哪种，都说明「第一优先源」这一核心诉求在未解决前是空头支票。**

### 2.2 dev.mjs 端口清理竞态（运维可靠性缺陷）
- `dev.mjs start` 报告「端口 8787 被占用 → 终止」，但新 tsx 反复 `EADDRINUSE: address already in use :::8787`（10 次重试），说明旧 server 子进程未被真正杀掉、或旧 supervisor 在被杀瞬间又拉起新子进程抢回端口。
- 后果：监听 8787 的是**旧代码（无 market-service 逻辑）的 server**，新 server 永远绑不上 → 任何「看起来在跑」的验证都是假的。
- 临时绕过：先 `stop` 再 `start` 可规避，但这是 supervisor 的健壮性问题，本就不该在「验证新功能」时被它绊住。

### 2.3 akshare 数据源本环境脆弱（功能可靠性缺陷）
- 东财 spot（`stock_zh_a_spot_em`）：TLS 不稳（`RemoteDisconnected`），本机基本不可用。
- 新浪全市场快照（`stock_zh_a_spot`）：可达，但返回 **GBK 列名且随会话编码漂移** → 必须按列位置取值（已改），且单次 ~24s 延迟。
- 港股 spot（`stock_hk_spot_em`）：同样受限，本机取不到 → 只能靠 TS 侧 tencent hk 兜底。
- 含义：market-service 在本机只能稳定覆盖 A 股快照 + K线，**核心卖点「统一公共行情源」在本环境是残缺的**，与「第一优先源」诉求自相矛盾。

## 三、验证乌龙（过程问题）

- 实测 `source=tencent` 后，误判为「旧 server 缓存/未重载」，先 `stop` 再 `start` 重测——仍 `tencent`。
- 此时才意识到是 `fetchFromMarketService` 在 server 内返回 null，而非缓存问题。来回在「端口竞态」与「逻辑 bug」两个假设间切换，浪费多轮。
- 教训：**网关层集成不能只靠「Python 服务能跑 + typecheck 绿」就乐观判定**，必须打穿 api-service 端到端看 `source` 字段；且 dev.mjs 的端口竞态会让「看起来在跑」极具误导性。

## 四、为什么放弃而非继续修

1. 核心诉求（market-service 作为第一优先源）**未实证成立**，且根因未定位。
2. 即便修好 2.1，本环境 akshare 也只能覆盖 A 股（2.3），「统一公共行情微服务」名不副实，收益远低于引入一个常驻 Python 进程 + 端口 + 依赖安装的运维成本。
3. 与既有 `plans/server-microservices.md` 结论一致：**< 5 服务时不拆微服务**；本场景 TS 多源（腾讯/东财/新浪）已能稳定服务，Python 旁路进程是「净成本」。
4. 用户明确「放弃这次改动和分支」。

## 五、可复用资产（若未来重做）

- `services/market-service/.venv`：已装 akshare/fastapi/uvicorn/httpx/pandas（约 24s 装完，重装耗时），保留可省去依赖下载。
- 已验证可用的取数路径：`stock_zh_a_spot`（按位置取值）、`stock_zh_a_daily`（K线）、`_resample_period`（日→周/月聚合）。
- 若重做，应先解决：① server→market-service 的 fetch 在 tsx/IPv6 下的连通性（用 `http://localhost:8899` 或显式 IPv4）；② 在 `dev.mjs` 端口清理中先杀干净旧 supervisor 的全部子进程再 spawn；③ 明确 market-service 仅作「A股增强源」而非「统一第一优先源」，避免与 TS 多源定位冲突。

## 六、本次新增的教训（沉淀）

- **网关集成必须端到端看字段**：microservice 类改动，live 验证要直接打 api-service 看 `source`/`provider` 这类溯源字段，不能只看「服务起来了」。
- **supervisor 端口竞态会伪造「在跑」**：`dev.mjs` 杀旧 supervisor 与 spawn 新 server 之间存在竞态，旧子进程抢回端口 → 新进程永远 EADDRINUSE。验证新功能前先 `status` 确认端口持有者 PID 是预期的新进程。
- **跨进程 fetch 在 Node/tsx 运行时下的连通性要单独验证**：server 内 fetch 旁路服务与 standalone 脚本行为可能不同（IPv6 监听、AbortSignal、异常吞掉）。
- **akshare 本机连通性需先灰度探活**：不同接口可达性差异极大，先 `stock_zh_a_spot_em` 失败才知要换源；「能 import」≠「能取数」。
