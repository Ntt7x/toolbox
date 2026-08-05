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
  try {
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
        },
        body,
        signal: AbortSignal.timeout(25000),
      },
      proxy,
    );
    const text = await res.text();
    if (res.status === 429) {
      return { ok: false, code: "rate_limited", message: "zlib 匿名搜索被限流（429 Too Many Requests）。请稍后再试，或在下方按钮用浏览器打开 zlib 直接搜索（浏览器登录态不限）。" };
    }
    if (!res.ok) {
      return { ok: false, code: "http_error", message: `zlib 响应异常（HTTP ${res.status}）` };
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
