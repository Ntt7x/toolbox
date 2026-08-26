// ============================================================
// 公共 hook：data-infra 统一任务（统一模式——分析任务全走 data-infra runTask）
// - 创建任务（业务注入 create）→ 返回 taskId
// - SSE 实时状态/进度（/api/data-infra/tasks/:id/stream，status 事件）
// - 降级轮询（/api/data-infra/tasks/:id 任务详情）
// - done → 业务注入 fetchResult 取结果
// - cancelled/failed/notfound → 终态
// - 跨页恢复：taskId 存 sessionStorage（切页/刷新后继续等待）
// 用法：
//   const t = useDataInfraTask<CbRateResponse>({
//     storageKey: "cbRateTaskId",
//     create: () => api.cbRate(req).then((r) => ({ taskId: r.taskId })),
//     fetchResult: (taskId) => api.cbRateTask(taskId),
//     cancel: (taskId) => api.cancelDataInfraTask(taskId),
//   });
//   t.run();                       // 开始
//   t.resumeIfPending();           // 挂载时恢复（sessionStorage 有 taskId 且未终态）
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";

export type DataInfraTaskStatus = "idle" | "running" | "done" | "failed" | "cancelled" | "notfound";

export interface DataInfraTaskState<T> {
  status: DataInfraTaskStatus;
  taskId: string | null;
  progress: string;
  detail?: unknown;
  result: T | null;
  error: string | null;
}

export interface UseDataInfraTaskOptions<T> {
  /** sessionStorage key（跨页恢复；同页并发任务用不同 key） */
  storageKey: string;
  /** 创建任务：返回 taskId（业务接口）；也可直接返回 result（如缓存命中——直接落地终态） */
  create: () => Promise<{ taskId?: string; result?: T }>;
  /** 结果获取：done 后调（业务接口） */
  fetchResult: (taskId: string) => Promise<T>;
  /** 取消（业务接口；缺省 = 调 data-infra cancel 端点） */
  cancel?: (taskId: string) => Promise<unknown>;
}

const isFinal = (s: DataInfraTaskStatus) => s === "done" || s === "failed" || s === "cancelled" || s === "notfound";

export function useDataInfraTask<T>(opts: UseDataInfraTaskOptions<T>) {
  const [state, setState] = useState<DataInfraTaskState<T>>({
    status: "idle", taskId: null, progress: "", result: null, error: null,
  });
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<number | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const taskIdRef = useRef<string | null>(null);

  const patch = useCallback((p: Partial<DataInfraTaskState<T>>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  const stop = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    if (pollRef.current !== null) { window.clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  /** done → 取结果；终态清理存储 */
  const settle = useCallback((taskId: string, status: "done" | "failed" | "cancelled" | "notfound", lastResult?: string) => {
    stop();
    try { sessionStorage.removeItem(optsRef.current.storageKey); } catch { /* ignore */ }
    if (status === "done") {
      optsRef.current.fetchResult(taskId)
        .then((r) => { patch({ status: "done", result: r, error: null }); })
        .catch((e) => { patch({ status: "failed", error: e instanceof Error ? e.message : String(e) }); });
    } else {
      patch({ status, error: lastResult ?? (status === "failed" ? "任务失败" : status === "cancelled" ? "已取消" : "任务不存在") });
    }
  }, [patch, stop]);

  /** SSE 订阅（优先）；onerror 一次即降级轮询（不依赖 EventSource 自动重连——历史教训） */
  const watchSse = useCallback((taskId: string) => {
    const es = new EventSource(`/api/data-infra/tasks/${taskId}/stream`);
    esRef.current = es;
    let degraded = false;
    es.addEventListener("status", (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { status: string; progress?: string; detail?: unknown; lastResult?: string };
        if (d.status === "done" || d.status === "failed" || d.status === "cancelled" || d.status === "notfound") {
          settle(taskId, d.status, d.lastResult);
        } else {
          patch({ status: d.status as DataInfraTaskStatus, progress: d.progress ?? "" });
        }
      } catch { /* ignore malformed */ }
    });
    es.onerror = () => {
      // 连接错误：关闭并降级轮询（任务不存在时服务端发 notfound status 后关闭——也会走这里）
      es.close();
      esRef.current = null;
      if (!degraded) {
        degraded = true;
        watchPoll(taskId);
      }
    };
  }, [patch, settle]);

  /** 轮询任务详情（降级路径） */
  const watchPoll = useCallback((taskId: string) => {
    const tick = async () => {
      try {
        const r = await fetch(`/api/data-infra/tasks/${taskId}`).then((x) => x.json()).catch(() => null);
        if (!r?.ok) { settle(taskId, "notfound", r?.message ?? "任务不存在"); return; }
        const t = r.task;
        const status = t.status as string;
        if (status === "done" || status === "failed" || status === "cancelled") { settle(taskId, status, t.lastResult ?? undefined); return; }
        if (status === "notfound") { settle(taskId, "notfound"); return; }
        patch({ status: status as DataInfraTaskStatus, progress: r.progress?.progress ?? "" });
      } catch { /* 网络错：下一 tick 继续 */ }
    };
    void tick();
    pollRef.current = window.setInterval(tick, 3000);
  }, [patch, settle]);

  /** 开始执行：创建任务 + 监听 */
  const run = useCallback(async () => {
    stop();
    try { sessionStorage.removeItem(optsRef.current.storageKey); } catch { /* ignore */ }
    patch({ status: "running", taskId: null, progress: "任务创建中…", result: null, error: null });
    try {
      const { taskId, result } = await optsRef.current.create();
      if (result !== undefined) {
        // 缓存命中/即时结果：直接落地终态
        try { sessionStorage.removeItem(optsRef.current.storageKey); } catch { /* ignore */ }
        patch({ status: "done", result, error: null, progress: "" });
        return;
      }
      if (!taskId) { patch({ status: "failed", error: "任务未创建" }); return; }
      taskIdRef.current = taskId;
      try { sessionStorage.setItem(optsRef.current.storageKey, taskId); } catch { /* ignore */ }
      patch({ taskId, progress: "已提交，等待执行…" });
      watchSse(taskId);
    } catch (e) {
      patch({ status: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }, [patch, stop, watchSse]);

  /** 挂载时恢复：sessionStorage 有 taskId 且未终态 → 继续监听 */
  const resumeIfPending = useCallback(() => {
    if (state.status !== "idle") return;
    let stored: string | null = null;
    try { stored = sessionStorage.getItem(optsRef.current.storageKey); } catch { /* ignore */ }
    if (!stored) return;
    taskIdRef.current = stored;
    patch({ status: "running", taskId: stored, progress: "恢复任务…" });
    watchSse(stored);
  }, [patch, state.status, watchSse]);

  /** 取消：通知服务端 + 本地停止 */
  const cancel = useCallback(async () => {
    const id = taskIdRef.current ?? state.taskId;
    if (id) {
      try {
        if (optsRef.current.cancel) await optsRef.current.cancel(id);
        else await fetch(`/api/data-infra/tasks/${id}/cancel`, { method: "POST" }).catch(() => null);
      } catch { /* ignore */ }
    }
    settle(id ?? "", "cancelled");
  }, [settle, state.taskId]);

  /** 重置（idle） */
  const reset = useCallback(() => {
    stop();
    try { sessionStorage.removeItem(optsRef.current.storageKey); } catch { /* ignore */ }
    taskIdRef.current = null;
    patch({ status: "idle", taskId: null, progress: "", result: null, error: null });
  }, [patch, stop]);

  useEffect(() => () => { stop(); }, [stop]);
  // 终态清理（防 dangling）
  useEffect(() => {
    if (isFinal(state.status)) {
      taskIdRef.current = null;
      try { sessionStorage.removeItem(optsRef.current.storageKey); } catch { /* ignore */ }
    }
  }, [state.status]);

  return { state, run, cancel, reset, resumeIfPending };
}
