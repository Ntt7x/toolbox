import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  API_PREFIX,
  type GridPlanRequest,
  type GridPlanResult,
  type GridTrendType,
  type HealthResponse,
  type ToolListResponse,
  type ToolMeta,
} from "@toolbox/shared";
import { generateGridPlan } from "./gridPlan.js";

const app = new Hono();
app.use(`${API_PREFIX}/*`, cors());

// 健康检查：vibe coding 阶段用于验证前后端联通
app.get(`${API_PREFIX}/health`, (c) => {
  const body: HealthResponse = {
    ok: true,
    service: "toolbox-server",
    version: "0.1.0",
    time: new Date().toISOString(),
  };
  return c.json(body);
});

// 小工具注册表（实际工具由 vibe coding 逐步添加）
const tools: ToolMeta[] = [
  {
    id: "grid-plan",
    name: "交易网格计划",
    description: "仓位中性趋势优势网格计划生成（月线布林带 + 趋势类型）",
    path: "/tools/grid-plan",
  },
];

app.get(`${API_PREFIX}/tools`, (c) => {
  const body: ToolListResponse = { tools };
  return c.json(body);
});

// 交易网格计划生成
app.post(`${API_PREFIX}/tools/grid-plan`, async (c) => {
  const raw = await c.req.json().catch(() => null) as Partial<GridPlanRequest> | null;
  if (!raw || typeof raw !== "object") {
    const body: GridPlanResult = { ok: false, error: "format", message: "请求体必须是 JSON" };
    return c.json(body, 400);
  }
  const { type, boll, maxAmount } = raw;
  if (
    typeof type !== "number" || !Number.isInteger(type) || type < 1 || type > 7 ||
    !Array.isArray(boll) || boll.length !== 3 ||
    !boll.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0) ||
    (maxAmount !== undefined && (typeof maxAmount !== "number" || !Number.isFinite(maxAmount) || maxAmount <= 0))
  ) {
    const body: GridPlanResult = {
      ok: false,
      error: "format",
      message: "格式错误，请按 `编号 数值1 数值2 数值3` 发送。示例：`1 1.073 1.290 0.856`",
    };
    return c.json(body, 400);
  }
  const result = generateGridPlan(type as GridTrendType, boll as [number, number, number], maxAmount);
  const status = result.ok ? 200 : result.error === "format" ? 400 : 422;
  return c.json(result, status);
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`toolbox server: http://localhost:${info.port}${API_PREFIX}/health`);
});
