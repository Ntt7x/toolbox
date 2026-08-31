// ============================================================
// 业务模块：新闻中心（features/newsCenter）
// 多新闻源配置 + 展示（新闻源可拓展：registerNewsSource 即接入）
// 配置存本地设置数据（settings:news.sources），展示区按启用源拉取（每源缓存 10 分钟）
// 文本加工（打标/高亮/黑名单，非 LLM）见同目录 textRules.ts
// ============================================================
import { Hono } from "hono";
import type { Context } from "hono";
import { API_PREFIX } from "@toolbox/shared";
import { kvGet, kvSet } from "../../core/kvStore.js";
import { getSetting, setSetting } from "../../core/settingsStore.js";
import { registerDataSource } from "../../core/dataRegistry.js";
import { getTextConfig, processNews, processTextItem, sanitizeTextConfig, saveTextConfig } from "./textRules.js";

export const meta = {
  id: "news-center",
  name: "新闻中心",
  description: "多新闻源配置与展示（东财 7x24 快讯等，可拓展）",
  path: "/tools/news-center",
};

export interface NewsItem {
  title: string;
  digest: string;
  time: string;
  url: string;
  source: string; // 源 id（eastmoney 等）
  sourceName: string;
}

export interface NewsSourceDef {
  id: string;
  name: string;
  desc: string;
  /** 拉取实现（须自带超时；返回按时间降序的条目；page 可选，1 起，用于分页获取更多） */
  fetch: (page?: number) => Promise<{ title: string; digest: string; time: string; url: string }[]>;
  /** 缓存 TTL（默认 10 分钟） */
  ttlMs?: number;
}

const DEFAULT_TTL = 10 * 60 * 1000;
const CONFIG_KEY = "settings:news.sources"; // 启用的源 id 列表（缺省 = 全部）
const CACHE_PREFIX = "news:items:";

// ---------- 新闻源注册表（可拓展：新增源即 push 一条） ----------
const sources: NewsSourceDef[] = [];

/** 注册新闻源（feature 加载时调用） */
export function registerNewsSource(def: NewsSourceDef): void {
  if (!sources.some((s) => s.id === def.id)) sources.push(def);
}

export function listSources(): { id: string; name: string; desc: string; enabled: boolean }[] {
  const enabled = enabledIds();
  return sources.map((s) => ({ id: s.id, name: s.name, desc: s.desc, enabled: enabled.includes(s.id) }));
}

function enabledIds(): string[] {
  const raw = getSetting<string[]>(CONFIG_KEY);
  if (!Array.isArray(raw)) return sources.map((s) => s.id); // 未配置 = 全部源
  if (raw.length === 0) return []; // 2026-08-14：显式空列表 = 关闭全部源（此前被静默当「全部」）
  const valid = raw.filter((id) => sources.some((s) => s.id === id));
  return valid.length > 0 ? valid : sources.map((s) => s.id);
}

/** 设置启用的源 id 列表 */
export function setEnabledSources(ids: string[]): { ok: boolean; message?: string } {
  const unknown = ids.filter((id) => !sources.some((s) => s.id === id));
  if (unknown.length > 0) return { ok: false, message: `未知新闻源：${unknown.join("、")}` };
  setSetting(CONFIG_KEY, ids);
  return { ok: true };
}

/** 拉取指定源新闻（带缓存；单源失败降级旧缓存/记错误，不阻塞其他源） */
export async function fetchNews(sourceIds?: string[], page = 1): Promise<{ ok: boolean; items: NewsItem[]; errors: string[]; fromCache: boolean[] }> {
  const ids = sourceIds && sourceIds.length > 0 ? sourceIds : enabledIds();
  const items: NewsItem[] = [];
  const errors: string[] = [];
  const fromCache: boolean[] = [];
  for (const id of ids) {
    const src = sources.find((s) => s.id === id);
    if (!src) continue;
    const ttl = src.ttlMs ?? DEFAULT_TTL;
    // 缓存按源+页码隔离（分页后旧缓存不污染，memo msq32kgv）
    const cached = kvGet<{ _at?: string; items?: { title: string; digest: string; time: string; url: string }[] }>(`${CACHE_PREFIX}${id}:p${page}`);
    const at = cached?._at ? Date.parse(cached._at) : NaN;
    if (cached?.items && Number.isFinite(at) && Date.now() - at < ttl) {
      items.push(...cached.items.map((i) => ({ ...i, source: src.id, sourceName: src.name })));
      fromCache.push(true);
      continue;
    }
    try {
      const list = await src.fetch(page);
      kvSet(`${CACHE_PREFIX}${id}:p${page}`, { _at: new Date().toISOString(), items: list });
      items.push(...list.map((i) => ({ ...i, source: src.id, sourceName: src.name })));
      fromCache.push(false);
    } catch (e) {
      if (cached?.items) {
        items.push(...cached.items.map((i) => ({ ...i, source: src.id, sourceName: src.name })));
        fromCache.push(true);
      } else {
        errors.push(`${src.name}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  // 多源合并：按时间降序（time 形如 YYYY-MM-DD HH:mm:ss 可字符串比较）
  items.sort((a, b) => (a.time < b.time ? 1 : -1));
  return { ok: items.length > 0 || errors.length === 0, items, errors, fromCache };
}

registerDataSource({
  kind: "kv",
  name: "news:items:",
  page: "新闻中心",
  tag: "分析数据",
  description: "新闻中心各源抓取缓存（东财等，TTL 10 分钟）",
});

// ---------- 内置新闻源：东财 7x24 快讯（JSONP） ----------
export const EASTMONEY_SOURCE: NewsSourceDef = {
  id: "eastmoney",
  name: "东方财富 7x24 快讯",
  desc: "东财快讯聚合（A 股/宏观/行业实时消息，JSONP 解析，缓存 10 分钟）",
  fetch: async (page = 1) => {
    const res = await fetch(`https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_${page}_.html`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`东财快讯接口 ${res.status}`);
    const text = await res.text();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("东财快讯响应格式异常");
    const data = JSON.parse(m[0]) as { LivesList?: { title?: string; digest?: string; showtime?: string; url_w?: string }[] };
    return (data.LivesList ?? [])
      .filter((x) => x?.title)
      .map((x) => ({ title: x.title ?? "", digest: x.digest ?? "", time: x.showtime ?? "", url: x.url_w ?? "" }));
  },
};

// ---------- 路由 ----------
export function register(app: Hono): void {
  const route = new Hono();

  // 源列表 + 配置状态
  route.get("/sources", (c: Context) => c.json({ ok: true, sources: listSources() }));

  // 配置启用源
  route.post("/config", async (c: Context) => {
    const raw = (await c.req.json().catch(() => null)) as { sources?: unknown } | null;
    const ids = Array.isArray(raw?.sources) ? raw.sources.map((x) => String(x)).filter(Boolean) : [];
    const r = setEnabledSources(ids);
    if (!r.ok) return c.json({ ok: false, message: r.message }, 400);
    return c.json({ ok: true, sources: listSources() });
  });

  // 拉取新闻（?sources=id1,id2 可选；?page=N 分页，默认 1——分页获取更多，memo msq32kgv）
  // 返回为**加工后**条目：tags（打标）/ hits（高亮区间）/ blocked（黑名单）+ blockedCount（被剔除条数）
  route.get("/items", async (c: Context) => {
    const q = c.req.query("sources");
    const ids = q ? q.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
    const r = await fetchNews(ids, page);
    const processed = processNews(r.items);
    return c.json({
      ok: r.ok,
      items: processed.items,
      errors: r.errors,
      fromCache: r.fromCache,
      page,
      blockedCount: processed.blockedCount,
    });
  });

  // ---------- 文本加工配置（打标规则 / 高亮词组 / 黑名单词组） ----------

  // 读取配置
  route.get("/rules", (c: Context) => c.json({ ok: true, config: getTextConfig() }));

  // 保存配置
  route.post("/rules", async (c: Context) => {
    const raw = (await c.req.json().catch(() => null)) as { config?: unknown } | null;
    if (!raw || typeof raw.config !== "object" || raw.config === null) {
      return c.json({ ok: false, message: "缺少 config" }, 400);
    }
    const r = saveTextConfig(raw.config);
    if (!r.ok) return c.json({ ok: false, config: r.config, message: r.message }, 400);
    return c.json({ ok: true, config: r.config });
  });

  // 试跑（不落库）：用给定配置加工当前新闻流前 N 条，或加工一段自定义文本
  route.post("/preview", async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as { config?: unknown; text?: string; limit?: number } | null;
    const cfg = sanitizeTextConfig(body?.config ?? getTextConfig());
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (text) {
      // 自定义文本：与新闻流同一套语义（黑名单 hide 时不返回条目，只回计数）
      const item = processTextItem(text, cfg);
      const hidden = item.blocked && cfg.blacklist.enabled && cfg.blacklist.action === "hide";
      return c.json({ ok: true, items: hidden ? [] : [item], blockedCount: hidden ? 1 : 0 });
    }
    const limit = Math.min(Math.max(1, Number(body?.limit ?? 20) || 20), 100);
    const r = await fetchNews(undefined, 1);
    const processed = processNews(r.items.slice(0, limit), cfg);
    return c.json({ ok: true, items: processed.items, blockedCount: processed.blockedCount });
  });

  app.route(`${API_PREFIX}/tools/news`, route);
}
