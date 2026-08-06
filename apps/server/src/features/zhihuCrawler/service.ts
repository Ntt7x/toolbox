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
import type { ZhihuComment, ZhihuCrawlItem, ZhihuCrawlKind, ZhihuCrawlProgress, ZhihuCrawlResult, ZhihuUserInfo } from "@toolbox/shared";
import { chromium, type BrowserContext } from "playwright-core";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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
  await sleep(3000 + Math.floor(Math.random() * 3000));
}

export function extractUrlToken(target: string): string {
  const t = target.trim();
  const m = t.match(/zhihu\.com\/people\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{2,}$/.test(t)) return t;
  return "";
}

// ---------- 目标解析：支持用户/问题/回答/文章/想法链接，或包含链接的分享文本（自动提取） ----------
export interface ZhihuTargetInfo {
  kind: "user" | "question" | "answer" | "article" | "pin" | "unknown";
  /** urlToken / 问题 id / 回答 id / 文章 id */
  ref: string;
  url?: string;
  label: string;
}

const ZH_LINK_RE = /https?:\/\/(?:[\w-]+\.)?zhihu\.com\/[^\s"'“”，。；;]+/g;

export function parseZhihuTarget(input: string): ZhihuTargetInfo {
  const t = input.trim();
  // 0) 专栏域必须最先匹配：zhuanlan.zhihu.com/p/xxx 与 zhihu.com/p/xxx 是不同 id 体系，专栏文章须保留 zhuanlan 域名
  const zl = t.match(/zhuanlan\.zhihu\.com\/p\/([A-Za-z0-9_-]+)/);
  if (zl) return { kind: "article", ref: zl[1], url: `https://zhuanlan.zhihu.com/p/${zl[1]}`, label: `专栏文章 ${zl[1]}` };
  // 1) 直接是知乎链接 → 按路径识别类型（answer 路径需在 question 之前匹配：question/{qid}/answer/{aid}）
  const ans = t.match(/zhihu\.com\/question\/(\d+)\/answer\/(\d+)/);
  if (ans) return { kind: "answer", ref: ans[2], url: `${BASE}/question/${ans[1]}/answer/${ans[2]}`, label: `回答 ${ans[2]}` };
  const m = t.match(/zhihu\.com\/([a-z]+)\/([A-Za-z0-9_-]+)/);
  if (m) {
    const type = m[1];
    const id = m[2];
    if (type === "people") return { kind: "user", ref: id, url: `${BASE}/people/${id}`, label: `用户 ${id}` };
    if (type === "question") return { kind: "question", ref: id, url: `${BASE}/question/${id}`, label: `问题 ${id}` };
    if (type === "p") return { kind: "article", ref: id, url: `${BASE}/p/${id}`, label: `文章 ${id}` };
    if (type === "pin") return { kind: "pin", ref: id, url: `${BASE}/pin/${id}`, label: `想法 ${id}` };
    return { kind: "unknown", ref: id, url: t, label: t.slice(0, 60) };
  }
  // 2) 分享文本：从任意文本中提取知乎链接（取第一个）
  const links = [...t.matchAll(ZH_LINK_RE)].map((x) => x[0]);
  if (links.length > 0) return parseZhihuTarget(links[0]);
  // 3) 裸 token → 用户
  if (/^[A-Za-z0-9_-]{2,}$/.test(t)) return { kind: "user", ref: t, url: `${BASE}/people/${t}`, label: `用户 ${t}` };
  return { kind: "unknown", ref: "", label: t.slice(0, 60) };
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

async function launchZhihuContext(retries = 3): Promise<BrowserContext> {
  const exe = findBrowser();
  if (!exe) throw new Error("未找到系统 Chrome/Edge");
  mkdirSync(PROFILE_DIR, { recursive: true });
  // Windows Chrome profile 独占锁：连续 launch 同 profile 可能因前一个未完全退出失败 → 等待重试
  for (let i = 0; i < retries; i++) {
    try {
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
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(1500 + i * 1000);
      // 失败重试前清除 profile 锁：残留 Chrome 子进程锁文件导致同 profile 无法再启动；
      // 删除 profile 目录重建（登录 cookie 经 injectCookie 注入，不影响授权）
      rmSync(PROFILE_DIR, { recursive: true, force: true });
    }
  }
  throw new Error("浏览器启动失败（多次重试）");
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
    // 用响应内 offset 续页（比固定步长更稳；next 形如 ...offset=40&limit=20）
    const next = (j.paging as { next?: string }).next ?? "";
    const m = next.match(/[?&]offset=(\d+)/);
    offset = m ? Number(m[1]) : offset + data.length;
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
        // 滚动加载评论（不限制数量：滚动至评论区到底、连续无新数据即停止；知乎评论翻页靠滚动到底触发）
        let stuck = 0;
        let blocked = false;
        for (let i = 0; i < 200; i++) {
          if (signal?.aborted) break;
          const before = comments.length;
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
          await sleep(2500 + Math.floor(Math.random() * 2000));
          // 风控熔断：页面被限流（40362）立即停止，不重试风暴
          if (!blocked) {
            blocked = await page
              .evaluate(() => {
                const t = document.body?.innerText ?? "";
                return t.includes("暂时限制本次访问") || t.includes("40362");
              })
              .catch(() => false);
          }
          if (blocked) {
            onProgress?.(`评论抓取被风控拦截（40362），已保留已抓取部分，请稍后再试`);
            break;
          }
          if (comments.length === before) {
            stuck++;
            if (stuck >= 3) break; // 连续无新数据 → 评论区已到底
          } else {
            stuck = 0;
          }
        }
        page.off("response", listener);
        if (comments.length > 0) item.comments = comments;
        await sleep(2000);
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
      for (let i = 0; i < 15 && items.length === 0 && !signal?.aborted; i++) await sleep(2000);
      // 滚动翻页（无限加载）；人类频率 1.5~3s
      let stuck = 0;
      for (let i = 0; i < 40; i++) {
        if (signal?.aborted) break;
        if (limit > 0 && items.length >= limit) break;
        const before = items.length;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
        await sleep(3000 + Math.floor(Math.random() * 3000));
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

// ---------- 问题/单条内容抓取（标准链接目标） ----------
/** 抓取问题下的回答（浏览器拦截 /api/v4/questions/{qid}/answers，滚动加载回答流） */
async function crawlQuestionAnswers(
  qid: string,
  opts: { limit?: number; dateFrom?: string; dateTo?: string; signal?: AbortSignal; onProgress?: (msg: string) => void },
): Promise<ZhihuCrawlItem[]> {
  const items: ZhihuCrawlItem[] = [];
  const seen = new Set<string>();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  return withBrowserLock(async () => {
    let context: BrowserContext | null = null;
    try {
      context = await launchZhihuContext();
      const page = context.pages()[0] ?? (await context.newPage());
      const apiPath = `/api/v4/questions/${qid}/answers`;
      page.on("response", async (res) => {
        if (opts.signal?.aborted) return;
        const u = res.url();
        if (u.includes(apiPath) && res.status() === 200) {
          try {
            const j = (await res.json()) as { data?: unknown[] };
            const data = Array.isArray(j.data) ? j.data : [];
            for (const d of data) {
              const item = parseApiItem(d as Record<string, unknown>, "answer");
              if (item && !seen.has(item.url)) {
                seen.add(item.url);
                items.push(toItem(item));
              }
            }
          } catch {
            /* ignore */
          }
        }
      });
      opts.onProgress?.(`正在打开问题页…`);
      await page.goto(`${BASE}/question/${qid}`, { timeout: 30000, waitUntil: "domcontentloaded" }).catch(() => {});
      // 等待首屏回答
      for (let i = 0; i < 15 && items.length === 0 && !opts.signal?.aborted; i++) await sleep(1000);
      // 滚动加载回答流（人类频率）
      let stuck = 0;
      for (let i = 0; i < 60; i++) {
        if (opts.signal?.aborted) break;
        if (items.length >= limit) break;
        const before = items.length;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
        await sleep(2500 + Math.floor(Math.random() * 2000));
        if (items.length === before) {
          stuck++;
          if (stuck >= 3) break;
        } else {
          stuck = 0;
          opts.onProgress?.(`已收集 ${items.length} 个回答…`);
        }
      }
    } catch (e) {
      opts.onProgress?.(`问题抓取异常：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (context) await context.close().catch(() => {});
    }
    return items;
  });
}

/** 抓取单条内容（回答/文章/想法：打开详情页，从 DOM 提取正文） */
async function crawlSingleContent(
  info: ZhihuTargetInfo,
  opts: { signal?: AbortSignal; onProgress?: (msg: string) => void },
): Promise<ZhihuCrawlItem | null> {
  return withBrowserLock(async () => {
    let context: BrowserContext | null = null;
    try {
      context = await launchZhihuContext();
      const page = context.pages()[0] ?? (await context.newPage());
      opts.onProgress?.(`正在打开内容页…`);
      await page.goto(info.url ?? `${BASE}/question/${info.ref}`, { timeout: 30000, waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(3000);
      const content = await page
        .evaluate((kind) => {
          const selectors: Record<string, string[]> = {
            answer: [".RichContent-inner", ".RichText", ".AnswerCard .RichContent", ".RichText.ztext"],
            article: [".Post-RichTextContainer", ".Post-Content", ".RichText.ztext", ".Post-RichText", ".ArticleContent"],
            pin: [".Pin .RichText", ".PinItem .RichText"],
          };
          for (const sel of selectors[kind] ?? []) {
            const el = document.querySelector(sel);
            if (el && el.textContent && el.textContent.trim().length > 30) return el.textContent.trim();
          }
          return "";
        }, info.kind)
        .catch(() => "");
      const title = (await page.title().catch(() => "")).replace(/\s*-\s*知乎$/, "").slice(0, 120);
      if (!content) {
        opts.onProgress?.(`未能从页面提取到正文（可能被风控拦截或页面结构变化）`);
        return null;
      }
      return {
        kind: info.kind === "article" ? "article" : info.kind === "pin" ? "pin" : "answer",
        title: title || info.label,
        content: htmlToMarkdown(content),
        createdAt: new Date().toISOString(),
        url: info.url ?? `${BASE}/question/${info.ref}`,
      };
    } finally {
      if (context) await context.close().catch(() => {});
    }
  });
}

// ---------- 主抓取流程（支持断点续爬：数量上限/超时自动暂停、取消返回已抓结果、续爬 seed） ----------
export interface CrawlProgress {
  kind: string;
  fetched: number;
  message: string;
}

export interface CrawlOptions {
  types?: ZhihuCrawlKind[];
  /** 总数目标上限（默认 20；硬上限 100） */
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
  signal?: AbortSignal;
  onProgress?: (p: CrawlProgress) => void;
  /** 断点 id（续爬时复用；暂停/取消后返回给前端） */
  progressId?: string;
  /** 续爬：已抓取的结果（按 url 去重，跳过已抓） */
  seed?: ZhihuCrawlItem[];
  /** 续爬：评论阶段是否已完成 */
  commentsDone?: boolean;
  /** 续爬起点类型下标（之前的类型已抓满/完成） */
  phaseIndex?: number;
  /** 单次任务数量硬上限（默认 100） */
  maxTotal?: number;
  /** 单次任务超时（默认 20 分钟；触碰后自动暂停） */
  deadlineMs?: number;
  /** 进度持久化回调（index 注入写 KV） */
  saveProgress?: (snap: ZhihuCrawlProgress) => void;
}

function toItem(i: RawItem): ZhihuCrawlItem {
  return {
    kind: i.kind,
    title: i.title || (i.content.split("\n")[0]?.slice(0, 40) ?? ""),
    content: i.content,
    createdAt: new Date(i.created * 1000).toISOString(),
    url: i.url,
    ...(i.voteup !== undefined ? { voteupCount: i.voteup } : {}),
  };
}

function dateInRange(created: number, dateFrom?: string, dateTo?: string): boolean {
  const d = new Date(created * 1000);
  if (dateFrom) {
    const from = new Date(dateFrom);
    from.setHours(0, 0, 0, 0);
    if (d < from) return false;
  }
  if (dateTo) {
    const to = new Date(dateTo);
    to.setHours(23, 59, 59, 999);
    if (d > to) return false;
  }
  return true;
}

export async function crawlUser(target: string, opts: CrawlOptions = {}): Promise<ZhihuCrawlResult> {
  // 目标解析：支持用户主页/问题/回答/文章/想法链接，或包含链接的分享文本（自动提取）
  const ti = parseZhihuTarget(target);
  if (ti.kind === "unknown") return { ok: false, message: `无法识别的知乎目标：${ti.label || "（请输入用户主页、问题/回答/文章链接，或包含知乎链接的文本）"}` };
  if (ti.kind === "question") {
    // 问题 → 抓回答流（单目标，简单暂停/取消语义）
    const warnings: string[] = [];
    const deadline = Date.now() + (opts.deadlineMs ?? 20 * 60 * 1000);
    const items = await crawlQuestionAnswers(ti.ref, {
      limit: opts.limit,
      dateFrom: opts.dateFrom,
      dateTo: opts.dateTo,
      signal: opts.signal,
      onProgress: (msg) => opts.onProgress?.({ kind: "question", fetched: 0, message: msg }),
    });
    const filtered = items.filter((it) => dateInRange(new Date(it.createdAt).getTime() / 1000, opts.dateFrom, opts.dateTo));
    if (filtered.length === 0) warnings.push(`问题下未获取到回答（可能无回答、被风控拦截，或所选日期范围内无回答）`);
    if (Date.now() > deadline) warnings.push("单次任务超过 20 分钟超时，已自动停止");
    if (opts.signal?.aborted) warnings.push("已取消");
    const result = {
      ok: true as const,
      items: filtered,
      total: filtered.length,
      ...(warnings.length ? { warnings } : {}),
    };
    return opts.signal?.aborted ? { ...result, partial: true, cancelled: true, progressId: `zhp-${Date.now().toString(36)}` } : result;
  }
  if (ti.kind === "answer" || ti.kind === "article" || ti.kind === "pin") {
    const item = await crawlSingleContent(ti, { signal: opts.signal, onProgress: (msg) => opts.onProgress?.({ kind: ti.kind, fetched: 0, message: msg }) });
    const items = item ? [item] : [];
    return {
      ok: true,
      items,
      total: items.length,
      ...(items.length === 0 ? { warnings: ["未能提取到内容（可能被风控拦截、Cookie 失效或页面结构变化）"] } : {}),
    };
  }
  // 用户：token = ti.ref
  const token = ti.ref;
  if (!token) return { ok: false, message: "无法识别用户（请输入知乎主页 URL 或 urlToken）" };
  if (!hasCookie()) return { ok: false, message: "未配置知乎登录 cookie（浏览器登录授权或手动粘贴），请先在页面设置" };

  const info = await getUserInfo(target);
  if (!info.ok) return { ok: false, message: info.message };

  const types = opts.types?.length ? opts.types : (["answer", "article", "pin"] as ZhihuCrawlKind[]);
  // 每类目标（默认 20，上限 100）；单次任务总数硬上限（默认 100）
  const perKindLimit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const maxTotal = Math.min(Math.max(opts.maxTotal ?? 100, 1), 500);
  const progressId = opts.progressId ?? `zhp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const deadline = Date.now() + (opts.deadlineMs ?? 20 * 60 * 1000);

  // 续爬：seed 作为已抓集合（去重 + 每类计数）
  const seed = Array.isArray(opts.seed) ? opts.seed : [];
  const seen = new Set(seed.map((s) => s.url));
  const items: ZhihuCrawlItem[] = [...seed];
  const kindCount = new Map<ZhihuCrawlKind, number>();
  for (const s of seed) kindCount.set(s.kind, (kindCount.get(s.kind) ?? 0) + 1);
  const commentsDone = opts.commentsDone === true;
  const startPhase = Math.min(Math.max(opts.phaseIndex ?? 0, 0), Math.max(types.length - 1, 0));
  // 诊断信息（各类型失败/0 结果/风控原因）
  const warnings: string[] = [];

  const emitProgress = (kind: string, message: string) => opts.onProgress?.({ kind, fetched: items.length, message });
  const snapshot = (phaseIndex: number): ZhihuCrawlProgress => ({
    progressId,
    token,
    types,
    limit: perKindLimit,
    ...(opts.dateFrom ? { dateFrom: opts.dateFrom } : {}),
    ...(opts.dateTo ? { dateTo: opts.dateTo } : {}),
    items,
    commentsDone,
    phaseIndex,
    startedAt: Date.now() - (Date.now() - deadline + (opts.deadlineMs ?? 20 * 60 * 1000)),
    updatedAt: Date.now(),
  });
  const persist = (phaseIndex: number) => opts.saveProgress?.(snapshot(phaseIndex));

  // 类型循环（从续爬起点开始；单类达每类目标 → 下一类；总数达硬上限/超时 → 暂停）
  let paused = false;
  let finalPhase = startPhase;
  for (let ki = startPhase; ki < types.length; ki++) {
    finalPhase = ki;
    const kind = types[ki];
    if (opts.signal?.aborted) break;
    if (Date.now() > deadline || items.length >= maxTotal) {
      paused = true;
      break;
    }
    const gotCount = kindCount.get(kind) ?? 0;
    if (gotCount >= perKindLimit) continue; // 该类已满 → 下一类
    emitProgress(kind, `开始抓取 ${kindLabel(kind)}（已有 ${gotCount}/${perKindLimit}，目标 ${perKindLimit}）…`);
    const beforeKind = gotCount;
    try {
      const remaining = perKindLimit - gotCount;
      if (kind === "pin") {
        const pins = await fetchPinsApi(token, remaining, opts.signal);
        for (const p of pins) {
          if ((kindCount.get(kind) ?? 0) >= perKindLimit) break;
          if (seen.has(p.url)) continue;
          seen.add(p.url);
          if (dateInRange(p.created, opts.dateFrom, opts.dateTo)) {
            items.push(toItem(p));
            kindCount.set(kind, (kindCount.get(kind) ?? 0) + 1);
          }
        }
        emitProgress(kind, `想法本轮 +${pins.length}，累计 ${kindCount.get(kind) ?? 0}/${perKindLimit}（总数 ${items.length}）`);
      } else {
        const got = await crawlKindWithBrowser(token, kind, remaining, opts.signal, (msg) => emitProgress(kind, msg));
        for (const g of got) {
          if ((kindCount.get(kind) ?? 0) >= perKindLimit) break; // 知乎 API 单次返回一页，避免超该类目标
          if (seen.has(g.url)) continue;
          seen.add(g.url);
          if (dateInRange(g.created, opts.dateFrom, opts.dateTo)) {
            items.push(toItem(g));
            kindCount.set(kind, (kindCount.get(kind) ?? 0) + 1);
          }
        }
        emitProgress(kind, `${kindLabel(kind)}本轮 +${got.length}，累计 ${kindCount.get(kind) ?? 0}/${perKindLimit}（总数 ${items.length}）`);
      }
    } catch (e) {
      const msg = `${kindLabel(kind)}：${e instanceof Error ? e.message : String(e)}`;
      emitProgress(kind, msg);
      warnings.push(msg);
    }
    // 0 结果诊断：该类没有抓到任何内容（含续爬 seed 统计），提示可能原因
    if ((kindCount.get(kind) ?? 0) === 0 && (kindCount.get(kind) ?? 0) === beforeKind && kind === types[ki]) {
      warnings.push(`${kindLabel(kind)}：未获取到内容（可能该用户无${kindLabel(kind)}、被风控拦截，或所选日期范围内无${kindLabel(kind)}）`);
    }
    if (Date.now() > deadline || items.length >= maxTotal) {
      paused = true;
      break;
    }
    if (opts.signal?.aborted) break;
    await humanDelay();
  }

  // 评论阶段（全部类型处理完且未暂停/取消；续爬跳过已完成）
  if (!paused && !opts.signal?.aborted && !commentsDone && items.length > 0) {
    emitProgress("comment", `抓取评论（全部 ${items.length} 条内容，作者参与的讨论；可随时停止）…`);
    const commentWarnings: string[] = [];
    await crawlCommentsBatch(token, items, opts.signal, (msg) => {
      emitProgress("comment", msg);
      // 评论阶段的风控/异常提示收集为诊断信息
      if (/风控|异常|失败/.test(msg)) commentWarnings.push(msg);
    });
    for (const w of commentWarnings) if (!warnings.includes(w)) warnings.push(w);
    if (Date.now() > deadline || items.length >= maxTotal) paused = true; // 评论阶段触碰限制 → 暂停（已抓保留）
  }

  // 结果（时间降序）
  const finalItems = items.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  // 全部 0 结果 → 汇总原因（去重后至多 3 条）
  if (finalItems.length === 0 && warnings.length === 0) {
    warnings.push("未获取到任何内容：可能用户无创作、被风控拦截，或所选日期范围内无内容（可检查 Cookie 是否有效后重试）");
  }
  const warn = warnings.length > 0 ? [...new Set(warnings)].slice(0, 5) : undefined;
  const base = {
    ok: true as const,
    user: { name: info.name ?? token, urlToken: token, ...(info.headline ? { headline: info.headline } : {}) },
    items: finalItems,
    total: finalItems.length,
    ...(warn ? { warnings: warn } : {}),
  };

  // 暂停/取消 → 保存进度供续爬，返回已抓结果
  if (opts.signal?.aborted) {
    persist(finalPhase);
    return { ...base, partial: true, cancelled: true, progressId };
  }
  if (paused) {
    persist(finalPhase);
    return { ...base, partial: true, paused: true, progressId };
  }
  return base;
}

function kindLabel(kind: ZhihuCrawlKind): string {
  return kind === "answer" ? "回答" : kind === "article" ? "文章" : "想法";
}
