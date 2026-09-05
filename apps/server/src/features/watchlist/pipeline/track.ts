// ============================================================
// 自选股·行情跟踪采集（features/watchlist/pipeline/track）
// ------------------------------------------------------------
// 分工（数据工程铁律：纯函数可单测，副作用集中在一处）
//   源   ：sources.ts（快照走 tencent.quote / eastmoney.fund，日 K 走 tencent.kline）
//   采集 ：本文件（快照与日 K **并行**拉取 + 血缘累加）
//   加工 ：periodStats.ts（周期聚合，纯函数）
//   服务 ：index.ts 路由
//
// 相对旧 loadTrack 的两处实质改进：
//   ① **快照与日 K 并行**：旧实现先 await 快照、再 await 日 K —— 两条互不依赖的
//      链路被串成 2 个 RTT。改为 Effect.all 并发后，跟踪首屏理论省一半等待。
//   ② 血缘统一由 Lineage 累加（旧实现手拼 sources/degraded/caveats，口径易漂）。
// ============================================================

import { Effect } from "effect";
import type {
  FundSnapshot,
  QuoteSnapshot,
  WatchDataMeta,
  WatchItem,
  WatchPeriod,
  WatchPeriodStat,
} from "@toolbox/shared";
import { bucketize, equalWeightSeries, periodSeries, type DailyBar } from "../periodStats.js";
import { Lineage, WATCH_SOURCES } from "./lineage.js";
import { dailyBars, fundSnapshots, quoteSnapshots } from "./sources.js";

/** 各周期默认展示的周期数（走势图 + 表格） */
export const PERIOD_LIMIT: Record<WatchPeriod, number> = { day: 20, week: 12, month: 12 };
/** 日 K 拉取根数：覆盖约两年交易日（周/月走势需要） */
const KLINE_COUNT = 500;
/** 提醒判定需要的周期（不随展示周期变化，口径固定） */
const ALERT_PERIODS: WatchPeriod[] = ["day", "week", "month"];

/** 周期口径说明（前端展示，避免用户误解统计口径） */
export const PERIOD_NOTE: Record<WatchPeriod, string> = {
  day: "日度 = 每个交易日一根（前复权日 K）",
  week: "周度 = 自然周（周一至周日）内日 K 聚合",
  month: "月度 = 自然月内日 K 聚合",
};

function isFund(kind?: string): boolean {
  return kind === "fund";
}

/** 快照索引：normCode 与裸码双键（兼容用户手写的 600519 / sh600519 两种写法） */
function indexSnapshots(quotes: readonly (QuoteSnapshot | FundSnapshot)[]): Map<string, QuoteSnapshot | FundSnapshot> {
  const map = new Map<string, QuoteSnapshot | FundSnapshot>();
  for (const q of quotes) {
    if (!q?.code) continue;
    map.set(q.code, q);
    const bare = q.code.replace(/^(sh|sz|hk|bj)/, "");
    if (bare !== q.code) map.set(bare, q);
  }
  return map;
}

/** 去市场前缀（日 K 索引兜底） */
function bareCode(code: string): string {
  return code.trim().toLowerCase().replace(/^(sh|sz|hk|bj)/, "");
}

/** 单个标的的跟踪数据 */
export interface TrackItem {
  code: string;
  name?: string;
  kind?: "stock" | "fund";
  /** 请求周期的序列（升序；无日 K 时为空数组） */
  stats: WatchPeriodStat[];
  /** 日/周/月 当期涨跌幅 %（提醒判定用，口径固定不随展示周期变化） */
  latestPct: Partial<Record<WatchPeriod, number>>;
  /** 当期振幅 %（日度口径） */
  amplitude?: number;
  /** 最新交易日（日 K 最后一根；无日 K 时为空串） */
  lastBarDate: string;
}

export interface TrackBundle {
  /** 每标的的跟踪数据（保持传入顺序；单标的场景只有 1 项） */
  items: TrackItem[];
  /** 等权平均序列（升序；单标的场景与该项序列一致，保留供列表页复用） */
  group: ReturnType<typeof equalWeightSeries>;
  /** 快照索引（code → 快照） */
  quotes: Map<string, QuoteSnapshot | FundSnapshot>;
  meta: WatchDataMeta;
}

/** 快照装配：股票与基金分两路（类型不同，源也不同） */
function loadQuotes(
  stockCodes: string[],
  fundCodes: string[],
  force: boolean,
): Effect.Effect<{ quotes: Map<string, QuoteSnapshot | FundSnapshot>; allCached: boolean; notes: string[] }, never> {
  return Effect.gen(function* () {
    const [stockRes, fundList] = yield* Effect.all(
      [
        stockCodes.length > 0 ? quoteSnapshots(stockCodes, { force }) : Effect.succeed({ snapshots: [] as QuoteSnapshot[], notes: [] as string[] }),
        fundCodes.length > 0 ? fundSnapshots(fundCodes, { force }) : Effect.succeed([] as FundSnapshot[]),
      ],
      // 两条链路互不依赖 → 并行（旧实现是串行 await）
      { concurrency: 2 },
    );
    const all = [...stockRes.snapshots, ...fundList] as (QuoteSnapshot | FundSnapshot)[];
    const notes = [...stockRes.notes];
    for (const q of all) {
      if (!q.ok) notes.push(`${q.code} 行情获取失败：${q.message ?? "多源均不可用"}`);
    }
    // 缓存判定：任一路快照发生真实取数即视为未全命中缓存（保守标注）
    const allCached = all.length > 0 && all.every((q) => (q.source ?? "").endsWith("cache"));
    return { quotes: indexSnapshots(all), allCached, notes };
  });
}

/**
 * 采集 + 加工（Effect 版）：给定标的集合的周期行情。
 * 传入单项即服务「单一标的」的四个功能面；传入多项可用于列表统计（等权平均）。
 * 场外基金为净值型、无日 K → 周期统计缺省并标注 caveat（缺失即标注，不静默留空）。
 */
export function trackEffect(
  items: readonly WatchItem[],
  period: WatchPeriod,
  opts: { force?: boolean } = {},
): Effect.Effect<TrackBundle, never> {
  const force = opts.force === true;
  return Effect.gen(function* () {
    const line = new Lineage();
    const stockItems = items.filter((i) => !isFund(i.kind));
    const fundItems = items.filter((i) => isFund(i.kind));
    const stockCodes = stockItems.map((i) => i.code);
    const fundCodes = fundItems.map((i) => i.code);
    if (stockCodes.length > 0) line.add(WATCH_SOURCES.quote);
    if (fundCodes.length > 0) line.add(WATCH_SOURCES.fund);

    // 快照与日 K 并行（三条链路互不依赖，串行只是白等一个 RTT）
    const [quoteRes, klineMap] = yield* Effect.all(
      [
        loadQuotes(stockCodes, fundCodes, force),
        stockItems.length > 0
          ? dailyBars(stockItems.map((i) => i.code), { count: KLINE_COUNT, force })
          : Effect.succeed(new Map<string, DailyBar[]>()),
      ],
      { concurrency: 2 },
    );
    if (stockItems.length > 0) line.add(WATCH_SOURCES.kline);
    if (!quoteRes.allCached) line.miss();
    for (const n of quoteRes.notes) line.note(n);

    // 日 K 索引：normCode 与裸码双键（与快照索引同口径）
    const barsByCode = new Map<string, DailyBar[]>();
    for (const [code, bars] of klineMap) {
      barsByCode.set(code, bars);
      const bare = bareCode(code);
      if (bare !== code.trim()) barsByCode.set(bare, bars);
    }
    const noKline = stockItems.filter((i) => (barsByCode.get(i.code) ?? []).length === 0);
    if (noKline.length > 0) {
      line.note(`${noKline.length} 个标的无日 K 数据（代码不受支持或数据源暂不可用）`);
    }

    // 加工（纯函数）
    const limit = PERIOD_LIMIT[period];
    const trackItems: TrackItem[] = items.map((it) => {
      const bars = barsByCode.get(it.code) ?? [];
      const extra = { ...(it.name ? { name: it.name } : {}), ...(it.kind ? { kind: it.kind } : {}) };
      const stats = periodSeries(bars, period, limit, it.code, extra);

      // 三个周期的当期涨跌幅（提醒判定需要固定口径，与展示周期解耦）
      const latestPct: Partial<Record<WatchPeriod, number>> = {};
      for (const p of ALERT_PERIODS) {
        if (bucketize(bars, p).length === 0) continue;
        const s = periodSeries(bars, p, 1, it.code, extra)[0];
        if (s && typeof s.pct === "number") latestPct[p] = s.pct;
      }
      const dayStats = periodSeries(bars, "day", 1, it.code, extra)[0];

      // 实时快照补最新价/当日涨跌（快照可能领先于最后一根日 K）
      if (stats.length > 0) {
        const q = quoteRes.quotes.get(it.code);
        const last = stats[stats.length - 1] as WatchPeriodStat;
        if (q?.ok) {
          const price = (q as QuoteSnapshot).price ?? (q as FundSnapshot).nav;
          if (typeof price === "number") last.last = price;
          if (typeof q.pct === "number") last.lastPct = q.pct;
        }
      }

      return {
        code: it.code,
        ...(it.name ? { name: it.name } : {}),
        ...(it.kind ? { kind: it.kind } : {}),
        stats,
        latestPct,
        ...(typeof dayStats?.amplitude === "number" ? { amplitude: dayStats.amplitude } : {}),
        lastBarDate: bars.length > 0 ? (bars[bars.length - 1] as DailyBar).date : "",
      };
    });

    return {
      items: trackItems,
      group: equalWeightSeries(trackItems.map((t) => ({ stats: t.stats })), limit),
      quotes: quoteRes.quotes,
      meta: line.meta(),
    };
  });
}
