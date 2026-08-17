// ============================================================
// 开发辅助脚本：API CLI（scripts/dev-utils/api-cli.mjs）
// 固化「curl 调本地 API 验证」——Windows cmd 下 curl 引号/转义是痛点
// （dev.md §4.7 服务端校验 400/200 断言）。
// 用法（node scripts/dev-utils/api-cli.mjs <method> <path> [json-body]）：
//   node scripts/dev-utils/api-cli.mjs GET /api/health
//   node scripts/dev-utils/api-cli.mjs POST /api/tools/trade-plan/strategies '{"name":"x"}'
// 输出：HTTP 状态 + 响应 JSON（格式化）。body 用单引号包 JSON（内部双引号）。
// ============================================================
import { call, BASE } from "./api.mjs";

const argsAll = process.argv.slice(2);
const fullOut = argsAll.includes("--full");
const [method, p, bodyRaw] = argsAll.filter((a) => a !== "--full");
if (!method || !p) {
  console.error(`用法: node scripts/dev-utils/api-cli.mjs <GET|POST|PUT|DELETE> <path> [json-body]\nBASE: ${BASE}`);
  process.exit(1);
}
let body;
if (bodyRaw) {
  try {
    body = JSON.parse(bodyRaw);
  } catch {
    // cmd 下双引号被剥（如 '{"force":true}' → {force:true}）——宽松 JSON 修复：给 key/裸值补引号
    const fixed = bodyRaw
      .trim()
      .replace(/^['"]+|['"]+$/g, "")
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
      .replace(/:\s*([A-Za-z_][A-Za-z0-9_]*)(\s*[,}])/g, ':"$1"$2');
    try {
      body = JSON.parse(fixed);
    } catch {
      console.error(`❌ body 不是合法 JSON：${bodyRaw.slice(0, 60)}`);
      console.error(`   提示：cmd 下双引号会被剥，建议 body 写宽松形式如 {force:true}（已自动补引号）或改用临时脚本`);
      process.exit(1);
    }
  }
}
// BASE 已含 /api，path 直接拼接（如 /health 或 health）
const fullPath = p.startsWith("/") ? p : "/" + p;
try {
  const { status, data } = await call(fullPath, method.toUpperCase(), body);
  console.log(`HTTP ${status}`);
  const out = JSON.stringify(data, null, 2);
  // 大响应降本（2026-08-16）：默认截断，--full 全量（回测序列等大响应避免刷屏费 token）
  if (!fullOut && out.length > 4000) {
    console.log(out.slice(0, 4000));
    console.log(`\n…（响应 ${out.length} 字符，已截断；如需全量加 --full）`);
  } else {
    console.log(out);
  }
} catch (e) {
  console.log(`HTTP ${e.status ?? "ERR"} ❌ ${e.message}`);
  if (e.data) console.log(JSON.stringify(e.data, null, 2));
  process.exit(1);
}
