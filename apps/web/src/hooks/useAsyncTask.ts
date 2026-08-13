// ============================================================
// 公共 hook：异步任务（服务端后台执行 + 消息推拉）
// - 优先 SSE 实时推送（EventSource 自动重连）
// - 失败/不支持时自动降级轮询（业务方注入 fetcher）
// - 状态双持久化：
//     taskId  → sessionStorage（进行中任务：切页/刷新后恢复继续等待）
//     结果    → sessionStorage(:result)（已完成成果：切页后回来直接展示，不丢失）
// - 初始即终态（如缓存命中返回 cache- 假 taskId + 完整 result）直接落地，不连 SSE
// 用法：
//   const task = useAsyncTask<CbRateResponse>("cbRateTaskId", api.cbRateTaskStatus, api.cancelTask);
//   task.watch(t.taskId, t);   // t 为提交任务的初始响应；若已是终态则直接展示
//   task.result / task.running / task.error
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { API_PREFIX, type AsyncTaskResult, type AsyncTaskStatus } from "@toolbox/shared";

interface UseAsyncTask<T> {
  taskId: string | null;
  status: AsyncTaskStatus | null;
  result: T | null;
  error: string | null;
  running: boolean;
  /** 开始监听一个任务；initial 为提交时的初始响应（已是终态则直接落地，如缓存命中） */
  watch: (taskId: string, initial?: AsyncTaskResult<T>) => void;
  /** 重置（清除本地状态与存储，包括已存结果） */
  reset: () => void;
  /** 强行中断：通知服务端取消并本地停止监听 */
  cancel: () => Promise<void>;
}

function isFinal(s: AsyncTaskStatus | undefined): boolean {
  return s === "done" || s === "error" || s === "cancelled";
}

export function useAsyncTask<T>(
  storageKey: string,
  fetcher: (taskId: string) => Promise<AsyncTaskResult<T>>,
  cancelFetcher?: (taskId: string) => Promise<unknown>,
): UseAsyncTask<T> {
  const RESULT_KEY = `${storageKey}:result`;
  const [taskId, setTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState<AsyncTaskStatus | null>(null);
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<number | null>(null);
  /** 是否已落地终态（防止 error/onerror 双路径重复处理） */
  const settledRef = useRef(false);
  const taskIdRef = useRef<string | null>(null);

  useEffect(() => {
    taskIdRef.current = taskId;
  }, [taskId]);

  const stop = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  /** 结果持久化到 sessionStorage（已完成成果跨页保留） */
  const persistResult = useCallback(
    (r: T) => {
      try {
        sessionStorage.setItem(RESULT_KEY, JSON.stringify(r));
      } catch {
        // 存储不可用时静默降级（结果仅存内存）
      }
    },
    [RESULT_KEY],
  );

  const clearAll = useCallback(() => {
    sessionStorage.removeItem(storageKey);
    sessionStorage.removeItem(RESULT_KEY);
  }, [storageKey, RESULT_KEY]);

  /** 任务到达终态：落地结果并清理（结果持久化，供切页后恢复） */
  const settle = useCallback(
    (tid: string, t: AsyncTaskResult<T>) => {
      settledRef.current = true;
      if (!t.ok) {
        setError(t.message);
      } else if (t.status === "done" && t.result !== undefined) {
        setResult(t.result);
        persistResult(t.result);
      } else if (t.status === "error") {
        setError(t.message ?? "任务失败");
      } else if (t.status === "cancelled") {
        // 用户主动取消：不显示错误，仅停止并清理
        setError(null);
      }
      setStatus(t.ok ? t.status : "error");
      setRunning(false);
      setTaskId(null);
      taskIdRef.current = null;
      sessionStorage.removeItem(storageKey); // 任务 id 清除，但 :result 保留
      stop();
    },
    [storageKey, persistResult, stop],
  );

  /** 处理单次状态响应 */
  const handle = useCallback(
    (tid: string, t: AsyncTaskResult<T>) => {
      // 任务身份校验（2026-08 修复）：旧任务的迟到响应/轮询结果不得覆盖新任务状态
      if (tid !== taskIdRef.current) return;
      if (settledRef.current) return; // 已落地终态，忽略迟到帧
      if (!t.ok) {
        settle(tid, t);
        return;
      }
      setStatus(t.status);
      if (isFinal(t.status)) {
        settle(tid, t);
      } else {
        setRunning(true);
      }
    },
    [settle],
  );

  /** 轮询兜底（SSE 不可用时） */
  const startPoll = useCallback(
    (tid: string) => {
      const pollOnce = () => {
        void fetcher(tid)
          .then((t) => handle(tid, t))
          .catch((e) => {
            if (settledRef.current || tid !== taskIdRef.current) return; // 2026-08：跨任务竞态防护
            setError(String(e));
            setRunning(false);
            setTaskId(null);
            sessionStorage.removeItem(storageKey);
            stop();
          });
      };
      pollOnce();
      pollRef.current = window.setInterval(pollOnce, 3000);
    },
    [fetcher, handle, stop, storageKey],
  );

  /** SSE 监听（EventSource 自动重连；传输错误 → 降级轮询；服务端 error 帧 → 直接落地） */
  const startSse = useCallback(
    (tid: string) => {
      stop();
      settledRef.current = false;
      let connectFails = 0;
      const es = new EventSource(`${API_PREFIX}/tasks/${encodeURIComponent(tid)}/stream`);
      esRef.current = es;
      es.addEventListener("status", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as AsyncTaskResult<T>;
          handle(tid, data);
        } catch {
          // 忽略无法解析的帧
        }
      });
      es.addEventListener("error", (ev) => {
        const raw = (ev as MessageEvent).data;
        // 传输层错误（data 为空）→ 交给 onerror 走降级轮询，不得当作"任务不存在"清状态
        if (typeof raw !== "string" || raw.trim() === "") return;
        if (settledRef.current) return;
        let message = "任务不存在或已过期";
        try {
          const data = JSON.parse(raw) as { ok: false; message?: string };
          if (data.message) message = data.message;
        } catch {
          // 保持默认
        }
        settledRef.current = true;
        setError(message);
        setRunning(false);
        setTaskId(null);
        sessionStorage.removeItem(storageKey);
        stop();
      });
      es.onerror = () => {
        if (settledRef.current) return; // 已落地（含服务端 error 帧），不再降级
        if (es.readyState === EventSource.CLOSED) {
          // CLOSED：连接彻底结束 → 降级轮询
          es.close();
          esRef.current = null;
          startPoll(tid);
          return;
        }
        // CONNECTING：浏览器自动重连中；连续 3 次连接失败 → 降级轮询（防永久卡死）
        connectFails += 1;
        if (connectFails >= 3) {
          es.close();
          esRef.current = null;
          startPoll(tid);
        }
      };
    },
    [handle, startPoll, stop, storageKey],
  );

  const watch = useCallback(
    (tid: string, initial?: AsyncTaskResult<T>) => {
      // 初始响应已是终态（如缓存命中：cache- 假 taskId + 完整 result）：直接落地，不连 SSE
      if (initial && initial.ok && isFinal(initial.status)) {
        settledRef.current = true;
        setTaskId(null);
        setRunning(false);
        if (initial.status === "done" && initial.result !== undefined) {
          setResult(initial.result);
          persistResult(initial.result);
          setError(null);
          setStatus("done");
        } else if (initial.status === "error") {
          setError(initial.message ?? "任务失败");
          setStatus("error");
        } else {
          setError(null);
          setStatus("cancelled");
        }
        sessionStorage.removeItem(storageKey);
        stop();
        return;
      }
      // 正常后台任务：清旧结果、记录 taskId、SSE 监听
      taskIdRef.current = tid; // 同步 ref（useEffect 有渲染延迟，身份校验依赖它）
      setResult(null);
      setError(null);
      setTaskId(tid);
      setRunning(true);
      setStatus(initial && initial.ok ? initial.status : "pending");
      sessionStorage.removeItem(RESULT_KEY);
      sessionStorage.setItem(storageKey, tid);
      startSse(tid);
    },
    [storageKey, RESULT_KEY, persistResult, startSse, stop],
  );

  const reset = useCallback(() => {
    stop();
    settledRef.current = true;
    setTaskId(null);
    taskIdRef.current = null;
    setStatus(null);
    setResult(null);
    setError(null);
    setRunning(false);
    clearAll();
  }, [clearAll, stop]);

  /** 强行中断：通知服务端取消（abort LLM 资源）并本地停止监听 */
  const cancel = useCallback(async () => {
    const tid = taskIdRef.current ?? taskId;
    if (tid && cancelFetcher) {
      try {
        await cancelFetcher(tid);
      } catch {
        // 服务端可能已结束；本地仍执行清理
      }
    }
    stop();
    settledRef.current = true;
    setTaskId(null);
    taskIdRef.current = null;
    setStatus("cancelled");
    setRunning(false);
    setError(null);
    clearAll();
  }, [taskId, taskIdRef, cancelFetcher, clearAll, stop]);

  // 挂载时恢复：进行中任务继续等待；已完成结果直接展示（切页/刷新不丢成果）
  useEffect(() => {
    const tid = sessionStorage.getItem(storageKey);
    if (tid) {
      // 必须同步 taskId，否则恢复后的任务无法被 cancel()（取 taskIdRef 为 null）通知服务端
      taskIdRef.current = tid;
      setTaskId(tid);
      setStatus("running");
      setRunning(true);
      startSse(tid);
      return stop;
    }
    const saved = sessionStorage.getItem(RESULT_KEY);
    if (saved) {
      try {
        const r = JSON.parse(saved) as T;
        settledRef.current = true;
        setResult(r);
        setStatus("done");
        setRunning(false);
      } catch {
        // 存储损坏：忽略
      }
    }
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { taskId, status, result, error, running, watch, reset, cancel };
}
