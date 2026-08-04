// ============================================================
// 业务模块：央行利率分析（features/cb-rate）
// - meta：工具注册信息
// - register：本工具的路由
// 依赖下层公共模块：core/llm（chat + search + JSON 输出）
// ============================================================

import { Hono } from "hono";
import { API_PREFIX, type CbRateRequest, type ToolMeta } from "@toolbox/shared";
import { analyzeCentralBankRates } from "./service.js";

export const meta: ToolMeta = {
  id: "cb-rate",
  name: "央行利率分析",
  description: "九大央行利率政策时间线分析（LLM 驱动，需配置 DeepSeek key）",
  path: "/tools/cb-rate",
};

export function register(app: Hono): void {
  // 央行利率分析（LLM 驱动）
  app.post(`${API_PREFIX}/tools/cb-rate`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Partial<CbRateRequest> | null;
    if (!raw || (raw.period !== "month" && raw.period !== "year")) {
      return c.json({ ok: false, message: "period 必须为 month 或 year" }, 400);
    }
    const result = await analyzeCentralBankRates({
      period: raw.period,
      ...(typeof raw.month === "string" ? { month: raw.month } : {}),
      ...(Array.isArray(raw.banks) ? { banks: raw.banks } : {}),
      ...(typeof raw.withCalendar === "boolean" ? { withCalendar: raw.withCalendar } : {}),
      ...(typeof raw.search === "boolean" ? { search: raw.search } : {}),
    });
    return c.json(result, result.ok ? 200 : 400);
  });
}
