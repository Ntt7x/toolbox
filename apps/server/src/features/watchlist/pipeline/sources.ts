// ============================================================
// 自选股·数据源（features/watchlist/pipeline/sources）
// ------------------------------------------------------------
// 把「怎么取到数据」从业务编排里彻底剥离，本文件只做三件事：
//   ① 把 core/ 的取数能力包成 Effect（统一的超时/重试/并发/错误类型）
//   ② 声明源标识（WATCH_SOURCES，见 lineage.ts），供血缘累加器登记
//   ③ 定义失败语义：**批量场景逐项容错**——单只取不到只标注、不拖垮整批
//
// 依赖方向：features → core（合规）。本文件不得被 core 反向依赖。
// core 内部已做超时/重试/缓存降级，这里的 Effect 包装只负责「并发编排 + 失败可见」。
// ============================================================

import { Effect } from "effect";
import type { FundSnapshot, QuoteSnapshot, WatchKlinePeriod, WatchNewsItem } from "@toolbox/shared";
import { getDailyBars, getIntraday, getKlineBars } from "../../../core/kline.js";
import type { DailyBar } from "../periodStats.js";
import { getFundSnapshots } from "../../../core/fund.js";
import { snapshotsEffect } from "../../../core/quote.js";
import { NET_CONCURRENCY } from "../../../core/concurrency.js";
import { allOrdered } from "../../../core/effect/concurrency.js";
import { describeError } from "../../../core/effect/errors.js";
import { loadNews } from "../news.js";

/** 日 K 默认根数（跟踪视图只需判断有无 K 与最新收盘日，8 根 ≈ 一周多，够用且快） */
export const DEFAULT_DAILY_COUNT = 8;

/**
 * Promise → Effect 提升（带兜底值）。
 * core 的取数函数已把异常收敛为「空/降级值」，这里的兜底只防**漏出的缺陷**，
 * 保证整条链路不会因为一个未捕获异常而全崩。
 */
function lift<A>(run: () => Promise<A>, fallback: A): Effect.Effect<A, never> {
  return Effect.tryPromise({ try: run, catch: () => null }).pipe(
    Effect.catchAll(() => Effect.succeed(fallback)),
    Effect.map((v): A => (v === null ? fallback : v)),
  );
}

/**
 * 股票 / ETF 快照批量（结果**与入参下标严格一一对应**）。
 * 单只失败降级为 `ok:false` 快照（不抛）；批量请求整批失败 → 记入 notes。
 */
export function quoteSnapshots(
  codes: string[],
  opts: { force?: boolean } = {},
): Effect.Effect<{ snapshots: QuoteSnapshot[]; notes: string[] }, never> {
  return snapshotsEffect(codes, opts);
}

/** 场外基金净值快照批量（天天基金 → 新浪兜底；逐只降级为 ok:false） */
export function fundSnapshots(codes: string[], opts: { force?: boolean } = {}): Effect.Effect<FundSnapshot[], never> {
  return lift(() => getFundSnapshots(codes, opts), [] as FundSnapshot[]);
}

/**
 * 日 K 批量：有界并发；单只失败 → 空数组（由调用方决定标注文案）。
 *
 * 类型说明：core 的 KlineBar 的 OHLC 是可选的（旧缓存可能没有），
 * 而加工层 periodStats.DailyBar 要求齐备——这里按加工层契约收口（与重构前同语义）：
 * 缺 OHLC 的 K 线不会中断聚合（bucketize 内部对 high/low 有 isFinite 保护）。
 */
export function dailyBars(
  codes: string[],
  opts: { count?: number; force?: boolean } = {},
): Effect.Effect<Map<string, DailyBar[]>, never> {
  const count = opts.count ?? DEFAULT_DAILY_COUNT;
  return Effect.map(
    allOrdered(codes, NET_CONCURRENCY, (code) =>
      lift(
        async () => [code, (await getDailyBars(code, { count, ...(opts.force ? { force: true } : {}) })) as unknown as DailyBar[]] as const,
        [code, []] as const,
      ),
    ),
    (pairs) => new Map(pairs),
  );
}

/** 单标的 K 线（day/week/month/min…） */
export function klineBars(
  code: string,
  opts: { period?: WatchKlinePeriod; count?: number; force?: boolean } = {},
): Effect.Effect<DailyBar[], never> {
  return lift(async () => (await getKlineBars(code, opts)) as unknown as DailyBar[], [] as DailyBar[]);
}

/** 分时（当日 1 分钟价格线 + 均价 + 昨收）；无数据返回 null */
export function intraday(
  code: string,
  opts: { force?: boolean } = {},
): Effect.Effect<{ date: string; prevClose: number; points: { time: string; price: number; avg: number; volume: number }[]; name?: string; fromCache?: boolean } | null, never> {
  return lift(() => getIntraday(code, opts), null);
}

/** 新闻取数结果：值 + 失败原因（旁路取数，失败不阻塞主链路） */
export interface NewsOutcome {
  readonly items: WatchNewsItem[];
  readonly error: string | null;
}

/** 新闻（旁路）：失败不抛，返回空列表 + 原因，由调用方决定是否标 caveat */
export function newsOf(code: string, name: string): Effect.Effect<NewsOutcome, never> {
  return Effect.tryPromise({
    try: async (): Promise<NewsOutcome> => ({ items: (await loadNews(code, name)).items, error: null }),
    catch: (e): NewsOutcome => ({ items: [], error: describeError(e) }),
  }).pipe(Effect.catchAll((outcome) => Effect.succeed<NewsOutcome>(outcome)));
}
