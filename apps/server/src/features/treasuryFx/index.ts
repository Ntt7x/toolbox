// ============================================================
// 业务模块：国债汇率分析（features/treasury-fx）
// - meta：工具注册信息
// - register：本工具的路由（后台任务 + 轮询，仿 cbRate）
// 依赖下层公共模块：core/tasks、core/llm、core/prompts、core/kvStore
// ============================================================

import { Hono } from "hono";
import {
  API_PREFIX,
  type AsyncTaskResult,
  type ToolMeta,
  type TreasuryFxRequest,
  type TreasuryFxResponse,
} from "@toolbox/shared";
import { createTask, getTask } from "../../core/tasks.js";
import { kvGet, kvSet } from "../../core/kvStore.js";
import { registerDataSource } from "../../core/dataRegistry.js";
import { analyzeTreasuryFx } from "./service.js";

// 注册数据源：国债汇率分析缓存（本地数据管理页展示 tag 用）
registerDataSource({
  kind: "kv",
  name: "treasuryFx:",
  page: "国债汇率分析",
  tag: "分析缓存",
  description: "国债汇率分析结果持久化缓存（Key-结构化 Value，TTL 2 年）",
});

/** 缓存 TTL：2 年（历史数据为权威/已确认信息，长期有效；「强制刷新/重建」按钮可绕过缓存重新查询） */
export const CACHE_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** 缓存 key：参数归一化。v1 = 初始 schema */
export function treasuryFxCacheKey(req: TreasuryFxRequest): string {
  const days = typeof req.days === "number" && Number.isInteger(req.days) ? Math.min(10, Math.max(1, req.days)) : 5;
  return ["treasuryFx", "v1", String(days), req.search !== false ? "search" : "noknowledge"].join(":");
}

export const meta: ToolMeta = {
  id: "treasury-fx",
  name: "国债汇率分析",
  description: "人民币短波段研判框架（汇率套利+债券信号）：USDJPY/USDCNY 排序 + 中日 10Y 利差 → A股波段",
  path: "/tools/treasury-fx",
};

export function register(app: Hono): void {
  // 创建后台分析任务：立即返回 taskId，异步执行（切页/刷新不丢失）
  app.post(`${API_PREFIX}/tools/treasury-fx`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Partial<TreasuryFxRequest> | null;
    if (!raw || typeof raw !== "object") {
      return c.json({ ok: false, message: "请求体必须是 JSON" }, 400);
    }
    const req: TreasuryFxRequest = {
      days: raw.days,
      search: raw.search !== false,
      useCache: raw.useCache !== false,
    };
    const useCache = req.useCache;

    // 缓存命中（TTL 内）：直接返回 done（零 LLM 用量）
    if (useCache) {
      const cached = kvGet<TreasuryFxResponse & { cachedAt?: string }>(treasuryFxCacheKey(req));
      const cachedAtMs = cached?.cachedAt ? Date.parse(cached.cachedAt) : NaN;
      const fresh = cached && Number.isFinite(cachedAtMs) && Date.now() - cachedAtMs < CACHE_TTL_MS;
      if (fresh) {
        const hit: AsyncTaskResult<TreasuryFxResponse> = {
          ok: true,
          taskId: `cache-${treasuryFxCacheKey(req).replace(/[^a-z0-9]/gi, "")}`,
          status: "done",
          result: { ...cached, fromCache: true, cachedAt: cached.cachedAt ?? new Date().toISOString() },
          createdAt: new Date().toISOString(),
        };
        return c.json(hit, 200);
      }
    }

    // 未命中：后台任务执行，完成后写缓存
    const { taskId } = createTask<TreasuryFxResponse>(
      async (signal) => {
        const r = await analyzeTreasuryFx(req, signal);
        if (!r.ok) throw new Error(r.message);
        if (useCache) {
          kvSet(treasuryFxCacheKey(req), { ...r, fromCache: false, cachedAt: new Date().toISOString() });
        }
        return r;
      },
      { timeoutMs: 5 * 60 * 1000 },
    );
    return c.json(getTask<TreasuryFxResponse>(taskId), 202);
  });

  // 查询任务状态（轮询兜底；实时推送走全局 GET /api/tasks/:taskId/stream）
  app.get(`${API_PREFIX}/tools/treasury-fx/task/:taskId`, (c) => {
    const taskId = c.req.param("taskId");
    const task: AsyncTaskResult<TreasuryFxResponse> | null = getTask<TreasuryFxResponse>(taskId);
    if (!task) {
      return c.json({ ok: false, message: "任务不存在或已过期" }, 404);
    }
    return c.json(task, 200);
  });
}
