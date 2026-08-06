// ============================================================
// 业务模块：知乎爬虫（features/zhihu-crawler）
// - meta：工具注册信息（小工具分组）
// - register：cookie 设置 / 用户信息 / 抓取（后台任务，人类频率）/ 抓取历史
// 依赖下层公共模块：core/tasks（后台任务）、core/settingsStore（cookie）
// ============================================================
import { Hono } from "hono";
import { API_PREFIX, type ToolMeta, type ZhihuCrawlResult } from "@toolbox/shared";
import { createTask } from "../../core/tasks.js";
import { registerDataSource } from "../../core/dataRegistry.js";
import { kvGet, kvSet, kvListRaw, kvDelete } from "../../core/kvStore.js";
import { crawlUser, saveCookie, hasCookie, getUserInfo, type CrawlProgress } from "./service.js";

// 抓取历史（KV：zhihuCrawl:history，上限 50 条）
const HISTORY_KEY = "zhihuCrawl:history";
const HISTORY_MAX = 50;

registerDataSource({
  kind: "kv",
  name: "zhihuCrawl:",
  page: "知乎爬虫",
  tag: "历史记录",
  description: "知乎爬虫抓取历史与结果（zhihuCrawl:history，上限 50 条）",
});

export const meta: ToolMeta = {
  id: "zhihu-crawler",
  name: "知乎爬虫",
  description: "授权登录后以人类频率抓取某用户的创作内容（回答/文章/想法，转 markdown）",
  path: "/tools/zhihu-crawler",
};

export function register(app: Hono): void {
  // 获取/保存 cookie（登录态授权）
  app.get(`${API_PREFIX}/tools/zhihu-crawler/cookie`, (c) => {
    return c.json({ ok: true, configured: hasCookie() });
  });

  app.put(`${API_PREFIX}/tools/zhihu-crawler/cookie`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { cookie?: unknown } | null;
    if (!raw || typeof raw.cookie !== "string") return c.json({ ok: false, message: "缺少 cookie" }, 400);
    saveCookie(raw.cookie);
    return c.json({ ok: true, configured: hasCookie() });
  });

  // 用户信息（验证目标 + 计数）
  app.get(`${API_PREFIX}/tools/zhihu-crawler/user`, (c) => {
    const target = c.req.query("target") ?? "";
    return getUserInfo(target).then((r) => c.json(r, r.ok ? 200 : 400));
  });

  // 抓取（后台任务；人类频率逐步进行）
  app.post(`${API_PREFIX}/tools/zhihu-crawler/crawl`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as {
      target?: unknown;
      types?: unknown;
      limit?: unknown;
    } | null;
    const target = typeof raw?.target === "string" ? raw.target.trim() : "";
    if (!target) return c.json({ ok: false, message: "缺少 target（知乎主页 URL 或 urlToken）" }, 400);
    if (!hasCookie()) return c.json({ ok: false, message: "未配置知乎登录 cookie" }, 400);
    const types = Array.isArray(raw?.types)
      ? (raw.types as string[]).filter((t): t is "answer" | "article" | "pin" => t === "answer" || t === "article" || t === "pin")
      : undefined;
    const limit = typeof raw?.limit === "number" && raw.limit >= 0 ? Math.floor(raw.limit) : 0;

    const { taskId } = createTask<ZhihuCrawlResult>(
      async (signal) => {
        const progress: CrawlProgress[] = [];
        const r = await crawlUser(target, {
          types,
          limit,
          signal,
          onProgress: (p) => {
            progress.push(p);
          },
        });
        if (!r.ok) return { ok: false, message: r.message };
        recordHistory(target, r.user?.name ?? "", r.total ?? 0);
        return r;
      },
      { timeoutMs: 60 * 60 * 1000, module: "zhihu.crawler", name: `知乎爬虫 · ${target}` },
    );
    return c.json({ ok: true, taskId, status: "running" }, 202);
  });

  // 抓取历史
  app.get(`${API_PREFIX}/tools/zhihu-crawler/history`, (c) => {
    return c.json({ ok: true, items: listHistory() });
  });

  app.delete(`${API_PREFIX}/tools/zhihu-crawler/history/:id`, (c) => {
    const id = c.req.param("id");
    const items = listHistory().filter((e) => e.id !== id);
    kvSet(HISTORY_KEY, { items });
    kvDelete(`zhihuCrawl:result:${id}`);
    return c.json({ ok: true, deleted: true });
  });
}

// ---------- 历史 ----------
interface HistoryEntry {
  id: string;
  target: string;
  name: string;
  ts: string;
  total: number;
}

function readHistory(): HistoryEntry[] {
  const saved = kvGet<{ items?: unknown[] }>(HISTORY_KEY);
  if (!Array.isArray(saved?.items)) return [];
  return saved.items
    .filter((e): e is HistoryEntry => !!e && typeof (e as HistoryEntry).id === "string")
    .slice(0, HISTORY_MAX);
}

function recordHistory(target: string, name: string, total: number): void {
  const items = readHistory();
  items.unshift({ id: `zh-${Date.now()}`, target, name, ts: new Date().toISOString(), total });
  kvSet(HISTORY_KEY, { items: items.slice(0, HISTORY_MAX) });
}

function listHistory(): HistoryEntry[] {
  return readHistory();
}

// 供其他模块读取结果（预留）
export function readCrawlResult(id: string): unknown {
  return kvGet(`zhihuCrawl:result:${id}`);
}
