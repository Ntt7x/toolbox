// ============================================================
// 业务模块：DeepSeek Share 提取（features/deepseek-share）
// - meta：工具注册信息
// - register：提取路由 + 提取历史（KV 持久化，成功即记录）
// 依赖下层公共模块：core/deepseekShare（分享提取能力）
// ============================================================

import { Hono } from "hono";
import { API_PREFIX, type ToolMeta } from "@toolbox/shared";
import { registerDataSource } from "../../core/dataRegistry.js";
import { extractShare } from "../../core/deepseekShare.js";
import { kvGet, kvSet } from "../../core/kvStore.js";

// ============================================================
// 提取历史（KV：deepseekShare:history，上限 50 条）
// ============================================================

export interface ShareHistoryEntry {
  url: string;
  shareId: string;
  ts: string;
  messageCount: number;
}

const HISTORY_KEY = "deepseekShare:history";
const HISTORY_MAX = 50;

function readHistory(): ShareHistoryEntry[] {
  const saved = kvGet<{ items?: unknown[] }>(HISTORY_KEY);
  if (!Array.isArray(saved?.items)) return [];
  return saved.items
    .filter((e): e is ShareHistoryEntry => !!e && typeof (e as ShareHistoryEntry).url === "string")
    .slice(0, HISTORY_MAX);
}

function writeHistory(items: ShareHistoryEntry[]): void {
  kvSet(HISTORY_KEY, { items });
}

function recordHistory(url: string, shareId: string, messageCount: number): void {
  const items = readHistory().filter((e) => e.url !== url);
  items.unshift({ url, shareId, ts: new Date().toISOString(), messageCount });
  writeHistory(items.slice(0, HISTORY_MAX));
}

function listHistory(): ShareHistoryEntry[] {
  return readHistory();
}

function clearHistory(): void {
  writeHistory([]);
}

// 注册数据源：提取历史（本地数据管理页展示）
registerDataSource({
  kind: "kv",
  name: "deepseekShare:",
  page: "DeepSeek 分享提取",
  tag: "历史记录",
  description: "DeepSeek 分享提取历史（deepseekShare:history，上限 50 条）",
});

export const meta: ToolMeta = {
  id: "deepseek-share",
  name: "DeepSeek 分享提取",
  description: "从 DeepSeek 分享链接提取完整对话（含思考链）",
  path: "/tools/deepseek-share",
};

export function register(app: Hono): void {
  // DeepSeek 分享链接对话提取（成功自动记录历史）
  app.post(`${API_PREFIX}/tools/deepseek-share`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    const url = raw?.url;
    if (typeof url !== "string" || url.trim() === "") {
      return c.json({ ok: false, message: "缺少 url 参数（DeepSeek 分享链接或 share id）" }, 400);
    }
    const result = await extractShare(url);
    if (result.ok) {
      // 2026-08-14：分享 URL 可能带 query（?x=1），历史记录剥离 query 保持与规范化 shareId 一致
      const lastSeg = url.trim().split("/").filter(Boolean).pop() ?? "";
      const shareId = lastSeg.split(/[?#]/)[0] || url.trim();
      recordHistory(url.trim(), shareId, Array.isArray(result.messages) ? result.messages.length : 0);
    }
    return c.json(result, result.ok ? 200 : 400);
  });

  // 提取历史列表
  app.get(`${API_PREFIX}/tools/deepseek-share/history`, (c) => {
    return c.json({ ok: true, items: listHistory() });
  });

  // 清空提取历史
  app.delete(`${API_PREFIX}/tools/deepseek-share/history`, (c) => {
    clearHistory();
    return c.json({ ok: true, cleared: true });
  });
}
