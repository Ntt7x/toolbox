// ============================================================
// 业务模块：DeepSeek Chat 自动填入（features/browserChat）
// 用 playwright-core + 系统 Chrome 打开 chat.deepseek.com 并自动填入提示词，
// 解决"去 DeepSeek Chat"按钮无法预填提示词的问题（DeepSeek 网页版不支持 URL 预填）。
// - 浏览器操控复用公共模块 core/browser（findBrowser/launchPersistentContext）
// - 持久化 profile（.file/ds-chat-profile）：登录态自动记住（首次弹窗登录一次）
// - 单实例：模块级持有当前 context，重复调用先关旧窗口（避免同 profile 独占锁）
// - 未登录：保持窗口 + 轮询等待用户登录（最多 3 分钟）→ 登录后自动填入
// - 打开后不自动发送，用户确认后回车发送
// ============================================================
import { Hono } from "hono";
import type { Context } from "hono";
import type { BrowserContext, Page } from "playwright-core";
import { join } from "node:path";
import { API_PREFIX } from "@toolbox/shared";
import { DATA_DIR } from "../../core/db.js";
import { launchPersistentContext, sleep } from "../../core/browser.js";

export const meta = { id: "browser-chat", name: "DeepSeek Chat 自动填入" };

const PROFILE_DIR = join(DATA_DIR, "ds-chat-profile");
const DS_HOME = "https://chat.deepseek.com/";
const LOGIN_WAIT_MS = 3 * 60 * 1000; // 未登录时等待用户登录的时限

// 单实例：同一时间只允许一个 browserChat 窗口（防同 profile 独占锁）
let activeCtx: BrowserContext | null = null;

export interface ChatBrowserOpenResult {
  ok: boolean;
  loggedIn: boolean;
  message: string;
}

/** 定位输入框并填入提示词（textarea 优先，兜底 contenteditable） */
async function fillPrompt(page: Page, prompt: string): Promise<boolean> {
  try {
    const ta = page.locator("textarea").first();
    await ta.waitFor({ state: "visible", timeout: 8000 });
    await ta.click();
    await ta.fill(prompt);
    return true;
  } catch {
    try {
      const ce = page.locator('div[contenteditable="true"]').first();
      await ce.waitFor({ state: "visible", timeout: 4000 });
      await ce.click();
      await ce.fill(prompt);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 打开 chat.deepseek.com 并自动填入提示词（保持窗口，不自动发送）。
 * 未登录时保持窗口并轮询等待用户登录，登录完成后自动填入。
 */
export async function openChatWithPrompt(prompt: string): Promise<ChatBrowserOpenResult> {
  // 关闭上一个残留窗口（避免同 profile 并发锁）
  if (activeCtx) {
    await activeCtx.close().catch(() => {});
    activeCtx = null;
  }
  let ctx: BrowserContext | null = null;
  try {
    ctx = await launchPersistentContext(PROFILE_DIR, { headless: false });
    activeCtx = ctx;
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(DS_HOME, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(3500);

    // 未登录 → 保持窗口，轮询等待用户登录（URL 离开 /sign_in 即视为登录成功）
    if (page.url().includes("/sign_in")) {
      const deadline = Date.now() + LOGIN_WAIT_MS;
      while (Date.now() < deadline) {
        await sleep(2000);
        try {
          if (!page.url().includes("/sign_in")) break;
        } catch {
          break; // 页面已跳转/关闭
        }
      }
      if (page.url().includes("/sign_in")) {
        return { ok: true, loggedIn: false, message: "请在浏览器窗口中完成 DeepSeek 登录（仅首次需要），登录后将自动填入提示词。" };
      }
      await sleep(1500); // 等登录后页面就绪
    }

    // 登录后：自动填入
    const filled = await fillPrompt(page, prompt);
    if (!filled) {
      return { ok: true, loggedIn: true, message: "已打开 DeepSeek Chat 但未找到输入框（页面结构可能变化），请手动粘贴提示词。" };
    }
    return { ok: true, loggedIn: true, message: "✅ 已自动填入提示词，请在浏览器窗口中确认并发送。" };
  } catch (e) {
    if (ctx) await ctx.close().catch(() => {});
    activeCtx = null;
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
