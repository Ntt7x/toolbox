// ============================================================
// 专题自选股：个股财报分析（LLM 驱动）
// 提示词存于本地设置数据（watchlist.fundamental），LLM 用 core/llm（默认联网搜索），
// 结果 robustJsonParse 容错 + KV 缓存（TTL 2 年，「强制分析」可绕过）。
// ============================================================

import { chat } from "../../core/llm.js";
import { getPromptTemplate } from "../../core/prompts.js";
import { robustJsonParse } from "../../core/jsonParse.js";
import { kvGet, kvSet } from "../../core/kvStore.js";
import { getQuoteSnapshot } from "../../core/quote.js";
import type { WatchlistFundamentalResult } from "@toolbox/shared";

/** 财报分析缓存 TTL：2 年（历史分析长期有效；「强制分析」按钮可绕过） */
export const FUNDAMENTAL_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000;

const FUNDAMENTAL_PREFIX = "watchlist:fundamental:";

function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** 用标准行情工具解析股票名称（快照接口，多源 failover；失败静默返回空） */
export async function resolveStockName(code: string): Promise<string> {
  try {
    const q = await getQuoteSnapshot(code);
    if (q.ok && q.name) return q.name;
  } catch {
    // 行情接口失败静默：名称留空由用户/LLM 补
  }
  return "";
}

/** 个股财报分析（LLM 驱动；命中缓存直接返回） */
export async function fundamentalAnalysis(
  code: string,
  opts: { force?: boolean; name?: string; signal?: AbortSignal } = {},
): Promise<WatchlistFundamentalResult> {
  const stockCode = code.trim();
  if (!stockCode) return { ok: false, code, summary: "", message: "缺少股票代码" };

  // 缓存命中（TTL 内）
  const cacheKey = `${FUNDAMENTAL_PREFIX}${stockCode}`;
  if (!opts.force) {
    const cached = kvGet<WatchlistFundamentalResult & { _at?: string }>(cacheKey);
    const at = cached?._at ? Date.parse(cached._at) : NaN;
    if (cached && cached.ok && Number.isFinite(at) && Date.now() - at < FUNDAMENTAL_TTL_MS) {
      return { ...cached, fromCache: true };
    }
  }

  // 名称解析（行情工具；用户未提供时）
  const name = opts.name?.trim() || (await resolveStockName(stockCode));

  const today = todayStr();
  const template = getPromptTemplate("watchlist.fundamental")
    .replace("{code}", stockCode)
    .replace("{name}", name || stockCode)
    .replace("{date}", today);
  const messages = [
    { role: "system" as const, content: template },
    { role: "user" as const, content: "请联网搜索该股票最新财报并输出 JSON。" },
  ];

  const result = await chat(messages, { temperature: 0.3, search: true, ...(opts.signal ? { signal: opts.signal } : {}) });
  if (!result.ok) return { ok: false, code: stockCode, summary: "", message: result.message };

  const content = result.content.trim();
  const parsed = robustJsonParse(content);
  if (!parsed) {
    return {
      ok: false,
      code: stockCode,
      summary: "",
      message: `LLM 输出无法解析为结构化数据。原始输出（前 200 字）：${content.slice(0, 200)}`,
      raw: content,
    };
  }

  const p = parsed as Record<string, unknown>;
  const summary = typeof p.summary === "string" ? p.summary : "";
  const out: WatchlistFundamentalResult = {
    ok: true,
    code: stockCode,
    name: typeof p.name === "string" && p.name ? p.name : name || stockCode,
    summary,
    ...(typeof p.financials === "string" && p.financials ? { financials: p.financials } : {}),
    ...(typeof p.strengths === "string" && p.strengths ? { strengths: p.strengths } : {}),
    ...(typeof p.risks === "string" && p.risks ? { risks: p.risks } : {}),
    ...(typeof p.conclusion === "string" && p.conclusion ? { conclusion: p.conclusion } : {}),
    dataMode: "search",
    model: result.model,
    raw: content,
  };
  kvSet(cacheKey, { ...out, _at: new Date().toISOString() });
  return out;
}
