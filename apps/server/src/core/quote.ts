// ============================================================
// A/H 股行情获取：输入股票代码 → 腾讯月 K 线 → 计算月线 BOLL
// BOLL(20,2)：MID = MA20(收盘)，UPPER/LOWER = MID ± 2σ（总体标准差）
// 计算使用最近 20 根「完整月」K 线（排除未结束的当月）
// ============================================================

import type { QuoteResult } from "@toolbox/shared";

const QT_URL =
  "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={param},month,,,{count},qfq";

const BOLL_PERIOD = 20;
const BOLL_STD = 2;
const FETCH_COUNT = 60; // 拉取根数（含当前月，计算取最后 20 根完整月）

interface ParsedCode {
  /** 腾讯市场前缀：sh / sz / hk */
  market: "sh" | "sz" | "hk";
  /** 腾讯代码（港股为 5 位含前导零） */
  code: string;
  normCode: string;
}

/** 解析用户输入的代码 → 腾讯 param 结构，无法识别时返回 null */
export function parseSecCode(input: string): ParsedCode | null {
  const s = input.trim().toUpperCase();
  if (!/^[0-9HKSHZ]{2,9}$/.test(s)) return null;

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
    // 6xx/9xx(沪) → sh；0xx/3xx/2xx(深) → sz；4xx/8xx(北交所) → 腾讯不支持，走 sz 试
    return /^[69]/.test(s)
      ? { market: "sh", code: s, normCode: `sh${s}` }
      : { market: "sz", code: s, normCode: `sz${s}` };
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
    // 排除未结束的当月（东财/腾讯月线最后一条为当前月）
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
