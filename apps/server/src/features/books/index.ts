// ============================================================
// 业务模块：书籍下载（features/books）
// - meta：工具注册信息
// - register：搜索 zlib（经代理）+ 配置读取/保存（本地设置数据）
// - 下载动作在前端触发（window.open 下载链接，浏览器登录态下载）
// 依赖下层公共模块：core/httpProxy、core/settingsStore
// ============================================================

import { Hono } from "hono";
import { API_PREFIX, type BookItem, type BookSearchResult, type ToolMeta } from "@toolbox/shared";
import { registerDataSource } from "../../core/dataRegistry.js";
import {
  addFavorite,
  bookConfigResult,
  clearFavorites,
  clearSearchHistory,
  listFavorites,
  listSearchHistory,
  removeFavorite,
  removeSearchHistory,
  saveBookConfig,
  searchBooks,
} from "./service.js";

// 注册数据源：历史搜索记录（本地数据管理页展示）
registerDataSource({
  kind: "kv",
  name: "books:",
  page: "书籍下载",
  tag: "历史记录",
  description: "书籍下载历史搜索记录（books:history，上限 50 条）",
});

export const meta: ToolMeta = {
  id: "books",
  name: "书籍下载",
  description: "zlib 图书搜索（经本机代理），浏览器一键打开下载/详情页",
  path: "/tools/books",
};

export function register(app: Hono): void {
  // 搜索（POST 表单；q 支持模糊书名）
  app.get(`${API_PREFIX}/tools/books/search`, async (c) => {
    const q = c.req.query("q")?.trim() ?? "";
    if (!q) return c.json({ ok: false, message: "缺少书名参数 q" }, 400);
    const page = Number(c.req.query("page")) || 1;
    const limit = Number(c.req.query("limit")) || 20;
    const r: BookSearchResult = await searchBooks(q, { page, limit });
    return c.json(r, r.ok ? 200 : 429);
  });

  // 历史搜索记录
  app.get(`${API_PREFIX}/tools/books/history`, (c) => {
    return c.json({ ok: true, items: listSearchHistory() });
  });

  // 删除单条历史（?q=关键词）或清空（无 q）
  app.delete(`${API_PREFIX}/tools/books/history`, (c) => {
    const q = c.req.query("q")?.trim() ?? "";
    if (!q) {
      clearSearchHistory();
      return c.json({ ok: true, cleared: true });
    }
    const removed = removeSearchHistory(q);
    return c.json({ ok: true, removed });
  });

  // 收藏列表
  app.get(`${API_PREFIX}/tools/books/favorites`, (c) => {
    return c.json({ ok: true, items: listFavorites() });
  });

  // 收藏一本书（POST body: 完整 BookItem）
  app.post(`${API_PREFIX}/tools/books/favorites`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Partial<BookItem> | null;
    if (!raw || typeof raw.id !== "number" || typeof raw.title !== "string") {
      return c.json({ ok: false, message: "收藏数据无效（需 id 与 title）" }, 400);
    }
    const item = raw as BookItem;
    const r = addFavorite(item);
    return c.json({ ok: true, added: r.added, count: r.count });
  });

  // 取消收藏（?id=bookId）或清空（无 id）
  app.delete(`${API_PREFIX}/tools/books/favorites`, (c) => {
    const idRaw = c.req.query("id");
    const id = idRaw ? Number(idRaw) : NaN;
    if (!Number.isFinite(id)) {
      clearFavorites();
      return c.json({ ok: true, cleared: true });
    }
    const removed = removeFavorite(id);
    return c.json({ ok: true, removed });
  });

  // 配置读取
  app.get(`${API_PREFIX}/tools/books/config`, (c) => {
    return c.json(bookConfigResult());
  });

  // 配置保存（本地设置数据；本地数据管理页也可改）
  app.put(`${API_PREFIX}/tools/books/config`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { zlibBase?: unknown; proxy?: unknown } | null;
    if (!raw || typeof raw !== "object") return c.json({ ok: false, message: "请求体无效" }, 400);
    const cfg = saveBookConfig({
      zlibBase: typeof raw.zlibBase === "string" ? raw.zlibBase : undefined,
      proxy: typeof raw.proxy === "string" ? raw.proxy : undefined,
    });
    return c.json({ ok: true, ...cfg });
  });
}
