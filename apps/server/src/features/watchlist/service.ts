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
import { getFundSnapshot } from "../../core/fund.js";
import { extractShare } from "../../core/deepseekShare.js";
import { createTopic, getTopic, updateTopic } from "./store.js";
import type { WatchlistFundamentalResult, WatchlistStock, WatchlistTopic } from "@toolbox/shared";

/** 财报分析缓存 TTL：2 年（历史分析长期有效；「强制分析」按钮可绕过） */
export const FUNDAMENTAL_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000;

const FUNDAMENTAL_PREFIX = "watchlist:fundamental:";

function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** 解析名称（标准行情工具，多源 failover；kind=fund 走天天基金净值接口） */
export async function resolveStockName(code: string, kind?: string): Promise<string> {
  try {
    if (kind === "fund") {
      const f = await getFundSnapshot(code);
      if (f.ok && f.name) return f.name;
    } else {
      const q = await getQuoteSnapshot(code);
      if (q.ok && q.name) return q.name;
    }
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
  // 前缀稳定（缓存友好）：{code}/{name}/{date} 在 system 内替换为固定文本，标的与日期放 user
  const template = getPromptTemplate("watchlist.fundamental")
    .replace("{code}", "（标的代码见用户消息）")
    .replace("{name}", "（标的名称见用户消息）")
    .replace("{date}", "（日期见用户消息）");
  const messages = [
    { role: "system" as const, content: template },
    { role: "user" as const, content: `请分析标的 ${name || stockCode}（代码 ${stockCode}），今天是 ${today}。请联网搜索该股票最新财报并输出 JSON。` },
  ];

  const result = await chat(messages, { temperature: 0.3, search: true, module: "watchlist.fundamental", ...(opts.signal ? { signal: opts.signal } : {}) });
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

// ============================================================
// Chat 分享链接导入：提取对话 → LLM 整理 → 自动创建专题
// ============================================================

/** 对话文本上限（超长截断，防止超 token） */
const CONVERSATION_LIMIT = 60000;

/** 对话内容 → 简洁文本 */
function conversationText(messages: { role: string; content: string }[]): string {
  const parts = messages.map((m) => (m.role === "user" ? `[用户] ${m.content}` : `[AI] ${m.content}`));
  return parts.join("\n\n").slice(0, CONVERSATION_LIMIT);
}

/** 校验股票条目（6 位数字代码 + 名称），非法剔除 */
function normalizeImportedStock(s: unknown): WatchlistStock | null {
  if (!s || typeof s !== "object") return null;
  const r = s as Record<string, unknown>;
  const code = typeof r.code === "string" ? r.code.trim() : "";
  if (!/^\d{6}$/.test(code)) return null;
  const name = typeof r.name === "string" ? r.name.trim().slice(0, 20) : "";
  const reason = typeof r.reason === "string" ? r.reason.trim().slice(0, 120) : "";
  if (!name && !reason) return null;
  return { code, ...(name ? { name } : {}), reason: reason || "（由 Chat 对话导入）" };
}

/**
 * Chat 导入：解析分享链接 → 提取对话 → LLM 整理专题 → 自动创建。
 * topicId 提供时：**追加**到现有专题（Chat 补充个股，已有代码去重更新），否则新建。
 * 返回专题；失败抛错。
 */
export async function importFromChat(shareUrl: string, signal?: AbortSignal, topicId?: string): Promise<WatchlistTopic> {
  const extracted = await extractShare(shareUrl);
  if (!extracted.ok || !Array.isArray(extracted.messages) || extracted.messages.length === 0) {
    throw new Error(!extracted.ok && "message" in extracted ? extracted.message : "对话提取为空，请检查链接");
  }
  const messages = extracted.messages;

  const template = getPromptTemplate("watchlist.import").replace("{conversation}", conversationText(messages));
  const result = await chat(
    [
      { role: "system" as const, content: template },
      { role: "user" as const, content: "请整理上述对话并输出 JSON。" },
    ],
    { temperature: 0.2, module: "watchlist.import", ...(signal ? { signal } : {}) },
  );
  if (!result.ok) throw new Error(result.message);

  const parsed = robustJsonParse(result.content.trim());
  if (!parsed) throw new Error(`LLM 输出无法解析为结构化数据。原始输出（前 200 字）：${result.content.trim().slice(0, 200)}`);

  const p = parsed as Record<string, unknown>;
  const name = typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 30) : "Chat 导入专题";
  const description = typeof p.description === "string" && p.description.trim() ? p.description.trim().slice(0, 1000) : undefined;
  const stocks = (Array.isArray(p.stocks) ? p.stocks : [])
    .map(normalizeImportedStock)
    .filter((s): s is WatchlistStock => !!s);

  // 追加模式：合并进现有专题（addStocks 按 code 去重更新），专题名/介绍不变
  if (topicId) {
    const existing = await getTopic(topicId);
    if (!existing) throw new Error("专题不存在");
    if (stocks.length === 0) throw new Error("Chat 对话中未识别到可补充的个股");
    const updated = updateTopic(topicId, { addStocks: stocks });
    if (!updated) throw new Error("补充失败");
    return updated;
  }

  const topic = createTopic(name, description);
  if (stocks.length > 0) {
    const updated = updateTopic(topic.id, { addStocks: stocks });
    if (updated) return updated;
  }
  return topic;
}
