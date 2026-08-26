// ============================================================
// 业务模块：逆回购余额跟踪（features/reverse-repo）
// - meta：工具注册信息
// - register：存量月度数据（GET，权威种子）+ 每日变动探查（POST，LLM+缓存）
// 依赖下层公共模块：core/data-infra（统一任务）、core/llm、core/prompts、core/kvStore
// ============================================================

import { Hono } from "hono";
import {
  API_PREFIX,
  type ReverseRepoDailyResponse,
  type ReverseRepoDailyResult,
  type ReverseRepoMonthlyResult,
  type ToolMeta,
} from "@toolbox/shared";
import { getTask, newTaskId, registerScheduledTask, registerTask, startTask } from "../../core/data-infra/index.js";
import { kvGet, kvSet } from "../../core/kvStore.js";
import { registerDataSource } from "../../core/dataRegistry.js";
import { getMonthlyData, getUpdateState, missingMonths, probeDaily, runMonthlyUpdate, UPDATE_STATE_KEY } from "./service.js";

// 注册数据源：买断式逆回购（本地数据管理页展示 tag 用）
registerDataSource({
  kind: "kv",
  name: "reverseRepo:monthly",
  page: "买断式逆回购余额",
  tag: "存量数据",
  description: "买断式逆回购存量数据（逐笔流水+月度汇总，默认种子 seed，可编辑/删除重置）",
});
registerDataSource({
  kind: "kv",
  name: "reverseRepo:daily:",
  page: "买断式逆回购余额",
  tag: "分析数据",
  description: "买断式逆回购每日变动探查缓存（Key-结构化 Value）",
});
registerDataSource({
  kind: "kv",
  name: "reverseRepo:monthlyUpdate",
  page: "买断式逆回购余额",
  tag: "运行状态",
  description: "月度数据触发式更新状态（running/done/failed，可手动重置）",
});

// 月度数据更新改为统一数据基建调度任务（data-infra）：cron 每日检查缺失月份，有缺失才执行 LLM 补更（成本可控）；
// 运管页可手动触发 / 回溯重建；原先的 POST /monthly/refresh 手动触发保留为兼容入口
registerScheduledTask({
  id: "reverseRepo-monthly",
  type: "reverse-repo",
  name: "买断式逆回购月度更新",
  cron: "0 0 9 * * *",
  handler: async () => {
    const body = getMonthlyData();
    const stale = missingMonths(body.rows);
    if (stale.length === 0) return { ok: true, message: "月度数据已是最新，无需更新" };
    // 双轨防并发：手动入口（POST /monthly/refresh）可能正在跑——状态锁跳过本次调度，避免重复 LLM 调用
    if (getUpdateState().state === "running") return { ok: true, message: "已有更新任务进行中，本次调度跳过" };
    await runMonthlyUpdate(stale);
    return { ok: true, message: `已补更 ${stale.length} 个月份（${stale.join(",")}）` };
  },
});

export const meta: ToolMeta = {
  id: "reverse-repo",
  name: "买断式逆回购余额",
  description: "央行买断式逆回购（2024.10 启用）存量余额跟踪：逐笔操作流水+月度汇总+余额曲线，每日变动探查",
  path: "/tools/reverse-repo",
};

export function register(app: Hono): void {
  // 存量月度数据（权威种子 seed → KV 读取；缺失月份仅提示，不自动触发 LLM）
  app.get(`${API_PREFIX}/tools/reverse-repo/monthly`, (c) => {
    const body = getMonthlyData();
    const stale = missingMonths(body.rows);
    return c.json({ ...body, stale: stale.length > 0, staleMonths: stale });
  });

  // 月度更新状态（触发式更新进度/结果）
  app.get(`${API_PREFIX}/tools/reverse-repo/monthly/update-status`, (c) => {
    const st = getUpdateState();
    return c.json({ ok: true, ...st });
  });

  // 手动触发月度数据更新（等价于 GET monthly 的自动触发；返回立即结果，任务后台执行）
  // 手动更新入口：统一触发调度任务（reverseRepo-monthly）——与 cron 同链路 + 状态锁防并发
  app.post(`${API_PREFIX}/tools/reverse-repo/monthly/refresh`, (c) => {
    const body = getMonthlyData();
    const stale = missingMonths(body.rows);
    if (stale.length === 0) return c.json({ ok: true, state: "idle", message: "数据已是最新，无需更新" });
    if (getUpdateState().state === "running") {
      return c.json({ ok: true, state: "running", months: stale, message: "已有更新任务进行中" });
    }
    const t = getTask("reverseRepo-monthly");
    if (!t) return c.json({ ok: false, message: "调度任务未注册" }, 500);
    if (t.status === "paused") return c.json({ ok: false, message: "调度任务已暂停，请先在数据基础设施页恢复" }, 400);
    startTask("reverseRepo-monthly", { trigger: "manual" });
    return c.json({ ok: true, state: "running", months: stale, taskId: "reverseRepo-monthly" });
  });

  /** 每日变动探查缓存 TTL：2 年（历史数据长期有效；「强制刷新」按钮可绕过缓存重新探查）
   *  缓存 key 按「分析日期」隔离（v2）：每日探查按天独立，跨天自动失效不命中旧缓存 */
  const DAILY_CACHE_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000;
  const dailyCacheKey = () => {
    const n = new Date();
    const d = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
    return `reverseRepo:daily:${d}`;
  };
  app.post(`${API_PREFIX}/tools/reverse-repo/daily`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { force?: unknown } | null;
    const force = raw?.force === true;

    if (!force) {
      const cached = kvGet<ReverseRepoDailyResponse & { _at?: string }>(dailyCacheKey());
      const at = cached?._at ? Date.parse(cached._at) : NaN;
      if (cached && Number.isFinite(at) && Date.now() - at < DAILY_CACHE_TTL_MS) {
        const hit = { ok: true, result: { ...cached, fromCache: true } };
        return c.json(hit, 200);
      }
    }

    // 统一模式：ephemeral 一次性任务（data-infra）
    const taskId = newTaskId("reverse-repo-daily");
    registerTask({
      id: taskId,
      type: "reverse-repo",
      name: `${new Date().toISOString().slice(0, 10)} · 逆回购每日变动探查`,
      handler: async (ctx) => {
        const r = await probeDaily(ctx.signal ?? new AbortController().signal);
        if (!r.ok) throw new Error(r.message);
        kvSet(dailyCacheKey(), { ...r, _at: new Date().toISOString() });
        return { ok: true, message: "探查完成", result: r };
      },
    }, { ephemeral: true });
    startTask(taskId, { trigger: "manual" });
    return c.json({ ok: true, taskId }, 202);
  });

}
