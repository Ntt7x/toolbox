// ============================================================
// 专题自选股：个股财报分析（LLM 驱动）
// 提示词存于本地设置数据（watchlist.fundamental），LLM 用 core/llm（默认联网搜索），
// 结果 robustJsonParse 容错 + KV 缓存（TTL 2 年，「强制分析」可绕过）。
// ============================================================

import { chatSessionAsk, createChatSession } from "../../core/chatSession.js";
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

// 结果缓存 key 模板版本：提示词/输出结构升级时 +1（防旧缓存命中返回旧格式，dev.md §7.4 教训）
const FUNDAMENTAL_CACHE_V = "v1";
const FUNDAMENTAL_PREFIX = `watchlist:fundamental:${FUNDAMENTAL_CACHE_V}:`;

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

/** 个股财报分析（LLM 驱动；命中缓存直接返回）
 * 模式 2（chatSession）：同一股票共享会话（wl-fund-<code>），system 固定、标的/日期放 user，
 * force 重跑时命中前缀缓存（第 1 次搜索+输出后，后续分析前缀稳定） */
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
  // 业务确定性 id（代码规范化）：幂等复用；提示词升级自动重建
  const sid = `wl-fund-${stockCode.toLowerCase().replace(/[^a-z0-9]/g, "") || "unknown"}`;
  createChatSession({ id: sid, module: "watchlist.fundamental", system: template, search: true, temperature: 0.3 });

  const result = await chatSessionAsk(
    sid,
    `请分析标的 ${name || stockCode}（代码 ${stockCode}），今天是 ${today}。请联网搜索该股票最新财报并输出 JSON。`,
    { signal: opts.signal },
  );
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

/** 简单字符串哈希（会话 id 用：对话内容 → 幂等会话） */
function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 对话内容 → 简洁文本 */
function conversationText(messages: { role: string; content: string }[]): string {
  const parts = messages.map((m) => (m.role === "user" ? `[用户] ${m.content}` : `[AI] ${m.content}`));
  return parts.join("\n\n").slice(0, CONVERSATION_LIMIT);
}

/** 从对话文本提取该股票的关键理由句（代码后文含"龙头/领先/核心/市占率/最大"等，截 60 字） */
function extractReasonFromText(text: string, code: string): string {
  const digits = code.replace(/^0+/, "");
  const idx = text.indexOf(`${digits}.HK`);
  const after = idx >= 0 ? text.slice(idx) : text;
  // 去 [AI]/[用户] 前缀
  const clean = after.replace(/^\[(AI|USER|用户|助手)\][\s:：]*/, "");
  const sentences = clean.split(/[。；\n]/);
  const kw = /龙头|领先|核心|市占率|最大|第一|龙头|国内/;
  const hit = sentences.find((s) => kw.test(s) && s.length > 8 && s.length < 90);
  const raw = hit ?? sentences[0] ?? "";
  return raw
    .replace(/^\d{3,6}\.HK[）)是：:、\s]*/, "")   // 去代码前缀（01763.HK）是
    .replace(/\[reference:\d+\]/g, "")           // 去引用标记
    .replace(/^[）)是：:、\s]+/, "")
    .trim()
    .slice(0, 60);
}

/** 校验股票条目（6 位数字代码 + 名称），非法剔除 */
function normalizeImportedStock(s: unknown): WatchlistStock | null {
  if (!s || typeof s !== "object") return null;
  const r = s as Record<string, unknown>;
  const raw0 = typeof r.code === "string" ? r.code.trim() : "";
  // 容错：去交易所后缀（01763.HK / 600519.SH 等）再规范化
  const raw = raw0.toUpperCase().replace(/\.(HK|SH|SZ|BJ)$/, "").trim();
  // 代码规范化：A股/ETF 6 位；港股 5 位（裸数字含前导 0，或 HK 前缀 3-5 位）→ 统一裸 5 位（与现有专题一致，如 01763/00700）
  let code = "";
  if (/^\d{6}$/.test(raw)) code = raw;
  else if (/^HK\d{3,5}$/.test(raw)) code = raw.slice(2).replace(/^0+/, "").padStart(5, "0");
  else if (/^\d{3,5}$/.test(raw)) code = raw.padStart(5, "0");
  if (!code) return null;
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
/** 解析 Chat 分享链接 → 候选专题信息（不落库；供预览-确认流程，memo msozzpcl） */
export async function parseImportFromChat(shareUrl: string, signal?: AbortSignal): Promise<{ name: string; description?: string; stocks: WatchlistStock[] }> {
  const extracted = await extractShare(shareUrl);
  if (!extracted.ok || !Array.isArray(extracted.messages) || extracted.messages.length === 0) {
    throw new Error(!extracted.ok && "message" in extracted ? extracted.message : "对话提取为空，请检查链接");
  }
  const messages = extracted.messages;

  // 会话化调用：system 模板固定（不含对话）→ DeepSeek 前缀缓存命中省 token；
  // 会话 id 按对话内容哈希（幂等复用 + 无跨导入历史污染）
  const text = conversationText(messages);
  const template = getPromptTemplate("watchlist.import");
  const sid = `wl-imp-${hashText(text).slice(0, 16)}`;
  createChatSession({ id: sid, module: "watchlist.import", system: template });
  const result = await chatSessionAsk(sid, text, { module: "watchlist.import", ...(signal ? { signal } : {}) });
  if (!result.ok) throw new Error(result.message);

  const parsed = robustJsonParse(result.content.trim());
  if (!parsed) throw new Error(`LLM 输出无法解析为结构化数据。原始输出（前 200 字）：${result.content.trim().slice(0, 200)}`);

  const p = parsed as Record<string, unknown>;
  const name = typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 30) : "Chat 导入专题";
  const description = typeof p.description === "string" && p.description.trim() ? p.description.trim().slice(0, 1000) : undefined;
  const stocks = (Array.isArray(p.stocks) ? p.stocks : [])
    .map(normalizeImportedStock)
    .filter((s): s is WatchlistStock => !!s);
  // 兜底：LLM 未识别时从对话文本正则提取带明确市场后缀的股票代码（01763.HK / 600519.SH 等）
  if (stocks.length === 0) {
    const rawText = typeof text === "string" ? text : "";
    const codes = [...new Set(
      [...(rawText.match(/(?:HK|SH|SZ|BJ)?\d{3,6}\.(?:HK|SH|SZ|BJ)/gi) ?? [])]
        .map((m) => {
          const upper = m.toUpperCase();
          const market = upper.match(/\.(HK|SH|SZ|BJ)$/)?.[1] ?? "";
          const digits = upper.replace(/\.(HK|SH|SZ|BJ)$/, "");
          if (market === "HK") return digits.replace(/^HK/, "").padStart(5, "0");
          return digits.replace(/^(HK|SH|SZ|BJ)/, "");
        })
        .filter((c) => /^\d{5,6}$/.test(c)),
    )];
    if (codes.length > 0) {
      // 兜底候选：名称由 confirm 时行情工具补全（可靠）；理由尽力从代码后文提取关键句
      stocks.push(...codes.map((code) => {
        const reason = extractReasonFromText(rawText, code) || "（由 Chat 对话代码提取）";
        return { code, reason };
      }));
    }
  }
  if (stocks.length === 0) {
    // 诊断信息：LLM 原始 stocks 内容（定位是 LLM 空输出还是代码格式过滤）
    const rawStocks = Array.isArray(p.stocks) ? JSON.stringify(p.stocks).slice(0, 200) : "（非数组）";
    throw new Error(`Chat 对话中未识别到可补充的个股（LLM 原始 stocks：${rawStocks}）`);
  }
  return { name, description, stocks };
}

export async function importFromChat(shareUrl: string, signal?: AbortSignal, topicId?: string): Promise<WatchlistTopic> {
  const { name, description, stocks } = await parseImportFromChat(shareUrl, signal);

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

// ============================================================
// 根据财报分析优化入选理由（读取 fundamental 缓存 → LLM 优化）
// ============================================================

export async function optimizeReason(
  code: string,
  opts: { reason?: string; name?: string; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; reason?: string; message?: string }> {
  const stockCode = code.trim();
  // 财报分析缓存（须先运行过财报分析）
  const cached = kvGet<WatchlistFundamentalResult & { _at?: string }>(`${FUNDAMENTAL_PREFIX}${stockCode}`);
  const fundamentalText = cached && cached.ok && cached.summary ? cached.summary : "";
  if (!fundamentalText) return { ok: false, message: "暂无财报分析结果，请先对个股运行财报分析" };

  // 成本原则：system 固定模板；标的/理由/财报内容放 user
  const system = getPromptTemplate("watchlist.reason-optimize");
  const user = `股票代码：${stockCode}${cached?.name || opts.name ? `（${cached?.name || opts.name}）` : ""}\n原入选理由：${opts.reason?.trim() || "（无）"}\n财报分析内容：\n${fundamentalText.slice(0, 4000)}`;
  const result = await chat(
    [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
    { temperature: 0.3, module: "watchlist.reason-optimize", ...(opts.signal ? { signal: opts.signal } : {}) },
  );
  if (!result.ok) return { ok: false, message: result.message };
  const parsed = robustJsonParse(result.content.trim());
  const reason = typeof parsed?.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : null;
  if (!reason) return { ok: false, message: "LLM 输出无法解析为理由，请重试" };
  return { ok: true, reason };
}

// ============================================================
// 生成延续思路 / 扩展思考提示词（专题信息 → LLM → 可直接粘贴 DeepSeek Chat 的提示词）
// ============================================================

export async function extendPrompt(
  topic: { name: string; description?: string; stocks: { code: string; name?: string; reason?: string }[] },
  opts: { signal?: AbortSignal } = {},
): Promise<{ ok: boolean; prompt?: string; message?: string }> {
  const stocksText =
    topic.stocks.length > 0
      ? topic.stocks.map((s) => `- ${s.code} ${s.name ?? ""}${s.reason ? `：${s.reason}` : ""}`).join("\n")
      : "（暂无个股）";
  const user = `专题名称：${topic.name}\n专题介绍：${topic.description?.trim() || "（无）"}\n已有个股与理由：\n${stocksText}`;
  const system = getPromptTemplate("watchlist.extend");
  const result = await chat(
    [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
    { temperature: 0.5, module: "watchlist.extend", ...(opts.signal ? { signal: opts.signal } : {}) },
  );
  if (!result.ok) return { ok: false, message: result.message };
  const parsed = robustJsonParse(result.content.trim());
  const prompt = typeof parsed?.prompt === "string" && parsed.prompt.trim() ? parsed.prompt.trim() : null;
  if (!prompt) return { ok: false, message: "LLM 输出无法解析为提示词，请重试" };
  return { ok: true, prompt };
}
