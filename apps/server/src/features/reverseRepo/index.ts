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
import { getMonthlyData, probeDaily } from "./service.js";

// 注册数据源：逆回购探查结果缓存（本地数据管理页展示 tag 用）
registerDataSource({
  kind: "kv",
  name: "reverseRepo:",
  page: "逆回购余额",
  tag: "分析数据",
  description: "买断式逆回购每日变动探查缓存（Key-结构化 Value）",
});

export const meta: ToolMeta = {
  id: "reverse-repo",
  name: "逆回购余额",
  description: "央行买断式逆回购（2024.10 启用）存量余额跟踪：月度操作/余额表+曲线，每日变动探查",
  path: "/tools/reverse-repo",
};

export function register(app: Hono): void {
  // 存量月度数据（权威种子，直接读取，无 LLM 开销）
  app.get(`${API_PREFIX}/tools/reverse-repo/monthly`, (c) => {
    const body: ReverseRepoMonthlyResult = getMonthlyData();
    return c.json(body);
  });

  // 每日变动探查（增量）：LLM 后台任务 + 缓存 TTL 30 分钟
  app.post(`${API_PREFIX}/tools/reverse-repo/daily`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { force?: unknown } | null;
    const force = raw?.force === true;

    if (!force) {
      const cached = kvGet<ReverseRepoDailyResponse & { _at?: string }>("reverseRepo:daily");
      const at = cached?._at ? Date.parse(cached._at) : NaN;
      if (cached && Number.isFinite(at) && Date.now() - at < 30 * 60 * 1000) {
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
