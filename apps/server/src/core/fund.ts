// ============================================================
// 场外基金（开放式基金）净值查询：天天基金移动 API
// fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation
// - 单位净值 DWJZ、净值日期 FSRQ、日涨跌 RZDF（%）、累计净值 LJJZ、
//   区间收益、基金经理/公司、风险等级、申赎状态
// - KV 缓存（净值 T+1、估算盘中更新；缓存 10 分钟）
// ============================================================

import type { FundSnapshot } from "@toolbox/shared";
import { kvGet, kvSet } from "./kvStore.js";
import { registerDataSource } from "./dataRegistry.js";

/** 基金快照缓存 TTL：10 分钟 */
const FUND_TTL_MS = 10 * 60 * 1000;

const FUND_CACHE_PREFIX = "fund:s:";

/** 基金代码校验（6 位数字） */
export function isFundCode(code: string): boolean {
  return /^\d{6}$/.test(code.trim());
}

/** 从天天基金移动 API 拉取基金基本信息 */
async function fetchFundInfo(code: string): Promise<Partial<FundSnapshot>> {
  const url = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation?FCODE=${code}&deviceid=Wap&plat=Wap&product=EFund&version=6.2.8`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`天天基金响应异常（HTTP ${res.status}）`);
  const json = (await res.json().catch(() => null)) as {
    Datas?: Record<string, unknown>;
    Success?: boolean;
    ErrMsg?: string | null;
  } | null;
  if (!json?.Success || !json.Datas) throw new Error(json?.ErrMsg ?? "天天基金未返回数据");
  const d = json.Datas;
  /** 净值/累计净值：0 无意义 → 视为缺失 */
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n !== 0 ? n : undefined;
  };
  /** 日涨跌：0 是合法值（净值持平），不可丢——否则该基金会从等权平均里被静默剔除 */
  const numOrZero = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() && v !== "--" ? v.trim() : undefined);
  return {
    name: str(d.SHORTNAME),
    nav: num(d.DWJZ),
    navDate: str(d.FSRQ),
    pct: numOrZero(d.RZDF),
    totalNav: num(d.LJJZ),
    m1: num(d.SYL_Y), // 近 1 月
    y1: num(d.SYL_1N), // 近 1 年
    riskLevel: str(d.RISKLEVEL),
    manager: str(d.JJJL),
    company: str(d.JJGS),
    buyStatus: str(d.SGZT),
    redeemStatus: str(d.SHZT),
  };
}

/** GBK 转码（新浪返回 GBK；Node 内置 ICU） */
function decodeGbk(buf: ArrayBuffer): string {
  return new TextDecoder("gbk").decode(buf);
}

/** 新浪基金兜底（净值基础字段）：of{code} → 名称,单位净值,累计净值,昨净值,日增长率%,日期 */
async function fetchSinaFund(code: string): Promise<Partial<FundSnapshot>> {
  const url = `https://hq.sinajs.cn/list=of${code}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://finance.sina.com.cn" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`新浪基金响应异常（HTTP ${res.status}）`);
  const text = decodeGbk(await res.arrayBuffer());
  const m = text.match(/="([^"]*)"/);
  if (!m || !m[1]) throw new Error("新浪基金未返回数据");
  const f = m[1].split(",");
  if (f.length < 6) throw new Error("新浪基金字段不足");
  /** 净值类：0 无意义 → 视为缺失 */
  const num = (v: string): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n !== 0 ? n : undefined;
  };
  /** 日增长率：0 是合法值（净值持平） */
  const numOrZero = (v: string): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    name: f[0] || undefined,
    nav: num(f[1]),
    totalNav: num(f[2]),
    pct: numOrZero(f[4]),
    navDate: f[5] || undefined,
  };
}

/** 场外基金净值快照（多源：天天基金 → 新浪兜底；缓存 10 分钟；force 可绕过） */
export async function getFundSnapshot(codeInput: string, opts: { force?: boolean } = {}): Promise<FundSnapshot> {
  const code = codeInput.trim();
  if (!isFundCode(code)) {
    return { ok: false, code, message: "场外基金代码必须为 6 位数字" };
  }
  const cacheKey = `${FUND_CACHE_PREFIX}${code}`;
  if (!opts.force) {
    const cached = kvGet<FundSnapshot>(cacheKey);
    const at = cached?.ts ? Date.parse(cached.ts) : NaN;
    if (cached && cached.ok && Number.isFinite(at) && Date.now() - at < FUND_TTL_MS) {
      return { ...cached, source: `${cached.source ?? "cache"}` };
    }
  }
  const attempts: { name: string; fn: () => Promise<Partial<FundSnapshot>> }[] = [
    { name: "eastmoney-fund", fn: () => fetchFundInfo(code) },
    { name: "sina-fund", fn: () => fetchSinaFund(code) },
  ];
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      const part = await a.fn();
      const snapshot: FundSnapshot = {
        ok: true,
        code,
        ...part,
        source: a.name,
        ts: new Date().toISOString(),
      };
      if (!snapshot.name && !snapshot.nav) throw new Error(`${a.name} 返回空数据`);
      kvSet(cacheKey, snapshot);
      return snapshot;
    } catch (e) {
      errors.push(`${a.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: false, code, message: `基金行情源均不可用（${errors.join("；")}）` };
}

/** 批量基金快照（逐只 + 缓存） */
export async function getFundSnapshots(codes: string[], opts: { force?: boolean } = {}): Promise<FundSnapshot[]> {
  const out: FundSnapshot[] = [];
  for (const c of codes) out.push(await getFundSnapshot(c, opts));
  return out;
}

// 注册数据源：场外基金净值（本地数据管理页展示）
registerDataSource({
  kind: "kv",
  name: FUND_CACHE_PREFIX,
  page: "行情工具",
  tag: "分析数据",
  description: "场外基金净值快照缓存（天天基金，TTL 10 分钟）",
});
