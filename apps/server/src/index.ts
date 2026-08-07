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
import { registerLlmRoutes, registerLlmUsageRoutes, registerPromptRoutes, registerQuoteRoutes } from "./core/routes.js";
import { registerTaskRoutes } from "./core/sse.js";
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
import * as tradePlanFeature from "./features/tradePlan/index.js";
import * as browserChatFeature from "./features/browserChat/index.js";

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
  tradePlanFeature.meta,
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
registerTaskRoutes(app);

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
tradePlanFeature.register(app);
knowledgeHubFeature.register(app);
// 新闻中心：注册东财源 + 路由
newsCenterFeature.registerNewsSource(newsCenterFeature.EASTMONEY_SOURCE);
newsCenterFeature.register(app);

// 导出 app 供集成测试（app.request 免端口调用）
export { app };

const port = Number(process.env.PORT ?? 8787);
// 集成测试（TOOLBOX_TEST=1）import 本模块时不启动端口监听
if (process.env.TOOLBOX_TEST !== "1") {
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`toolbox server: http://localhost:${info.port}${API_PREFIX}/health`);
  });
}
