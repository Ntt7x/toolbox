// ============================================================
// 服务端入口（装配层）
// 职责：创建 app、挂载中间件、注册各 feature 路由与公共路由、启动。
// 分层约定：
//   core/     下层公共模块（能力：LLM / 行情 / 分享提取，不依赖业务）
//   features/ 上层业务模块（每个工具：meta 注册信息 + register 路由）
// 依赖方向：features → core（业务编排公共能力）
// ============================================================

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  API_PREFIX,
  type HealthResponse,
  type ToolListResponse,
  type ToolMeta,
} from "@toolbox/shared";
import { registerLlmRoutes, registerLlmUsageRoutes, registerPromptRoutes, registerQuoteRoutes, registerDataInfraRoutes } from "./core/routes.js";
import { initDataInfra, startDataInfraRuntime } from "./core/data-infra/index.js";
import * as gridPlanFeature from "./features/gridPlan/index.js";
import * as cbRateFeature from "./features/cbRate/index.js";
import * as treasuryFxFeature from "./features/treasuryFx/index.js";
import * as reverseRepoFeature from "./features/reverseRepo/index.js";
import * as watchlistFeature from "./features/watchlist/index.js";
import * as kellyFeature from "./features/kelly/index.js";
import * as memoFeature from "./features/memo/index.js";
import * as booksFeature from "./features/books/index.js";
import * as deepseekShareFeature from "./features/deepseekShareTool/index.js";
import * as agentSessionsFeature from "./features/agentSessions/index.js";
import * as localDataFeature from "./features/localData/index.js";
import * as zhihuCrawlerFeature from "./features/zhihuCrawler/index.js";
import * as knowledgeHubFeature from "./features/knowledgeHub/index.js";
import * as newsCenterFeature from "./features/newsCenter/index.js";
import * as browserChatFeature from "./features/browserChat/index.js";
import * as todoV3Feature from "./features/todoV3/index.js";
import * as docsFeature from "./features/docs/index.js";
import * as tradeV2Feature from "./features/tradeV2/index.js";
import * as experimentFeature from "./features/experiment/index.js";

const app = new Hono();
app.use(`${API_PREFIX}/*`, cors());

// 健康检查：验证前后端联通
app.get(`${API_PREFIX}/health`, (c) => {
  const body: HealthResponse = {
    ok: true,
    service: "toolbox-server",
    version: "0.1.0",
    time: new Date().toISOString(),
  };
  return c.json(body);
});

// 工具注册表：由各业务 feature 提供 meta（前端菜单 /tools 数据源）
const tools: ToolMeta[] = [
  gridPlanFeature.meta,
  cbRateFeature.meta,
  treasuryFxFeature.meta,
  reverseRepoFeature.meta,
  watchlistFeature.meta,
  kellyFeature.meta,
  booksFeature.meta,
  deepseekShareFeature.meta,
  zhihuCrawlerFeature.meta,
  knowledgeHubFeature.meta,
  newsCenterFeature.meta,
  todoV3Feature.meta,
  docsFeature.meta,
  tradeV2Feature.meta,
  ...experimentFeature.meta,
];

app.get(`${API_PREFIX}/tools`, (c) => {
  const body: ToolListResponse = { tools };
  return c.json(body);
});

// 下层公共能力路由（LLM 设置 + 提示词管理 + 行情快照 + 任务 SSE/取消）
registerLlmRoutes(app);
registerLlmUsageRoutes(app);
registerPromptRoutes(app);
registerQuoteRoutes(app);
registerDataInfraRoutes(app);

// 上层业务路由
gridPlanFeature.register(app);
cbRateFeature.register(app);
treasuryFxFeature.register(app);
reverseRepoFeature.register(app);
watchlistFeature.register(app);
kellyFeature.register(app);
memoFeature.register(app);
booksFeature.register(app);
deepseekShareFeature.register(app);
agentSessionsFeature.register(app);
// 设置页模块（本地数据管理，非工具）
localDataFeature.register(app);
zhihuCrawlerFeature.register(app);
browserChatFeature.register(app);
knowledgeHubFeature.register(app);
// 待办清单 v3（Cordis 框架：Service 服务化 + DAG 依赖 + 周期调度）
todoV3Feature.registerTodoV3Feature(app);
// 文档中心（markdown/pdf 管理与浏览）
docsFeature.registerDocsFeature(app);
// 仓位管理 v2（逐笔交易账本 + 仓位明细派生 + 分组约束与分析）
tradeV2Feature.registerTradeV2Feature(app);
experimentFeature.register(app);
// 新闻中心：注册东财源 + 路由
newsCenterFeature.registerNewsSource(newsCenterFeature.EASTMONEY_SOURCE);
newsCenterFeature.register(app);

// 导出 app 供集成测试（app.request 免端口调用）
export { app };

// 数据工程基础设施：数据源注册（无条件执行——注册表完整性，测试断言"未标记应为 0"依赖）
initDataInfra();

const port = Number(process.env.PORT ?? 8787);
// 集成测试（TOOLBOX_TEST=1）import 本模块时不启动端口监听
if (process.env.TOOLBOX_TEST !== "1") {
  // 端口监听韧性（2026-08-14）：tsx watch 在源码变更重启时，旧子进程端口未释放会导致新进程 EADDRINUSE 崩溃——
  // 监听失败自动等待重试自愈（dev.mjs supervisor 无法感知 tsx 内部子进程竞态，由 server 自身兜底）
  const MAX_LISTEN_RETRY = 10;
  const listenWithRetry = (attempt: number): void => {
    const srv = serve({ fetch: app.fetch, port }, (info) => {
      console.log(`toolbox server: http://localhost:${info.port}${API_PREFIX}/health`);
    });
    srv.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE" && attempt < MAX_LISTEN_RETRY) {
        console.warn(`[listen] 端口 ${port} 被占用，1.5s 后重试（${attempt + 1}/${MAX_LISTEN_RETRY}）`);
        setTimeout(() => listenWithRetry(attempt + 1), 1500);
      } else {
        console.error(`[listen] 监听 ${port} 失败：`, e.message);
        process.exit(1);
      }
    });
  };
    listenWithRetry(0);
  // 测试环境（app.integration 免端口装配）不启动调度器/消费者运行时——否则定时器/循环卡测试进程
  startDataInfraRuntime(); // 调度器 + 消费者（消息驱动工作流运行时）
}
