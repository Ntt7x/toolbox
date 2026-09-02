// ============================================================
// 自选股：标的下沉分析（财报，LLM 驱动）+ Chat 分享链接导入
// 提示词存于本地设置数据（watchlist.*），LLM 用 core/llm（默认联网搜索），
// 结果 robustJsonParse 容错 + 统一缓存（core/cache.cachedFetch，stale-if-error 降级）。
// ============================================================

import { chatSessionAsk, createChatSession } from "../../core/chatSession.js";
import { chat } from "../../core/llm.js";
import { getPromptTemplate } from "../../core/prompts.js";
import { robustJsonParse } from "../../core/jsonParse.js";
import { cachedFetch, peekCache } from "../../core/cache.js";
import { getQuoteSnapshot } from "../../core/quote.js";
import { getFundSnapshot } from "../../core/fund.js";
import { extractShare } from "../../core/deepseekShare.js";
import { createItem, createTag, getItem, getTag, listItems, updateItem } from "./store.js";
import type { WatchFundamentalResult, WatchItem } from "@toolbox/shared";

/** 财报分析缓存 TTL：2 年（历史分析长期有效；「强制分析」按钮可绕过） */
export const FUNDAMENTAL_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000;

// 结果缓存 key 模板版本：提示词/输出结构升级时 +1（防旧缓存命中返回旧格式，dev.md §7.4 教训）
const FUNDAMENTAL_CACHE_V = "v2";
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

/** 财报分析失败错误（带 LLM 原始输出，便于前端兜底展示与定位） */
class FundamentalError extends Error {
  constructor(message: string, readonly raw?: string) {
    super(message);
  }
}

/** 财报分析的实际执行（失败一律 throw：不把失败结果写进缓存） */
async function runFundamental(
  code: string,
  opts: { name?: string; signal?: AbortSignal } = {},
): Promise<WatchFundamentalResult> {
  const stockCode = code.trim();
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
  if (!result.ok) throw new FundamentalError(result.message);

  const content = result.content.trim();
  const parsed = robustJsonParse(content);
  if (!parsed) {
    throw new FundamentalError(
      `LLM 输出无法解析为结构化数据。原始输出（前 200 字）：${content.slice(0, 200)}`,
      content,
    );
  }

  const p = parsed as Record<string, unknown>;
  const summary = typeof p.summary === "string" ? p.summary : "";
  const out: WatchFundamentalResult = {
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
  return out;
}

/**
 * 标的下沉分析（财报，LLM 驱动；命中缓存直接返回）
 * 模式 2（chatSession）：同一标的共享会话（wl-fund-<code>），system 固定、标的/日期放 user，
 * force 重跑时命中前缀缓存（第 1 次搜索+输出后，后续分析前缀稳定）
 * 缓存：core/cache.cachedFetch（失败不落缓存；stale-if-error 降级返回旧结果）
 */
export async function fundamentalAnalysis(
  code: string,
  opts: { force?: boolean; name?: string; signal?: AbortSignal } = {},
): Promise<WatchFundamentalResult> {
  const stockCode = code.trim();
  if (!stockCode) return { ok: false, code, summary: "", message: "缺少标的代码" };
  try {
    const r = await cachedFetch(
      `${FUNDAMENTAL_PREFIX}${stockCode}`,
      FUNDAMENTAL_TTL_MS,
      () => runFundamental(stockCode, { ...(opts.name ? { name: opts.name } : {}), ...(opts.signal ? { signal: opts.signal } : {}) }),
      { force: opts.force, staleIfError: true },
    );
    return { ...r.data, fromCache: r.fromCache };
  } catch (e) {
    if (e instanceof FundamentalError) {
      return { ok: false, code: stockCode, summary: "", message: e.message, ...(e.raw ? { raw: e.raw } : {}) };
    }
    return { ok: false, code: stockCode, summary: "", message: e instanceof Error ? e.message : String(e) };
  }
}

// ============================================================
// Chat 分享链接导入：提取对话 → LLM 整理 → 自动创建/补充分组
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

/** 校验标的条目（6 位数字代码 + 名称），非法剔除 */
function normalizeImportedItem(s: unknown): WatchItem | null {
  if (!s || typeof s !== "object") return null;
  const r = s as Record<string, unknown>;
  const raw0 = typeof r.code === "string" ? r.code.trim() : "";
  // 容错：去交易所后缀（01763.HK / 600519.SH 等）再规范化
  const raw = raw0.toUpperCase().replace(/\.(HK|SH|SZ|BJ)$/, "").trim();
  // 代码规范化：A股/ETF 6 位；港股 5 位（裸数字含前导 0，或 HK 前缀 3-5 位）→ 统一裸 5 位（如 01763/00700）
  let code = "";
  if (/^\d{6}$/.test(raw)) code = raw;
  else if (/^HK\d{3,5}$/.test(raw)) code = raw.slice(2).replace(/^0+/, "").padStart(5, "0");
  else if (/^\d{3,5}$/.test(raw)) code = raw.padStart(5, "0");
  if (!code) return null;
  const name = typeof r.name === "string" ? r.name.trim().slice(0, 20) : "";
  const reason = typeof r.reason === "string" ? r.reason.trim().slice(0, 120) : "";
  if (!name && !reason) return null;
  const kind = r.kind === "fund" ? "fund" as const : undefined;
  return {
    code,
    ...(name ? { name } : {}),
    ...(kind ? { kind } : {}),
    reason: reason || "（由 Chat 对话导入）",
    addedAt: new Date().toISOString(),
    tags: [], // tag 归属由导入流程（建 tag / 挂到指定 tag）决定
  };
}

/** 解析 Chat 分享链接 → 候选分组信息（不落库；供预览-确认流程，memo msozzpcl） */
export async function parseImportFromChat(shareUrl: string, signal?: AbortSignal): Promise<{ name: string; description?: string; items: WatchItem[] }> {
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
  const name = typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 30) : "Chat 导入分组";
  const description = typeof p.description === "string" && p.description.trim() ? p.description.trim().slice(0, 1000) : undefined;
  const items = (Array.isArray(p.stocks) ? p.stocks : [])
    .map(normalizeImportedItem)
    .filter((s): s is WatchItem => !!s);
  // 兜底：LLM 未识别时从对话文本正则提取带明确市场后缀的标的代码（01763.HK / 600519.SH 等）
  if (items.length === 0) {
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
      items.push(...codes.map((code) => ({
        code,
        reason: extractReasonFromText(rawText, code) || "（由 Chat 对话代码提取）",
        addedAt: new Date().toISOString(),
        tags: [],
      })));
    }
  }
  if (items.length === 0) {
    // 诊断信息：LLM 原始 stocks 内容（定位是 LLM 空输出还是代码格式过滤）
    const rawStocks = Array.isArray(p.stocks) ? JSON.stringify(p.stocks).slice(0, 200) : "（非数组）";
    throw new Error(`Chat 对话中未识别到可补充的标的（LLM 原始 stocks：${rawStocks}）`);
  }
  return { name, description, items };
}

/**
 * Chat 导入：解析分享链接 → 提取对话 → LLM 整理标的 → 建 tag 并挂标的。
 * tagId 提供时：**追加**到该 tag（已有代码去重更新），否则新建同名 tag。
 * 失败抛错（由路由层转 4xx）。
 */
export async function importFromChat(
  shareUrl: string,
  signal?: AbortSignal,
  tagId?: string,
): Promise<{ tagId: string; tagName: string; items: WatchItem[] }> {
  const { name, description, items } = await parseImportFromChat(shareUrl, signal);
  const codes = items.map((s) => s.code).filter(Boolean);

  // 追加模式：标的并入现有 tag（已存在标的按 code 去重更新描述字段）
  if (tagId) {
    const existing = getTag(tagId);
    if (!existing) throw new Error("标签不存在");
    for (const it of items) {
      if (!it.code) continue;
      const cur = getItem(it.code);
      const tags = Array.from(new Set([...(cur?.tags ?? []), tagId]));
      if (cur) updateItem(it.code, {
        tags,
        ...(it.reason ? { reason: it.reason } : {}),
        ...(it.expectation ? { expectation: it.expectation } : {}),
      });
      else createItem({ ...it, tags });
    }
    return { tagId, tagName: existing.name, items: listItems().filter((x) => x.tags.includes(tagId)) };
  }

  // 新建模式：以对话标题建 tag（挂「全部」下），标的统一挂上去
  const tag = createTag(name, null);
  if (!tag) throw new Error("创建标签失败");
  for (const it of items) {
    if (!it.code) continue;
    const cur = getItem(it.code);
    const tags = Array.from(new Set([...(cur?.tags ?? []), tag.id]));
    if (cur) updateItem(it.code, { tags, ...(it.reason ? { reason: it.reason } : {}) });
    else createItem({ ...it, tags });
  }
  void description; // 新模型下 tag 无介绍字段（历史分组介绍已在升级时兜底为标的选择理由）
  void codes;
  return { tagId: tag.id, tagName: tag.name, items: listItems().filter((x) => x.tags.includes(tag.id)) };
}

// ============================================================
// 根据财报分析优化入选理由（读取 fundamental 缓存 → LLM 优化）
// ============================================================

export async function optimizeReason(
  code: string,
  opts: { reason?: string; name?: string; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; reason?: string; message?: string }> {
  const stockCode = code.trim();
  // 财报分析缓存（须先运行过财报分析）：只读窥探，绝不触发取数/计费
  const cached = peekCache<WatchFundamentalResult>(`${FUNDAMENTAL_PREFIX}${stockCode}`);
  const fundamentalText = cached?.data?.ok && cached.data.summary ? cached.data.summary : "";
  if (!fundamentalText) return { ok: false, message: "暂无财报分析结果，请先对该标的运行财报分析" };

  // 成本原则：system 固定模板；标的/理由/财报内容放 user
  const system = getPromptTemplate("watchlist.reason-optimize");
  const cachedName = cached?.data?.name;
  const user = `标的代码：${stockCode}${cachedName || opts.name ? `（${cachedName || opts.name}）` : ""}\n原入选理由：${opts.reason?.trim() || "（无）"}\n财报分析内容：\n${fundamentalText.slice(0, 4000)}`;
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
// 生成延续思路 / 扩展思考提示词（分组信息 → LLM → 可直接粘贴 DeepSeek Chat 的提示词）
// 缓存：内容哈希版本化（分组内容变了才失效；core/cache.cachedFetch + TTL.ANALYSIS）
// ============================================================

const EXTEND_PREFIX = "watchlist:extend:v2:";

export async function extendPrompt(
  bag: { name: string; items: { code: string; name?: string; reason?: string }[] },
  opts: { signal?: AbortSignal } = {},
): Promise<{ ok: boolean; prompt?: string; message?: string }> {
  const itemsText =
    bag.items.length > 0
      ? bag.items.map((s) => `- ${s.code} ${s.name ?? ""}${s.reason ? `：${s.reason}` : ""}`).join("\n")
      : "（暂无标的）";
  const user = `标签：${bag.name}\n该标签下的标的与理由：\n${itemsText}`;
  const system = getPromptTemplate("watchlist.extend");
  // 缓存 key = 内容哈希（标签名/标的内容变了才失效），避免用 updatedAt 伪版本化
  const key = `${EXTEND_PREFIX}${hashText(user).slice(0, 16)}`;
  try {
    const r = await cachedFetch(
      key,
      FUNDAMENTAL_TTL_MS,
      async () => {
        const result = await chat(
          [
            { role: "system" as const, content: system },
            { role: "user" as const, content: user },
          ],
          { temperature: 0.5, module: "watchlist.extend", ...(opts.signal ? { signal: opts.signal } : {}) },
        );
        if (!result.ok) throw new Error(result.message);
        const parsed = robustJsonParse(result.content.trim());
        const prompt = typeof parsed?.prompt === "string" && parsed.prompt.trim() ? parsed.prompt.trim() : null;
        if (!prompt) throw new Error("LLM 输出无法解析为提示词，请重试");
        return prompt;
      },
      { staleIfError: true },
    );
    return { ok: true, prompt: r.data };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
