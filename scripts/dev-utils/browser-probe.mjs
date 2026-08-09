// ============================================================
// 开发辅助脚本：浏览器探针（scripts/dev-utils/browser-probe.mjs）
// 固化「浏览器自动化调试」（browserChat 开关诊断 / 知乎页面验证等反复手写
// launch Chrome + goto + 打印选择器状态 的脚本）。
// 用法：
//   node scripts/dev-utils/browser-probe.mjs <url> [--check "选择器:描述"]...
//   --check 可多个；每个打印 是否存在/可见/文本前 60 字/关键属性。
//   --screenshot <path> 可选截图；--profile <dir> 指定 profile（默认临时）。
// 输出：URL / title / 各选择器状态。注意：可能弹出真实 Chrome（headful）。
// ============================================================
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:\/\//.test(a));
const checks = [];
let screenshot = null;
let profile = undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--check" && args[i + 1]) checks.push(args[++i]);
  if (args[i] === "--screenshot" && args[i + 1]) screenshot = args[++i];
  if (args[i] === "--profile" && args[i + 1]) profile = args[++i];
}
if (!url) {
  console.error("用法: node scripts/dev-utils/browser-probe.mjs <url> [--check \"选择器:描述\"]... [--screenshot <path>] [--profile <dir>]");
  process.exit(1);
}
const exe = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!exe) {
  console.error("未找到系统 Chrome/Edge");
  process.exit(1);
}

const ctx = await chromium.launchPersistentContext(profile || `probe-${Date.now()}`, {
  executablePath: exe,
  headless: false,
  args: ["--no-first-run", "--disable-blink-features=AutomationControlled"],
});
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);
  console.log(`URL:   ${page.url()}`);
  console.log(`title: ${(await page.title()).slice(0, 100)}`);
  for (const c of checks) {
    const [sel, desc] = c.split(":");
    const info = await page.locator(sel).first().evaluate((el) => ({
      count: document.querySelectorAll ? 1 : 0,
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      text: (el.textContent || "").trim().slice(0, 60),
      ariaChecked: el.getAttribute("aria-checked"),
      ariaPressed: el.getAttribute("aria-pressed"),
    })).catch(() => null);
    if (!info) console.log(`check ${sel} (${desc || ""}): 不存在`);
    else console.log(`check ${sel} (${desc || ""}): ${info.visible ? "可见" : "不可见"} | ${info.text ? "文本: " + info.text : ""}${info.ariaChecked ? " | aria-checked=" + info.ariaChecked : ""}${info.ariaPressed ? " | aria-pressed=" + info.ariaPressed : ""}`);
  }
  if (screenshot) await page.screenshot({ path: screenshot, fullPage: false });
  console.log("完成（窗口保持打开，可手动操作查看）");
} finally {
  // 不关闭窗口（诊断需要人工观察）；进程退出时由用户关闭或下次启动复用 profile
}
