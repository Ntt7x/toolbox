// ============================================================
// 浏览器冒烟运行器（scripts/dev-utils/browser-run.mjs）
// 固化「playwright 冒烟脚本」模板：本迭代手写 ~15 次的 launch + goto + 日志模式。
// 用法：
//   node scripts/dev-utils/browser-run.mjs <script.mjs> [url]
// 脚本内可用全局：page（已打开 url 的页面）、log(msg)（写 .file/browser-run.log）、
// browser（可再 newPage）。脚本示例：
//   log("标题: " + await page.locator("h1").textContent());
//   log("表格: " + await page.locator("table").count());
// 自动处理：TMP/TEMP（playwright 需要）、playwright-core 绝对路径（apps/server 依赖树）、
// 本机 Chrome 查找、pageerror/console-error 收集、日志追加 .file/browser-run.log。
// 也接受裸表达式脚本（无 import/export，body 直接执行）。
// ============================================================
import { createRequire } from "node:module";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// playwright-core 位于 apps/server 依赖树（项目根未提升），经绝对路径 require
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pwPath = path.resolve(root, "apps", "server", "node_modules", "playwright-core");
if (!existsSync(pwPath)) { console.error("缺少 playwright-core（apps/server/node_modules）"); process.exit(1); }
const { chromium } = require(pwPath);

// 本机 Chrome 查找（依次尝试常见路径）
function findChrome() {
  const cands = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

const [scriptPath, urlArg] = process.argv.slice(2);
if (!scriptPath) { console.error("用法: node scripts/dev-utils/browser-run.mjs <script.mjs> [url]"); process.exit(1); }
const url = urlArg ?? "http://localhost:5173";
const LOG = path.join(root, ".file", "browser-run.log");

// playwright 需要可写临时目录（worker 无默认 TMP/TEMP）
process.env.TMP = process.env.TEMP = path.join(root, ".file");

const log = (s) => {
  console.log(s);
  try { appendFileSync(LOG, s + "\n", "utf8"); } catch { /* ignore */ }
};

const chrome = findChrome();
if (!chrome) { log("未找到本机 Chrome/Edge"); process.exit(1); }
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => log("PAGE-ERR: " + e.message.slice(0, 150)));
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) log("CONSOLE-ERR: " + m.text().slice(0, 150)); });

try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1500);
  log("URL: " + page.url());
  // 执行用户脚本（支持裸表达式：无 import/export 的 body）
  const body = readFileSync(scriptPath, "utf8");
  if (/\bimport\b|\bexport\b/.test(body)) {
    const mod = await import("file:///" + scriptPath.replace(/\\/g, "/") + "?t=" + Date.now());
    await mod.default?.({ page, browser, log, url });
  } else {
    const fn = new (Object.getPrototypeOf(async function(){}).constructor)("page", "browser", "log", "url", body);
    await fn(page, browser, log, url);
  }
} catch (e) {
  log("脚本错误: " + (e instanceof Error ? e.message : String(e)).slice(0, 300));
  process.exitCode = 1;
} finally {
  await browser.close();
}
