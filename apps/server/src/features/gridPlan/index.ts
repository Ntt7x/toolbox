// ============================================================
// 业务模块：交易网格计划（features/grid-plan）
// - meta：工具注册信息（供 /api/tools 列表与前端菜单使用）
// - register：本工具的路由（BOLL 行情补全 + 计划生成）
// 依赖下层公共模块：core/quote（行情）、core/llm（未来）
// ============================================================

import { Hono } from "hono";
import {
  API_PREFIX,
  type GridPlanRequest,
  type GridPlanResult,
  type GridTrendType,
  type ToolMeta,
} from "@toolbox/shared";
import { generateGridPlan } from "./compute.js";
import { queryMonthlyBoll } from "../../core/quote.js";

export const meta: ToolMeta = {
  id: "grid-plan",
  name: "交易网格计划",
  description: "仓位中性趋势优势网格计划生成（月线布林带 + 趋势类型）",
  path: "/tools/grid-plan",
};

export function register(app: Hono): void {
  // 股票月线 BOLL 查询（自动补全）
  app.get(`${API_PREFIX}/tools/grid-plan/quote`, async (c) => {
    const code = c.req.query("code")?.trim();
    if (!code) {
      return c.json({ ok: false, message: "缺少 code 参数" }, 400);
    }
    const result = await queryMonthlyBoll(code);
    return c.json(result, result.ok ? 200 : 400);
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
        message: "格式错误：type 必须为 1~7 的整数，boll 必须为三个正数（上轨/中轨/下轨，顺序任意）。示例：`1 1.073 1.290 0.856`",
      };
      return c.json(body, 400);
    }
    const result = generateGridPlan(type as GridTrendType, boll as [number, number, number], maxAmount);
    // 业务失败统一 400（compute 的 format 错误已被上方校验拦截，不会到达此处）
    return c.json(result, result.ok ? 200 : 400);
  });
}
