// ============================================================
// 业务模块：DeepSeek Chat 自动填入（features/browserChat）
// 用 playwright-core + 系统 Chrome 打开 chat.deepseek.com：
// 自动填入提示词 →（可选）开启深度思考/智能搜索 →（可选）自动发送启动对话。
// - 浏览器操控复用公共模块 core/browser（findBrowser/launchPersistentContext）
// - 持久化 profile（.file/ds-chat-profile）：登录态自动记住（首次弹窗登录一次）
// - 单实例：模块级持有当前 context，重复调用先关旧窗口（避免同 profile 独占锁）
// - 未登录：保持窗口 + 轮询等待用户登录（最多 3 分钟）→ 登录后继续
// 输入框填入选器实测（2026-08）：textarea（React 受控，须 keyboard.type 真实键入）；
// 开关：div.ds-toggle-button（hasText「深度思考」「智能搜索」），aria-checked 判状态。
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

export interface ChatBrowserOpenOptions {
  /** 填入后自动发送（Enter 启动对话） */
  send?: boolean;
  /** 打开「深度思考」开关 */
  deepThink?: boolean;
  /** 打开「智能搜索」（联网搜索）开关 */
  search?: boolean;
}

export interface ChatBrowserOpenResult {
  ok: boolean;
  loggedIn: boolean;
  message: string;
}

/** 定位输入框并填入提示词（textarea 优先，兜底 contenteditable）
 *  输入策略（实测迭代）：
 *  - fill() 直接设值不触发 React 受控更新（静默失败）→ 弃用
 *  - keyboard.type 逐字符：长文本受控更新跟不上会丢字/未输完（用户反馈"没输完就发送"）→ 弃用
 *  - keyboard.insertText：CDP 整段插入（等价粘贴，走输入管线触发受控 onChange），一次完整 → 采用
 *  填入后读回 value 校验完整性，不一致则回退逐字符补齐。 */
async function fillPrompt(page: Page, prompt: string): Promise<boolean> {
  const tryFill = async (sel: string) => {
    const el = page.locator(sel).first();
    await el.waitFor({ state: "visible", timeout: 10000 });
    await el.click();
    await page.keyboard.insertText(prompt);
    // 校验输入框内容完整（insertText 应一次插入整段；受控组件未采纳时回退逐字符）
    const actual = await el.inputValue().catch(() => "");
    if (actual !== prompt) {
      await el.click();
      await page.keyboard.type(prompt, { delay: 3 });
    }
    return true;
  };
  try {
    return await tryFill("textarea");
  } catch {
    try {
      return await tryFill('div[contenteditable="true"]');
    } catch {
      return false;
    }
  }
}

/** 读取开关状态（aria-checked 或 aria-pressed，二者取一） */
async function toggleState(btn: ReturnType<Page["locator"]>): Promise<boolean | null> {
  const c = await btn.getAttribute("aria-checked").catch(() => null);
  if (c === "true" || c === "false") return c === "true";
  const p = await btn.getAttribute("aria-pressed").catch(() => null);
  if (p === "true" || p === "false") return p === "true";
  return null;
}

/** 设置输入框旁的开关（深度思考/智能搜索）：div.ds-toggle-button + hasText，aria-checked/aria-pressed 判状态；点击后确认，未切换则重试一次 */
async function setToggle(page: Page, label: "深度思考" | "智能搜索", wantOn: boolean): Promise<void> {
  try {
    const btn = page.locator("div.ds-toggle-button", { hasText: label }).first();
    await btn.waitFor({ state: "visible", timeout: 5000 });
    const cur = await toggleState(btn);
    if (cur === wantOn) return;
    await btn.click();
    await sleep(500);
    // 点击后确认：仍未达到目标则再点一次（部分开关结构变化需重试）
    const after = await toggleState(btn);
    if (after !== null && after !== wantOn) {
      await btn.click();
      await sleep(500);
    }
  } catch {
    // 开关结构变化时静默跳过（不阻塞主流程）
  }
}

/**
 * 打开 chat.deepseek.com，填入提示词，并按选项开启开关/自动发送。
 * 未登录时保持窗口并轮询等待用户登录，登录完成后继续。
 */
export async function openChatWithPrompt(prompt: string, opts: ChatBrowserOpenOptions = {}): Promise<ChatBrowserOpenResult> {
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
    // 窗口置前，用户可见可操作
    await page.bringToFront().catch(() => {});
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
        return { ok: true, loggedIn: false, message: "请在浏览器窗口中完成 DeepSeek 登录（仅首次需要），登录后会自动继续填入并发送。" };
      }
      await sleep(1500); // 等登录后页面就绪
    }

    // 1. 先开开关（深度思考/智能搜索；此时不依赖输入框焦点）
    if (opts.deepThink !== false) await setToggle(page, "深度思考", true);
    if (opts.search !== false) await setToggle(page, "智能搜索", true);

    // 2. 填入提示词（焦点进入输入框）
    const filled = await fillPrompt(page, prompt);
    if (!filled) {
      return { ok: true, loggedIn: true, message: "已打开 DeepSeek Chat 但未找到输入框（页面结构可能变化），请手动粘贴提示词。" };
    }

    // 3. 自动发送：重聚焦输入框（点开关后焦点可能丢失）→ 等待受控状态提交 → Enter 启动对话
    if (opts.send) {
      await sleep(400);
      await page.locator("textarea").first().click().catch(() => {});
      await sleep(300);
      await page.keyboard.press("Enter");
      return { ok: true, loggedIn: true, message: "✅ 已填入提示词并发送，请在浏览器窗口中查看回复。" };
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
    const raw = (await c.req.json().catch(() => null)) as {
      prompt?: unknown;
      send?: unknown;
      deepThink?: unknown;
      search?: unknown;
    } | null;
    const prompt = typeof raw?.prompt === "string" ? raw.prompt.trim() : "";
    if (!prompt) return c.json({ ok: false, message: "缺少提示词内容" }, 400);
    const r = await openChatWithPrompt(prompt, {
      send: raw?.send === true,
      deepThink: raw?.deepThink !== false,
      search: raw?.search !== false,
    });
    return c.json(r);
  });

  app.route(`${API_PREFIX}/tools/chat-browser`, route);
}
