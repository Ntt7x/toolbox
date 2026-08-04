// ============================================================
// 下层公共模块：通用异步任务管理器
// 任意业务可 createTask(fn, {timeoutMs}) 提交后台任务，立即拿到 taskId；
// 通过 getTask 轮询、onTaskUpdate 事件订阅（供 SSE 推送）获取状态。
// 支持：
//   - 任务取消 cancelTask(taskId)：abort 传给 fn 的 AbortSignal，状态置 cancelled
//   - 超时保护 timeoutMs：超时自动终止，状态置 error（防永久卡死）
// 任务存内存，TTL 后自动清理（个人工具规模足够）。
// ============================================================

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AsyncTaskResult, AsyncTaskStatus } from "@toolbox/shared";

interface TaskHandle<T = unknown> {
  id: string;
  status: AsyncTaskStatus;
  result?: T;
  message?: string;
  createdAt: number;
  /** 取消控制器：cancelTask 或超时触发 abort */
  controller?: AbortController;
  /** 超时定时器 */
  timer?: NodeJS.Timeout;
}

const tasks = new Map<string, TaskHandle>();
const emitter = new EventEmitter();
const TTL_MS = 60 * 60 * 1000; // 1 小时
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 默认 5 分钟防卡死

interface CreateTaskOptions<T> {
  /** 超时自动终止（默认 5 分钟；0/负 = 不设超时） */
  timeoutMs?: number;
  /** 错误信息提取（默认用 Error.message；AbortError/迟到结果由终态保护兜底） */
  onError?: (e: unknown) => string;
}

/** 创建后台任务：立即返回 taskId，fn 异步执行（fn 可接收 AbortSignal 实现可中断） */
export function createTask<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: CreateTaskOptions<T> = {},
): { taskId: string } {
  const id = randomUUID();
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const handle: TaskHandle<T> = { id, status: "pending", createdAt: Date.now(), controller };
  tasks.set(id, handle);

  // 超时保护：超时未完成 → 自动终止
  if (timeoutMs > 0) {
    handle.timer = setTimeout(() => {
      const t = tasks.get(id);
      if (!t || t.status === "done" || t.status === "error" || t.status === "cancelled") return;
      t.status = "error";
      t.message = `任务超时（${Math.round(timeoutMs / 1000)}s）已自动终止`;
      controller.abort();
      emitter.emit("update", id, "error");
    }, timeoutMs);
  }

  void (async () => {
    const t = tasks.get(id);
    if (!t) return;
    t.status = "running";
    emitter.emit("update", id, "running");
    try {
      const result = await fn(controller.signal);
      const cur = tasks.get(id);
      if (!cur) return;
      // 超时/取消已设定终态（error/cancelled）：丢弃迟到的结果，不覆盖终态语义
      if (cur.status !== "done" && cur.status !== "running") return;
      cur.status = "done";
      cur.result = result;
      emitter.emit("update", id, cur.status);
    } catch (e) {
      const cur = tasks.get(id);
      if (!cur) return;
      // 终态已由取消/超时设定（cancelled 或 error），保留其 message 不覆盖
      if (cur.status === "cancelled" || cur.status === "error") return;
      cur.status = "error";
      cur.message = opts.onError ? opts.onError(e) : e instanceof Error ? e.message : String(e);
      emitter.emit("update", id, cur.status);
    } finally {
      if (handle.timer) clearTimeout(handle.timer);
    }
  })();

  return { taskId: id };
}

/** 取消任务：abort 底层信号（LLM 等资源随之释放），状态置 cancelled */
export function cancelTask(taskId: string): boolean {
  const t = tasks.get(taskId);
  if (!t) return false;
  if (t.status === "done" || t.status === "error" || t.status === "cancelled") return false;
  t.status = "cancelled";
  t.message = "任务已取消";
  t.controller?.abort();
  if (t.timer) clearTimeout(t.timer);
  emitter.emit("update", taskId, "cancelled");
  return true;
}

/** 查询任务状态（不存在返回 null） */
export function getTask<T = unknown>(taskId: string): AsyncTaskResult<T> | null {
  const t = tasks.get(taskId);
  if (!t) return null;
  return {
    ok: true,
    taskId: t.id,
    status: t.status,
    ...(t.result !== undefined ? { result: t.result as T } : {}),
    ...(t.message ? { message: t.message } : {}),
    createdAt: new Date(t.createdAt).toISOString(),
  };
}

/** 订阅任务状态更新（返回取消订阅函数）。回调 (taskId, status) */
export function onTaskUpdate(
  cb: (taskId: string, status: AsyncTaskStatus) => void,
): () => void {
  emitter.on("update", cb);
  return () => {
    emitter.off("update", cb);
  };
}

// 定期清理过期任务
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (now - t.createdAt > TTL_MS) tasks.delete(id);
  }
}, 10 * 60 * 1000).unref?.();
