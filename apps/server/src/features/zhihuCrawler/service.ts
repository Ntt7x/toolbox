// ============================================================
// 业务模块：知乎爬虫（features/zhihu-crawler）
// - 登录态授权：浏览器内登录（playwright-core + 系统 Chrome）或手动 Cookie
// - 抓取：playwright 渲染列表页并**拦截页面自带的签名 API 响应**（x-zse-96 由页面 JS 自动生成），
//   滚动触发无限加载翻页；人类频率（1.5~3s/滚动）——避免直连被风控（SSR 空壳 + 403）
// - pins 走免签名 API 直连（轻量）；answers/articles 走浏览器拦截
// - 输出：仅文字，转换为 markdown，时间降序合并
// 合规：个人备份用途；仅抓取用户主动指定的目标；频率模拟人类
// ============================================================
import { getSetting, setSetting, deleteSetting } from "../../core/settingsStore.js";
import type { ZhihuComment, ZhihuCrawlItem, ZhihuCrawlKind, ZhihuCrawlResult, ZhihuUserInfo } from "@toolbox/shared";
import { chromium, type BrowserContext } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../core/db.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BASE = "https://www.zhihu.com";
const PROFILE_DIR = join(DATA_DIR, "zhihu-auth-profile");

// ---------- cookie 管理（本地设置数据） ----------
export function getCookie(): string {
  return (getSetting<string>("zhihu.cookie") ?? "").trim();
}
export function saveCookie(cookie: string): void {
  const c = cookie.trim();
  if (c) setSetting("zhihu.cookie", c);
  else deleteSetting("zhihu.cookie");
}
export function hasCookie(): boolean {
  return getCookie().length > 0;
}

// ---------- 基础工具 ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function humanDelay(): Promise<void> {
  await sleep(1500 + Math.floor(Math.random() * 1500));
}

export function extractUrlToken(target: string): string {
  const t = target.trim();
  const m = t.match(/zhihu\.com\/people\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{2,}$/.test(t)) return t;
  return "";
}

// ---------- HTML → Markdown（仅文字） ----------
export function htmlToMarkdown(html: string): string {
  let s = html;
  s = s.replace(/<pre[\s\S]*?<code[^>]*>([\s\S]*?)<\/code>[\s\S]*?<\/pre>/g, (_, c: string) => `\n\`\`\`\n${c}\n\`\`\`\n`);
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/g, (_, c: string) => `\n> ${stripTags(c).replace(/\n/g, "\n> ")}\n`);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "- ");
  s = s.replace(/<h1[^>]*>/gi, "\n# ").replace(/<h2[^>]*>/gi, "\n## ").replace(/<h3[^>]*>/gi, "\n### ");
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_, h: string, t: string) => `[${stripTags(t)}](${h})`);
  s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/g, (_, t: string) => `**${stripTags(t)}**`);
  s = s.replace(/<em[^>]*>([\s\S]*?)<\/em>/g, (_, t: string) => `*${stripTags(t)}*`);
  s = s.replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, (_, a: string) => `[图片：${a}]`);
  s = stripTags(s);
  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

// ---------- 浏览器（playwright + 系统 Chrome/Edge） ----------
const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

function findBrowser(): string | undefined {
  return CHROME_CANDIDATES.find((p) => existsSync(p));
}

/** 浏览器 profile 互斥：auth / crawl 复用同一持久 profile（Chrome 不允许并发占用） */
let browserLock: Promise<unknown> = Promise.resolve();
function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = browserLock.then(fn, fn);
  browserLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** 把本地设置 cookie 注入浏览器上下文（手动粘贴 cookie 时浏览器抓取同样可用） */
function injectCookie(context: BrowserContext): void {
  const cookie = getCookie();
  if (!cookie) return;
  const parts = cookie.split(";");
  const entries = parts
    .map((p) => {
      const eq = p.indexOf("=");
      if (eq <= 0) return null;
      const name = p.slice(0, eq).trim();
      const value = p.slice(eq + 1).trim();
      if (!name) return null;
      return { name, value, domain: ".zhihu.com", path: "/" };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (entries.length > 0) context.addCookies(entries).catch(() => {});
}

async function launchZhihuContext(): Promise<BrowserContext> {
  const exe = findBrowser();
  if (!exe) throw new Error("未找到系统 Chrome/Edge");
  mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: exe,
    headless: true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
  });
  // 隐藏自动化指纹（navigator.webdriver）
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  injectCookie(ctx);
  return ctx;
}

// ---------- 浏览器内登录授权 ----------
export async function authViaBrowser(opts: { signal?: AbortSignal; onProgress?: (msg: string) => void } = {}): Promise<{ ok: boolean; name?: string; message?: string }> {
  return withBrowserLock(async () => {
    const exe = findBrowser();
    if (!exe) return { ok: false, message: "未找到系统 Chrome/Edge，请改用「手动粘贴 Cookie」方式" };
    opts.onProgress?.("正在启动浏览器…");
    mkdirSync(PROFILE_DIR, { recursive: true });
    let context: BrowserContext | null = null;
    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        executablePath: exe,
        headless: false,
        args: ["--no-first-run", "--no-default-browser-check"],
      });
      const page = context.pages()[0] ?? (await context.newPage());
      opts.onProgress?.("已打开登录窗口，请在浏览器中登录知乎（扫码或账号）…");
      await page.goto("https://www.zhihu.com/signin", { timeout: 30000 }).catch(() => {});
      const deadline = Date.now() + 5 * 60 * 1000;
      for (;;) {
        if (opts.signal?.aborted) {
          await context.close().catch(() => {});
          return { ok: false, message: "已取消授权" };
        }
        if (Date.now() > deadline) {
          await context.close().catch(() => {});
          return { ok: false, message: "等待登录超时（5 分钟），请重试" };
        }
        const cookies = await context.cookies();
        if (cookies.some((c) => c.name === "z_c0" && c.value.length > 20)) {
          const zhihu = cookies.filter((c) => c.domain.includes("zhihu.com") || c.domain === ".zhihu.com");
          const cookieStr = zhihu.map((c) => `${c.name}=${c.value}`).join("; ");
          if (!cookieStr) {
            await context.close().catch(() => {});
            return { ok: false, message: "已检测到登录，但未获取到 cookie" };
          }
          saveCookie(cookieStr);
          let name = "";
          try {
            const res = await page.evaluate(async () => {
              const r = await fetch("/api/v4/me", { headers: { Accept: "application/json" } });
              if (!r.ok) return "";
              const j = (await r.json()) as { name?: string };
              return j.name ?? "";
            });
            name = typeof res === "string" ? res : "";
          } catch {
            /* 昵称获取失败不影响授权 */
          }
          await context.close().catch(() => {});
          opts.onProgress?.("登录成功，cookie 已保存");
          return { ok: true, ...(name ? { name } : {}) };
        }
        await sleep(2000);
      }
    } catch (e) {
      if (context) await context.close().catch(() => {});
      return { ok: false, message: `浏览器启动失败：${e instanceof Error ? e.message : String(e)}` };
    }
  });
}

// ---------- 用户信息（免签名 API） ----------
export async function getUserInfo(target: string): Promise<ZhihuUserInfo> {
  const token = extractUrlToken(target);
  if (!token) return { ok: false, message: "无法识别用户（请输入知乎主页 URL 或 urlToken）" };
  const cookie = getCookie();
  const headers: Record<string, string> = { "User-Agent": UA, Referer: `${BASE}/people/${token}` };
  if (cookie) headers.Cookie = cookie;
  try {
    const res = await fetch(`${BASE}/api/v4/members/${token}`, { headers });
    if (res.status === 404) return { ok: false, message: `用户不存在：${token}` };
    if (res.status !== 200) return { ok: false, message: `获取用户信息失败（HTTP ${res.status}）` };
    const j = (await res.json()) as Record<string, unknown>;
    const name = typeof j.name === "string" ? j.name : token;
    const headline = typeof j.headline === "string" ? j.headline : "";
    const countOf = (k: string): number | undefined => (typeof j[k] === "number" ? (j[k] as number) : undefined);
    return {
      ok: true,
      name,
      urlToken: token,
      headline,
      answerCount: countOf("answer_count"),
      articleCount: countOf("articles_count"),
      pinCount: countOf("pins_count"),
    };
  } catch (e) {
    return { ok: false, message: `请求失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---------- 各类型解析（API data 条目 → RawItem） ----------
interface RawItem {
  kind: ZhihuCrawlKind;
  title: string;
  content: string;
  created: number;
  url: string;
  voteup?: number;
}

function parseApiItem(d: Record<string, unknown>, kind: ZhihuCrawlKind): RawItem | null {
  if (!d || typeof d !== "object") return null;
  const content = typeof d.content === "string" ? htmlToMarkdown(d.content) : "";
  const created = typeof d.created_time === "number" ? d.created_time : 0;
  const voteup = typeof d.voteup_count === "number" ? d.voteup_count : undefined;
  const id = typeof d.id === "string" || typeof d.id === "number" ? String(d.id) : "";
  if (kind === "answer") {
    const q = (d.question ?? {}) as Record<string, unknown>;
    const title = typeof q.title === "string" ? q.title : "（问题标题未知）";
    return { kind, title, content, created, url: `${BASE}/question/${String(q.id ?? "")}/answer/${id}`, voteup };
  }
  if (kind === "article") {
    const title = typeof d.title === "string" ? d.title : "（文章标题未知）";
    return { kind, title, content, created, url: `${BASE}/p/${id}`, voteup };
  }
  const title = content.split("\n")[0]?.slice(0, 40) ?? "";
  return { kind, title, content, created, url: `${BASE}/pin/${id}`, voteup };
}

// ---------- pins API（免签名，直连翻页） ----------
async function fetchPinsApi(token: string, limit: number, signal?: AbortSignal): Promise<RawItem[]> {
  const out: RawItem[] = [];
  const cookie = getCookie();
  const headers: Record<string, string> = { "User-Agent": UA, Referer: `${BASE}/people/${token}` };
  if (cookie) headers.Cookie = cookie;
  let offset = 0;
  for (;;) {
    if (signal?.aborted) break;
    const res = await fetch(`${BASE}/api/v4/members/${token}/pins?limit=20&offset=${offset}`, { headers, signal });
    if (res.status !== 200) break;
    const j = (await res.json()) as { data?: Record<string, unknown>[]; paging?: { is_end?: boolean } };
    const data = Array.isArray(j.data) ? j.data : [];
    for (const p of data) {
      const item = parseApiItem(p, "pin");
      if (item) out.push(item);
    }
    if (limit > 0 && out.length >= limit) break;
    if (!j.paging || j.paging.is_end !== false || data.length === 0) break;
    offset += data.length;
    await humanDelay();
  }
  return out;
}

// ---------- 浏览器渲染 + 拦截签名 API（answers/articles） ----------
/** 从 comment_v5 评论条目解析「作者参与的评论」（含回复上下文）；与作者无关的评论返回 null（导出供单测） */
export function parseZhihuComment(c: Record<string, unknown>, token: string): ZhihuComment | null {
  const id = c.id !== undefined && c.id !== null ? String(c.id) : "";
  if (!id) return null;
  const authorRaw = (c.author ?? {}) as Record<string, unknown>;
  const authorToken = typeof authorRaw.url_token === "string" ? authorRaw.url_token : "";
  const author = typeof authorRaw.name === "string" ? authorRaw.name : authorToken;
  const content = typeof c.content === "string" ? htmlToMarkdown(c.content) : "";
  const createdAt = typeof c.created_time === "number" ? new Date(c.created_time * 1000).toISOString() : "";
  // 回复目标（comment_v5：reply_author_tag 标记被回复者；顶层评论无）
  const replyTag = typeof c.reply_author_tag === "string" ? c.reply_author_tag : "";
  const replyTo = replyTag && replyTag !== author ? replyTag : undefined;
  // 子评论（递归：子级含作者参与则保留父为上下文）
  const children: ZhihuComment[] = [];
  if (Array.isArray(c.child_comments)) {
    for (const cc of c.child_comments) {
      const p = parseZhihuComment(cc as Record<string, unknown>, token);
      if (p) children.push(p);
    }
  }
  const self = authorToken === token || c.is_author === true; // 作者自己发表的评论（is_author 为内容作者标记）
  const repliedTo = replyTag ? replyTag === authorToken || replyTag === token : false; // 作者回复了这条
  if (!self && !repliedTo && children.length === 0) return null;
  return { id, author, content, createdAt, ...(replyTo ? { replyTo } : {}), ...(children.length ? { children } : {}) };
}

/**
 * 抓取一组内容的评论（作者参与讨论的部分 + 上下文）：
 * 同一浏览器 context 内逐个打开详情页 → 拦截 /api/v4/comments 响应 → 滚动加载 → 筛选附加。
 */
async function crawlCommentsBatch(
  token: string,
  items: ZhihuCrawlItem[],
  signal?: AbortSignal,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const targets = items; // 抓取全部内容的评论（用户要求）
  if (targets.length === 0) return;
  return withBrowserLock(async () => {
    let context: BrowserContext | null = null;
    try {
      context = await launchZhihuContext();
      const page = context.pages()[0] ?? (await context.newPage());
      for (let idx = 0; idx < targets.length; idx++) {
        const item = targets[idx];
        if (signal?.aborted) break;
        const comments: ZhihuComment[] = [];
        const seen = new Set<string>();
        const listener = async (res: { url: () => string; status: () => number; json: () => Promise<unknown> }) => {
          if (signal?.aborted) return;
          const u = res.url();
          if (u.includes("/api/v4/comment_v5") && u.includes("root_comment") && res.status() === 200) {
            try {
              const j = (await res.json()) as { data?: unknown[] };
              const data = Array.isArray(j.data) ? j.data : [];
              for (const d of data) {
                const p = parseZhihuComment(d as Record<string, unknown>, token);
                if (p && !seen.has(p.id)) {
                  seen.add(p.id);
                  comments.push(p);
                }
              }
            } catch {
              /* ignore */
            }
          }
        };
        page.on("response", listener);
        onProgress?.(`抓取评论 ${idx + 1}/${targets.length}：${item.title?.slice(0, 20)}…`);
        await page.goto(item.url, { timeout: 30000, waitUntil: "domcontentloaded" }).catch(() => {});
        // 知乎评论默认折叠：优先点「N 条评论」（数字评论列表入口）→「查看全部评论」→「添加评论」
        await page.waitForTimeout(1200);
        await page
          .evaluate(() => {
            const btns = [...document.querySelectorAll("button")];
            const num = btns.find((b) => /(\d+) 条评论/.test(b.textContent ?? ""));
            const all = num || btns.find((b) => /查看全部评论/.test(b.textContent ?? ""));
            const any = all || btns.find((b) => /添加评论/.test(b.textContent ?? ""));
            if (any) (any as HTMLElement).click();
          })
          .catch(() => {});
        // 滚动加载评论（知乎评论翻页：滚动到评论列表底部触发 offset 递增）
        let stuck = 0;
        for (let i = 0; i < 15; i++) {
          if (signal?.aborted) break;
          const before = comments.length;
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
          await sleep(1500 + Math.floor(Math.random() * 1000));
          if (comments.length === before) {
            stuck++;
            if (stuck >= 3) break;
          } else {
            stuck = 0;
          }
        }
        page.off("response", listener);
        if (comments.length > 0) item.comments = comments;
        await sleep(1000);
      }
    } catch (e) {
      onProgress?.(`评论抓取异常：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (context) await context.close().catch(() => {});
    }
  });
}

async function crawlKindWithBrowser(
  token: string,
  kind: ZhihuCrawlKind,
  limit: number,
  signal?: AbortSignal,
  onProgress?: (msg: string) => void,
): Promise<RawItem[]> {
  return withBrowserLock(async () => {
    const items: RawItem[] = [];
    const seen = new Set<string>();
    const listPage = kind === "answer" ? "answers" : "articles";
    const apiPath = `/api/v4/members/${token}/${listPage}`;
    let context: BrowserContext | null = null;
    try {
      context = await launchZhihuContext();
      const page = context.pages()[0] ?? (await context.newPage());
      // 拦截页面自带的签名 API 响应（x-zse-96 由页面 JS 自动生成）
      page.on("response", async (res) => {
        if (signal?.aborted) return;
        const u = res.url();
        if (u.includes(apiPath) && res.status() === 200) {
          try {
            const j = (await res.json()) as { data?: unknown[] };
            const data = Array.isArray(j.data) ? j.data : [];
            for (const d of data) {
              const item = parseApiItem(d as Record<string, unknown>, kind);
              if (item && !seen.has(item.url)) {
                seen.add(item.url);
                items.push(item);
              }
            }
          } catch {
            /* 响应体非 JSON（如被重定向）忽略 */
          }
        }
      });
      onProgress?.(`正在打开 ${kindLabel(kind)}列表页…`);
      await page.goto(`${BASE}/people/${token}/${listPage}`, { timeout: 30000, waitUntil: "domcontentloaded" }).catch(() => {});
      // 检测风控拦截（40362：页面返回错误 JSON）
      await page.waitForTimeout(1500);
      const blocked = await page.evaluate(() => {
        const t = document.body?.innerText ?? "";
        return t.includes("暂时限制本次访问") || t.includes("40362");
      });
      if (blocked) {
        onProgress?.(`${kindLabel(kind)}：页面被知乎风控拦截（40362），请稍等 1~2 分钟后再试`);
        return items;
      }
      // 等待首次数据
      for (let i = 0; i < 15 && items.length === 0 && !signal?.aborted; i++) await sleep(1000);
      // 滚动翻页（无限加载）；人类频率 1.5~3s
      let stuck = 0;
      for (let i = 0; i < 40; i++) {
        if (signal?.aborted) break;
        if (limit > 0 && items.length >= limit) break;
        const before = items.length;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
        await sleep(1500 + Math.floor(Math.random() * 1500));
        if (items.length === before) {
          stuck++;
          if (stuck >= 3) break; // 连续无新数据 → 到底
        } else {
          stuck = 0;
          onProgress?.(`${kindLabel(kind)}已抓取 ${items.length} 条…`);
        }
      }
    } catch (e) {
      onProgress?.(`${kindLabel(kind)}异常：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (context) await context.close().catch(() => {});
    }
    return items;
  });
}

// ---------- 主抓取流程 ----------
export interface CrawlProgress {
  kind: string;
  fetched: number;
  message: string;
}

export async function crawlUser(
  target: string,
  opts: { types?: ZhihuCrawlKind[]; limit?: number; signal?: AbortSignal; onProgress?: (p: CrawlProgress) => void },
): Promise<ZhihuCrawlResult> {
  const token = extractUrlToken(target);
  if (!token) return { ok: false, message: "无法识别用户（请输入知乎主页 URL 或 urlToken）" };
  if (!hasCookie()) return { ok: false, message: "未配置知乎登录 cookie（浏览器登录授权或手动粘贴），请先在页面设置" };

  const info = await getUserInfo(target);
  if (!info.ok) return { ok: false, message: info.message };

  const types = opts.types?.length ? opts.types : (["answer", "article", "pin"] as ZhihuCrawlKind[]);
  const limit = Math.max(0, Math.min(opts.limit ?? 0, 500));
  const all: RawItem[] = [];

  for (const kind of types) {
    if (opts.signal?.aborted) break;
    opts.onProgress?.({ kind, fetched: all.length, message: `开始抓取 ${kindLabel(kind)}…` });
    try {
      if (kind === "pin") {
        // 想法：免签名 API 直连翻页（轻量）
        const pins = await fetchPinsApi(token, limit, opts.signal);
        all.push(...pins);
        opts.onProgress?.({ kind, fetched: pins.length, message: `想法抓取完成（${pins.length} 条）` });
      } else {
        // 回答/文章：浏览器渲染 + 拦截签名 API + 滚动翻页
        const items = await crawlKindWithBrowser(token, kind, limit, opts.signal, (msg) =>
          opts.onProgress?.({ kind, fetched: all.length, message: msg }),
        );
        all.push(...items);
        opts.onProgress?.({ kind, fetched: items.length, message: `${kindLabel(kind)}抓取完成（${items.length} 条）` });
      }
    } catch (e) {
      opts.onProgress?.({ kind, fetched: all.length, message: `${kindLabel(kind)}：异常 ${e instanceof Error ? e.message : String(e)}` });
    }
    if (opts.signal?.aborted) break;
    await humanDelay();
  }

  if (opts.signal?.aborted) return { ok: false, message: "已取消" };

  const items = all
    .filter((i) => i.content.length > 0 || i.title)
    .sort((a, b) => b.created - a.created)
    .slice(0, limit > 0 ? limit : undefined)
    .map((i) => ({
      kind: i.kind,
      title: i.title || (i.content.split("\n")[0]?.slice(0, 40) ?? ""),
      content: i.content,
      createdAt: new Date(i.created * 1000).toISOString(),
      url: i.url,
      ...(i.voteup !== undefined ? { voteupCount: i.voteup } : {}),
    }));

  // 抓取作者参与讨论的评论（含上下文；全部内容，人类频率）
  if (!opts.signal?.aborted && items.length > 0) {
    opts.onProgress?.({ kind: "comment", fetched: items.length, message: `抓取评论（全部 ${items.length} 条内容，作者参与的讨论；内容多时耗时较长，可随时停止）…` });
    await crawlCommentsBatch(token, items, opts.signal, (msg) => opts.onProgress?.({ kind: "comment", fetched: items.length, message: msg }));
  }

  if (opts.signal?.aborted) return { ok: false, message: "已取消" };

  return {
    ok: true,
    user: { name: info.name ?? token, urlToken: token, ...(info.headline ? { headline: info.headline } : {}) },
    items,
    total: items.length,
  };
}

function kindLabel(kind: ZhihuCrawlKind): string {
  return kind === "answer" ? "回答" : kind === "article" ? "文章" : "想法";
}
