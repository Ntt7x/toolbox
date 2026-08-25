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
import { kvGet, kvListRaw, kvSet } from "./kvStore.js";
import { recordExternalRun, registerExternalTask } from "./data-infra/index.js";
import type { AsyncTaskResult, AsyncTaskStatus, TaskHistoryEntry } from "@toolbox/shared";

interface TaskHandle<T = unknown> {
  id: string;
  status: AsyncTaskStatus;
  result?: T;
  message?: string;
  createdAt: number;
  /** 结束时间（终态时设定） */
  finishedAt?: number;
  /** 任务归属模块（如 cb-rate）；提供时结果会归档到历史 KV */
  module?: string;
  /** 用户可读任务名称（归档到历史展示） */
  name?: string;
  /** 取消控制器：cancelTask 或超时触发 abort */
  controller?: AbortController;
  /** 超时定时器 */
  timer?: NodeJS.Timeout;
}

const tasks = new Map<string, TaskHandle>();
const emitter = new EventEmitter();
const TTL_MS = 60 * 60 * 1000; // 1 小时
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 默认 5 分钟防卡死
/** 任务历史 KV 前缀（taskHistory:<module> → { entries: TaskHistoryEntry[] }） */
const HISTORY_PREFIX = "taskHistory:";
/** 每个模块历史保留条数（超出截断最旧） */
const HISTORY_LIMIT = 50;

/** 任务进入终态：记录结束时间并归档到历史 KV（module 提供时）；同步 data-infra 生命周期（登记模式） */
function finalizeTask(handle: TaskHandle): void {
  handle.finishedAt = Date.now();
  if (handle.module) {
    // 数据工程登记模式：同步外部托管任务生命周期到 data-infra（运管可见 + 历史）
    try {
      const st = handle.status === "done" ? "done" : handle.status === "cancelled" ? "paused" : "failed";
      recordExternalRun(handle.module, st as "done" | "failed" | "paused", {
        ok: handle.status === "done",
        message: handle.message ?? (handle.status === "done" ? "ok" : ""),
      });
    } catch {
      // 同步失败静默（不影响主流程）
    }
  }
  if (!handle.module) return;
  try {
    const key = `${HISTORY_PREFIX}${handle.module}`;
    const saved = kvGet<{ entries?: unknown[] }>(key);
    const entries: TaskHistoryEntry[] = Array.isArray(saved?.entries) ? (saved.entries as TaskHistoryEntry[]) : [];
    entries.push({
      taskId: handle.id,
      module: handle.module,
      ...(handle.name ? { name: handle.name } : {}),
      status: handle.status,
      createdAt: new Date(handle.createdAt).toISOString(),
      finishedAt: new Date(handle.finishedAt).toISOString(),
      durationMs: handle.finishedAt - handle.createdAt,
      ...(handle.result !== undefined ? { result: handle.result } : {}),
      ...(handle.message ? { message: handle.message } : {}),
    });
    if (entries.length > HISTORY_LIMIT) entries.splice(0, entries.length - HISTORY_LIMIT);
    kvSet(key, { entries });
  } catch {
    // 归档失败静默（不影响任务主流程）
  }
}

interface CreateTaskOptions<T> {
  /** 超时自动终止（默认 5 分钟；0/负 = 不设超时） */
  timeoutMs?: number;
  /** 错误信息提取（默认用 Error.message；AbortError/迟到结果由终态保护兜底） */
  onError?: (e: unknown) => string;
  /** 任务归属模块（如 cb-rate）；提供时终态结果归档到 KV 历史（供页面回看） */
  module?: string;
  /** 用户可读任务名称（如「2026-08 · 央行利率分析」）；归档到历史展示 */
  name?: string;
}

/** 创建后台任务：立即返回 taskId，fn 异步执行（fn 可接收 AbortSignal 实现可中断） */
export function createTask<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: CreateTaskOptions<T> = {},
): { taskId: string } {
  const id = randomUUID();
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const handle: TaskHandle<T> = { id, status: "pending", createdAt: Date.now(), controller, ...(opts.module ? { module: opts.module } : {}), ...(opts.name ? { name: opts.name } : {}) };
  tasks.set(id, handle);

  // 数据工程登记模式：module 提供时登记外部托管任务（运管可见）+ 标记 running
  if (opts.module) {
    try {
      registerExternalTask({ id: opts.module, name: opts.name ?? `${opts.module} 分析` });
      recordExternalRun(opts.module, "running");
    } catch {
      // 登记失败静默（不影响任务主流程）
    }
  }

  // 超时保护：超时未完成 → 自动终止
  if (timeoutMs > 0) {
    handle.timer = setTimeout(() => {
      const t = tasks.get(id);
      if (!t || t.status === "done" || t.status === "error" || t.status === "cancelled") return;
      t.status = "error";
      t.message = `任务超时（${Math.round(timeoutMs / 1000)}s）已自动终止`;
      finalizeTask(t);
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
      finalizeTask(cur);
      emitter.emit("update", id, cur.status);
    } catch (e) {
      const cur = tasks.get(id);
      if (!cur) return;
      // 终态已由取消/超时设定（cancelled 或 error），保留其 message 不覆盖
      if (cur.status === "cancelled" || cur.status === "error") return;
      cur.status = "error";
      cur.message = opts.onError ? opts.onError(e) : e instanceof Error ? e.message : String(e);
      finalizeTask(cur);
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
  finalizeTask(t);
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
    ...(t.finishedAt ? { finishedAt: new Date(t.finishedAt).toISOString(), durationMs: t.finishedAt - t.createdAt } : {}),
    ...(t.module ? { module: t.module } : {}),
  };
}

/** 任务历史列表（KV 持久化，内存任务过期后仍可查） */
export function listTaskHistory(module: string): TaskHistoryEntry[] {
  if (!module) return [];
  try {
    const saved = kvGet<{ entries?: unknown[] }>(`${HISTORY_PREFIX}${module}`);
    const entries: TaskHistoryEntry[] = Array.isArray(saved?.entries) ? (saved.entries as TaskHistoryEntry[]) : [];
    return entries.slice().reverse(); // 新的在前
  } catch {
    return [];
  }
}

/** 按 taskId 查历史条目（内存任务过期后兜底；直接扫 KV 前缀，不依赖内存） */
export function getTaskHistoryEntry(taskId: string): TaskHistoryEntry | null {
  if (!taskId) return null;
  try {
    const rows = kvListRaw(HISTORY_PREFIX, 5000);
    for (const r of rows) {
      const saved = JSON.parse(r.value) as { entries?: unknown[] };
      if (!Array.isArray(saved.entries)) continue;
      const hit = (saved.entries as TaskHistoryEntry[]).find((e) => e && e.taskId === taskId);
      if (hit) return hit;
    }
  } catch {
    // 忽略
  }
  return null;
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
    if (t.status !== "running" && now - t.createdAt > TTL_MS) tasks.delete(id); // 2026-08：运行中任务不因 TTL 被移出内存（否则终态不归档 + SSE 卡死）
  }
}, 10 * 60 * 1000).unref?.();
