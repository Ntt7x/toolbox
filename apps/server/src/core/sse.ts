// ============================================================
// 下层公共模块：SSE（Server-Sent Events）推送出口
// 统一注册 GET /api/tasks/:taskId/stream：
// 任务状态变化（pending/running/done/error）实时推送给客户端，
// EventSource 断开自动重连；任务终态后关闭流。
// 客户端降级策略：不支持 SSE 时回退轮询 GET /api/tasks/:taskId。
// ============================================================

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { API_PREFIX, type AsyncTaskResult } from "@toolbox/shared";
import { cancelTask, getTask, getTaskHistoryEntry, listTaskHistory, onTaskUpdate } from "./tasks.js";

/**
 * 注册全局任务路由（index.ts 装配时调用一次）：
 * - GET  /api/tasks/:taskId/stream  SSE 推送（状态实时通知）
 * - POST /api/tasks/:taskId/cancel  取消任务（abort 底层资源）
 */
export function registerTaskRoutes(app: Hono): void {
  // 任务历史列表（KV 持久化；内存任务过期后仍可查）：GET /api/tasks/history?module=cb-rate
  app.get(`${API_PREFIX}/tasks/history`, (c) => {
    const module = c.req.query("module")?.trim() ?? "";
    if (!module) return c.json({ ok: false, message: "缺少 module 参数" }, 400);
    const entries = listTaskHistory(module);
    return c.json({ ok: true, module, entries, total: entries.length });
  });

  // 任务历史条目（按 taskId，内存兜底）：GET /api/tasks/history/:taskId
  app.get(`${API_PREFIX}/tasks/history/:taskId`, (c) => {
    const taskId = c.req.param("taskId");
    const entry = getTaskHistoryEntry(taskId);
    if (!entry) return c.json({ ok: false, message: "历史任务不存在" }, 404);
    return c.json({ ok: true, entry });
  });

  // 取消任务：客户端强行中断
  app.post(`${API_PREFIX}/tasks/:taskId/cancel`, (c) => {
    const taskId = c.req.param("taskId");
    const ok = cancelTask(taskId);
    if (!ok) {
      return c.json({ ok: false, message: "任务不存在或已结束" }, 404);
    }
    return c.json({ ok: true, taskId, status: "cancelled" });
  });

  app.get(`${API_PREFIX}/tasks/:taskId/stream`, (c) => {
    const taskId = c.req.param("taskId");
    const initial = getTask(taskId);
    // 任务不存在：仍返回 SSE 流并推 error 事件后关闭——
    // EventSource 对非 200 会无限重连导致前端永久卡死，SSE error 事件可被前端感知终止。
    if (!initial || !initial.ok) {
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ ok: false, message: "任务不存在或已过期" }),
        });
      });
    }
    const isFinal = initial.status === "done" || initial.status === "error" || initial.status === "cancelled";

    return streamSSE(c, async (stream) => {
      // 先推当前状态，让重连/晚到的客户端立即同步
      await stream.writeSSE({ event: "status", data: JSON.stringify(initial) });
      if (isFinal) return; // 已结束：推完终态即关闭

      // 心跳：防止代理/中间层因空闲断开长连接。
      // 注意 Hono 的 stream.close() 不会触发 onAbort，终态/竞态分支必须显式 cleanup()
      // 否则 heartbeat 定时器泄漏（每 15s 向已关闭流空写）。
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const cleanup = () => {
        off();
        if (heartbeat) clearInterval(heartbeat);
      };

      const off = onTaskUpdate((id, status) => {
        if (id !== taskId) return;
        const cur = getTask(id);
        if (!cur || !cur.ok) return;
        void stream.writeSSE({ event: "status", data: JSON.stringify(cur) }).then(() => {
          if (status === "done" || status === "error" || status === "cancelled") {
            cleanup();
            void stream.close();
          }
        });
      });

      // 注册后立即重查，覆盖「推送初始态 → 注册监听」间隙完成的竞态
      const recheck = getTask(taskId);
      if (recheck && recheck.ok && (recheck.status === "done" || recheck.status === "error" || recheck.status === "cancelled")) {
        await stream.writeSSE({ event: "status", data: JSON.stringify(recheck) });
        cleanup();
        await stream.close();
        return;
      }

      stream.onAbort?.(cleanup);
      heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "" });
      }, 15_000);
    });
  });
}
