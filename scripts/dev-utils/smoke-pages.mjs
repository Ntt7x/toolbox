// ============================================================
// 页面冒烟自测（scripts/dev-utils/smoke-pages.mjs）
// 用 playwright-core + 本机 Chrome 打开全部前端页面，验证：
//   - 页面能渲染（无 JS 崩溃）
//   - 关键 API 请求全部成功（无 404/500/挂起）
// 用法：node scripts/dev-utils/smoke-pages.mjs（需前端 dev 5173 + 服务端 8787 在运行）
// 历史教训：TradePlanTool 曾因挂载 useEffect 被误删导致列表卡"加载中"（API 请求根本不发出），
// 此类问题只能靠浏览器级冒烟发现——每次页面大改后跑一次本脚本。
// ============================================================
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// playwright-core 位于 apps/server 依赖树（项目根未提升），经绝对路径 require
const require = createRequire(import.meta.url);
const pwPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/server/node_modules/playwright-core");
const { chromium } = require(pwPath);

const WEB = process.env.SMOKE_WEB ?? "http://localhost:5173";

// --page <path>：定向冒烟（只测一个页面，配合 §6.4 L2 小改动验证；不传则全量 17 页）
const onlyPage = process.argv.includes("--page") ? process.argv[process.argv.indexOf("--page") + 1] : null;
const PAGES = [
  "/",
  "/tools/grid-plan",
  "/tools/kelly",
  "/tools/cb-rate",
  "/tools/treasury-fx",
  "/tools/reverse-repo",
  "/tools/watchlist",
  "/tools/trade-plan",
  "/tools/deepseek-share",
  "/tools/zhihu-crawler",
  "/tools/books",
  "/tools/knowledge-hub",
  "/tools/news-center",
  "/settings/llm",
  "/settings/local-data",
  "/settings/memo",
  "/admin/deps",
];

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
if (!CHROME) { console.error("未找到 Chrome/Edge"); process.exit(1); }

const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ["--no-sandbox"] });
const page = await browser.newPage();
let fail = 0;

for (const path of onlyPage ? [onlyPage] : PAGES) {
  const problems = [];
  page.on("response", (r) => {
    if (r.url().includes("/api/") && r.status() >= 400) problems.push(`${r.status()} ${r.url().slice(0, 110)}`);
  });
  page.on("pageerror", (e) => problems.push("JS崩溃: " + String(e).slice(0, 150)));
  try {
    await page.goto(WEB + path, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3500);
  } catch (e) {
    problems.push("加载失败: " + e.message.slice(0, 100));
  }
  page.removeAllListeners("response");
  page.removeAllListeners("pageerror");
  if (problems.length > 0) {
    fail++;
    console.log(`❌ ${path}`);
    problems.slice(0, 4).forEach((p) => console.log("   " + p));
  } else {
    console.log(`✅ ${path}`);
  }
}
await browser.close();
console.log(fail === 0 ? "\nALL-PASS" : `\nFAIL-${fail}`);
process.exit(fail === 0 ? 0 : 1);
