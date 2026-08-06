// ============================================================
// 业务模块：知乎爬虫（features/zhihu-crawler）
// - meta：工具注册信息（小工具分组）
// - register：cookie 设置 / 用户信息 / 抓取（后台任务，人类频率）/ 抓取历史
// 依赖下层公共模块：core/tasks（后台任务）、core/settingsStore（cookie）
// ============================================================
import { Hono } from "hono";
import { API_PREFIX, type ToolMeta, type ZhihuCrawlResult, type ZhihuCrawlItem, type ZhihuCrawlProgress, type ZhihuImportResult, type ZhihuImportRequest, type ZhihuResumeRequest } from "@toolbox/shared";
import { createTask } from "../../core/tasks.js";
import { registerDataSource } from "../../core/dataRegistry.js";
import { kvGet, kvSet, kvListRaw, kvDelete } from "../../core/kvStore.js";
import { kbListInstances, kbSet } from "../../core/knowledge.js";
import { crawlUser, saveCookie, hasCookie, getUserInfo, authViaBrowser, extractUrlToken } from "./service.js";

// 抓取历史（KV：zhihuCrawl:history，上限 50 条）
const HISTORY_KEY = "zhihuCrawl:history";
const HISTORY_MAX = 50;

registerDataSource({
  kind: "kv",
  name: "zhihuCrawl:",
  page: "知乎爬虫",
  tag: "爬取数据",
  description: "知乎爬虫数据：history（抓取历史）/ progress（断点续爬进度）/ favorites（收藏目标）/ result（完整结果）",
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

  // 浏览器内登录授权（后台任务：弹窗 → 用户登录 → 自动提取 cookie）
  app.post(`${API_PREFIX}/tools/zhihu-crawler/auth`, async (c) => {
    const { taskId } = createTask<{ ok: boolean; name?: string; message?: string }>(
      async (signal) => {
        return authViaBrowser({ signal, onProgress: () => {} });
      },
      { timeoutMs: 6 * 60 * 1000, module: "zhihu.auth", name: "知乎浏览器登录授权" },
    );
    return c.json({ ok: true, taskId, status: "running" }, 202);
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
      dateFrom?: unknown;
      dateTo?: unknown;
    } | null;
    const target = typeof raw?.target === "string" ? raw.target.trim() : "";
    if (!target) return c.json({ ok: false, message: "缺少 target（知乎主页 URL 或 urlToken）" }, 400);
    if (!hasCookie()) return c.json({ ok: false, message: "未配置知乎登录 cookie" }, 400);
    const types = Array.isArray(raw?.types)
      ? (raw.types as string[]).filter((t): t is "answer" | "article" | "pin" => t === "answer" || t === "article" || t === "pin")
      : undefined;
    const limit = typeof raw?.limit === "number" && raw.limit >= 0 ? Math.floor(raw.limit) : 0;
    const dateFrom = typeof raw?.dateFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.dateFrom) ? raw.dateFrom : undefined;
    const dateTo = typeof raw?.dateTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.dateTo) ? raw.dateTo : undefined;

    const { taskId } = createTask<ZhihuCrawlResult>(
      async (signal) => {
        const r = await crawlUser(target, {
          types,
          limit,
          ...(dateFrom ? { dateFrom } : {}),
          ...(dateTo ? { dateTo } : {}),
          signal,
          onProgress: () => {},
          saveProgress: (snap) => kvSet(`zhihuCrawl:progress:${snap.progressId}`, snap),
        });
        return finishCrawl(r, target);
      },
      { timeoutMs: 30 * 60 * 1000, module: "zhihu.crawler", name: `知乎爬虫 · ${target}` },
    );
    return c.json({ ok: true, taskId, status: "running" }, 202);
  });

  // 断点续爬：从暂停/取消的进度继续
  app.post(`${API_PREFIX}/tools/zhihu-crawler/resume`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as ZhihuResumeRequest | null;
    const progressId = typeof raw?.progressId === "string" ? raw.progressId.trim() : "";
    if (!progressId) return c.json({ ok: false, message: "缺少 progressId" }, 400);
    const progress = kvGet<ZhihuCrawlProgress>(`zhihuCrawl:progress:${progressId}`);
    if (!progress || !Array.isArray(progress.items)) {
      return c.json({ ok: false, message: "进度不存在或已过期（可重新开始爬取）" }, 404);
    }
    // 过期进度（7 天未续爬）拒绝并清理
    if (Date.now() - (progress.updatedAt ?? 0) > 7 * 24 * 60 * 60 * 1000) {
      kvDelete(`zhihuCrawl:progress:${progressId}`);
      return c.json({ ok: false, message: "进度已超过 7 天未续爬，已清理（可重新开始爬取）" }, 404);
    }
    const snap = progress as ZhihuCrawlProgress;
    const { taskId } = createTask<ZhihuCrawlResult>(
      async (signal) => {
        const r = await crawlUser(snap.token, {
          types: snap.types,
          limit: snap.limit,
          ...(snap.dateFrom ? { dateFrom: snap.dateFrom } : {}),
          ...(snap.dateTo ? { dateTo: snap.dateTo } : {}),
          seed: snap.items,
          commentsDone: snap.commentsDone === true,
          phaseIndex: snap.phaseIndex,
          progressId: snap.progressId,
          signal,
          onProgress: () => {},
          saveProgress: (s) => kvSet(`zhihuCrawl:progress:${s.progressId}`, s),
        });
        return finishCrawl(r, snap.token);
      },
      { timeoutMs: 30 * 60 * 1000, module: "zhihu.crawler", name: `知乎爬虫（续爬） · ${snap.token}` },
    );
    return c.json({ ok: true, taskId, status: "running" }, 202);
  });

  // 查询进度（续爬前确认）
  app.get(`${API_PREFIX}/tools/zhihu-crawler/progress/:id`, (c) => {
    const p = kvGet<ZhihuCrawlProgress>(`zhihuCrawl:progress:${c.req.param("id")}`);
    if (!p) return c.json({ ok: false, message: "进度不存在" }, 404);
    return c.json({ ok: true, items: p.items?.length ?? 0, total: p.items?.length ?? 0, updatedAt: p.updatedAt });
  });

  // 收藏的爬取目标（历史抓取目标）
  app.get(`${API_PREFIX}/tools/zhihu-crawler/favorites`, (c) => {
    return c.json({ ok: true, items: listFavorites() });
  });

  app.put(`${API_PREFIX}/tools/zhihu-crawler/favorites`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { target?: unknown; name?: unknown } | null;
    const target = typeof raw?.target === "string" ? raw.target.trim() : "";
    const name = typeof raw?.name === "string" ? raw.name.trim() : target;
    if (!target) return c.json({ ok: false, message: "缺少 target" }, 400);
    const token = extractUrlToken(target);
    if (!token) return c.json({ ok: false, message: "无法识别用户" }, 400);
    const items = listFavorites().filter((f) => f.token !== token);
    items.unshift({ token, name, ts: new Date().toISOString() });
    kvSet(FAVORITES_KEY, { items: items.slice(0, 50) });
    return c.json({ ok: true, favorites: items });
  });

  app.delete(`${API_PREFIX}/tools/zhihu-crawler/favorites/:token`, (c) => {
    const token = c.req.param("token");
    const items = listFavorites().filter((f) => f.token !== token);
    kvSet(FAVORITES_KEY, { items });
    return c.json({ ok: true, favorites: items });
  });

  // 查看已保存的抓取结果
  app.get(`${API_PREFIX}/tools/zhihu-crawler/result/:id`, (c) => {
    const r = kvGet<ZhihuCrawlResult>(`zhihuCrawl:result:${c.req.param("id")}`);
    if (!r) return c.json({ ok: false, message: "结果不存在" }, 404);
    return c.json({ ...r, resultId: c.req.param("id") });
  });

  // 知识库实例列表（导入知识库选择目标）
  app.get(`${API_PREFIX}/tools/zhihu-crawler/instances`, (c) => {
    return c.json({ ok: true, instances: kbListInstances() });
  });

  // 导入知识库：把已保存结果的选中条目写入指定实例
  app.post(`${API_PREFIX}/tools/zhihu-crawler/import`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as ZhihuImportRequest | null;
    if (!raw || typeof raw.resultId !== "string" || typeof raw.instance !== "string") {
      const body: ZhihuImportResult = { ok: false, imported: 0, message: "缺少 resultId 或 instance" };
      return c.json(body, 400);
    }
    const instance = raw.instance.trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(instance)) {
      const body: ZhihuImportResult = { ok: false, imported: 0, message: "知识库实例名仅允许字母数字._-" };
      return c.json(body, 400);
    }
    const saved = kvGet<ZhihuCrawlResult>(`zhihuCrawl:result:${raw.resultId}`);
    if (!saved?.ok || !Array.isArray(saved.items)) {
      const body: ZhihuImportResult = { ok: false, imported: 0, message: "结果不存在或为空" };
      return c.json(body, 404);
    }
    const pickIdx = Array.isArray(raw.indexes) && raw.indexes.length > 0 ? new Set(raw.indexes) : null;
    const targets = pickIdx ? saved.items.filter((_, i) => pickIdx.has(i)) : saved.items;
    if (targets.length === 0) {
      const body: ZhihuImportResult = { ok: false, imported: 0, message: "未选中任何条目" };
      return c.json(body, 400);
    }
    let imported = 0;
    for (const item of targets) {
      const key = `${instance}.zhihu.${item.kind}.${slugify(item.title)}-${Date.now().toString(36)}`;
      const md = buildImportMarkdown(item);
      try {
        kbSet(key, md, item.url);
        imported += 1;
      } catch {
        /* 单条失败跳过 */
      }
    }
    const body: ZhihuImportResult = { ok: true, imported, instance };
    return c.json(body);
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
/** 爬取结束统一收尾：部分结果（暂停/取消）保留进度供续爬；完整结果写历史 + 持久化 + 清理进度 */
function finishCrawl(r: ZhihuCrawlResult, target: string): ZhihuCrawlResult {
  if (!r.ok) return r;
  if (r.partial) {
    // 暂停/取消：保留进度（saveProgress 已写），不写历史
    return r;
  }
  // 完整结果
  const resultId = `zh-${Date.now()}`;
  kvSet(`zhihuCrawl:result:${resultId}`, { ...r, savedAt: new Date().toISOString() });
  recordHistory(target, r.user?.name ?? "", r.total ?? 0, resultId);
  // 清理进度（若续爬残留）
  if (r.progressId) kvDelete(`zhihuCrawl:progress:${r.progressId}`);
  return { ...r, resultId };
}

interface HistoryEntry {
  id: string;
  target: string;
  name: string;
  ts: string;
  total: number;
  resultId?: string;
}

// ---------- 收藏目标（zhihuCrawl:favorites，上限 50） ----------
const FAVORITES_KEY = "zhihuCrawl:favorites";
const FAVORITES_MAX = 50;

interface FavoriteEntry {
  token: string;
  name: string;
  ts: string;
}

function listFavorites(): FavoriteEntry[] {
  const saved = kvGet<{ items?: unknown[] }>(FAVORITES_KEY);
  if (!Array.isArray(saved?.items)) return [];
  return saved.items
    .filter((e): e is FavoriteEntry => !!e && typeof (e as FavoriteEntry).token === "string")
    .slice(0, FAVORITES_MAX);
}

function readHistory(): HistoryEntry[] {
  const saved = kvGet<{ items?: unknown[] }>(HISTORY_KEY);
  if (!Array.isArray(saved?.items)) return [];
  return saved.items
    .filter((e): e is HistoryEntry => !!e && typeof (e as HistoryEntry).id === "string")
    .slice(0, HISTORY_MAX);
}

function recordHistory(target: string, name: string, total: number, resultId?: string): void {
  const items = readHistory();
  items.unshift({ id: `zh-${Date.now()}`, target, name, ts: new Date().toISOString(), total, ...(resultId ? { resultId } : {}) });
  kvSet(HISTORY_KEY, { items: items.slice(0, HISTORY_MAX) });
}

function listHistory(): HistoryEntry[] {
  return readHistory();
}

/** 条目标题 → 安全 slug（knowledge key 段） */
function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "item";
}

/** 条目 → 知识库 markdown（含创作信息） */
function buildImportMarkdown(item: ZhihuCrawlItem): string {
  const kindLabel: Record<string, string> = { answer: "回答", article: "文章", pin: "想法" };
  const lines = [
    `# ${item.title}`,
    "",
    `- 类型：${kindLabel[item.kind] ?? item.kind}`,
    `- 创作时间：${item.createdAt.slice(0, 10)}`,
    ...(item.voteupCount !== undefined ? [`- 赞同：${item.voteupCount}`] : []),
    `- 原文：${item.url}`,
    "",
    "## 正文",
    "",
    item.content,
  ];
  if (item.comments && item.comments.length > 0) {
    lines.push("", "## 作者参与的评论（含上下文）", "");
    for (const cm of item.comments) {
      lines.push(`- **${cm.author}**${cm.replyTo ? ` 回复 ${cm.replyTo}` : ""}：${cm.content}`);
      if (cm.children && cm.children.length > 0) {
        for (const ch of cm.children) {
          lines.push(`  - ↳ **${ch.author}**${ch.replyTo ? ` 回复 ${ch.replyTo}` : ""}：${ch.content}`);
        }
      }
    }
  }
  return lines.join("\n");
}

// 供其他模块读取结果（预留）
export function readCrawlResult(id: string): unknown {
  return kvGet(`zhihuCrawl:result:${id}`);
}
