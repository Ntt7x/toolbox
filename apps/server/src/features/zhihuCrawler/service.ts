// ============================================================
// 业务模块：知乎爬虫（features/zhihu-crawler）
// - 用户授权登录态（浏览器 cookie，存本地设置数据 settings:zhihu.cookie）
// - 以人类频率（3~6s 随机间隔）抓取某用户的时间降序创作内容
// - 内容源：pins 走免签名 API；answers/articles 走带 cookie 的 SSR HTML（js-initialData）
// - 输出：仅文字，转换为 markdown
// 合规：个人备份用途；仅抓取用户主动指定的目标；频率模拟人类，避免对服务造成压力
// ============================================================
import { getSetting, setSetting, deleteSetting } from "../../core/settingsStore.js";
import type { ZhihuCrawlKind, ZhihuCrawlResult, ZhihuUserInfo } from "@toolbox/shared";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BASE = "https://www.zhihu.com";

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

// ---------- 请求工具（人类频率） ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function humanDelay(): Promise<void> {
  await sleep(3000 + Math.floor(Math.random() * 3000)); // 3~6s 随机
}

async function fetchZhihu(path: string): Promise<{ status: number; text: string }> {
  const cookie = getCookie();
  const token = extractUrlToken(path) ?? "";
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: `${BASE}/people/${token}`,
  };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { headers });
  const text = await res.text();
  return { status: res.status, text };
}

// ---------- urlToken 解析 ----------
export function extractUrlToken(target: string): string {
  const t = target.trim();
  // https://www.zhihu.com/people/{token} 或 /people/{token}/answers
  const m = t.match(/zhihu\.com\/people\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  // 裸 token（字母数字下划线连字符）
  if (/^[A-Za-z0-9_-]{2,}$/.test(t)) return t;
  return "";
}

// ---------- js-initialData 解析 ----------
function parseInitialData(html: string): Record<string, unknown> | null {
  const m = html.match(/<script id="js-initialData"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]);
    return j?.initialState && typeof j.initialState === "object" ? j.initialState : j;
  } catch {
    return null;
  }
}

// ---------- HTML → Markdown（仅文字） ----------
export function htmlToMarkdown(html: string): string {
  let s = html;
  // 代码块
  s = s.replace(/<pre[\s\S]*?<code[^>]*>([\s\S]*?)<\/code>[\s\S]*?<\/pre>/g, (_, c: string) => `\n\`\`\`\n${c}\n\`\`\`\n`);
  // 引用
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/g, (_, c: string) => `\n> ${stripTags(c).replace(/\n/g, "\n> ")}\n`);
  // 换行标签
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n");
  // 列表
  s = s.replace(/<li[^>]*>/gi, "- ");
  // 标题
  s = s.replace(/<h1[^>]*>/gi, "\n# ").replace(/<h2[^>]*>/gi, "\n## ").replace(/<h3[^>]*>/gi, "\n### ");
  // 链接 → [text](href)
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_, h: string, t: string) => `[${stripTags(t)}](${h})`);
  // 加粗/斜体
  s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/g, (_, t: string) => `**${stripTags(t)}**`);
  s = s.replace(/<em[^>]*>([\s\S]*?)<\/em>/g, (_, t: string) => `*${stripTags(t)}*`);
  // 图片 → alt 文本
  s = s.replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, (_, a: string) => `[图片：${a}]`);
  // 其余标签剥离
  s = stripTags(s);
  // 清理多余空行
  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

// ---------- 各类型解析 ----------
interface RawItem {
  kind: ZhihuCrawlKind;
  title: string;
  content: string;
  created: number;
  url: string;
  voteup?: number;
}

function pick(obj: unknown, keys: string[]): unknown {
  if (obj && typeof obj === "object") {
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k];
      if (v !== undefined && v !== null) return v;
    }
  }
  return undefined;
}

function parseAnswers(state: Record<string, unknown>): RawItem[] {
  const entities = pick(state, ["entities"]) as Record<string, unknown> | undefined;
  const answers = (entities && pick(entities, ["answers"])) as Record<string, unknown> | undefined;
  if (!answers) return [];
  const out: RawItem[] = [];
  for (const [id, a] of Object.entries(answers)) {
    const r = a as Record<string, unknown>;
    const q = (r.question ?? {}) as Record<string, unknown>;
    const title = typeof q.title === "string" ? q.title : "（问题标题未知）";
    const content = typeof r.content === "string" ? htmlToMarkdown(r.content) : "";
    const created = typeof r.created_time === "number" ? r.created_time : typeof r.created === "number" ? r.created : 0;
    const voteup = typeof r.voteup_count === "number" ? r.voteup_count : undefined;
    out.push({ kind: "answer", title, content, created, url: `${BASE}/question/${String(q.id ?? "")}/answer/${id}`, voteup });
  }
  return out;
}

function parseArticles(state: Record<string, unknown>): RawItem[] {
  const entities = pick(state, ["entities"]) as Record<string, unknown> | undefined;
  const articles = (entities && pick(entities, ["articles"])) as Record<string, unknown> | undefined;
  if (!articles) return [];
  const out: RawItem[] = [];
  for (const [id, a] of Object.entries(articles)) {
    const r = a as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title : "（文章标题未知）";
    const content = typeof r.content === "string" ? htmlToMarkdown(r.content) : "";
    const created = typeof r.created_time === "number" ? r.created_time : 0;
    const voteup = typeof r.voteup_count === "number" ? r.voteup_count : undefined;
    out.push({ kind: "article", title, content, created, url: `${BASE}/p/${id}`, voteup });
  }
  return out;
}

function parsePins(state: Record<string, unknown>): RawItem[] {
  const entities = pick(state, ["entities"]) as Record<string, unknown> | undefined;
  const pins = (entities && pick(entities, ["pins"])) as Record<string, unknown> | undefined;
  if (!pins) return [];
  const out: RawItem[] = [];
  for (const [id, a] of Object.entries(pins)) {
    const r = a as Record<string, unknown>;
    const title = typeof r.title === "string" && r.title ? r.title : "";
    const content = typeof r.content === "string" ? htmlToMarkdown(r.content) : "";
    const created = typeof r.created_time === "number" ? r.created_time : 0;
    const voteup = typeof r.voteup_count === "number" ? r.voteup_count : undefined;
    out.push({ kind: "pin", title, content, created, url: `${BASE}/pin/${id}`, voteup });
  }
  return out;
}

// ---------- pins API（免签名，可翻页） ----------
async function fetchPinsApi(token: string, limit: number, signal?: AbortSignal): Promise<RawItem[]> {
  const out: RawItem[] = [];
  const cookie = getCookie();
  const headers: Record<string, string> = { "User-Agent": UA, Referer: `${BASE}/people/${token}` };
  if (cookie) headers.Cookie = cookie;
  let offset = 0;
  for (;;) {
    if (signal?.aborted) break;
    const url = `${BASE}/api/v4/members/${token}/pins?limit=20&offset=${offset}`;
    const res = await fetch(url, { headers, signal });
    if (res.status !== 200) break;
    const j = (await res.json()) as { data?: Record<string, unknown>[]; paging?: { is_end?: boolean } };
    const data = Array.isArray(j.data) ? j.data : [];
    for (const p of data) {
      const content = typeof p.content === "string" ? htmlToMarkdown(p.content) : "";
      const created = typeof p.created_time === "number" ? p.created_time : 0;
      out.push({
        kind: "pin",
        title: content.split("\n")[0]?.slice(0, 40) ?? "",
        content,
        created,
        url: `${BASE}/pin/${String(p.id ?? "")}`,
        voteup: typeof p.voteup_count === "number" ? p.voteup_count : undefined,
      });
    }
    if (limit > 0 && out.length >= limit) break;
    if (!j.paging || j.paging.is_end !== false || data.length === 0) break;
    offset += data.length;
    await humanDelay();
  }
  return out;
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
  if (!hasCookie()) return { ok: false, message: "未配置知乎登录 cookie（浏览器登录后复制），请先在页面设置" };

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
        // 想法：免签名 API 翻页
        const pins = await fetchPinsApi(token, limit, opts.signal);
        all.push(...pins);
        opts.onProgress?.({ kind, fetched: pins.length, message: `想法抓取完成（${pins.length} 条）` });
        continue;
      }
      // 回答/文章：SSR HTML（js-initialData）
      const page = kind === "answer" ? "answers" : "articles";
      const { status, text } = await fetchZhihu(`/people/${token}/${page}`);
      if (status === 403 || status === 401) {
        opts.onProgress?.({ kind, fetched: all.length, message: `${kindLabel(kind)}：页面被风控拦截（HTTP ${status}），请确认 cookie 有效` });
        continue;
      }
      if (status !== 200) {
        opts.onProgress?.({ kind, fetched: all.length, message: `${kindLabel(kind)}：页面返回 HTTP ${status}` });
        continue;
      }
      const state = parseInitialData(text);
      if (!state) {
        opts.onProgress?.({ kind, fetched: all.length, message: `${kindLabel(kind)}：未能解析页面数据（可能需要更新解析器）` });
        continue;
      }
      const items = kind === "answer" ? parseAnswers(state) : parseArticles(state);
      all.push(...items);
      opts.onProgress?.({ kind, fetched: items.length, message: `${kindLabel(kind)}抓取完成（${items.length} 条，SSR 首页）` });
    } catch (e) {
      opts.onProgress?.({ kind, fetched: all.length, message: `${kindLabel(kind)}：异常 ${e instanceof Error ? e.message : String(e)}` });
    }
    if (opts.signal?.aborted) break;
    await humanDelay();
  }

  if (opts.signal?.aborted) return { ok: false, message: "已取消" };

  // 时间降序合并
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
