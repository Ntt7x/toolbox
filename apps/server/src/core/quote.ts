// ============================================================
// A/H 股行情获取（多源）：
// 1) getQuoteSnapshot：实时快照（现价/涨跌/换手/PE/PB/市值/52周区间）
//    —— 腾讯主源（A/H 一体、字段最全），东财/新浪自动降级，KV 缓存 5 分钟
// 2) queryMonthlyBoll：月 K 线 → 月线 BOLL(20,2)（网格计划用，腾讯月 K）
// 选型结论（2026-08 实测）：
//   - 腾讯 qt.gtimg.cn：A/H 同一接口、字段最全（含市值/52周/PE/PB）、GBK 需转码
//   - 东财 push2.eastmoney.com：JSON 干净（PE/PB/换手齐全）、secid 分市场、历史 TLS 不稳
//   - 新浪 hq.sinajs.cn：字段贫乏（仅价量）、需 Referer，仅作兜底
// ============================================================

import type { QuoteResult, QuoteSnapshot } from "@toolbox/shared";
import { kvGet, kvSet } from "./kvStore.js";
import { registerDataSource } from "./dataRegistry.js";
import { mapLimit, NET_CONCURRENCY } from "./concurrency.js";

// 注册数据源：行情快照缓存（本地数据管理可见，避免落入"未标记"）
registerDataSource({
  kind: "kv",
  name: "quote:s:",
  page: "行情工具",
  tag: "分析数据",
  description: "行情快照缓存（腾讯/东财/新浪多源，TTL 5 分钟）",
});

const QT_URL =
  "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={param},month,,,{count},qfq";

const BOLL_PERIOD = 20;
const BOLL_STD = 2;
const FETCH_COUNT = 60; // 拉取根数（含当前月，计算取最后 20 根完整月）

interface ParsedCode {
  /** 腾讯市场前缀：sh / sz / hk / bj（北交所） */
  market: "sh" | "sz" | "hk" | "bj";
  /** 腾讯代码（港股为 5 位含前导零） */
  code: string;
  normCode: string;
}

/** 解析用户输入的代码 → 腾讯 param 结构，无法识别时返回 null */
function parseSecCode(input: string): ParsedCode | null {
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
    // 北交所：43x/83x/87x/92x（先特判，避免 92 落入沪市）
    if (/^(4|8|92)/.test(s)) return { market: "bj", code: s, normCode: `bj${s}` };
    // 沪市：6xx/9xx 股票、5xx ETF（510300/563530…）、900 B 股
    if (/^[569]/.test(s)) return { market: "sh", code: s, normCode: `sh${s}` };
    // 深市：0xx/2xx/3xx 股票、1xx ETF（159915…）
    return { market: "sz", code: s, normCode: `sz${s}` };
  }
  // 3~5 位数字 → 港股
  if (/^\d{3,5}$/.test(s)) {
    const code = s.padStart(5, "0");
    return { market: "hk", code, normCode: `hk${code}` };
  }
  return null;
}

/** 从腾讯拉取月 K 线（返回按时间升序的收盘价序列，含当前未完成月） */
async function fetchMonthlyCloses(p: ParsedCode): Promise<{ name: string; bars: { date: string; close: number }[] }> {
  const paramKey = `${p.market}${p.code}`;
  const url = QT_URL.replace("{param}", paramKey).replace("{count}", String(FETCH_COUNT));
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`行情接口响应异常（HTTP ${res.status}）`);
  const json = (await res.json()) as {
    data?: Record<string, { qfqmonth?: string[][]; month?: string[][]; qt?: Record<string, string[]> }>;
  };
  const data = json.data?.[paramKey];
  const klines = data?.qfqmonth ?? data?.month;
  if (!Array.isArray(klines) || klines.length === 0) {
    throw new Error("未查询到该代码的月 K 数据，请检查代码是否正确");
  }
  const bars = klines
    .map((row) => ({ date: String(row[0]), close: Number(row[2]) }))
    .filter((b) => Number.isFinite(b.close) && b.close > 0);
  // qt 形如 { "sh600519": ["1", "贵州茅台", "600519", ...] }
  const name = data?.qt?.[paramKey]?.[1] ?? "";
  return { name, bars };
}

/** 由收盘价序列计算 BOLL（取最近 period 根，末尾为最新） */
function calcBoll(closes: { date: string; close: number }[]): {
  U: number;
  M: number;
  L: number;
  bars: number;
  lastDate: string;
} | null {
  const n = Math.min(BOLL_PERIOD, closes.length);
  if (n < 2) return null;
  const window = closes.slice(-n);
  const mean = window.reduce((s, b) => s + b.close, 0) / n;
  const variance = window.reduce((s, b) => s + (b.close - mean) ** 2, 0) / n; // 总体标准差
  const std = Math.sqrt(variance);
  const last = window[n - 1];
  return {
    U: mean + BOLL_STD * std,
    M: mean,
    L: mean - BOLL_STD * std,
    bars: n,
    lastDate: last.date,
  };
}

/** 查询股票月线 BOLL（入口） */
export async function queryMonthlyBoll(codeInput: string): Promise<QuoteResult> {
  const parsed = parseSecCode(codeInput);
  if (!parsed) {
    return {
      ok: false,
      message: "无法识别的代码格式。支持：sh600519 / sz000001 / 600519 / hk00700 / 00700",
    };
  }
  try {
    const { name, bars } = await fetchMonthlyCloses(parsed);
    // 排除未结束的当月（腾讯月线最后一条为当前月）
    const complete = bars.length > 1 ? bars.slice(0, -1) : bars;
    const boll = calcBoll(complete);
    if (!boll) {
      return { ok: false, message: "月 K 数据不足（至少需要 2 根完整月 K）" };
    }
    const warning =
      boll.bars < BOLL_PERIOD
        ? `月 K 仅 ${boll.bars} 根（不足 ${BOLL_PERIOD} 根），BOLL 按实际根数计算`
        : undefined;
    return {
      ok: true,
      code: parsed.normCode,
      name,
      U: Math.round(boll.U * 10000) / 10000,
      M: Math.round(boll.M * 10000) / 10000,
      L: Math.round(boll.L * 10000) / 10000,
      bars: boll.bars,
      lastDate: boll.lastDate,
      ...(warning ? { warning } : {}),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: msg };
  }
}

// ============================================================
// 行情快照（多源 failover + 缓存）
// ============================================================

/** 快照缓存 TTL：5 分钟（行情时效短，区别于 2 年的分析缓存） */
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

const SNAPSHOT_PREFIX = "quote:s:";

/**
 * 字段解析：0 视为「缺失」（用于价格/量额等——0 价无意义，代表停牌或无数据）。
 * ⚠️ 不可用于涨跌幅/涨跌额：平盘的 0 是合法值，见 {@link numOrZero}。
 */
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n !== 0 ? n : undefined;
};

/**
 * 字段解析：0 视为「合法值」（用于涨跌幅 / 涨跌额 / 成交量 / 换手）。
 *
 * 历史 bug：涨跌幅原先用 `num()` 解析，而 `num()` 把 0 当「缺失」→
 * 涨跌幅恰好 0（平盘，含停牌，行情源对二者都返回 0）的标的被静默丢弃。
 * 后果：自选股 tag 的等权平均涨跌幅把它们排除在分母外，均值被放大
 * （实测 159 只里 4 只被剔除，6 个 tag 涨幅失真，最大偏差 0.14 个百分点）。
 *
 * 取舍：停牌与平盘在行情源里数据形态相同（现价=昨收、涨跌幅=0），
 * 唯一可区分的是成交量=0，但据此判定会引入跨源不一致与误判风险
 * （盘前集合竞价、港股/基金量字段口径各异）。收益（多标一个「停牌」角标）
 * 不抵复杂度与误判成本 → 统一按 0.00% 正常显示并计入平均。
 */
const numOrZero = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** 解析腾讯快照行（GBK 已转码；~ 分隔）。
 * A/H 前段同构：3=价 4=昨收 5=开 31=涨跌 32=涨跌幅 33=高 34=低 36=量 37=额 39=PE 45=市值
 * 差异：A 股 38=换手 46=PB 47/48=52周高低；港股 46=TENCENT 占位 → PB=47、52周=48/49；
 *       A 股 37=万元，港股 37=元（均转亿元） */
function parseTencent(line: string, market: "sh" | "sz" | "hk" | "bj"): Partial<QuoteSnapshot> {
  const f = line.split("~");
  if (f.length < 50) throw new Error("腾讯快照字段不足");
  const hk = market === "hk";
  const price = num(f[3]);
  const prevClose = num(f[4]);
  // 成交额 0（无成交）同为合法值，与 volume 同口径
  const amountRaw = numOrZero(f[37]);
  const amount = amountRaw !== undefined ? (hk ? amountRaw / 1e8 : amountRaw / 1e4) : undefined; // 港股元→亿；A 股万元→亿
  return {
    name: f[1],
    price,
    prevClose,
    open: num(f[5]),
    // 涨跌额/涨跌幅：0 是合法值（平盘），不可丢弃 → numOrZero
    change: numOrZero(f[31]),
    pct: numOrZero(f[32]),
    high: num(f[33]),
    low: num(f[34]),
    // 成交量/额：0 是合法值（无成交），也是停牌判据 → 不可丢弃
    volume: numOrZero(f[36]),
    amount,
    turnover: hk ? undefined : numOrZero(f[38]),
    pe: num(f[39]),
    pb: num(f[hk ? 47 : 46]),
    marketCap: num(f[45]),
    high52: num(f[hk ? 48 : 47]),
    low52: num(f[hk ? 49 : 48]),
    currency: f.find((v) => v === "CNY" || v === "HKD"),
  };
}

/** 解析东财快照 JSON（fields：f58名 f43现价 f46昨收 f44高 f45低 f47成交量 f169涨跌 f170涨跌幅 f168换手 f162PE f167PB f116总市值） */
async function fetchEastmoney(p: ParsedCode): Promise<Partial<QuoteSnapshot>> {
  const secid = p.market === "hk" ? `116.${p.code}` : p.market === "sh" ? `1.${p.code}` : p.market === "bj" ? `0.${p.code}` : `0.${p.code}`;
  // f47=成交量（手）——停牌判定依赖它（停牌股现价=昨收、涨跌幅=0，只有成交量为 0 能区分「停牌」与「平盘」）
  const fields = "f57,f58,f43,f44,f45,f46,f47,f60,f116,f162,f167,f168,f169,f170";
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}&invt=2`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`东财响应异常（HTTP ${res.status}）`);
  const json = (await res.json()) as { data?: Record<string, number | string> };
  const d = json.data;
  if (!d) throw new Error("东财未返回数据");
  const scale = (v: unknown, k: number): number | undefined => (typeof v === "number" ? v / k : undefined);
  return {
    name: typeof d.f58 === "string" ? d.f58 : undefined,
    price: scale(d.f43, 100),
    prevClose: scale(d.f46, 100),
    high: scale(d.f44, 100),
    low: scale(d.f45, 100),
    change: scale(d.f169, 100),
    pct: scale(d.f170, 100),
    turnover: scale(d.f168, 100),
    pe: scale(d.f162, 100),
    pb: scale(d.f167, 100),
    marketCap: scale(d.f116, 1e8), // 元 → 亿元
  };
}

/** 解析新浪快照（价量为主，仅兜底）：name,昨收,今开,现价,最高,最低,... */
async function fetchSina(p: ParsedCode): Promise<Partial<QuoteSnapshot>> {
  const url = `https://hq.sinajs.cn/list=${p.market === "hk" ? `hk${p.code}` : `${p.market}${p.code}`}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://finance.sina.com.cn" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`新浪响应异常（HTTP ${res.status}）`);
  const text = await res.text();
  const m = text.match(/="([^"]*)"/);
  if (!m || !m[1]) throw new Error("新浪未返回数据");
  const f = m[1].split(",");
  if (f.length < 10) throw new Error("新浪字段不足");
  const price = num(f[3]);
  const prevClose = num(f[2]);
  return {
    name: f[0],
    prevClose,
    open: num(f[1]),
    price,
    high: num(f[4]),
    low: num(f[5]),
    change: price !== undefined && prevClose !== undefined ? Math.round((price - prevClose) * 1000) / 1000 : undefined,
    pct: price !== undefined && prevClose !== undefined && prevClose !== 0 ? Math.round(((price - prevClose) / prevClose) * 10000) / 100 : undefined,
    // 成交量 0 = 无成交（停牌判据），不可丢弃——与腾讯源同口径
    volume: numOrZero(f[8]),
  };
}

/** GBK 转码（腾讯/新浪返回 GBK；Node 内置 ICU） */
function decodeGbk(buf: ArrayBuffer): string {
  return new TextDecoder("gbk").decode(buf);
}

/** 腾讯快照主源 */
async function fetchTencent(p: ParsedCode): Promise<Partial<QuoteSnapshot>> {
  const url = `https://qt.gtimg.cn/q=${p.market}${p.code}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`腾讯响应异常（HTTP ${res.status}）`);
  const text = decodeGbk(await res.arrayBuffer());
  const m = text.match(/="([^"]*)"/);
  if (!m || !m[1]) throw new Error("腾讯未返回数据");
  return parseTencent(m[1], p.market);
}

/**
 * 外汇快照（腾讯 wh 接口）：EURJPY / USDJPY / EURUSD。
 * 字段：3=最新价 6=昨收 13=涨跌%。
 */
/** 日 K 收盘序列（腾讯 qfqday；from/to 格式 YYYY-MM-DD）。返回 [{date, close}] 升序；失败返回空数组。 */
export async function fetchDailyCloses(codeInput: string, from: string, to: string, max = 500): Promise<{ date: string; close: number }[]> {
  const rows = await fetchDailyRows(codeInput, from, to, max);
  return rows.map((r) => ({ date: r.date, close: r.close }));
}

/**
 * 日 K OHLC 序列（腾讯 qfqday，数据工程波动率流水线数据源）。
 * 每行 [date, open, close, high, low, volume]；升序返回；失败返回空数组。
 */
export async function fetchDailyOHLC(
  codeInput: string, from: string, to: string, max = 500,
): Promise<{ date: string; open: number; close: number; high: number; low: number }[]> {
  const rows = await fetchDailyRows(codeInput, from, to, max);
  return rows.map((r) => ({ date: r.date, open: r.open, close: r.close, high: r.high, low: r.low }));
}

/** 腾讯日K原始行（内部共用；qfqday 优先，退 day） */
async function fetchDailyRows(
  codeInput: string, from: string, to: string, max = 500,
): Promise<{ date: string; open: number; close: number; high: number; low: number }[]> {
  try {
    const parsed = parseSecCode(codeInput);
    if (!parsed) return [];
    const r = await fetch(
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${parsed.market}${parsed.code},day,${from},${to},${max},qfq`,
      { headers: { Referer: "https://gu.qq.com/" }, signal: AbortSignal.timeout(12000) },
    );
    const j = (await r.json()) as Record<string, any>;
    const data = j?.data?.[`${parsed.market}${parsed.code}`];
    const kline = data?.qfqday ?? data?.day ?? [];
    if (!Array.isArray(kline)) return [];
    const out: { date: string; open: number; close: number; high: number; low: number }[] = [];
    for (const row of kline) {
      const d = String(row?.[0] ?? "");
      const open = Number(row?.[1]);
      const close = Number(row?.[2]);
      const high = Number(row?.[3]);
      const low = Number(row?.[4]);
      if (d && isFinite(close)) out.push({ date: d, open, close, high, low });
    }
    return out;
  } catch {
    return [];
  }
}

export async function fetchFx(code: "EURJPY" | "USDJPY" | "EURUSD" | "HKDCNY" | "USDCNY"): Promise<{ price: number; prevClose: number; changePct: number } | null> {
  try {
    const r = await fetch(`https://qt.gtimg.cn/q=wh${code}`, { headers: { Referer: "https://gu.qq.com/" }, signal: AbortSignal.timeout(8000) });
    const t = await r.text();
    const m = t.match(/="([^"]+)"/);
    if (!m || !m[1]) return null;
    const f = m[1].split("~");
    const price = Number(f[3]);
    const prevClose = Number(f[6]);
    if (!isFinite(price)) return null;
    return { price, prevClose, changePct: prevClose > 0 ? Math.round(((price - prevClose) / prevClose) * 10000) / 100 : 0 };
  } catch {
    return null;
  }
}

/**
 * 获取实时行情快照（多源 failover：腾讯 → 东财 → 新浪）。
 * KV 缓存 5 分钟（force 可绕过）。
 */
export async function getQuoteSnapshot(codeInput: string, opts: { force?: boolean } = {}): Promise<QuoteSnapshot> {
  const parsed = parseSecCode(codeInput);
  if (!parsed) {
    return { ok: false, code: codeInput.trim(), message: "无法识别的代码格式。支持：sh600519 / sz000001 / 600519 / hk00700 / 00700" };
  }
  const cacheKey = `${SNAPSHOT_PREFIX}${parsed.normCode}`;
  if (!opts.force) {
    const cached = kvGet<QuoteSnapshot>(cacheKey);
    const at = cached?.ts ? Date.parse(cached.ts) : NaN;
    if (cached && cached.ok && Number.isFinite(at) && Date.now() - at < SNAPSHOT_TTL_MS) {
      return { ...cached, source: `${cached.source ?? "cache"}` };
    }
  }

  const attempts: { name: string; fn: () => Promise<Partial<QuoteSnapshot>> }[] = [
    { name: "tencent", fn: () => fetchTencent(parsed) },
    { name: "eastmoney", fn: () => fetchEastmoney(parsed) },
    { name: "sina", fn: () => fetchSina(parsed) },
  ];
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      const part = await a.fn();
      const snapshot: QuoteSnapshot = {
        ok: true,
        code: parsed.normCode,
        ...part,
        source: a.name,
        ts: new Date().toISOString(),
      };
      if (!snapshot.price && !snapshot.name) throw new Error(`${a.name} 返回空数据`);
      kvSet(cacheKey, snapshot);
      return snapshot;
    } catch (e) {
      errors.push(`${a.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: false, code: parsed.normCode, message: `行情源均不可用（${errors.join("；")}）` };
}

/** 腾讯批量快照（一次请求多个代码，返回 map：normCode → 快照）。
 * 逐行容错：单只解析失败（字段不足/异常代码）只跳过该只，不拖垮整批（其余代码仍走批量结果）。 */
async function fetchTencentBatch(parsedList: ParsedCode[]): Promise<Map<string, Partial<QuoteSnapshot>>> {
  const url = `https://qt.gtimg.cn/q=${parsedList.map((p) => `${p.market}${p.code}`).join(",")}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`腾讯批量响应异常（HTTP ${res.status}）`);
  const text = decodeGbk(await res.arrayBuffer());
  const out = new Map<string, Partial<QuoteSnapshot>>();
  for (const line of text.split(";")) {
    const m = line.match(/v_(sh|sz|hk|bj)(\d+)="([^"]*)"/);
    if (!m || !m[3]) continue;
    const market = m[1] as "sh" | "sz" | "hk" | "bj";
    const normCode = `${m[1]}${m[2]}`;
    try {
      out.set(normCode, parseTencent(m[3], market));
    } catch {
      // 单只解析失败（如退市/新上市字段不足）→ 跳过，调用方对该代码走单源降级
    }
  }
  if (out.size === 0) throw new Error("腾讯批量未返回数据");
  return out;
}

/** 腾讯批量单次请求的代码数上限（URL 长度与对端稳定性折中） */
const BATCH_SIZE = 60;
/** 批量请求的并发度（多批之间；单批内部是一次 HTTP） */
const BATCH_CONCURRENCY = 4;

/** 分批并发调用腾讯批量（单批失败静默 → 该批代码后续走单源降级，不拖垮整批） */
async function fetchTencentBatched(parsedList: ParsedCode[]): Promise<Map<string, Partial<QuoteSnapshot>>> {
  const chunks: ParsedCode[][] = [];
  for (let i = 0; i < parsedList.length; i += BATCH_SIZE) chunks.push(parsedList.slice(i, i + BATCH_SIZE));
  const maps = await mapLimit(chunks, BATCH_CONCURRENCY, (c) =>
    fetchTencentBatch(c).catch(() => new Map<string, Partial<QuoteSnapshot>>()),
  );
  const out = new Map<string, Partial<QuoteSnapshot>>();
  for (const m of maps) for (const [k, v] of m) out.set(k, v);
  return out;
}

/**
 * 批量实时快照（一次拉取多只，个股列表/组合估值展示用）。
 * 策略：先查缓存（5 分钟内命中直接返回）→ 未命中代码走腾讯批量（每批一次请求）→
 * 批量未覆盖（无价/无名/批量失败）的走单代码 failover（东财→新浪）。
 *
 * 性能要点（2026-09-03 仓位页首屏 15s→亚秒级修复）：
 *   - **保序返回**：out 与 codes 下标严格一一对应，调用方可按下标配对（原实现先推缓存命中、
 *     后推未命中，顺序与入参不一致）；
 *   - **批量结果落缓存**：原实现只缓存单源降级结果，批量命中的不写缓存 → 每次冷启都要重跑批量；
 *   - **降级走有界并发**：原实现串行 await，N 只未命中 = N 次串联 RTT（冷缓存长尾主因）。
 */
export async function getQuoteSnapshots(codes: string[], opts: { force?: boolean } = {}): Promise<QuoteSnapshot[]> {
  const now = Date.now();
  // 占位数组 → 保序；未填位置用错误项兜底（不丢项）
  const slots: (QuoteSnapshot | null)[] = codes.map(() => null);
  const missing: { index: number; code: string; parsed: ParsedCode }[] = [];

  codes.forEach((c, index) => {
    const parsed = parseSecCode(c);
    if (!parsed) {
      slots[index] = { ok: false, code: c.trim(), message: "无法识别的代码格式" };
      return;
    }
    if (!opts.force) {
      const cached = kvGet<QuoteSnapshot>(`${SNAPSHOT_PREFIX}${parsed.normCode}`);
      const at = cached?.ts ? Date.parse(cached.ts) : NaN;
      if (cached && cached.ok && Number.isFinite(at) && now - at < SNAPSHOT_TTL_MS) {
        slots[index] = { ...cached, source: `${cached.source ?? "cache"}` };
        return;
      }
    }
    missing.push({ index, code: parsed.normCode, parsed });
  });

  if (missing.length > 0) {
    const batch = await fetchTencentBatched(missing.map((m) => m.parsed));
    const needFallback: { index: number; code: string }[] = [];
    for (const m of missing) {
      const part = batch.get(m.code);
      // 无价（未开盘/停牌/字段缺失）或无名 → 降级单源补价
      if (part && part.price && part.name) {
        const snapshot: QuoteSnapshot = { ok: true, code: m.code, ...part, source: "tencent", ts: new Date().toISOString() };
        kvSet(`${SNAPSHOT_PREFIX}${m.code}`, snapshot);
        slots[m.index] = snapshot;
      } else {
        needFallback.push({ index: m.index, code: m.code });
      }
    }
    if (needFallback.length > 0) {
      const resolved = await mapLimit(needFallback, NET_CONCURRENCY, (m) => getQuoteSnapshot(m.code, { force: true }));
      resolved.forEach((snapshot, k) => {
        slots[needFallback[k]!.index] = snapshot;
      });
    }
  }

  return slots.map((s, i) => s ?? { ok: false, code: String(codes[i] ?? "").trim(), message: "行情不可得" });
}
// ============================================================
// 行情数据源注册（血缘/目录：统一数据工程层）
// tencent.quote：A/H 股快照（腾讯主源 → 东财 → 新浪 failover）
// tencent.fx：外汇快照（腾讯 wh 接口）
// ============================================================
import { registerDataSource as registerDs } from "./datasource.js";

registerDs({
  id: "tencent.quote",
  kind: "api",
  name: "腾讯行情（A/H 股快照）",
  ttlMs: 5 * 60_000,
  fetch: async (params: Record<string, unknown>) => {
    const code = String(params.code ?? "");
    const q = await getQuoteSnapshot(code, {});
    return q;
  },
});

registerDs({
  id: "tencent.fx",
  kind: "api",
  name: "腾讯外汇（wh 接口）",
  ttlMs: 60_000,
  fetch: async (params: Record<string, unknown>) => {
    const code = String(params.code ?? "EURJPY") as "EURJPY" | "USDJPY" | "EURUSD";
    return fetchFx(code);
  },
});
