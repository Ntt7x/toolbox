// ============================================================
// 自选股·行情跟踪：周期聚合纯函数（日 / 周 / 月）
// 数据管道中的「加工层」：日 K 序列（silver）→ 周期指标（gold，不物化）。
// 纯函数零 I/O（同 core/volatility.ts 模式），副作用留在 klineStore.ts，便于单测。
// ============================================================
import type { WatchPeriod, WatchPeriodStat } from "@toolbox/shared";

/** 日 K 一根（core/quote.fetchDailyOHLC 的产出，升序） */
export interface DailyBar {
  /** 交易日 YYYY-MM-DD */
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
}

/** 周期分桶结果（未做百分比换算的中间结构，便于单测断言） */
export interface PeriodBucket {
  /** 周期内首个交易日 */
  from: string;
  /** 周期内最后交易日 */
  to: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 上一周期收盘（首周期无 → NaN，涨跌幅不可算） */
  prevClose: number;
  /** 周期内交易日数 */
  sessions: number;
}

/** 数值安全取整（避免浮点毛刺：0.1+0.2 类） */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** YYYY-MM-DD → UTC 毫秒（避免本地时区漂移导致跨周/跨月判定错误） */
function parseDate(d: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.trim());
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** UTC 毫秒 → YYYY-MM-DD */
function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 该日期所属自然周的周一（ISO 周：周一为一周之始） */
export function weekStart(d: string): string {
  const ms = parseDate(d);
  if (!Number.isFinite(ms)) return d;
  const dow = new Date(ms).getUTCDay(); // 0=周日
  const back = dow === 0 ? 6 : dow - 1;
  return fmtDate(ms - back * 86_400_000);
}

/** 该日期所属自然月 YYYY-MM */
export function monthKey(d: string): string {
  return d.trim().slice(0, 7);
}

/** 周期分桶 key：day=交易日 / week=周一的日期 / month=YYYY-MM */
export function periodKey(date: string, period: WatchPeriod): string {
  if (period === "week") return weekStart(date);
  if (period === "month") return monthKey(date);
  return date.trim();
}

/**
 * 日 K 序列 → 周期分桶（升序）。
 * 空序列返回空数组；单根 K 线的首周期 prevClose 为 NaN（涨跌幅不可算，调用方须标注 caveat）。
 */
export function bucketize(bars: DailyBar[], period: WatchPeriod): PeriodBucket[] {
  const out: PeriodBucket[] = [];
  let cur: { key: string; bucket: PeriodBucket } | null = null;
  let prevClose = Number.NaN;

  for (const b of bars) {
    if (!b || typeof b.date !== "string" || !Number.isFinite(b.close)) continue;
    const key = periodKey(b.date, period);
    if (!cur || cur.key !== key) {
      // 上一周期收盘 = 进入新周期前最后一根 K 的收盘
      if (cur) prevClose = cur.bucket.close;
      cur = {
        key,
        bucket: {
          from: b.date,
          to: b.date,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          prevClose,
          sessions: 0,
        },
      };
      out.push(cur.bucket);
    }
    const k = cur.bucket;
    k.to = b.date;
    if (Number.isFinite(b.high)) k.high = Math.max(k.high, b.high);
    if (Number.isFinite(b.low)) k.low = Math.min(k.low, b.low);
    k.close = b.close;
    k.sessions += 1;
  }
  return out;
}

/** 涨跌幅 %（相对上一周期收盘）；基准无效返回 undefined（不静默置 0） */
export function pctOf(close: number, prevClose: number): number | undefined {
  if (!Number.isFinite(close) || !Number.isFinite(prevClose) || prevClose === 0) return undefined;
  return round4(((close - prevClose) / prevClose) * 100);
}

/** 振幅 %（周期内 (high-low)/上周期收盘）；基准无效返回 undefined */
export function amplitudeOf(bucket: PeriodBucket): number | undefined {
  if (!Number.isFinite(bucket.prevClose) || bucket.prevClose === 0) return undefined;
  return round4(((bucket.high - bucket.low) / bucket.prevClose) * 100);
}

/** 分桶 → 契约结构（含快照字段由调用方补齐） */
export function bucketToStat(
  bucket: PeriodBucket,
  code: string,
  extra: Pick<WatchPeriodStat, "name" | "kind"> = {},
): WatchPeriodStat {
  const pct = pctOf(bucket.close, bucket.prevClose);
  return {
    code,
    ...(extra.name ? { name: extra.name } : {}),
    ...(extra.kind ? { kind: extra.kind } : {}),
    from: bucket.from,
    to: bucket.to,
    open: round4(bucket.open),
    high: round4(bucket.high),
    low: round4(bucket.low),
    close: round4(bucket.close),
    ...(pct === undefined ? {} : { pct }),
    ...(() => {
      const amp = amplitudeOf(bucket);
      return amp === undefined ? {} : { amplitude: amp };
    })(),
    sessions: bucket.sessions,
    ...(Number.isFinite(bucket.prevClose) ? {} : { caveat: "周期内缺少上一周期收盘价，涨跌幅不可计算" }),
  };
}

/**
 * 最近 `limit` 个周期（降序 → 升序返回，便于画走势）。
 * 无有效 K 线返回空数组。
 */
export function periodSeries(
  bars: DailyBar[],
  period: WatchPeriod,
  limit: number,
  code: string,
  extra: Pick<WatchPeriodStat, "name" | "kind"> = {},
): WatchPeriodStat[] {
  const buckets = bucketize(bars, period);
  if (buckets.length === 0) return [];
  const n = Math.max(1, Math.floor(limit) || 1);
  return buckets.slice(-n).map((b) => bucketToStat(b, code, extra));
}

/** 分组等权平均涨跌幅序列（各周期内有涨跌幅标的的算术平均） */
export interface GroupPeriodPoint {
  from: string;
  to: string;
  /** 等权平均涨跌幅 % */
  pct: number;
  /** 参与平均的标的数量（≥1） */
  count: number;
}

/**
 * 多标的周期序列 → 分组等权平均序列（按周期区间对齐，升序）。
 * 取舍：无法计算涨跌幅的周期（如首周期缺上一周期收盘）直接剔除——走势图是连续折线，
 * 留空档会被误读为「零涨幅」；缺失情况由各标的的 caveat 单独标注。
 */
export function equalWeightSeries(
  perItem: { stats: WatchPeriodStat[] }[],
  limit: number,
): GroupPeriodPoint[] {
  const map = new Map<string, { from: string; to: string; sum: number; count: number }>();
  for (const { stats } of perItem) {
    for (const s of stats) {
      if (typeof s.pct !== "number") continue;
      const key = `${s.from}~${s.to}`;
      const cur = map.get(key) ?? { from: s.from, to: s.to, sum: 0, count: 0 };
      cur.sum += s.pct;
      cur.count += 1;
      map.set(key, cur);
    }
  }
  const out = [...map.values()]
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
    .map((v) => ({ from: v.from, to: v.to, pct: round4(v.sum / v.count), count: v.count }));
  const n = Math.max(1, Math.floor(limit) || 1);
  return out.slice(-n);
}
