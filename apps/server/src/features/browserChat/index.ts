// ============================================================
// 业务模块：DeepSeek Chat 自动填入（features/browserChat）
// 用 playwright-core + 系统 Chrome 打开 chat.deepseek.com 并自动填入提示词，
// 解决"去 DeepSeek Chat"按钮无法预填提示词的问题（DeepSeek 网页版不支持 URL 预填）。
// - 持久化 profile（.file/ds-chat-profile）：首次需用户在弹出窗口中手动登录一次
// - 打开后保持窗口（不自动发送），用户确认后回车发送
// - headful（真实窗口，用户可操作）
// 评估（2026-08）：chat.deepseek.com 未登录跳 /sign_in 且无输入框 → 必须登录态；
// 登录后输入框为 textarea。与知乎爬虫共用同一套 playwright 基础设施。
// ============================================================
import { Hono } from "hono";
import type { Context } from "hono";
import { chromium } from "playwright-core";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { API_PREFIX } from "@toolbox/shared";
import { DATA_DIR } from "../../core/db.js";

export const meta = { id: "browser-chat", name: "DeepSeek Chat 自动填入" };

// 与知乎爬虫同款浏览器定位（本机 Chrome/Edge）
const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

function findBrowser(): string | undefined {
  return CHROME_CANDIDATES.find((p) => existsSync(p));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const PROFILE_DIR = join(DATA_DIR, "ds-chat-profile");
const DS_HOME = "https://chat.deepseek.com/";

export interface ChatBrowserOpenResult {
  ok: boolean;
  loggedIn: boolean;
  message: string;
}

/**
 * 打开 chat.deepseek.com 并自动填入提示词（保持窗口，不自动发送）。
 * 未登录时保持窗口并提示用户登录后重试（profile 会记住登录态）。
 */
export async function openChatWithPrompt(prompt: string): Promise<ChatBrowserOpenResult> {
  const exe = findBrowser();
  if (!exe) return { ok: false, loggedIn: false, message: "未找到系统 Chrome/Edge 浏览器" };
  mkdirSync(PROFILE_DIR, { recursive: true });

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      executablePath: exe,
      headless: false, // 真实窗口：用户可见可操作
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(DS_HOME, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(3500);

    // 未登录 → 跳转 sign_in（保持窗口让用户登录，profile 记住登录态）
    if (page.url().includes("/sign_in")) {
      return { ok: true, loggedIn: false, message: "DeepSeek 未登录，请在弹窗中登录（仅需一次，之后自动记住）。登录后请重试自动填入。" };
    }

    // 定位输入框：textarea 优先（登录后主输入框），兜底 contenteditable
    let filled = false;
    try {
      const ta = page.locator("textarea").first();
      await ta.waitFor({ state: "visible", timeout: 8000 });
      await ta.click();
      await ta.fill(prompt);
      filled = true;
    } catch {
      const ce = page.locator('div[contenteditable="true"]').first();
      try {
        await ce.waitFor({ state: "visible", timeout: 4000 });
        await ce.click();
        await ce.fill(prompt);
        filled = true;
      } catch {
        filled = false;
      }
    }
    if (!filled) {
      return { ok: true, loggedIn: true, message: "已打开 DeepSeek Chat 但未找到输入框（页面结构可能变化），请手动粘贴提示词。" };
    }
    return { ok: true, loggedIn: true, message: "✅ 已自动填入提示词，请在浏览器窗口中确认并发送。" };
  } catch (e) {
    if (ctx) await ctx.close().catch(() => {});
    return { ok: false, loggedIn: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export function register(app: Hono): void {
  const route = new Hono();

  route.post("/open", async (c: Context) => {
    const raw = (await c.req.json().catch(() => null)) as { prompt?: unknown } | null;
    const prompt = typeof raw?.prompt === "string" ? raw.prompt.trim() : "";
    if (!prompt) return c.json({ ok: false, message: "缺少提示词内容" }, 400);
    const r = await openChatWithPrompt(prompt);
    return c.json(r);
  });

  app.route(`${API_PREFIX}/tools/chat-browser`, route);
}
