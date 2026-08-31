// ============================================================
// 开发辅助脚本：SQLite 数据诊断 + WAL 恢复排查（scripts/dev-utils/dbdiag.mjs）
// 事故固化：2026-08-31 低级 agent 直连 DB 误删 137 条仓位交易 → 沉淀排查法
// 用法（node scripts/dev-utils/dbdiag.mjs ...）：
//   health                 完整性检查 + 键前缀分布（只读）
//   compare <备份DB路径>   对比当前库与备份：总键数/指定前缀条数/分布差异
//   prefix <前缀>          统计某前缀的条数与按日期/字段分布（如 tradeV2:trade: 按 date）
//   wal <wal文件> [--prefix X]  扫描 WAL 提取含 key 的行（可恢复已删帧）
//   ids <wal文件> <前缀>    解码 id 时间戳分布（如 trade 创建日期分布）
// 说明：所有读操作 readOnly 打开；不修改任何数据。
// ============================================================
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DB_CANDIDATES = [join(process.cwd(), ".file", "toolbox.db"), join(process.cwd(), "apps", "server", ".file", "toolbox.db")];
const dbPath = DB_CANDIDATES.find((p) => existsSync(p));
if (!dbPath) {
  console.error("未找到 toolbox.db（.file/toolbox.db）");
  process.exit(1);
}
const [cmd, arg] = process.argv.slice(2);

/** 打开 DB（默认只读） */
function open(path, ro = true) {
  return new DatabaseSync(path, { readOnly: ro });
}

/** 统计某前缀 key 的条数 + 按 JSON 字段分布 */
function prefixStats(db, prefix, field) {
  const rows = db.prepare("select key, value from kv_store where key like ?").all(prefix + "%");
  const dist = {};
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value);
      const f = field && v ? String(v[field] ?? "?") : "?";
      dist[f] = (dist[f] ?? 0) + 1;
    } catch { dist["(非JSON)"] = (dist["(非JSON)"] ?? 0) + 1; }
  }
  return { total: rows.length, dist };
}

// ---------- health ----------
if (cmd === "health") {
  const db = open(dbPath);
  const ic = db.prepare("PRAGMA integrity_check").get();
  console.log(`完整性: ${ic.integrity_check}`);
  // 按一级前缀统计
  const rows = db.prepare("select key from kv_store").all();
  const dist = {};
  for (const r of rows) {
    const p = r.key.split(":")[0];
    dist[p] = (dist[p] ?? 0) + 1;
  }
  console.log(`总键数: ${rows.length}`);
  console.log("前缀分布:");
  for (const [k, n] of Object.entries(dist).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
  db.close();
}

// ---------- compare ----------
else if (cmd === "compare") {
  if (!arg || !existsSync(arg)) { console.error("用法: dbdiag compare <备份DB路径> [前缀...]"); process.exit(1); }
  const cur = open(dbPath);
  const bak = open(arg);
  const cTotal = cur.prepare("select count(*) c from kv_store").get().c;
  const bTotal = bak.prepare("select count(*) c from kv_store").get().c;
  console.log(`总键数: 当前=${cTotal} 备份=${bTotal} 差=${cTotal - bTotal}`);
  // 前缀参数：仅保留以冒号结尾/不含 .db 的（过滤误传路径）
  const prefixes = process.argv.slice(3).filter((p) => !p.includes(".") || p.endsWith(":"));
  for (const p of prefixes) {
    const c = prefixStats(cur, p, null);
    const b = prefixStats(bak, p, null);
    console.log(`\n前缀 ${p}: 当前=${c.total} 备份=${b.total} 差=${c.total - b.total}`);
  }
  cur.close(); bak.close();
}

// ---------- prefix ----------
else if (cmd === "prefix") {
  if (!arg) { console.error("用法: dbdiag prefix <前缀> [字段]"); process.exit(1); }
  const field = process.argv[3];
  const db = open(dbPath);
  const s = prefixStats(db, arg, field);
  console.log(`${arg} → ${s.total} 条`);
  if (field && Object.keys(s.dist).length) {
    console.log(`按 ${field} 分布:`);
    for (const [k, n] of Object.entries(s.dist).sort()) console.log(`  ${k}: ${n}`);
  }
  db.close();
}

// ---------- wal ----------
else if (cmd === "wal") {
  if (!arg || !existsSync(arg)) { console.error("用法: dbdiag wal <wal文件> [--prefix X]"); process.exit(1); }
  const prefix = process.argv.includes("--prefix") ? process.argv[process.argv.indexOf("--prefix") + 1] : "tradeV2:trade:";
  const wal = readFileSync(arg);
  const s = wal.toString("latin1");
  const pageSize = 4096;
  const found = new Map();
  for (let off = 32; off + 24 + pageSize <= wal.length; off += 24 + pageSize) {
    const page = wal.subarray(off + 24, off + 24 + pageSize).toString("latin1");
    let idx = 0;
    while ((idx = page.indexOf(prefix, idx)) !== -1) {
      const keyStart = idx;
      // key 到 { 为止（JSON 起始），避免吞入二进制干扰字符
      const brace = page.indexOf("{", keyStart);
      const key = brace === -1 ? page.slice(keyStart, keyStart + 200) : page.slice(keyStart, brace);
      if (brace === -1) { idx = keyStart + prefix.length; continue; }
      const ua = page.indexOf('"updatedAt"', brace);
      const close = ua === -1 ? -1 : page.indexOf("}", ua);
      if (close === -1) { idx = brace + 1; continue; }
      try {
        const v = JSON.parse(page.slice(brace, close + 1));
        found.set(key, v);
      } catch { /* 截断帧跳过 */ }
      idx = brace + 1;
    }
  }
  console.log(`WAL ${arg} 提取到 ${prefix} 唯一行: ${found.size}`);
  // 按 date 字段分布（若存在）
  const dates = {};
  for (const v of found.values()) {
    if (v && v.date) dates[v.date] = (dates[v.date] ?? 0) + 1;
  }
  if (Object.keys(dates).length) {
    console.log("按 date 分布:");
    for (const [k, n] of Object.entries(dates).sort()) console.log(`  ${k}: ${n}`);
  }
}

// ---------- ids ----------
else if (cmd === "ids") {
  if (!arg || !existsSync(arg)) { console.error("用法: dbdiag ids <wal文件> <前缀>"); process.exit(1); }
  const prefix = process.argv[4] ?? "tradeV2:trade:";
  const wal = readFileSync(arg);
  const s = wal.toString("latin1");
  const pageSize = 4096;
  const tsDist = {};
  let count = 0;
  for (let off = 32; off + 24 + pageSize <= wal.length; off += 24 + pageSize) {
    const page = wal.subarray(off + 24, off + 24 + pageSize).toString("latin1");
    let idx = 0;
    while ((idx = page.indexOf(prefix, idx)) !== -1) {
      const keyStart = idx;
      const brace = page.indexOf("{", keyStart);
      if (brace === -1) { idx = keyStart + prefix.length; continue; }
      const id = page.slice(keyStart + prefix.length, brace);
      const m = id.match(/^t-([a-z0-9]+)-/);
      if (m) {
        let ms = 0;
        for (const ch of m[1]) ms = ms * 36 + parseInt(ch, 36);
        const d = new Date(ms);
        if (!isNaN(d)) {
          const day = d.toISOString().slice(0, 10);
          tsDist[day] = (tsDist[day] ?? 0) + 1;
          count++;
        }
      }
      idx = brace + 1;
    }
  }
  console.log(`WAL ${arg} 中 ${prefix} 唯一 id: ${count}`);
  console.log("按 id 创建时间分布:");
  for (const [k, n] of Object.entries(tsDist).sort()) console.log(`  ${k}: ${n}`);
}

else {
  console.log(`用法: dbdiag health|compare <bak> [前缀...]|prefix <前缀> [字段]|wal <wal> [--prefix X]|ids <wal> <前缀>`);
}
