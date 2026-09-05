// ============================================================
// Effect 并发编排（core/effect/concurrency）
// ------------------------------------------------------------
// 替掉手写的 worker+游标版 mapLimit 与各处裸 Promise.all：
//   · allOrdered  —— 有界并发 + **保序** + **结构化并发**
//                    （任一失败 → 自动中断兄弟任务，不留悬空请求；
//                      裸 Promise.all 会让其余请求跑完再丢弃结果，白打对端）
//   · allSettled  —— 逐项容错（批量场景：单只失败不该拖垮整批），
//                    失败的项转成 note 交给调用方写进 caveats（降级可见，不静默）
// 并发度：统一取 NET_CONCURRENCY（core/concurrency.ts），不各处写魔数。
// ============================================================

import { Effect, Either } from "effect";

/**
 * 有界并发映射，结果数组与入参**严格同序**（批量接口按下标配对的前提，见 dev.md §6.9）。
 * 失败即整体失败（调用方用 Effect.catchAll / catchTags 决定降级）。
 */
export function allOrdered<T, A, E>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Effect.Effect<A, E>,
): Effect.Effect<A[], E> {
  if (items.length === 0) return Effect.succeed([]);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  return Effect.all(
    items.map((item, index) => fn(item, index)),
    { concurrency: width },
  );
}

/** 逐项容错的结果：成功值 + 失败项（已转成调用方的 note） */
export interface SettledResult<T, A, N> {
  readonly ok: readonly A[];
  readonly failed: readonly { item: T; note: N }[];
}

/**
 * 有界并发 + 逐项容错：单项失败不中断其它项，失败转成 note 返回。
 * 用于「部分失败可接受」的批量取数（如列表页批量行情：个别标的取不到，其余照常展示）。
 */
export function allSettled<T, A, E, N>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Effect.Effect<A, E>,
  onError: (item: T, error: E) => N,
): Effect.Effect<SettledResult<T, A, N>, never> {
  if (items.length === 0) return Effect.succeed({ ok: [], failed: [] });
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  return Effect.map(
    Effect.all(items.map((item, index) => Effect.either(fn(item, index))), { concurrency: width }),
    (results) => {
      const ok: A[] = [];
      const failed: { item: T; note: N }[] = [];
      results.forEach((r, i) => {
        if (Either.isRight(r)) ok.push(r.right);
        else failed.push({ item: items[i] as T, note: onError(items[i] as T, r.left) });
      });
      return { ok, failed };
    },
  );
}
