// ============================================================
// 业务模块：逆回购余额跟踪（features/reverse-repo）
// - meta：工具注册信息
// - register：存量月度数据（GET，权威种子）+ 每日变动探查（POST，LLM+缓存）
// 依赖下层公共模块：core/tasks、core/llm、core/prompts、core/kvStore
// ============================================================

import { Hono } from "hono";
import {
  API_PREFIX,
  type AsyncTaskResult,
  type ReverseRepoDailyResponse,
  type ReverseRepoDailyResult,
  type ReverseRepoMonthlyResult,
  type ToolMeta,
} from "@toolbox/shared";
import { createTask, getTask } from "../../core/tasks.js";
import { kvGet, kvSet } from "../../core/kvStore.js";
import { registerDataSource } from "../../core/dataRegistry.js";
import { getMonthlyData, getUpdateState, missingMonths, probeDaily, runMonthlyUpdate } from "./service.js";

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
  name: "reverseRepo:daily",
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
  app.post(`${API_PREFIX}/tools/reverse-repo/monthly/refresh`, (c) => {
    const body = getMonthlyData();
    const stale = missingMonths(body.rows);
    if (stale.length === 0) return c.json({ ok: true, state: "idle", message: "数据已是最新，无需更新" });
    if (getUpdateState().state === "running") {
      return c.json({ ok: true, state: "running", months: stale, message: "已有更新任务进行中" });
    }
    let taskId = "";
    const created = createTask(async (signal) => runMonthlyUpdate(stale, signal, taskId), { timeoutMs: 15 * 60 * 1000 });
    taskId = created.taskId;
    return c.json({ ok: true, state: "running", months: stale, taskId });
  });

  /** 每日变动探查缓存 TTL：2 年（历史数据长期有效；「强制刷新」按钮可绕过缓存重新探查） */
  const DAILY_CACHE_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000;
  app.post(`${API_PREFIX}/tools/reverse-repo/daily`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { force?: unknown } | null;
    const force = raw?.force === true;

    if (!force) {
      const cached = kvGet<ReverseRepoDailyResponse & { _at?: string }>("reverseRepo:daily");
      const at = cached?._at ? Date.parse(cached._at) : NaN;
      if (cached && Number.isFinite(at) && Date.now() - at < DAILY_CACHE_TTL_MS) {
        const hit: AsyncTaskResult<ReverseRepoDailyResult> = {
          ok: true,
          taskId: "reverse-repo-daily-cache",
          status: "done",
          result: { ...cached, fromCache: true },
          createdAt: cached._at ?? new Date().toISOString(),
        };
        return c.json(hit, 200);
      }
    }

    const { taskId } = createTask<ReverseRepoDailyResult>(
      async (signal) => {
        const r = await probeDaily(signal);
        if (!r.ok) throw new Error(r.message);
        kvSet("reverseRepo:daily", { ...r, _at: new Date().toISOString() });
        return r;
      },
      { timeoutMs: 5 * 60 * 1000 },
    );
    return c.json(getTask<ReverseRepoDailyResult>(taskId), 202);
  });

  // 增量任务状态轮询
  app.get(`${API_PREFIX}/tools/reverse-repo/daily/task/:taskId`, (c) => {
    const task: AsyncTaskResult<ReverseRepoDailyResult> | null = getTask<ReverseRepoDailyResult>(c.req.param("taskId"));
    if (!task) return c.json({ ok: false, message: "任务不存在或已过期" }, 404);
    return c.json(task, 200);
  });
}
