// ============================================================
// 业务模块：央行利率分析（features/cb-rate）
// - meta：工具注册信息
// - register：本工具的路由（后台任务 + 轮询）
// 依赖下层公共模块：core/tasks（通用任务）、core/llm（chat+search+JSON）
// ============================================================

import { Hono } from "hono";
import {
  API_PREFIX,
  type AsyncTaskResult,
  type CbRateRequest,
  type CbRateResponse,
  type ToolMeta,
} from "@toolbox/shared";
import { createTask, getTask } from "../../core/tasks.js";
import { kvGet, kvSet } from "../../core/kvStore.js";
import { registerDataSource } from "../../core/dataRegistry.js";
import { analyzeCentralBankRates } from "./service.js";

// 注册数据源：央行利率分析缓存（本地数据管理页展示 tag 用）
registerDataSource({
  kind: "kv",
  name: "cbRate:",
  page: "央行利率分析",
  tag: "分析缓存",
  description: "利率分析结果持久化缓存（Key-结构化 Value，TTL 24h 自动过期）",
});

/** 缓存 TTL：24 小时（超期命中视为未命中，重新查询并刷新缓存） */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 缓存 key：参数归一化（banks 排序）后的查询组合。v2 = 防幻觉/数据模式/缺失提示等 schema 升级（旧缓存自动失效） */
export function cbRateCacheKey(req: CbRateRequest): string {
  const banks = (req.banks ?? []).slice().sort().join(",");
  return [
    "cbRate",
    "v2",
    req.period,
    req.month ?? "",
    banks,
    req.withCalendar ? "cal" : "nocal",
    req.search !== false ? "search" : "noknowledge",
  ].join(":");
}

export const meta: ToolMeta = {
  id: "cb-rate",
  name: "央行利率分析",
  description: "九大央行利率政策时间线分析（LLM 驱动，需配置 DeepSeek key）",
  path: "/tools/cb-rate",
};

export function register(app: Hono): void {
  // 创建后台分析任务：立即返回 taskId，分析异步执行（切页/刷新不丢失）
  app.post(`${API_PREFIX}/tools/cb-rate`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Partial<CbRateRequest> | null;
    if (!raw || (raw.period !== "month" && raw.period !== "year")) {
      return c.json({ ok: false, message: "period 必须为 month 或 year" }, 400);
    }
    const req: CbRateRequest = {
      period: raw.period,
      ...(typeof raw.month === "string" ? { month: raw.month } : {}),
      ...(Array.isArray(raw.banks) ? { banks: raw.banks } : {}),
      ...(typeof raw.withCalendar === "boolean" ? { withCalendar: raw.withCalendar } : {}),
      ...(typeof raw.search === "boolean" ? { search: raw.search } : {}),
    };
    const useCache = raw.useCache !== false; // 默认开启缓存

    // 缓存命中（TTL 内）：直接返回 done（零 LLM 用量）；超期视为未命中，重新查询并刷新
    if (useCache) {
      const cached = kvGet<CbRateResponse & { cachedAt?: string }>(cbRateCacheKey(req));
      const cachedAtMs = cached?.cachedAt ? Date.parse(cached.cachedAt) : NaN;
      const fresh = cached && Number.isFinite(cachedAtMs) && Date.now() - cachedAtMs < CACHE_TTL_MS;
      if (fresh) {
        const hit: AsyncTaskResult<CbRateResponse> = {
          ok: true,
          taskId: `cache-${cbRateCacheKey(req).replace(/[^a-z0-9]/gi, "")}`,
          status: "done",
          result: { ...cached, fromCache: true, cachedAt: cached.cachedAt ?? new Date().toISOString() },
          createdAt: new Date().toISOString(),
        };
        return c.json(hit, 200);
      }
    }

    // 未命中：后台任务执行，完成后写缓存
    const { taskId } = createTask<CbRateResponse>(
      async (signal) => {
        const r = await analyzeCentralBankRates(req, signal);
        if (!r.ok) throw new Error(r.message); // 业务错误 → 任务 error 态
        if (useCache) {
          kvSet(cbRateCacheKey(req), { ...r, fromCache: false, cachedAt: new Date().toISOString() });
        }
        return r;
      },
      { timeoutMs: 5 * 60 * 1000 },
    );
    return c.json(getTask<CbRateResponse>(taskId), 202);
  });

  // 查询任务状态（轮询兜底；实时推送走全局 GET /api/tasks/:taskId/stream）
  app.get(`${API_PREFIX}/tools/cb-rate/task/:taskId`, (c) => {
    const taskId = c.req.param("taskId");
    const task: AsyncTaskResult<CbRateResponse> | null = getTask<CbRateResponse>(taskId);
    if (!task) {
      return c.json({ ok: false, message: "任务不存在或已过期" }, 404);
    }
    return c.json(task, 200);
  });
}
