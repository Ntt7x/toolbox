// ============================================================
// 自选股·下沉分析（新闻）：标的维度的新闻关联
// ------------------------------------------------------------
// 数据链路：新闻源采集（features/newsCenter.fetchNews，已缓存）
//           → 确定性关键词匹配（core/newsText.findHits，纯函数、零 LLM、零额外请求）
//           → 标的维度结果（WatchNewsResult，带血缘与降级标注）
// 取舍：东财 7x24 是「全市场快讯」而非「个股新闻源」，因此用名称/代码做文本匹配关联；
//       匹配不上是正常结果（caveats 标注），不静默返回空列表了事。
// ============================================================
import type { WatchDataMeta, WatchNewsItem, WatchNewsResult } from "@toolbox/shared";
import { fetchNews, type NewsItem } from "../newsCenter/index.js";
import { findHits } from "../../core/newsText.js";

/** 拉取页数（东财每页 50 条；取 2 页平衡覆盖率与成本） */
const PAGES = 2;
/** 单标的返回上限 */
const LIMIT = 30;

/** 标的代码 → 匹配关键词（名称 + 裸代码；太短的代码不做匹配，避免误命中） */
export function newsKeywords(code: string, name?: string): string[] {
  const words: string[] = [];
  if (name && name.trim().length >= 2) words.push(name.trim());
  const bare = code.trim().toLowerCase().replace(/^(sh|sz|hk|bj)/, "").replace(/^0+/, "");
  // 6 位 A 股/基金代码、4-5 位港股代码才有区分度；过短（如 00700 → 700）易误命中，故保留前导零形态
  if (/^\d{4,6}$/.test(bare)) words.push(bare);
  return [...new Set(words)];
}

/**
 * 关联单个标的的新闻。
 * 无关键词（无名称且代码过短）/ 无源启用 / 无命中 → 返回空列表 + caveats 说明。
 */
export async function loadNews(code: string, name?: string): Promise<WatchNewsResult> {
  const words = newsKeywords(code, name);
  const caveats: string[] = [];
  const meta: WatchDataMeta = { sources: [], fetchedAt: new Date().toISOString() };

  if (words.length === 0) {
    return { ok: true, code, items: [], meta: { ...meta, caveats: ["标的无名称且代码过短，无法做文本关联"] } };
  }

  const all: NewsItem[] = [];
  const errors: string[] = [];
  let fromCache = true;
  for (let p = 1; p <= PAGES; p++) {
    const r = await fetchNews(undefined, p);
    if (r.errors.length > 0) errors.push(...r.errors);
    if (r.fromCache.includes(false)) fromCache = false;
    all.push(...r.items);
  }
  const sourceIds = [...new Set(all.map((i) => i.source))];
  meta.sources = sourceIds;
  meta.fromCache = fromCache;
  if (errors.length > 0) {
    meta.degraded = true;
    caveats.push(...errors.map((e) => `新闻源降级：${e}`));
  }
  if (all.length === 0) {
    caveats.push("当前没有已启用的新闻源或无可用新闻（可在「新闻中心」启用数据源）");
    return { ok: true, code, items: [], meta: { ...meta, caveats } };
  }

  const items: WatchNewsItem[] = [];
  for (const n of all) {
    const text = `${n.title}\n${n.digest}`;
    const hits = findHits(text, words, "exact");
    if (hits.length === 0) continue;
    items.push({
      title: n.title,
      digest: n.digest,
      time: n.time,
      url: n.url,
      source: n.source,
      sourceName: n.sourceName,
      hits: [...new Set(hits.map((h) => h.word))],
    });
    if (items.length >= LIMIT) break;
  }
  if (items.length === 0) caveats.push(`已扫描 ${all.length} 条快讯，未命中「${words.join(" / ")}」（全市场快讯源，个股提及有限）`);

  return { ok: true, code, items, meta: { ...meta, ...(caveats.length ? { caveats } : {}) } };
}
