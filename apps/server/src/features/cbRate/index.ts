// ============================================================
// 业务模块：央行利率分析（features/cb-rate）
// - meta：工具注册信息
// - register：本工具的路由（后台任务 + 轮询）
// 依赖下层公共模块：core/data-infra（统一任务）、core/llm（chat+search+JSON）
// ============================================================

import { Hono } from "hono";
import {
  API_PREFIX,
  type CbRateRequest,
  type CbRateResponse,
  type ToolMeta,
} from "@toolbox/shared";
import { newTaskId, registerTask, startTask } from "../../core/data-infra/index.js";
import { kvGet, kvSet } from "../../core/kvStore.js";
import { registerDataSource } from "../../core/dataRegistry.js";
import { analyzeCentralBankRates } from "./service.js";

// 注册数据源：央行利率分析缓存（本地数据管理页展示 tag 用）
registerDataSource({
  kind: "kv",
  name: "cbRate:",
  page: "央行利率分析",
  tag: "分析缓存",
  description: "利率分析结果持久化缓存（Key-结构化 Value，TTL 2 年）",
});

// 注：任务历史已统一到 data-infra（dataInfra:task: / dataInfra:taskHist:），core/tasks 时代的 taskHistory: 已退役

/** 缓存 TTL：2 年（历史数据为权威/已确认信息，长期有效；「强制刷新/重建」按钮可绕过缓存重新查询） */
export const CACHE_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** 缓存 key：参数归一化（banks 排序）后的查询组合。v2 = 防幻觉/数据模式/缺失提示等 schema 升级（旧缓存自动失效） */
/** 用户可读任务名称：{查询月份} · 央行利率分析（选中央行数） */
function cbRateTaskName(req: CbRateRequest): string {
  // 2026-08-14：本地时区月份（toISOString 是 UTC，跨月边界任务名与缓存 key 不一致）
  const now = new Date();
  const month = req.month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const bankCount = req.banks?.length ? req.banks.length : 9;
  const scope = req.banks?.length ? `${bankCount} 家央行` : "九大央行";
  return `${month} · 央行利率分析（${scope}）`;
}

export function cbRateCacheKey(req: CbRateRequest): string {
  const banks = (req.banks ?? []).slice().sort().join(",");
  const n = new Date();
  const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
  // 无显式月份时按「查询日」纳入 key：本月以来/今年以来 是进行时数据（截至今天），按日自动失效（v4，2026-08 修复）；
  // period=year 且携带 month 时把 month 纳入（防不同月份碰撞同一 key）
  const scope = req.period === "month"
    ? (req.month || today)
    : (req.month || `${n.getFullYear()}`);
  return [
    "cbRate",
    "v4",
    req.period,
    scope,
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
        const hit = { ok: true, result: { ...cached, fromCache: true, cachedAt: cached.cachedAt ?? new Date().toISOString() } };
        return c.json(hit, 200);
      }
    }

    // 未命中：统一模式一次性任务（data-infra ephemeral）——状态/进度/结果统一链路，完成后写缓存
    const taskName = cbRateTaskName(req);
    const id = newTaskId("cb-rate");
    registerTask({
      id,
      type: "cb-rate",
      name: taskName,
      handler: async (ctx) => {
        const r = await analyzeCentralBankRates(req, ctx.signal ?? new AbortController().signal);
        if (!r.ok) throw new Error(r.message); // 业务错误 → 任务 failed 态
        if (useCache) {
          kvSet(cbRateCacheKey(req), { ...r, fromCache: false, cachedAt: new Date().toISOString() });
        }
        return { ok: true, message: "分析完成", result: r };
      },
    }, { ephemeral: true });
    startTask(id, { trigger: "manual" });
    return c.json({ ok: true, taskId: id }, 202);
  });

}
