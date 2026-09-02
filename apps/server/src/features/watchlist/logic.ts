// ============================================================
// 自选股·逻辑确认：入选理由 / 预期 随时间是否成立
// ------------------------------------------------------------
// 设计要点（dev.md §6.2 防「裁判兼运动员」假收敛）：
//   确定性锚（非 LLM）：基准价 → 当前价涨跌幅、目标价达成度、相关新闻条数
//   LLM 判定         ：仅用于「理由是否成立 / 预期是否达成」的定性判断，
//                      且输入必须是服务端采集的真实事实（不让它自己造数）
//   成本原则         ：LLM 调用只由用户点击触发；同日同标的复用上次结论（force 可绕过）
//   时间序列         ：每次复核落库（watchlist:logic:<groupId>:<code>），体现「随时间」
// ============================================================
import type {
  FundSnapshot,
  QuoteSnapshot,
  WatchDataMeta,
  WatchItem,
  WatchLogicAnchor,
  WatchLogicItem,
  WatchLogicResult,
  WatchLogicReview,
} from "@toolbox/shared";
import { chat } from "../../core/llm.js";
import { getPromptTemplate } from "../../core/prompts.js";
import { robustJsonParse } from "../../core/jsonParse.js";
import { getDailyBars } from "../../core/kline.js";
import { getReviews, appendReview } from "./store.js";
import { loadTrack, type TrackBundle } from "./track.js";
import { loadNews } from "./news.js";
import type { DailyBar } from "./periodStats.js";

/** 日 K 中取「指定日期当天或之前最近」的收盘价（入选日可能非交易日） */
export function closeOnOrBefore(bars: DailyBar[], date: string): number | undefined {
  if (bars.length === 0) return undefined;
  let pick: number | undefined;
  for (const b of bars) {
    if (b.date > date) break; // bars 升序
    pick = b.close;
  }
  // 早于首根 K 线的入选日 → 用首根（无更好基准）
  return pick ?? bars[0]?.close;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 快照取价：股票取 price，场外基金取 nav */
function priceOf(q: QuoteSnapshot | FundSnapshot | undefined): number | undefined {
  if (!q || !q.ok) return undefined;
  const p = (q as QuoteSnapshot).price ?? (q as FundSnapshot).nav;
  return typeof p === "number" ? p : undefined;
}

/**
 * 组装单个标的的确定性锚（纯数据、无 LLM）。
 * 基准价取「入选日当天或之前最近的收盘价」；无日 K 时基准价缺失，涨跌幅不可算（不静默置 0）。
 */
export async function buildAnchors(
  code: string,
  opts: { addedAt?: string; targetPrice?: number; quote?: QuoteSnapshot | FundSnapshot; name?: string },
): Promise<WatchLogicAnchor> {
  const anchor: WatchLogicAnchor = {};
  const price = priceOf(opts.quote);
  if (typeof price === "number") anchor.price = round4(price);

  const bars = (await getDailyBars(code, { count: 500 })) as unknown as DailyBar[];
  const addDate = (opts.addedAt ?? "").slice(0, 10);
  const base = addDate ? closeOnOrBefore(bars, addDate) : undefined;
  if (typeof base === "number" && base > 0) {
    anchor.basePrice = round4(base);
    if (typeof price === "number") anchor.sinceAddPct = round4(((price - base) / base) * 100);
  }
  if (typeof opts.targetPrice === "number" && opts.targetPrice > 0 && typeof price === "number") {
    anchor.targetProgressPct = round4((price / opts.targetPrice) * 100);
  }
  if (opts.name || /\d{4,6}/.test(code)) {
    try {
      const news = await loadNews(code, opts.name);
      anchor.newsCount = news.items.length;
    } catch {
      // 新闻不可用不影响其它锚点（缺失即缺失，不伪造）
    }
  }
  return anchor;
}

/**
 * 逻辑确认视图：**单一标的**的理由/预期 + 最新复核 + 确定性锚 + 复核历史。
 * 行情走 loadTrack（复用其缓存与血缘），避免重复取数。
 */
export async function loadLogic(item: WatchItem, opts: { force?: boolean } = {}): Promise<WatchLogicResult> {
  const bundle: TrackBundle = await loadTrack([item], "day", opts);
  const quotes = bundle.quotes;

  const history = getReviews(item.code);
  const review = history.length > 0 ? history[history.length - 1] : null;
  const anchors = await buildAnchors(item.code, {
    addedAt: item.addedAt,
    ...(typeof item.targetPrice === "number" ? { targetPrice: item.targetPrice } : {}),
    quote: quotes.get(item.code),
    ...(item.name ? { name: item.name } : {}),
  });
  const logicItem: WatchLogicItem = {
    code: item.code,
    ...(item.name ? { name: item.name } : {}),
    ...(item.kind ? { kind: item.kind } : {}),
    reason: item.reason,
    ...(item.expectation ? { expectation: item.expectation } : {}),
    ...(typeof item.targetPrice === "number" ? { targetPrice: item.targetPrice } : {}),
    addedAt: item.addedAt,
    review,
    reviewCount: history.length,
    anchors,
  };

  const meta: WatchDataMeta = {
    sources: ["tencent.quote", "tencent.kline", "eastmoney.news"],
    fetchedAt: new Date().toISOString(),
    ...(bundle.meta.caveats ? { caveats: bundle.meta.caveats } : {}),
  };
  return { ok: true, code: item.code, item: logicItem, reviews: history, meta };
}

function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * 对单个标的做逻辑复核（LLM，用户点击触发）。
 * 同日已有结论且未 force → 直接返回该结论（fromCache=true），避免重复计费。
 */
export async function reviewItem(
  item: WatchItem,
  opts: { force?: boolean; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; review?: WatchLogicReview; message?: string }> {
  const code = item.code;
  const name = item.name ?? "";

  const history = getReviews(code);
  const today = todayStr();
  const last = history.length > 0 ? history[history.length - 1] : null;
  if (last && !opts.force && (last.at ?? "").slice(0, 10) === today) {
    return { ok: true, review: { ...last, fromCache: true } };
  }

  // 事实采集（服务端真实数据；LLM 只做定性判断，不让它自己造数）
  const bundle = await loadTrack([item], "day");
  const quote = bundle.quotes.get(code);
  const anchors = await buildAnchors(code, {
    addedAt: item.addedAt,
    ...(typeof item.targetPrice === "number" ? { targetPrice: item.targetPrice } : {}),
    quote,
    ...(name ? { name } : {}),
  });
  const news = (await loadNews(code, name)).items.slice(0, 8);

  const facts = [
    `标的：${name || code}（代码 ${code}）`,
    `入选时间：${(item.addedAt ?? "").slice(0, 10)}`,
    `入选理由：${item.reason || "（未填写）"}`,
    `预期：${item.expectation || "（未填写）"}${typeof item.targetPrice === "number" ? `｜目标价 ${item.targetPrice}` : ""}`,
    `当前价：${typeof anchors.price === "number" ? anchors.price : "未知"}`,
    `入选以来涨跌幅：${typeof anchors.sinceAddPct === "number" ? `${anchors.sinceAddPct}%` : "未知（无基准价）"}`,
    `目标价达成度：${typeof anchors.targetProgressPct === "number" ? `${anchors.targetProgressPct}%` : "未设目标价"}`,
    `近期相关新闻（${news.length} 条）：`,
    ...news.map((n) => `- ${n.time} ${n.title}${n.digest ? `｜${n.digest.slice(0, 80)}` : ""}`),
  ].join("\n");

  const system = getPromptTemplate("watchlist.logic-review");
  const result = await chat(
    [
      { role: "system" as const, content: system },
      { role: "user" as const, content: `${facts}\n\n今天是 ${today}。请判断该标的的入选理由与预期是否仍成立，输出 JSON。` },
    ],
    { temperature: 0.2, module: "watchlist.logic-review", ...(opts.signal ? { signal: opts.signal } : {}) },
  );
  if (!result.ok) return { ok: false, message: result.message };

  const parsed = robustJsonParse(result.content.trim());
  if (!parsed) return { ok: false, message: `LLM 输出无法解析为结构化数据。原始输出（前 200 字）：${result.content.trim().slice(0, 200)}` };
  const p = parsed as Record<string, unknown>;
  const premise = String(p.premise ?? "");
  const expectation = String(p.expectation ?? "");
  const suggestion = String(p.suggestion ?? "");
  if (!["holds", "partial", "broken"].includes(premise)) return { ok: false, message: "LLM 输出 premise 取值非法" };
  if (!["met", "pending", "failed"].includes(expectation)) return { ok: false, message: "LLM 输出 expectation 取值非法" };
  if (!["hold", "review", "exit"].includes(suggestion)) return { ok: false, message: "LLM 输出 suggestion 取值非法" };

  const review: WatchLogicReview = {
    at: new Date().toISOString(),
    premise: premise as WatchLogicReview["premise"],
    expectation: expectation as WatchLogicReview["expectation"],
    evidence: typeof p.evidence === "string" ? p.evidence : "",
    suggestion: suggestion as WatchLogicReview["suggestion"],
    note: typeof p.note === "string" ? p.note : "",
    anchors,
  };
  appendReview(code, review);
  return { ok: true, review };
}
