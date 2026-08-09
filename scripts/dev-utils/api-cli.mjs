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

const [method, p, bodyRaw] = process.argv.slice(2);
if (!method || !p) {
  console.error(`用法: node scripts/dev-utils/api-cli.mjs <GET|POST|PUT|DELETE> <path> [json-body]\nBASE: ${BASE}`);
  process.exit(1);
}
let body;
if (bodyRaw) {
  try {
    body = JSON.parse(bodyRaw);
  } catch {
    console.error(`❌ body 不是合法 JSON：${bodyRaw.slice(0, 60)}`);
    process.exit(1);
  }
}
// BASE 已含 /api，path 直接拼接（如 /health 或 health）
const fullPath = p.startsWith("/") ? p : "/" + p;
try {
  const { status, data } = await call(fullPath, method.toUpperCase(), body);
  console.log(`HTTP ${status}`);
  console.log(JSON.stringify(data, null, 2));
} catch (e) {
  console.log(`HTTP ${e.status ?? "ERR"} ❌ ${e.message}`);
  if (e.data) console.log(JSON.stringify(e.data, null, 2));
  process.exit(1);
}
