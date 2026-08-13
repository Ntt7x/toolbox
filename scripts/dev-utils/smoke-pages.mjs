// ============================================================
// 页面冒烟自测（scripts/dev-utils/smoke-pages.mjs）
// 用 playwright-core + 本机 Chrome 打开全部前端页面，验证：
//   - 页面渲染出预期内容（body 含 expect 标志词，且非 404 占位页）
//   - 关键 API 请求全部成功（无 404/500/挂起）
//   - 无 JS 崩溃
// 用法：
//   node scripts/dev-utils/smoke-pages.mjs                全量
//   node scripts/dev-utils/smoke-pages.mjs --page /tools/x  定向单页（§5.1 L2）
// 需前端 dev 5173 + 服务端 8787 在运行（dev.mjs start）。
// 历史教训：
//   - TradePlanTool 挂载 useEffect 被误删 → 列表卡"加载中"（API 请求根本不发出）→ 浏览器级冒烟才能发现
//   - 旧版只查 API 状态不查内容 → /admin/deps（不存在路由）404 占位页也 PASS，静默放行 → 必须断言页面内容
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

// --page <path>：定向冒烟（只测一个页面，配合 §5.1 L2；不传则全量）
const onlyPage = process.argv.includes("--page") ? process.argv[process.argv.indexOf("--page") + 1] : null;

// 每页断言：body 文本包含 expect（页面级标题/标志词），且不得出现「页面不存在」（404 占位页反断言）
const PAGES = [
  { path: "/", expect: "工作台" },
  { path: "/tools/grid-plan", expect: "交易网格计划" },
  { path: "/tools/kelly", expect: "凯利仓位助手" },
  { path: "/tools/cb-rate", expect: "央行利率分析" },
  { path: "/tools/treasury-fx", expect: "国债汇率分析" },
  { path: "/tools/reverse-repo", expect: "逆回购" },
  { path: "/tools/watchlist", expect: "专题自选股" },
  { path: "/tools/trade-plan", expect: "策略仓位管理" },
  { path: "/tools/deepseek-share", expect: "提取历史" },
  { path: "/tools/zhihu-crawler", expect: "知乎爬虫" },
  { path: "/tools/books", expect: "书籍下载" },
  { path: "/tools/knowledge-hub", expect: "知识库中心" },
  { path: "/tools/news-center", expect: "新闻中心" },
  { path: "/settings/llm", expect: "用量" },
  { path: "/settings/local-data", expect: "数据源" },
  { path: "/settings/memo", expect: "改进备忘录" },
  { path: "/settings/arch-graph", expect: "项目架构依赖图" },
  { path: "/settings/agent-sessions", expect: "会话" },
];
const NOT_FOUND_TEXT = "页面不存在";

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

const targets = onlyPage
  ? (PAGES.find((p) => p.path === onlyPage) ? [PAGES.find((p) => p.path === onlyPage)] : [{ path: onlyPage, expect: null }])
  : PAGES;

for (const { path, expect } of targets) {
  const problems = [];
  page.on("response", (r) => {
    if (r.url().includes("/api/") && r.status() >= 400) problems.push(`${r.status()} ${r.url().slice(0, 110)}`);
  });
  page.on("pageerror", (e) => problems.push("JS崩溃: " + String(e).slice(0, 150)));
  try {
    await page.goto(WEB + path, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3500);
    if (expect) {
      const body = await page.evaluate(() => document.body.innerText);
      if (!body.includes(expect)) problems.push(`内容缺失：未找到「${expect}」`);
      if (body.includes(NOT_FOUND_TEXT)) problems.push("命中 404 占位页（页面不存在）");
    }
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
console.log(fail === 0 ? `\nALL-PASS（${targets.length} 页）` : `\nFAIL-${fail}`);
process.exit(fail === 0 ? 0 : 1);
