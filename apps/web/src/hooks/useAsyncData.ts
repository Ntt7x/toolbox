// ============================================================
// 公共 hook：面板数据加载（RxJS switchMap 语义）
// -----------------------------------------------------------
// 解决的问题——**面板加载竞态**：
//   旧写法是 `useEffect(() => { void load(); }, [code])`，`load()` 内部 await 后
//   直接 setState。**没有判断这次响应是不是最新的**：
//     快速从 A 切到 B 时，A 的请求可能后于 B 返回 → A 的数据覆盖 B 的，
//     页面显示的代码与内容对不上（这类 bug 只在网络抖动时才复现，极难排查）。
//
// 改法：把「依赖变化 → 取数 → 落地」建模成一条流，
//   `switchMap` 保证只有**最后一次**触发的结果会被应用（旧的自动作废）。
//
// 用法：
//   const { data, loading, error, reload } = useAsyncData(
//     () => api.watchlistAlerts(code),
//     [code],
//   );
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { Subject, catchError, from, map, of, switchMap, tap } from "rxjs";

export interface AsyncDataState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

type Inner<T> = { kind: "ok"; data: T } | { kind: "err"; error: string };

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 依赖驱动的异步数据加载（后发先至安全）。
 * @param fetcher 取数函数（被 ref 持有，无需 useCallback 包裹）
 * @param deps    依赖数组（变化即重新取数，并作废旧请求的结果）
 */
export function useAsyncData<T>(fetcher: () => Promise<T>, deps: readonly unknown[]): AsyncDataState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncDataState<T>>({ data: null, loading: true, error: null });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const trigger$ = useRef(new Subject<"init" | "reload">()).current;
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const sub = trigger$
      .pipe(
        tap(() => {
          if (alive.current) setState((s) => ({ data: s.data, loading: true, error: null }));
        }),
        // 关键：新触发会取消上一次未完成的取数（switchMap）
        switchMap(() =>
          from(fetcherRef.current()).pipe(
            map((data) => ({ kind: "ok" as const, data })),
            catchError((e) => of({ kind: "err" as const, error: msgOf(e) })),
          ),
        ),
      )
      .subscribe((r) => {
        if (!alive.current) return;
        setState(r.kind === "ok" ? { data: r.data, loading: false, error: null } : { data: null, loading: false, error: r.error });
      });
    trigger$.next("init");
    return () => {
      alive.current = false;
      sub.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const reload = useCallback(() => {
    trigger$.next("reload");
  }, [trigger$]);

  return { ...state, reload };
}

/**
 * 命令式场景的竞态守卫（不适合套 useAsyncData 的手动流程用）。
 * 用法：
 *   const g = useRaceGuard();
 *   const token = g.begin();
 *   const r = await api.xxx();
 *   if (!g.isLatest(token)) return;   // 已被后续请求作废
 *   setData(r);
 */
export function useRaceGuard(): { begin: () => number; isLatest: (token: number) => boolean } {
  const seq = useRef(0);
  const begin = useCallback(() => {
    seq.current += 1;
    return seq.current;
  }, []);
  const isLatest = useCallback((token: number) => token === seq.current, []);
  return { begin, isLatest };
}
