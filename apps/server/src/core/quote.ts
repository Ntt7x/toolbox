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

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n !== 0 ? n : undefined;
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
  const amountRaw = num(f[37]);
  const amount = amountRaw !== undefined ? (hk ? amountRaw / 1e8 : amountRaw / 1e4) : undefined; // 港股元→亿；A 股万元→亿
  return {
    name: f[1],
    price,
    prevClose,
    open: num(f[5]),
    change: num(f[31]),
    pct: num(f[32]),
    high: num(f[33]),
    low: num(f[34]),
    volume: num(f[36]),
    amount,
    turnover: hk ? undefined : num(f[38]),
    pe: num(f[39]),
    pb: num(f[hk ? 47 : 46]),
    marketCap: num(f[45]),
    high52: num(f[hk ? 48 : 47]),
    low52: num(f[hk ? 49 : 48]),
    currency: f.find((v) => v === "CNY" || v === "HKD"),
  };
}

/** 解析东财快照 JSON（fields：f58名 f43现价 f46昨收 f44高 f45低 f169涨跌 f170涨跌幅 f168换手 f162PE f167PB f116总市值） */
async function fetchEastmoney(p: ParsedCode): Promise<Partial<QuoteSnapshot>> {
  const secid = p.market === "hk" ? `116.${p.code}` : p.market === "sh" ? `1.${p.code}` : p.market === "bj" ? `0.${p.code}` : `0.${p.code}`;
  const fields = "f57,f58,f43,f44,f45,f46,f60,f116,f162,f167,f168,f169,f170";
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
    volume: num(f[8]),
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
export async function fetchFx(code: "EURJPY" | "USDJPY" | "EURUSD"): Promise<{ price: number; prevClose: number; changePct: number } | null> {
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

/**
 * 批量实时快照（一次拉取多只，个股列表展示用）。
 * 策略：先查缓存（5 分钟内命中直接返回）→ 未命中代码走腾讯批量（一次请求）→
 * 批量失败则逐代码降级（getQuoteSnapshot 单代码 failover）；全部失败返回错误项。
 */
export async function getQuoteSnapshots(codes: string[], opts: { force?: boolean } = {}): Promise<QuoteSnapshot[]> {
  const now = Date.now();
  const out: QuoteSnapshot[] = [];
  const missing: { code: string; parsed: ParsedCode }[] = [];

  for (const c of codes) {
    const parsed = parseSecCode(c);
    if (!parsed) {
      out.push({ ok: false, code: c.trim(), message: "无法识别的代码格式" });
      continue;
    }
    if (!opts.force) {
      const cached = kvGet<QuoteSnapshot>(`${SNAPSHOT_PREFIX}${parsed.normCode}`);
      const at = cached?.ts ? Date.parse(cached.ts) : NaN;
      if (cached && cached.ok && Number.isFinite(at) && now - at < SNAPSHOT_TTL_MS) {
        out.push({ ...cached, source: `${cached.source ?? "cache"}` });
        continue;
      }
    }
    missing.push({ code: parsed.normCode, parsed });
  }

  if (missing.length > 0) {
    // 腾讯批量优先
    let batch: Map<string, Partial<QuoteSnapshot>> | null = null;
    try {
      batch = await fetchTencentBatch(missing.map((m) => m.parsed));
    } catch {
      batch = null; // 批量失败 → 逐代码降级
    }
    for (const { code, parsed } of missing) {
      let snapshot: QuoteSnapshot | null = null;
      const part = batch?.get(code);
      if (part) {
        snapshot = { ok: true, code, ...part, source: "tencent", ts: new Date().toISOString() };
        // 无价（未开盘/停牌/字段缺失，price 为 0 或 undefined）→ 降级单源补价；无名无价同样降级
        if (!snapshot.price || !snapshot.name) snapshot = null;
      }
      if (!snapshot) {
        // 单代码降级（东财→新浪；未命中批量/批量失败/无价的代码都走这里）
        snapshot = await getQuoteSnapshot(code, { force: true });
      }
      if (snapshot) {
        if (snapshot.ok) kvSet(`${SNAPSHOT_PREFIX}${code}`, snapshot);
        out.push(snapshot);
      }
    }
  }
  return out;
}
