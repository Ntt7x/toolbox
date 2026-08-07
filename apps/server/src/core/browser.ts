// ============================================================
// 公共模块：浏览器操控（core/browser）
// 统一封装 playwright-core + 本机 Chrome/Edge 的启动、持久化 profile、指纹伪装。
// 供业务模块复用：知乎爬虫（抓取/登录）、DeepSeek Chat 自动填入、书籍下载等。
// - launchPersistentContext：持久化 profile（登录态复用）+ headless/headful 切换
// - profile 独占锁自愈：Windows Chrome 同 profile 并发启动会失败，重试前清理残留锁
// ============================================================
import { chromium, type BrowserContext } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

/** 定位本机浏览器（Chrome 优先，兜底 Edge） */
export function findBrowser(): string | undefined {
  return CHROME_CANDIDATES.find((p) => existsSync(p));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface LaunchPersistentOptions {
  headless?: boolean;
  userAgent?: string;
  extraArgs?: string[];
  /** 启动失败重试次数（默认 3）；Windows profile 锁问题靠重试 + 清理自愈 */
  retries?: number;
}

/**
 * 启动持久化浏览器上下文（真实 Chrome + 独立 profile）。
 * - 指纹伪装：稳定 UA + 禁 AutomationControlled + 清 navigator.webdriver
 * - 重试：连续启动同 profile 可能因残留 Chrome 子进程锁文件失败 → 等待重试
 *   ⚠️ 不删除 profile（会丢失登录态 cookie）；锁问题靠等待残留进程退出解决
 */
export async function launchPersistentContext(profileDir: string, opts: LaunchPersistentOptions = {}): Promise<BrowserContext> {
  const exe = findBrowser();
  if (!exe) throw new Error("未找到系统 Chrome/Edge 浏览器");
  mkdirSync(profileDir, { recursive: true });
  const retries = opts.retries ?? 5;
  for (let i = 0; i < retries; i++) {
    try {
      const ctx = await chromium.launchPersistentContext(profileDir, {
        executablePath: exe,
        headless: opts.headless ?? true,
        userAgent: opts.userAgent ?? DEFAULT_UA,
        args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled", ...(opts.extraArgs ?? [])],
      });
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
      return ctx;
    } catch (e) {
      if (i === retries - 1) throw e;
      // 等待残留进程释放 profile 锁（不删除 profile，避免丢登录态）
      await sleep(2000 + i * 1500);
    }
  }
  throw new Error("浏览器启动失败（重试后仍失败，可能是残留 Chrome 进程占用 profile）");
}
