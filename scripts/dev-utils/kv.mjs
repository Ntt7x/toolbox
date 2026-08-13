// ============================================================
// 开发辅助脚本：KV/DB 检查 CLI（scripts/dev-utils/kv.mjs）
// 反复需求固化：检查本地数据（.file/toolbox.db kv_store）——
// 「测试数据残留了没」「某前缀有多少条」等排查。
// 用法（node scripts/dev-utils/kv.mjs ...）：
//   list [prefix]        列出 key（可选前缀过滤；--limit N 默认 100）
//   count [prefix]       统计条数
//   get <key>            读取单条并格式化输出
//   backup <key> [file]  备份单条到 .file/kv-backup/<key>.json（危险操作/迁移前先备份）
//   restore <key> [file] 从备份文件恢复单条（INSERT OR REPLACE，安全写回）
// 说明：只读操作 readOnly 打开；restore 单独读写连接。DB 路径自动定位（根 .file/ 或 apps/server/.file/）。
// ============================================================
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const DB_CANDIDATES = [join(process.cwd(), ".file", "toolbox.db"), join(process.cwd(), "apps", "server", ".file", "toolbox.db")];
const dbPath = DB_CANDIDATES.find((p) => existsSync(p));
if (!dbPath) {
  console.error("未找到 toolbox.db（.file/toolbox.db）");
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });

const [cmd, arg] = process.argv.slice(2);
const limit = process.argv.includes("--limit") ? Number(process.argv[process.argv.indexOf("--limit") + 1]) : 100;

/** 备份文件名（key 中的特殊字符替换为 _） */
const backupFile = (key, explicit) => {
  if (explicit) return explicit;
  return join(dirname(dbPath), "kv-backup", `${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
};

if (cmd === "count") {
  const { c } = db.prepare("select count(*) as c from kv_store where key like ?").get((arg ?? "") + "%");
  console.log(`${arg ?? "(全部)"} → ${c} 条`);
} else if (cmd === "get") {
  if (!arg) { console.error("用法: kv.mjs get <key>"); process.exit(1); }
  const row = db.prepare("select value from kv_store where key = ?").get(arg);
  if (!row) { console.log(`${arg} → 不存在`); process.exit(0); }
  try { console.log(JSON.stringify(JSON.parse(row.value), null, 2)); } catch { console.log(row.value); }
} else if (cmd === "backup") {
  if (!arg) { console.error("用法: kv.mjs backup <key> [file]"); process.exit(1); }
  const row = db.prepare("select value, updated_at from kv_store where key = ?").get(arg);
  if (!row) { console.log(`${arg} → 不存在，无需备份`); process.exit(0); }
  const file = backupFile(arg, process.argv[4]);
  mkdirSync(dirname(file), { recursive: true });
  let parsed;
  try { parsed = JSON.parse(row.value); } catch { parsed = row.value; }
  writeFileSync(file, JSON.stringify({ key: arg, value: parsed, updatedAt: row.updated_at, backupAt: new Date().toISOString() }, null, 2));
  console.log(`已备份 ${arg} → ${file}`);
} else if (cmd === "restore") {
  if (!arg) { console.error("用法: kv.mjs restore <key> [file]"); process.exit(1); }
  const file = backupFile(arg, process.argv[4]);
  if (!existsSync(file)) { console.log(`备份文件不存在: ${file}`); process.exit(1); }
  const data = JSON.parse(readFileSync(file, "utf8"));
  const wdb = new DatabaseSync(dbPath);   // 读写连接（restore 专用）
  wdb.prepare("INSERT OR REPLACE INTO kv_store(key, value, updated_at) VALUES(?, ?, datetime('now'))").run(arg, JSON.stringify(data.value));
  wdb.close();
  console.log(`已恢复 ${arg} ← ${file}`);
} else {
  // list [prefix]
  const rows = db.prepare("select key, length(value) as len from kv_store where key like ? order by key limit ?").all((arg ?? "") + "%", limit);
  console.log(`${arg ?? "(全部)"} → ${rows.length} 条（限 ${limit}）`);
  for (const r of rows) console.log(` - ${r.key} (${r.len} bytes)`);
}
