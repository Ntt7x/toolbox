// ============================================================
// 开发辅助脚本：KV/DB 检查 CLI（scripts/dev-utils/kv.mjs）
// 反复需求固化：检查本地数据（.file/toolbox.db kv_store）——
// 「测试数据残留了没」「某前缀有多少条」等排查。
// 用法（node scripts/dev-utils/kv.mjs ...）：
//   list [prefix]        列出 key（可选前缀过滤；--limit N 默认 100）
//   count [prefix]       统计条数
//   get <key>            读取单条并格式化输出
// 说明：node:sqlite 只读打开，DB 路径自动定位（根 .file/ 或 apps/server/.file/）。
// ============================================================
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DB_CANDIDATES = [join(process.cwd(), ".file", "toolbox.db"), join(process.cwd(), "apps", "server", ".file", "toolbox.db")];
const dbPath = DB_CANDIDATES.find((p) => existsSync(p));
if (!dbPath) {
  console.error("未找到 toolbox.db（.file/toolbox.db）");
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });

const [cmd, arg] = process.argv.slice(2);
const limit = process.argv.includes("--limit") ? Number(process.argv[process.argv.indexOf("--limit") + 1]) : 100;

if (cmd === "count") {
  const { c } = db.prepare("select count(*) as c from kv_store where key like ?").get((arg ?? "") + "%");
  console.log(`${arg ?? "(全部)"} → ${c} 条`);
} else if (cmd === "get") {
  if (!arg) { console.error("用法: kv.mjs get <key>"); process.exit(1); }
  const row = db.prepare("select value from kv_store where key = ?").get(arg);
  if (!row) { console.log(`${arg} → 不存在`); process.exit(0); }
  try { console.log(JSON.stringify(JSON.parse(row.value), null, 2)); } catch { console.log(row.value); }
} else {
  // list [prefix]
  const rows = db.prepare("select key, length(value) as len from kv_store where key like ? order by key limit ?").all((arg ?? "") + "%", limit);
  console.log(`${arg ?? "(全部)"} → ${rows.length} 条（限 ${limit}）`);
  for (const r of rows) console.log(` - ${r.key} (${r.len} bytes)`);
}
