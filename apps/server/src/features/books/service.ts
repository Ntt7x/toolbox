// ============================================================
// 书籍下载：服务端逻辑（zlib 搜索）
// - 配置存本地设置数据（settings:books.zlibBase / settings:books.proxy）
// - 经 core/httpProxy 代理访问（本机直连被墙，需代理）
// - 匿名搜索每日有限额（429 时提示）；下载由浏览器端打开（登录态）
// ============================================================

import type { BookItem, BookConfig, BookSearchResult } from "@toolbox/shared";
import { proxyFetch } from "../../core/httpProxy.js";
import { kvGet, kvSet } from "../../core/kvStore.js";
import { getSetting, setSetting } from "../../core/settingsStore.js";

const DEFAULT_ZLIB_BASE = "https://z-library.bz";
const DEFAULT_PROXY = "http://127.0.0.1:10808";

const KEY_BASE = "books.zlibBase";
const KEY_PROXY = "books.proxy";

/** 读取书籍工具配置（本地设置数据；无则默认值） */
export function getBookConfig(): { zlibBase: string; proxy: string } {
  return {
    zlibBase: getSetting<string>(KEY_BASE)?.trim() || DEFAULT_ZLIB_BASE,
    proxy: getSetting<string>(KEY_PROXY)?.trim() || DEFAULT_PROXY,
  };
}

/** 保存配置（本地设置数据） */
export function saveBookConfig(patch: { zlibBase?: string; proxy?: string }): { zlibBase: string; proxy: string } {
  if (patch.zlibBase?.trim()) setSetting(KEY_BASE, patch.zlibBase.trim());
  if (patch.proxy?.trim() || patch.proxy === "") setSetting(KEY_PROXY, (patch.proxy ?? "").trim());
  return getBookConfig();
}

export function bookConfigResult(): BookConfig {
  const c = getBookConfig();
  return { ok: true, ...c };
}

// ============================================================
// 收藏（KV：books:favorites，上限 100 条，以 book id 去重）
// ============================================================

export interface BookFavoriteEntry extends BookItem {
  ts: string;
}

const FAV_KEY = "books:favorites";
const FAV_MAX = 100;

function readFavorites(): BookFavoriteEntry[] {
  const saved = kvGet<{ items?: unknown[] }>(FAV_KEY);
  if (!Array.isArray(saved?.items)) return [];
  return saved.items
    .filter((e): e is BookFavoriteEntry => !!e && typeof (e as BookFavoriteEntry).id === "number")
    .slice(0, FAV_MAX);
}

function writeFavorites(items: BookFavoriteEntry[]): void {
  kvSet(FAV_KEY, { items });
}

/** 收藏一本书（同 id 已收藏则更新时间提到最前；返回是否新增） */
export function addFavorite(item: BookItem): { added: boolean; count: number } {
  const items = readFavorites();
  const existed = items.some((e) => e.id === item.id);
  const next = items.filter((e) => e.id !== item.id);
  next.unshift({ ...item, ts: new Date().toISOString() });
  writeFavorites(next.slice(0, FAV_MAX));
  return { added: !existed, count: Math.min(next.length, FAV_MAX) }; // 2026-08-14：count 与实际存储一致
}

/** 取消收藏（按 book id）；返回是否移除 */
export function removeFavorite(id: number): boolean {
  const items = readFavorites();
  const next = items.filter((e) => e.id !== id);
  if (next.length === items.length) return false;
  writeFavorites(next);
  return true;
}

/** 收藏列表（最新在前） */
export function listFavorites(): BookFavoriteEntry[] {
  return readFavorites();
}

/** 清空收藏 */
export function clearFavorites(): void {
  writeFavorites([]);
}

// ============================================================
// 历史搜索记录（KV 持久化，本地数据管理可见：books:）
// ============================================================

export interface BookHistoryEntry {
  q: string;
  ts: string;
  /** 该次搜索命中条数 */
  hits?: number;
}

const HISTORY_KEY = "books:history";
const HISTORY_MAX = 50;

// ============================================================
// 访客会话（singlelogin 免密）：GET /login 获取 __ddg* DataDome cookie
// - 携带后可解除匿名搜索 429 限额（连搜验证 200）
// - 注意：下载仍需要真实登录会话（remix_userkey），访客态无法下载
// - cookie 与出口 IP 绑定，缓存 30 分钟；429 时强制刷新重试一次
// ============================================================

const SESSION_KEY = "books:session";
const SESSION_TTL_MS = 30 * 60 * 1000;

async function fetchGuestCookie(zlibBase: string, proxy: string): Promise<string> {
  const r = await proxyFetch(
    `${zlibBase.replace(/\/+$/, "")}/login`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
    },
    proxy,
  );
  const cookies = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
  return cookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

/** 获取（并缓存）访客 cookie；force 强制刷新 */
async function getGuestCookie(zlibBase: string, proxy: string, force = false): Promise<string> {
  if (!force) {
    const cached = kvGet<{ cookie: string; ts: string }>(SESSION_KEY);
    const at = cached?.ts ? Date.parse(cached.ts) : NaN;
    if (cached?.cookie && Number.isFinite(at) && Date.now() - at < SESSION_TTL_MS) {
      return cached.cookie;
    }
  }
  try {
    const cookie = await fetchGuestCookie(zlibBase, proxy);
    if (cookie) kvSet(SESSION_KEY, { cookie, ts: new Date().toISOString() });
    return cookie;
  } catch {
    return "";
  }
}

function readHistory(): BookHistoryEntry[] {
  const saved = kvGet<{ items?: unknown[] }>(HISTORY_KEY);
  if (!Array.isArray(saved?.items)) return [];
  return saved.items
    .filter((e): e is BookHistoryEntry => !!e && typeof (e as BookHistoryEntry).q === "string")
    .slice(0, HISTORY_MAX);
}

function writeHistory(items: BookHistoryEntry[]): void {
  kvSet(HISTORY_KEY, { items });
}

/** 搜索成功后记录历史（同关键词去重提前，上限 50 条截断） */
export function addSearchHistory(q: string, hits?: number): void {
  const qs = q.trim().slice(0, 100);
  if (!qs) return;
  const items = readHistory().filter((e) => e.q !== qs);
  items.unshift({ q: qs, ts: new Date().toISOString(), ...(typeof hits === "number" ? { hits } : {}) });
  writeHistory(items.slice(0, HISTORY_MAX));
}

/** 历史列表（倒序） */
export function listSearchHistory(): BookHistoryEntry[] {
  return readHistory();
}

/** 删除单条历史（同关键词全部删除） */
export function removeSearchHistory(q: string): boolean {
  const qs = q.trim();
  if (!qs) return false;
  const items = readHistory();
  const next = items.filter((e) => e.q !== qs);
  if (next.length === items.length) return false;
  writeHistory(next);
  return true;
}

/** 清空历史 */
export function clearSearchHistory(): void {
  writeHistory([]);
}

/** 归一化 zlib 书籍条目 */
function normalizeBook(raw: Record<string, unknown>, base: string): BookItem | null {
  const id = Number(raw.id);
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!Number.isFinite(id) || !title) return null;
  const str = (k: string): string | undefined => (typeof raw[k] === "string" && (raw[k] as string).trim() ? (raw[k] as string).trim() : undefined);
  const num = (k: string): number | undefined => {
    const n = Number(raw[k]);
    return Number.isFinite(n) ? n : undefined;
  };
  const href = str("href");
  const dl = str("dl");
  return {
    id,
    title,
    ...(str("author") ? { author: str("author") } : {}),
    ...(num("year") ? { year: num("year") } : {}),
    ...(str("publisher") ? { publisher: str("publisher") } : {}),
    ...(str("language") ? { language: str("language") } : {}),
    ...(num("pages") ? { pages: num("pages") } : {}),
    ...(str("extension") ? { extension: str("extension") } : {}),
    ...(num("filesize") ? { filesize: num("filesize") } : {}),
    ...(str("filesizeString") ? { filesizeString: str("filesizeString") } : {}),
    ...(str("md5") ? { md5: str("md5") } : {}),
    ...(str("hash") ? { hash: str("hash") } : {}),
    ...(str("cover") ? { cover: str("cover") } : {}),
    ...(href ? { detailUrl: href } : {}),
    ...(dl ? { downloadPath: dl } : {}),
    ...(str("readOnlineUrl") ? { readOnlineUrl: str("readOnlineUrl") } : {}),
  };
}

/** zlib 搜索（匿名；429 限流时返回 code=rate_limited） */
export async function searchBooks(qInput: string, opts: { page?: number; limit?: number } = {}): Promise<BookSearchResult> {
  const q = qInput.trim();
  if (!q) return { ok: false, message: "请输入书名" };
  const { zlibBase, proxy } = getBookConfig();
  const page = Math.max(1, Math.min(100, opts.page ?? 1));
  const limit = Math.max(1, Math.min(50, opts.limit ?? 20));

  const body = new URLSearchParams({ q, page: String(page), limit: String(limit), order: "popular" }).toString();
  const url = `${zlibBase.replace(/\/+$/, "")}/api/search`;

  /** 执行一次搜索请求（带 cookie）；返回原始响应文本 + 状态 */
  async function doSearch(cookie: string): Promise<{ status: number; text: string }> {
    const res = await proxyFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
          "Origin": zlibBase,
          "Referer": `${zlibBase}/s/`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body,
        signal: AbortSignal.timeout(25000),
      },
      proxy,
    );
    return { status: res.status, text: await res.text() };
  }

  try {
    // 访客会话（__ddg* cookie）：解除匿名搜索限额；429 时强制刷新重试一次
    let cookie = await getGuestCookie(zlibBase, proxy);
    let { status, text } = await doSearch(cookie);
    if (status === 429) {
      cookie = await getGuestCookie(zlibBase, proxy, true);
      const retry = await doSearch(cookie);
      status = retry.status;
      text = retry.text;
    }
    if (status === 429) {
      return { ok: false, code: "rate_limited", message: "zlib 搜索被限流（429 Too Many Requests）。请稍后再试，或在下方按钮用浏览器打开 zlib 直接搜索（浏览器登录态不限）。" };
    }
    if (status !== 200) {
      return { ok: false, code: "http_error", message: `zlib 响应异常（HTTP ${status}）` };
    }
    const j = JSON.parse(text) as { success?: number; books?: unknown[]; pagination?: { total?: number; page?: number } };
    if (j.success !== 1 || !Array.isArray(j.books)) {
      return { ok: false, message: "zlib 返回结构异常，请稍后重试" };
    }
    const items = j.books.map((b) => normalizeBook(b as Record<string, unknown>, zlibBase)).filter((x): x is BookItem => !!x);
    addSearchHistory(q, items.length);
    return {
      ok: true,
      items,
      total: j.pagination?.total,
      page,
      base: zlibBase,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = e instanceof DOMException && e.name === "TimeoutError";
    return {
      ok: false,
      code: "network_error",
      message: isTimeout ? "请求 zlib 超时（可能代理不可达）" : `访问 zlib 失败：${msg}`,
    };
  }
}
