// ============================================================
// K 线数据流管理（core/kline.ts）—— 收益曲线接入历史行情的服务端底座
// 能力：
//   1) getDailyKline(code)               单标的日 K（日期→收盘价），KV 缓存 + 增量拉取
//   2) fetchKlinesForCodes(codes)        批量并发拉取（收益分析接口用，按组内标的）
//   3) getDailyBars(code, {count})       单标的日 K OHLC 序列（自选股行情跟踪：日/周/月周期聚合用）
//   4) priceOnOrBefore(klines, code, date) 按日期取收盘价（无当日回退最近可得）
// 数据源：腾讯 fqkline day 周期（与月 K 同源），qfq 前复权
// 缓存：kline:d:<normCode> → { name, bars:[{date,open,close,high,low}], fetchedAt }；TTL 6 小时
//   （历史日 K 基本稳定，6h 足够；下次拉取增量合并新根）
// 设计取舍：
//   - 服务端拉取 + 缓存 → 前端无需管行情，compute 拿到映射即可重算真实市值
//   - 拉取失败静默（返回空映射）→ 调用方回退成本口径，不阻塞分析
//   - 无行情标的（基金/停牌/代码错误）→ 空映射，同样回退成本口径
// ============================================================
import { kvGet, kvSet } from "./kvStore.js";
import { registerDataSource } from "./dataRegistry.js";

registerDataSource({
  kind: "kv",
  name: "kline:d:",
  page: "行情工具",
  tag: "分析数据",
  description: "日 K 线缓存（腾讯 fqkline，历史收盘价，TTL 6 小时，收益曲线接入用）",
});

const KLINE_PREFIX = "kline:d:";
/** 历史日 K 缓存 TTL：6 小时（历史数据稳定；下次拉取增量合并） */
const KLINE_TTL_MS = 6 * 60 * 60 * 1000;
/** 单次拉取根数：覆盖约半年交易日（收益分析常见跨度） */
const DEFAULT_COUNT = 130;

/** 日 K 一根（qfq 前复权；open/high/low/volume 在旧缓存中可能缺省，消费方须容错） */
export interface KlineBar {
  date: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  /** 成交量（手）；券商式 K 线副图用。旧缓存无此字段 → 缺省 */
  volume?: number;
}
interface KlineCache {
  name?: string;
  bars: KlineBar[];
  fetchedAt: number;
}

/** 代码解析（腾讯 param：sh600519 / sz000001 / hk00700 / bj…）——复用 quote 语义 */
function parseSecCode(input: string): { market: string; code: string; normCode: string } | null {
  const s = input.trim().toUpperCase();
  if (!/^[0-9HKSHZBJ]{2,10}$/.test(s)) return null;
  if (s.startsWith("BJ")) {
    const c = s.slice(2);
    if (!/^\d{6}$/.test(c)) return null;
    return { market: "bj", code: c, normCode: `bj${c}` };
  }
  if (s.startsWith("HK")) {
    const c = s.slice(2).replace(/^0+/, "");
    if (!/^\d{3,5}$/.test(c)) return null;
    const code = c.padStart(5, "0");
    return { market: "hk", code, normCode: `hk${code}` };
  }
  if (s.startsWith("SH")) {
    const c = s.slice(2);
    if (!/^\d{6}$/.test(c)) return null;
    return { market: "sh", code: c, normCode: `sh${c}` };
  }
  if (s.startsWith("SZ")) {
    const c = s.slice(2);
    if (!/^\d{6}$/.test(c)) return null;
    return { market: "sz", code: c, normCode: `sz${c}` };
  }
  if (/^\d{6}$/.test(s)) {
    if (/^(4|8|92)/.test(s)) return { market: "bj", code: s, normCode: `bj${s}` };
    if (/^[569]/.test(s)) return { market: "sh", code: s, normCode: `sh${s}` };
    return { market: "sz", code: s, normCode: `sz${s}` };
  }
  if (/^\d{3,5}$/.test(s)) {
    const code = s.padStart(5, "0");
    return { market: "hk", code, normCode: `hk${code}` };
  }
  return null;
}

/** 从腾讯拉取日 K（qfq 前复权；返回按日期升序的收盘序列） */
async function fetchDailyCloses(p: { market: string; code: string }, count = DEFAULT_COUNT): Promise<{ name: string; bars: KlineBar[] }> {
  const paramKey = `${p.market}${p.code}`;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${paramKey},day,,,${count},qfq`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`K 线接口 HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: Record<string, { qfqday?: string[][]; day?: string[][]; qt?: Record<string, string[]> }>;
  };
  const data = json.data?.[paramKey];
  const klines = data?.qfqday ?? data?.day;
  if (!Array.isArray(klines) || klines.length === 0) throw new Error("无日 K 数据");
  // 行结构：[date, open, close, high, low, volume]
  const bars = klines
    .map((row) => {
      const date = String(row[0]);
      const open = Number(row[1]);
      const close = Number(row[2]);
      const high = Number(row[3]);
      const low = Number(row[4]);
      // row[5] = 成交量（手）；部分行情源缺省 → 容错省略，由消费方判断
      const volume = row[5] === undefined ? Number.NaN : Number(row[5]);
      return {
        date,
        close,
        ...(Number.isFinite(open) ? { open } : {}),
        ...(Number.isFinite(high) ? { high } : {}),
        ...(Number.isFinite(low) ? { low } : {}),
        ...(Number.isFinite(volume) && volume >= 0 ? { volume } : {}),
      };
    })
    .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && Number.isFinite(b.close) && b.close > 0);
  const name = data?.qt?.[paramKey]?.[1] ?? "";
  return { name, bars };
}

/** 合并新拉取的 bars 到缓存（按日期去重，新值覆盖旧值，升序） */
export function mergeBars(cached: KlineBar[] | undefined, fresh: KlineBar[]): KlineBar[] {
  const map = new Map<string, KlineBar>();
  for (const b of cached ?? []) map.set(b.date, b);
  for (const b of fresh) map.set(b.date, b);
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * 加载日 K 序列（缓存优先 + 增量合并）。
 * - 缓存新鲜（6h 内）→ 直接返回
 * - 否则拉取 `count` 根并合并进缓存（历史只增不减）
 * - 拉取失败 → 有旧缓存则降级返回（过期也可用），否则空数组
 */
async function loadBars(
  parsed: { market: string; code: string; normCode: string },
  opts: { count?: number; force?: boolean } = {},
): Promise<KlineBar[]> {
  const key = KLINE_PREFIX + parsed.normCode;
  const cached = kvGet<KlineCache>(key);
  const hasCache = !!cached && Array.isArray(cached.bars) && cached.bars.length > 0;
  const fresh = !!cached && Date.now() - cached.fetchedAt < KLINE_TTL_MS;
  if (hasCache && fresh && !opts.force) return cached!.bars;
  try {
    const { name, bars } = await fetchDailyCloses(parsed, opts.count ?? DEFAULT_COUNT);
    const merged = mergeBars(cached?.bars, bars);
    kvSet(key, { ...(name ? { name } : { ...(cached?.name ? { name: cached.name } : {}) }), bars: merged, fetchedAt: Date.now() });
    return merged;
  } catch {
    // 拉取失败/无数据：有缓存则用缓存（过期也可用），否则空
    return hasCache ? cached!.bars : [];
  }
}

/**
 * 获取单标的历史日 K（日期→收盘价映射）。
 * 拉取失败静默 → 返回空映射（调用方回退成本口径）。
 */
export async function getDailyKline(codeInput: string): Promise<Map<string, number>> {
  const parsed = parseSecCode(codeInput);
  if (!parsed) return new Map();
  const bars = await loadBars(parsed);
  return new Map(bars.map((b) => [b.date, b.close]));
}

/**
 * 获取单标的历史日 K OHLC 序列（升序；自选股行情跟踪的日/周/月周期聚合用）。
 * @param count 拉取根数（默认 130 ≈ 半年；周/月走势建议 500 ≈ 两年）
 */
export async function getDailyBars(codeInput: string, opts: { count?: number; force?: boolean } = {}): Promise<KlineBar[]> {
  const parsed = parseSecCode(codeInput);
  if (!parsed) return [];
  return loadBars(parsed, opts);
}

/**
 * 批量获取多标的历史日 K（并发；单个失败不影响其它）。
 * @returns code → 日期→收盘价映射（无行情标的为空 Map）
 */
export async function fetchKlinesForCodes(codes: string[]): Promise<Map<string, Map<string, number>>> {
  const uniq = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  const results = await Promise.all(uniq.map(async (code) => [code, await getDailyKline(code)] as const));
  return new Map(results);
}

/**
 * 按账本日期取每个标的的当日收盘价（无则回退最近可得的历史价）。
 * @param klines code → 日期→收盘价
 * @param code 标的
 * @param date 账本日期 YYYY-MM-DD
 */
export function priceOnOrBefore(klines: Map<string, Map<string, number>>, code: string, date: string): number | undefined {
  const m = klines.get(code);
  if (!m || m.size === 0) return undefined;
  const direct = m.get(date);
  if (direct !== undefined) return direct;
  // 无当日（停牌/非交易日）→ 找最近的 <= date 的收盘价
  let best: number | undefined;
  let bestDate = "";
  for (const [d, close] of m) {
    if (d <= date && d > bestDate) {
      bestDate = d;
      best = close;
    }
  }
  return best;
}
