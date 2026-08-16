// ============================================================
// 实验分组 · 小型数据工程核心（2026-08-16）
// 以数据为核心：①窗口数据（行情快照+补全）持久化并懒更新 ②每日结果快照 ③BMPI 今年起回测序列
// 供 bmpi.ts / ec.ts 复用，前端展示数据来源与历史。
// ============================================================
import { kvGet, kvSet, kvListRaw } from "../../core/kvStore.js";
import { fetchDailyCloses, fetchFx, getQuoteSnapshot } from "../../core/quote.js";
import { pctile, bmpiS1, bmpiS2, bmpiS3, bmpiWeights, bmpiComposite } from "./indicators.js";
import type { BmpiSupplement } from "./bmpi.js";

export type ExperimentPage = "bmpi" | "ec";

// ---------- 窗口数据 ----------
export interface DataWindow {
  page: ExperimentPage;
  asOf: string;
  /** bmpi：成分股行情快照 */
  stocks?: Record<string, { price?: number; pb?: number }>;
  /** ec：外汇快照 */
  fx?: { eurjpy?: number; usdjpy?: number; eurusd?: number };
  supplement?: Record<string, unknown>;
  updatedAt: string;
}
export const windowKey = (page: ExperimentPage) => `experiment:window:${page}`;

export function saveWindow(w: DataWindow): void {
  kvSet(windowKey(w.page), w);
}
export function loadWindow(page: ExperimentPage): DataWindow | null {
  const w = kvGet<DataWindow>(windowKey(page));
  return w && typeof w === "object" && w.page === page ? w : null;
}

// ---------- 每日结果 ----------
export interface DailyResult {
  asOf: string;
  indices: Record<string, number | { w1: number; w2: number; w3: number }>;
  bmpi?: number;
  status: string;
  summary: string;
  createdAt: string;
}
export const historyPrefix = (page: ExperimentPage) => `experiment:${page}:history:`;

export function saveDailyResult(page: ExperimentPage, r: DailyResult): void {
  kvSet(`${historyPrefix(page)}${r.asOf}`, r);
}
/** 历史结果（按日期降序） */
export function listHistory(page: ExperimentPage, limit = 60): DailyResult[] {
  const keys = kvListRaw(historyPrefix(page), 200).map((r) => r.key);
  const out: DailyResult[] = [];
  for (const k of keys) {
    const v = kvGet<DailyResult>(k);
    if (v && typeof v === "object" && v.asOf) out.push(v);
  }
  return out.sort((a, b) => (a.asOf < b.asOf ? 1 : -1)).slice(0, limit);
}

// ---------- BMPI 回测（今年起，日序列） ----------
export interface BacktestPoint {
  date: string;
  s1: number | null; s2: number | null; s3: number | null;
  r: number | null; sl: number | null;
  bmpi: number | null;
}
export const BACKTEST_KEY = "experiment:bmpi:backtest";
export interface BacktestResult {
  from: string; to: string;
  series: BacktestPoint[];
  generatedAt: string;
}

const S1_STOCKS = [
  { code: "600502", start: 3.82, end: 8.5 }, { code: "601868", start: 1.84, end: 4.5 },
  { code: "601390", start: 4.63, end: 7.5 }, { code: "601800", start: 6.53, end: 9.8 },
  { code: "600039", start: 5.09, end: 10.5 },
];
const S2_STOCKS = [
  { code: "601006", start: 5.42, end: 6.1 }, { code: "01052", start: 3.11, end: 4.65 },
  { code: "601818", start: 2.74, end: 5.1 }, { code: "600350", start: 8.06, end: 11.5 },
  { code: "01359", start: 0.55, end: 1.25 }, { code: "00152", start: 5.27, end: 8.5 },
];
const S3_STOCKS = [
  { code: "601939", endPb: 0.85 }, { code: "601398", endPb: 0.8 }, { code: "601088", endPb: 2.1 },
  { code: "601857", endPb: 1.35 }, { code: "600048", endPb: 0.7 }, { code: "600019", endPb: 0.85 },
  { code: "002142", endPb: 1.1 }, { code: "001979", endPb: 0.95 }, { code: "601169", endPb: 0.55 },
  { code: "00788", endPb: 1.25 }, { code: "600900", endPb: 3.2 },
];

/** 回测：拉成分股今年日 K → 每日股价/PB 百分位 → S 指数（宏观用最近补全）→ BMPI 日序列 */
export async function runBmpiBacktest(from = "2026-01-01", signal?: AbortSignal): Promise<BacktestResult> {
  const to = todayStr();
  // 1. 拉日 K（22 只成分股；失败个股跳过，容错）
  const daily: Record<string, { date: string; close: number }[]> = {};
  const all = [...S1_STOCKS, ...S2_STOCKS, ...S3_STOCKS];
  await Promise.all(all.map(async (s) => {
    if (signal?.aborted) return;
    const rows = await fetchDailyCloses(s.code, from, to, 300);
    if (rows.length > 0) daily[s.code] = rows;
  }));

  // 2. 构造每日 → 各股票 close 的映射
  const dates = new Set<string>();
  for (const rows of Object.values(daily)) for (const r of rows) dates.add(r.date);
  const sortedDates = [...dates].sort();

  // 3. 补全（当前值用于整个回测期，caveats 标注）
  const supp = (kvGet<BmpiSupplement>("experiment:bmpi:supplement") ?? {}) as BmpiSupplement;

  // 4. 逐日计算
  const series: BacktestPoint[] = sortedDates.map((date) => {
    const s1Pct = S1_STOCKS.map((s) => {
      const rows = daily[s.code] ?? [];
      const hit = rows.find((r) => r.date === date);
      return hit ? pctile(hit.close, s.start, s.end) : null;
    }).filter((v): v is number => v !== null);
    const s2Pct = S2_STOCKS.map((s) => {
      const rows = daily[s.code] ?? [];
      const hit = rows.find((r) => r.date === date);
      return hit ? pctile(hit.close, s.start, s.end) : null;
    }).filter((v): v is number => v !== null);
    // S3 用 PB 百分位——日 K 无历史 PB，改用"年内价格位置"（min-max 百分位）近似重估程度
    const s3Pct = S3_STOCKS.map((s) => {
      const rows = daily[s.code] ?? [];
      if (rows.length === 0) return null;
      const closes = rows.map((r) => r.close);
      const yMin = Math.min(...closes);
      const yMax = Math.max(...closes);
      const hit = rows.find((r) => r.date === date);
      return hit ? pctile(hit.close, yMin, yMax) : null;
    }).filter((v): v is number => v !== null);

    const s1 = bmpiS1(s1Pct, { progressPct: num(supp.progressPct), pmi: num(supp.s1Pmi), infraYoY: num(supp.infraYoY) });
    const s2 = bmpiS2(s2Pct, { spreadBp: num(supp.spreadBp), loanYoY: num(supp.loanYoY), cpi: num(supp.cpi), receivableDays: num(supp.receivableDays) });
    const y10 = num(supp.y10); const y1 = num(supp.y1);
    const spreadBp = y10 !== null && y1 !== null ? (y10 - y1) * 100 : null;
    const s3 = bmpiS3(s3Pct, { housePriceYoY: num(supp.housePriceYoY), soePb: num(supp.soePb), govDebtPct: num(supp.govDebtPct) }, spreadBp);
    const r = y10 !== null ? Math.round(100 - y10 * 25) : null;
    const sl = supp.netInjection !== undefined ? Math.round(slScore(supp.netInjection)) : null;
    let bmpi: number | null = null;
    if (s1 !== null && s2 !== null && s3 !== null) {
      const w = bmpiWeights(s1, s2, s3);
      const sPart = w.w1 * s1 + w.w2 * s2 + w.w3 * s3;
      bmpi = r !== null && sl !== null ? bmpiComposite(s1, s2, s3, r, sl, w) : Math.round((sPart / 0.7) * 100) / 100;
    }
    return { date, s1, s2, s3, r, sl, bmpi };
  });

  const result: BacktestResult = { from, to, series, generatedAt: new Date().toISOString() };
  kvSet(BACKTEST_KEY, result);
  return result;
}

export function loadBacktest(): BacktestResult | null {
  const b = kvGet<BacktestResult>(BACKTEST_KEY);
  return b && typeof b === "object" && Array.isArray(b.series) ? b : null;
}

// ---------- 工具 ----------
function todayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}
const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
function slScore(n: number): number {
  if (n >= 5000) return 100;
  if (n <= -3000) return 10;
  return Math.min(Math.max(50 + (n / 1000) * 10, 10), 100);
}

/** 统一窗口刷新（bmpi/ec 分析时调用）：行情 TTL 检查 + 拉新 + 保存 */
export async function refreshWindow(page: ExperimentPage, signal?: AbortSignal): Promise<DataWindow> {
  const existing = loadWindow(page);
  const supp: Record<string, unknown> = existing?.supplement ?? {};
  if (page === "bmpi") {
    const codes = [...S1_STOCKS, ...S2_STOCKS, ...S3_STOCKS].map((s) => s.code);
    const stocks: Record<string, { price?: number; pb?: number }> = {};
    await Promise.all(codes.map(async (code) => {
      if (signal?.aborted) return;
      try {
        const q = await getQuoteSnapshot(code, {});
        if (q && typeof q.price === "number") stocks[code] = { price: q.price, ...(typeof q.pb === "number" ? { pb: q.pb } : {}) };
      } catch { /* 单只失败跳过 */ }
    }));
    const w: DataWindow = { page, asOf: todayStr(), stocks, supplement: supp, updatedAt: new Date().toISOString() };
    saveWindow(w);
    return w;
  }
  // ec：外汇
  const [eurjpy, usdjpy, eurusd] = await Promise.all([fetchFx("EURJPY"), fetchFx("USDJPY"), fetchFx("EURUSD")]);
  const w: DataWindow = {
    page, asOf: todayStr(),
    fx: { eurjpy: eurjpy?.price, usdjpy: usdjpy?.price, eurusd: eurusd?.price },
    supplement: supp, updatedAt: new Date().toISOString(),
  };
  saveWindow(w);
  return w;
}
