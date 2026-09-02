// ============================================================
// 自选股·行情跟踪：采集编排层（数据管道：源 → 采集 → 加工 → 服务）
// ------------------------------------------------------------
// 分工（数据工程铁律：纯函数可单测，副作用集中在一处）
//   源      ：tencent.quote（快照，core/quote）+ tencent.kline（日 K，core/kline）
//   采集    ：本文件（批量快照 + 日 K 并发拉取，带降级标注）
//   加工    ：periodStats.ts（周期聚合，纯函数）
//   服务    ：index.ts 路由
// 血缘/质量：每条结果带 WatchDataMeta（sources / fromCache / degraded / caveats）
// ============================================================
import type {
  FundSnapshot,
  QuoteSnapshot,
  WatchDataMeta,
  WatchPeriod,
  WatchPeriodStat,
} from "@toolbox/shared";
import { getQuoteSnapshots } from "../../core/quote.js";
import { getFundSnapshots } from "../../core/fund.js";
import { getDailyBars } from "../../core/kline.js";
import { bucketize, equalWeightSeries, periodSeries, type DailyBar } from "./periodStats.js";
import type { WatchItem } from "@toolbox/shared";
import type { AlertContext } from "./alerts.js";

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
function indexSnapshots(quotes: (QuoteSnapshot | FundSnapshot)[]): Map<string, QuoteSnapshot | FundSnapshot> {
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

/**
 * 采集 + 加工：给定标的集合的周期行情。
 * 传入单项即服务「单一标的」的四个功能面；传入多项可用于列表统计（等权平均）。
 * 场外基金为净值型、无日 K → 周期统计缺省并标注 caveat（缺失即标注，不静默留空）。
 */
export async function loadTrack(
  items: WatchItem[],
  period: WatchPeriod,
  opts: { force?: boolean } = {},
): Promise<TrackBundle> {
  const sources: string[] = [];
  const caveats: string[] = [];
  let degraded = false;

  // 1) 快照（股票/ETF 与场外基金分两路，各自复用缓存）
  const stockCodes = items.filter((i) => !isFund(i.kind)).map((i) => i.code);
  const fundCodes = items.filter((i) => isFund(i.kind)).map((i) => i.code);
  const [stockQuotes, fundQuotes] = await Promise.all([
    stockCodes.length ? getQuoteSnapshots(stockCodes, { force: opts.force }) : Promise.resolve([] as QuoteSnapshot[]),
    fundCodes.length ? getFundSnapshots(fundCodes, { force: opts.force }) : Promise.resolve([] as FundSnapshot[]),
  ]);
  const quotes = indexSnapshots([...stockQuotes, ...fundQuotes]);
  if (stockCodes.length) sources.push("tencent.quote");
  if (fundCodes.length) sources.push("eastmoney.fund");
  for (const q of [...stockQuotes, ...fundQuotes]) {
    if (!q.ok) {
      degraded = true;
      caveats.push(`${q.code} 行情获取失败：${q.message ?? "多源均不可用"}`);
    }
  }

  // 2) 日 K（并发；场外基金跳过）
  const klineItems = items.filter((i) => !isFund(i.kind));
  const klineResults = await Promise.all(
    klineItems.map(async (i) => [i.code, await getDailyBars(i.code, { count: KLINE_COUNT, force: opts.force })] as const),
  );
  const barsByCode = new Map<string, DailyBar[]>();
  for (const [code, bars] of klineResults) {
    const arr = bars as unknown as DailyBar[];
    barsByCode.set(code, arr);
    const bare = bareCode(code);
    if (bare !== code.trim()) barsByCode.set(bare, arr);
  }
  if (klineItems.length) sources.push("tencent.kline");
  const noKline = klineItems.filter((i) => (barsByCode.get(i.code) ?? []).length === 0);
  if (noKline.length > 0) {
    degraded = true;
    caveats.push(`${noKline.length} 个标的无日 K 数据（代码不受支持或数据源暂不可用）`);
  }

  // 3) 加工（纯函数）
  const limit = PERIOD_LIMIT[period];
  const trackItems: TrackItem[] = items.map((it) => {
    const bars = barsByCode.get(it.code) ?? [];
    const extra = { ...(it.name ? { name: it.name } : {}), ...(it.kind ? { kind: it.kind } : {}) };
    const stats = periodSeries(bars, period, limit, it.code, extra);

    // 三个周期的当期涨跌幅（提醒判定需要固定口径，与展示周期解耦）
    const latestPct: Partial<Record<WatchPeriod, number>> = {};
    for (const p of ALERT_PERIODS) {
      const b = bucketize(bars, p);
      const last = b[b.length - 1];
      if (!last) continue;
      const s = periodSeries(bars, p, 1, it.code, extra)[0];
      if (s && typeof s.pct === "number") latestPct[p] = s.pct;
    }
    const dayStats = periodSeries(bars, "day", 1, it.code, extra)[0];

    // 实时快照补最新价/当日涨跌（快照可能领先于最后一根日 K）
    if (stats.length > 0) {
      const q = quotes.get(it.code);
      const last = stats[stats.length - 1];
      if (q?.ok) {
        if (typeof (q as QuoteSnapshot).price === "number") last.last = (q as QuoteSnapshot).price;
        else if (typeof (q as FundSnapshot).nav === "number") last.last = (q as FundSnapshot).nav;
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
      lastBarDate: bars.length > 0 ? bars[bars.length - 1].date : "",
    };
  });

  // 缓存判定：任一路快照发生真实取数即视为未全命中缓存（保守标注）
  const allCached = [...stockQuotes, ...fundQuotes].every((q) => (q.source ?? "").endsWith("cache"));

  return {
    items: trackItems,
    group: equalWeightSeries(trackItems.map((t) => ({ stats: t.stats })), limit),
    quotes,
    meta: {
      sources: [...new Set(sources)],
      fromCache: allCached,
      degraded,
      fetchedAt: new Date().toISOString(),
      ...(caveats.length ? { caveats } : {}),
    },
  };
}

/**
 * 提醒判定上下文：把周期统计 + 快照组装成 alerts.ts 的输入。
 * 日期取「最新交易日」：日 K 最后一根优先 → 快照时间 → 今天（保证去重键稳定）。
 */
export function toAlertContexts(bundle: TrackBundle): AlertContext[] {
  const today = new Date().toISOString().slice(0, 10);
  return bundle.items.map((it) => {
    const q = bundle.quotes.get(it.code);
    const price = q?.ok ? ((q as QuoteSnapshot).price ?? (q as FundSnapshot).nav) : undefined;
    return {
      code: it.code,
      ...(it.name ? { name: it.name } : {}),
      date: it.lastBarDate || (q?.ts ? q.ts.slice(0, 10) : today),
      ...(typeof price === "number" ? { last: price } : {}),
      ...(typeof q?.pct === "number" ? { dayPct: q.pct } : typeof it.latestPct.day === "number" ? { dayPct: it.latestPct.day } : {}),
      ...(typeof it.latestPct.week === "number" ? { weekPct: it.latestPct.week } : {}),
      ...(typeof it.latestPct.month === "number" ? { monthPct: it.latestPct.month } : {}),
      ...(typeof it.amplitude === "number" ? { amplitude: it.amplitude } : {}),
    };
  });
}
