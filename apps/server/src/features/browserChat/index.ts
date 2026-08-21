// ============================================================
// 业务模块：DeepSeek Chat 自动填入（features/browserChat）
// 用 playwright-core + 系统 Chrome 打开 chat.deepseek.com：
// 自动填入提示词 →（可选）开启深度思考/智能搜索 →（可选）自动发送启动对话。
// - 浏览器操控复用公共模块 core/browser（findBrowser/launchPersistentContext）
// - 持久化 profile（.file/ds-chat-profile）：登录态自动记住（首次弹窗登录一次）
// - 单实例：模块级持有当前 context，重复调用先关旧窗口（避免同 profile 独占锁）
// - 未登录：保持窗口 + 轮询等待用户登录（最多 3 分钟）→ 登录后继续
// 输入框填入选器实测（2026-08）：textarea（React 受控，须 keyboard.insertText 整段插入触发 onChange）；
// 开关：div.ds-toggle-button（hasText「深度思考」「智能搜索」），状态在 aria-pressed（aria-checked 恒 null）。
// ============================================================
import { Hono } from "hono";
import type { Context } from "hono";
import type { BrowserContext, Page } from "playwright-core";
import { join } from "node:path";
import { API_PREFIX } from "@toolbox/shared";
import { DATA_DIR } from "../../core/db.js";
import { launchPersistentContext, tryConnectCdp, sleep } from "../../core/browser.js";

export const meta = { id: "browser-chat", name: "DeepSeek Chat 自动填入" };

const PROFILE_DIR = join(DATA_DIR, "ds-chat-profile");
const DS_HOME = "https://chat.deepseek.com/";
const LOGIN_WAIT_MS = 3 * 60 * 1000; // 未登录时等待用户登录的时限

// 单实例：同一时间只允许一个 browserChat 窗口（防同 profile 独占锁）。
// activeCtx 存 globalThis（tsx watch 模块重载后仍保留——2026-08-19 修复"连续点击不能复用"）
const CTX_KEY = "__toolboxBrowserChatCtx";
function getActiveCtx(): BrowserContext | null {
  return ((globalThis as Record<string, unknown>)[CTX_KEY] as BrowserContext | null) ?? null;
}
function setActiveCtx(v: BrowserContext | null): void {
  (globalThis as Record<string, unknown>)[CTX_KEY] = v;
}
/** 2026-08-14：互斥锁——并发 /open 同时 launch 同 profile 会因 Chrome 独占锁失败 */
let chatBrowserBusy = false;

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
  /** 本次是否复用了上次的浏览器窗口（2026-08-19） */
  reused?: boolean;
}

/** 安全读取当前 URL（页面关闭/跳转时返回空串，不抛错） */
async function safeUrl(page: Page): Promise<string> {
  try {
    return page.url();
  } catch {
    return "";
  }
}

/** 点击输入框聚焦（textarea 优先，兜底 contenteditable——与 fillPrompt 对齐） */
async function focusInput(page: Page): Promise<void> {
  try {
    await page.locator("textarea").first().click({ timeout: 2000 });
    return;
  } catch {
    await page.locator('div[contenteditable="true"]').first().click({ timeout: 1000 }).catch(() => {});
  }
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
      // 2026-08-14：补齐后仍不一致 → 返回失败（此前不回读校验，残缺提示词被当成功发送）
      const actual2 = await el.inputValue().catch(() => "");
      if (actual2 !== prompt) return false;
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
  // 互斥锁（2026-08-14；2026-08-19 增强）：同一时刻只允许一个 browserChat 会话。
  // 连续点击多次「去 Chat」时不再直接拒绝，而是等待当前会话完成（最多 30s），随后复用同一窗口继续。
  const t0 = Date.now();
  while (chatBrowserBusy) {
    if (Date.now() - t0 > 30000) return { ok: false, loggedIn: false, message: "浏览器会话繁忙（超过 30s），请稍后再试" };
    await sleep(300);
  }
  chatBrowserBusy = true;
  let ctx: BrowserContext | null = null;
  let reused = false; // 本次是否复用上次窗口（2026-08-19）
  try {
    // 2026-08-19：① 优先 CDP 连接已打开的 Chrome；② 否则复用上次打开的窗口（不关闭，多次 chat 同一窗口）；③ 无则新开
    const cdp = await tryConnectCdp();
    if (cdp) {
      ctx = cdp;
      console.log("browserChat: CDP 连接已开浏览器");
    } else {
      // 复用上次窗口（模块 let 跨调用赋值，TS 单次调用分析误判恒 null → 用断言绕过）
      const maybe = getActiveCtx();
      if (maybe) {
        try {
          maybe.pages(); // 窗口/连接在则正常返回；已断开则抛错 → 判定不可复用
          ctx = maybe;
          reused = true;
          console.log("browserChat: 复用上次窗口");
        } catch (e) {
          setActiveCtx(null);
        }
      } else {
      }
      if (!ctx) {
        ctx = await launchPersistentContext(PROFILE_DIR, { headless: false });
        setActiveCtx(ctx);
      }
    }
    // 页面选择：新开窗口用初始空页；复用/CDP 优先用 about:blank 空页（避免空 tab 累积），否则新建 tab（不覆盖用户已有页面/对话——2026-08-19 修复"把前面的页面都关了"）
    const isNewWindow = !reused && !cdp;
    const page = isNewWindow ? (ctx.pages()[0] ?? (await ctx.newPage())) : (ctx.pages().find((p) => p.url() === "about:blank") ?? (await ctx.newPage()));
    // 窗口置前，用户可见可操作
    await page.bringToFront().catch(() => {});
    await page.goto(DS_HOME, { waitUntil: "domcontentloaded", timeout: 30000 });
    // 条件等待页面就绪（替代固定 3.5s）：先等 SPA 首屏路由稳定，再判断登录态
    await sleep(1200);

    // 未登录 → 保持窗口，轮询等待用户登录（URL 离开 /sign_in 即视为登录成功）
    if ((await safeUrl(page)).includes("/sign_in")) {
      const deadline = Date.now() + LOGIN_WAIT_MS;
      while (Date.now() < deadline) {
        await sleep(2000);
        const u = await safeUrl(page);
        if (!u.includes("/sign_in")) break;
        if (!u) break; // 页面已关闭
      }
      if ((await safeUrl(page)).includes("/sign_in")) {
        return { ok: true, loggedIn: false, message: "请在浏览器窗口中完成 DeepSeek 登录（仅首次需要），登录后会自动继续填入并发送。" };
      }
      await sleep(1200); // 登录后等页面就绪
    }
    // 已登录：等主输入框出现（通常已渲染，立即返回）
    await page.locator("textarea").first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});

    // 1. 先开开关（深度思考/智能搜索；两个开关并行，互不影响）
    await Promise.all([
      opts.deepThink !== false ? setToggle(page, "深度思考", true) : Promise.resolve(),
      opts.search !== false ? setToggle(page, "智能搜索", true) : Promise.resolve(),
    ]);

    // 2. 填入提示词（焦点进入输入框）
    const filled = await fillPrompt(page, prompt);
    if (!filled) {
      return { ok: true, loggedIn: true, message: "已打开 DeepSeek Chat 但未找到输入框（页面结构可能变化），请手动粘贴提示词。" };
    }

    // 3. 自动发送：重聚焦输入框（点开关后焦点可能丢失）→ 等待受控状态提交 → Enter 启动对话
    if (opts.send) {
      await sleep(200);
      await focusInput(page);
      await sleep(150);
      await page.keyboard.press("Enter");
      return { ok: true, loggedIn: true, message: "✅ 已填入提示词并发送，请在浏览器窗口中查看回复。" };
    }
    return { ok: true, loggedIn: true, message: "✅ 已自动填入提示词，请在浏览器窗口中确认并发送。", reused };
  } catch (e) {
    if (ctx) await ctx.close().catch(() => {});
    setActiveCtx(null);
    return { ok: false, loggedIn: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    chatBrowserBusy = false;
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
