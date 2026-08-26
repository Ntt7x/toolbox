// ============================================================
// 下层公共模块：任务结果 HTTP 处理器（统一模式）
// 消除各 feature 重复的"任务结果路由"样板（getTask → 404 → 状态检查 → result）
// 统一语义：done → result；failed/cancelled/未完成 → 400 带用户可读 message
// ============================================================
import type { Context } from "hono";
import { getTask } from "./taskRegistry.js";

/** 从 data-infra 任务记录取结果；返回 null 表示任务完成（可继续返回 result），非 null 为错误响应（404/400） */
export function taskResultOrError(c: Context, taskId: string): Response | null {
  const t = getTask(taskId);
  if (!t) {
    return c.json({ ok: false, message: "任务不存在或已过期" }, 404);
  }
  if (t.status !== "done") {
    const message =
      t.status === "failed" ? (t.lastResult ?? "任务失败")
      : t.status === "cancelled" ? "任务已取消"
      : "任务未完成";
    return c.json({ ok: false, message }, 400);
  }
  return null;
}
