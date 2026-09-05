// ============================================================
// K 线数据流管理（core/kline.ts）—— 收益曲线接入历史行情的服务端底座
// 能力：
//   1) getDailyKline(code)               单标的日 K（日期→收盘价），KV 缓存 + 增量拉取
//   2) fetchKlinesForCodes(codes)        批量并发拉取（收益分析接口用，按组内标的）
//   3) getKlineBars(code, {period})      单标的 OHLC 序列（多周期：日/周/月 + 5/15/30/60 分钟）
//   4) getIntraday(code)                 分时（1 分钟价格线 + 均价线 + 昨收基准）
//   5) priceOnOrBefore(klines, code, date) 按日期取收盘价（无当日回退最近可得）
// 数据源（周期不同，源也不同——这点必须显式，否则消费方会误读复权口径）：
//   · 日 / 周 / 月 K → 腾讯 fqkline（web.ifzq.gtimg.cn），**前复权 qfq**
//   · 分钟 K（5/15/30/60）→ 腾讯 mkline（ifzq.gtimg.cn），**不复权**
//     ⚠️ 行情源不提供分钟级复权 → 除权日会看到假跳空，必须由前端标注 caveat
//   · 分时 → 腾讯 minute/query（web.ifzq.gtimg.cn），1 分钟价格 + 累计量额
// 缓存：kline:<period>:<normCode> → { name, bars:[...], fetchedAt }
//   历史 K 线 TTL 6 小时（数据稳定，下次拉取增量合并新根）；分时 TTL 60 秒（盘中变化快）
// 设计取舍：
//   - 服务端拉取 + 缓存 → 前端无需管行情，compute 拿到映射即可重算真实市值
//   - 拉取失败静默（返回空映射）→ 调用方回退成本口径，不阻塞分析
//   - 无行情标的（基金/停牌/代码错误）→ 空映射，同样回退成本口径
// ============================================================
import type { WatchKlinePeriod } from "@toolbox/shared";
import { Effect } from "effect";
import { kvGet, kvSet } from "./kvStore.js";
import { registerDataSource } from "./dataRegistry.js";
import { mapLimit, NET_CONCURRENCY } from "./concurrency.js";
import { requestJson } from "./effect/http.js";
import { ParseError, type FetchError } from "./effect/errors.js";
import { runEffect } from "./effect/runtime.js";

/** K 线/分时取数档位：响应体较大，10s 超时、重试 1 次（失败即降级到缓存/空） */
const KLINE_TIMEOUT_MS = 10000;
const KLINE_RETRIES = 1;
const QT_HEADERS = { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" };

registerDataSource({
  kind: "kv",
  name: "kline:d:",
  page: "行情工具",
  tag: "分析数据",
  description: "日 K 线缓存（腾讯 fqkline，历史收盘价，TTL 6 小时，收益曲线接入用）",
});

/** 缓存 key 前缀：按周期分桶（历史遗留：日 K 沿用 `kline:d:`，避免旧缓存失效） */
const PERIOD_PREFIX: Record<WatchKlinePeriod, string> = {
  min: "kline:min:",
  m5: "kline:m5:",
  m15: "kline:m15:",
  m30: "kline:m30:",
  m60: "kline:m60:",
  day: "kline:d:",
  week: "kline:week:",
  month: "kline:month:",
};
const PERIOD_NOTE: Record<WatchKlinePeriod, string> = {
  min: "分时",
  m5: "5 分钟 K",
  m15: "15 分钟 K",
  m30: "30 分钟 K",
  m60: "60 分钟 K",
  day: "日 K",
  week: "周 K",
  month: "月 K",
};
// 新前缀统一注册为数据源（本地数据管理页可见；日 K 已在上面单独注册，跳过）
for (const [period, prefix] of Object.entries(PERIOD_PREFIX)) {
  if (period === "day") continue;
  registerDataSource({
    kind: "kv",
    name: prefix,
    page: "行情工具",
    tag: "分析数据",
    description: `${PERIOD_NOTE[period as WatchKlinePeriod]}缓存（腾讯行情源，行情图表多周期用）`,
  });
}

/** 历史 K 线缓存 TTL：6 小时（历史数据稳定；下次拉取增量合并） */
const KLINE_TTL_MS = 6 * 60 * 60 * 1000;
/** 分时缓存 TTL：60 秒（盘中数据每分钟都在变，缓存只用于防抖与并发合并） */
const INTRADAY_TTL_MS = 60 * 1000;
/** 单次拉取根数：覆盖约半年交易日（收益分析常见跨度） */
const DEFAULT_COUNT = 130;
/** 分钟 K 周期集合（走 mkline 源，不复权） */
const MINUTE_PERIODS = new Set<WatchKlinePeriod>(["m5", "m15", "m30", "m60"]);
/** 分周期默认拉取根数：分钟 K 盘子大，日/周/月看长周期 */
const PERIOD_COUNT: Record<WatchKlinePeriod, number> = {
  min: 1,
  m5: 320,
  m15: 320,
  m30: 320,
  m60: 320,
  day: DEFAULT_COUNT,
  week: DEFAULT_COUNT,
  month: DEFAULT_COUNT,
};

/** K 线一根（open/high/low/volume 在旧缓存中可能缺省，消费方须容错） */
export interface KlineBar {
  date: string;
  close: number;
  /** 分钟 K 的时刻 HH:mm；日 / 周 / 月 K 无此字段 */
  time?: string;
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

/**
 * 从腾讯拉取 K 线（按周期分流到不同源）。
 * - 日 / 周 / 月 → fqkline（前复权），行结构 `[YYYY-MM-DD, open, close, high, low, volume]`
 * - 5/15/30/60 分 → mkline（**不复权**），行结构 `[YYYYMMDDHHmm, open, close, high, low, volume]`
 * 两种源的行结构一致（时间列格式不同），故归一化逻辑可共用。
 */
function fetchKlineRows(
  p: { market: string; code: string },
  period: Exclude<WatchKlinePeriod, "min">,
  count = DEFAULT_COUNT,
): Effect.Effect<{ name: string; bars: KlineBar[] }, FetchError> {
  const paramKey = `${p.market}${p.code}`;
  const isMinute = MINUTE_PERIODS.has(period);
  const url = isMinute
    ? `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${paramKey},${period},,${count}`
    : `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${paramKey},${period},,,${count},qfq`;
  return Effect.gen(function* () {
    const json = yield* requestJson<{
      code?: number;
      data?: Record<string, Record<string, string[][] | Record<string, string[]> | undefined> | undefined>;
    }>({ url, headers: QT_HEADERS, timeoutMs: KLINE_TIMEOUT_MS, retries: KLINE_RETRIES });
    // mkline 对不支持的标的（如港股）返回 { code: -1 }，data 里没有对应周期数组
    if (json.code !== undefined && json.code !== 0) {
      return yield* Effect.fail(new ParseError({ source: "tencent.kline", reason: `行情源不支持该周期的 K 线（code ${json.code}）` }));
    }
    const data = json.data?.[paramKey];
    // 前复权优先（qfq<period>），缺失回退不复权（<period>）——月 K 偶发无 qfq 列
    const klines = isMinute ? data?.[period] : ((data?.[`qfq${period}`] ?? data?.[period]) as string[][] | undefined);
    if (!Array.isArray(klines) || klines.length === 0) {
      return yield* Effect.fail(new ParseError({ source: "tencent.kline", reason: "无 K 线数据" }));
    }
    const bars: KlineBar[] = [];
    for (const row of klines) {
      const raw = String(row[0] ?? "");
      // 分钟 K：`202609021500`（12 位）→ 拆成 date + HH:mm；日/周/月：`2026-09-02`
      const minute = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw);
      const date = minute ? `${minute[1]}-${minute[2]}-${minute[3]}` : raw;
      const open = Number(row[1]);
      const close = Number(row[2]);
      const high = Number(row[3]);
      const low = Number(row[4]);
      // row[5] = 成交量（手）；部分行情源缺省 → 容错省略，由消费方判断
      const volume = row[5] === undefined ? Number.NaN : Number(row[5]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close) || close <= 0) continue;
      bars.push({
        date,
        close,
        ...(minute ? { time: `${minute[4]}:${minute[5]}` } : {}),
        ...(Number.isFinite(open) ? { open } : {}),
        ...(Number.isFinite(high) ? { high } : {}),
        ...(Number.isFinite(low) ? { low } : {}),
        ...(Number.isFinite(volume) && volume >= 0 ? { volume } : {}),
      });
    }
    if (bars.length === 0) return yield* Effect.fail(new ParseError({ source: "tencent.kline", reason: "无 K 线数据" }));
    const qt = data?.qt as Record<string, string[]> | undefined;
    const name = qt?.[paramKey]?.[1] ?? "";
    return { name, bars };
  });
}

/**
 * 从腾讯拉取分时（1 分钟价格线）。
 * 返回结构：`data.<code>.data.data` 为 `["0930 1302.80 281 36608680.00", ...]`
 *   字段依次为 时刻 HHmm / 价格 / **累计**成交量（手）/ **累计**成交额（元）
 *   均价（券商黄线）= 累计成交额 / (累计成交量 × 100)——逐点推导，不另取接口
 * `data.<code>.data.date` 为交易日 YYYYMMDD；昨收取 `qt.<code>[4]`（腾讯快照固定位）
 */
function fetchIntraday(p: { market: string; code: string }): Effect.Effect<{
  name: string;
  date: string;
  prevClose: number;
  points: { time: string; price: number; avg: number; volume: number }[];
}, FetchError> {
  const paramKey = `${p.market}${p.code}`;
  return Effect.gen(function* () {
    const json = yield* requestJson<{
      data?: Record<string, { data?: { data?: string[]; date?: string }; qt?: Record<string, string[]> }>;
    }>({
      url: `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${paramKey}`,
      headers: QT_HEADERS,
      timeoutMs: KLINE_TIMEOUT_MS,
      retries: KLINE_RETRIES,
    });
    const node = json.data?.[paramKey];
    const rows = node?.data?.data;
    const dateRaw = node?.data?.date ?? "";
    if (!Array.isArray(rows) || rows.length === 0) {
      return yield* Effect.fail(new ParseError({ source: "tencent.intraday", reason: "无分时数据" }));
    }
    const date = /^(\d{4})(\d{2})(\d{2})$/.exec(dateRaw);
    const points: { time: string; price: number; avg: number; volume: number }[] = [];
    let prevCumVol = 0;
    for (const line of rows) {
      const m = /^(\d{2})(\d{2})\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(String(line).trim());
      if (!m) continue;
      const price = Number(m[3]);
      const cumVol = Number(m[4]); // 累计成交量（手）
      const cumAmt = Number(m[5]); // 累计成交额（元）
      if (!Number.isFinite(price) || price <= 0) continue;
      // 分时第一分钟累计量为 0（快照时点未成交）→ 均价回退到价格本身
      const avg = Number.isFinite(cumAmt) && Number.isFinite(cumVol) && cumVol > 0 ? cumAmt / (cumVol * 100) : price;
      points.push({
        time: `${m[1]}:${m[2]}`,
        price,
        avg,
        // 接口给的是累计量 → 差分成每分钟量（与 K 线 volume 口径一致）
        volume: Math.max(0, cumVol - prevCumVol),
      });
      prevCumVol = cumVol;
    }
    if (points.length === 0) return yield* Effect.fail(new ParseError({ source: "tencent.intraday", reason: "无分时数据" }));
    const qt = node?.qt?.[paramKey];
    const prevClose = Number(qt?.[4]);
    const name = qt?.[1] ?? "";
    return {
      name,
      date: date ? `${date[1]}-${date[2]}-${date[3]}` : "",
      prevClose: Number.isFinite(prevClose) && prevClose > 0 ? prevClose : Number.NaN,
      points,
    };
  });
}

/**
 * 一根 K 线的唯一键。
 * ⚠️ 分钟 K 不能只用 `date` 去重——同一天有几十根（5 分钟 K 一天 48 根），
 *    只按日期去重会把一整天塌成一根（实测 m5 只剩 11 根 = 11 个交易日）。
 */
function barKey(b: KlineBar): string {
  return b.time ? `${b.date} ${b.time}` : b.date;
}

/** 合并新拉取的 bars 到缓存（按根去重，新值覆盖旧值，升序） */
export function mergeBars(cached: KlineBar[] | undefined, fresh: KlineBar[]): KlineBar[] {
  const map = new Map<string, KlineBar>();
  for (const b of cached ?? []) map.set(barKey(b), b);
  for (const b of fresh) map.set(barKey(b), b);
  return [...map.values()].sort((a, b) => {
    const ka = barKey(a);
    const kb = barKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * 加载 K 线序列（缓存优先 + 增量合并）。
 * - 缓存新鲜（6h 内）→ 直接返回
 * - 否则拉取 `count` 根并合并进缓存（历史只增不减）
 * - 拉取失败 → 有旧缓存则降级返回（过期也可用），否则空数组
 */
async function loadBars(
  parsed: { market: string; code: string; normCode: string },
  period: Exclude<WatchKlinePeriod, "min">,
  opts: { count?: number; force?: boolean } = {},
): Promise<KlineBar[]> {
  const key = PERIOD_PREFIX[period] + parsed.normCode;
  const cached = kvGet<KlineCache>(key);
  const hasCache = !!cached && Array.isArray(cached.bars) && cached.bars.length > 0;
  const fresh = !!cached && Date.now() - cached.fetchedAt < KLINE_TTL_MS;
  if (hasCache && fresh && !opts.force) return cached!.bars;
  try {
    const { name, bars } = await runEffect(fetchKlineRows(parsed, period, opts.count ?? PERIOD_COUNT[period]));
    const merged = mergeBars(cached?.bars, bars);
    kvSet(key, { ...(name ? { name } : { ...(cached?.name ? { name: cached.name } : {}) }), bars: merged, fetchedAt: Date.now() });
    return merged;
  } catch {
    // 拉取失败/无数据：有缓存则用缓存（过期也可用），否则空
    return hasCache ? cached!.bars : [];
  }
}

/**
 * 该标的**支持的周期**（行情源能力，不靠试探请求推断）。
 * - 场外基金：净值型，行情源无 K 线 → 空数组
 * - 沪深（sh/sz）：分钟 K（mkline）+ 日/周/月 + 分时，全量
 * - 北交所 / 港股：mkline 返回空 → 只有 日/周/月 + 分时
 * ⚠️ 这是**按市场查表**而非试探：试探要为每个周期发一次请求，成本高且不可靠
 *   （北交所 mkline 返回 code=0 但数组为空，与「真的没有数据」无法区分）。
 */
export function supportedPeriods(
  codeInput: string,
  kind?: "stock" | "fund",
): WatchKlinePeriod[] {
  if (kind === "fund") return [];
  const parsed = parseSecCode(codeInput);
  if (!parsed) return [];
  const hasMinuteK = parsed.market === "sh" || parsed.market === "sz";
  return hasMinuteK ? ["min", "m5", "m15", "m30", "m60", "day", "week", "month"] : ["min", "day", "week", "month"];
}

/**
 * 获取单标的历史日 K（日期→收盘价映射）。
 * 拉取失败静默 → 返回空映射（调用方回退成本口径）。
 */
export async function getDailyKline(codeInput: string): Promise<Map<string, number>> {
  const parsed = parseSecCode(codeInput);
  if (!parsed) return new Map();
  const bars = await loadBars(parsed, "day");
  return new Map(bars.map((b) => [b.date, b.close]));
}

/**
 * 获取单标的的 K 线 OHLC 序列（升序，按周期）。
 * @param period 周期（分钟 K 不复权；日/周/月前复权）
 */
export async function getKlineBars(
  codeInput: string,
  opts: { period?: WatchKlinePeriod; count?: number; force?: boolean } = {},
): Promise<KlineBar[]> {
  const period = opts.period && opts.period !== "min" ? opts.period : "day";
  const parsed = parseSecCode(codeInput);
  if (!parsed) return [];
  return loadBars(parsed, period, opts);
}

/**
 * 获取单标的历史日 K OHLC 序列（升序）。
 * @param count 拉取根数（默认 130 ≈ 半年；周/月走势建议 500 ≈ 两年）
 */
export async function getDailyBars(codeInput: string, opts: { count?: number; force?: boolean } = {}): Promise<KlineBar[]> {
  const parsed = parseSecCode(codeInput);
  if (!parsed) return [];
  return loadBars(parsed, "day", opts);
}

/** 分时缓存结构 */
interface IntradayCache {
  name?: string;
  date: string;
  prevClose: number;
  points: { time: string; price: number; avg: number; volume: number }[];
  fetchedAt: number;
}

/**
 * 获取分时数据（当日 1 分钟价格线 + 均价 + 昨收；非交易日返回最近一个交易日）。
 * 缓存 TTL 60s：盘中数据分钟级变化，缓存只用于防抖与并发合并。
 * 拉取失败 → 有旧缓存则降级返回（可标注 degraded），否则 null。
 */
export async function getIntraday(
  codeInput: string,
  opts: { force?: boolean } = {},
): Promise<{ date: string; prevClose: number; points: IntradayCache["points"]; name?: string; fromCache?: boolean } | null> {
  const parsed = parseSecCode(codeInput);
  if (!parsed) return null;
  const key = PERIOD_PREFIX.min + parsed.normCode;
  const cached = kvGet<IntradayCache>(key);
  const fresh = !!cached && Date.now() - cached.fetchedAt < INTRADAY_TTL_MS;
  if (cached && fresh && !opts.force) {
    return { date: cached.date, prevClose: cached.prevClose, points: cached.points, ...(cached.name ? { name: cached.name } : {}), fromCache: true };
  }
  try {
    const { name, date, prevClose, points } = await runEffect(fetchIntraday(parsed));
    kvSet(key, { ...(name ? { name } : {}), date, prevClose, points, fetchedAt: Date.now() });
    return { date, prevClose, points, ...(name ? { name } : {}) };
  } catch {
    return cached
      ? { date: cached.date, prevClose: cached.prevClose, points: cached.points, ...(cached.name ? { name: cached.name } : {}), fromCache: true }
      : null;
  }
}

/**
 * 批量获取多标的历史日 K（并发；单个失败不影响其它）。
 * @returns code → 日期→收盘价映射（无行情标的为空 Map）
 */
export async function fetchKlinesForCodes(codes: string[]): Promise<Map<string, Map<string, number>>> {
  const uniq = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  // 有界并发：无界 Promise.all 在几十只标的时会对行情源瞬时打满并发（限流/失败率上升）
  const results = await mapLimit(uniq, NET_CONCURRENCY, async (code) => [code, await getDailyKline(code)] as const);
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
