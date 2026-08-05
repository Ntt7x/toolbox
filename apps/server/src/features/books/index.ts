// ============================================================
// 业务模块：书籍下载（features/books）
// - meta：工具注册信息
// - register：搜索 zlib（经代理）+ 配置读取/保存（本地设置数据）
// - 下载动作在前端触发（window.open 下载链接，浏览器登录态下载）
// 依赖下层公共模块：core/httpProxy、core/settingsStore
// ============================================================

import { Hono } from "hono";
import { API_PREFIX, type BookSearchResult, type ToolMeta } from "@toolbox/shared";
import { bookConfigResult, saveBookConfig, searchBooks } from "./service.js";

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
