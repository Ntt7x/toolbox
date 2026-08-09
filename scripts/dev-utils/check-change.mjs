// ============================================================
// 开发辅助脚本：改动健康检查（scripts/dev-utils/check-change.mjs）
// 受「Agent Loop Engineering」范式 V 启发（预检截断 R_max + 影响面因果半径）：
//   提交前先看"这刀切得大不大、切到哪些层"，再决定验证级别。
// 用法：
//   node scripts/dev-utils/check-change.mjs [--base main] [--stat-only]
// 对比范围：base..HEAD（默认 origin/main；工作区未提交改动也会计入）
// 输出：分级报告（PASS / WARN / FAIL）+ 建议验证级别（对照 dev.md §5.1）
//   FAIL：改动过大（>30 文件 或 >2000 行）→ 建议拆分提交
//   WARN：触及核心层 core/ → 强制 L3 冒烟；服务端 feature → L1 单测；前端页面 → --page 定向冒烟
// exit code：0=PASS / 1=WARN / 2=FAIL（只提示不拦截——控制效率原则：提示成本极低）
// ============================================================
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const base = baseIdx >= 0 ? args[baseIdx + 1] : "origin/main";
const statOnly = args.includes("--stat-only");

// 阈值（R_max 思想：单步改动幅度上限，来源启发式经验，可调）
const THRESHOLDS = {
  filesFail: 30,   // 文件数 FAIL 阈值
  linesFail: 2000, // 总行数 FAIL 阈值
  filesWarn: 15,   // 文件数 WARN 阈值
  coreWarn: true,  // 触及 core/ 即 WARN（核心层影响面大）
};

// 获取 diff stat：git diff <baseRef> = base 与当前工作区（含未提交 + 已提交）的全部差异
function diffStat(baseRef) {
  const r = spawnSync("git", ["diff", "--stat=200", baseRef], { encoding: "utf8" });
  return (r.stdout || "").trim();
}

// 解析 diff --stat 输出 → [{file, add, del}]
function parseStat(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^|]+?)\s*\|\s*(\d+)\s*([+-]+)/);
    if (m) rows.push({ file: m[1].trim(), changes: Number(m[2]) });
  }
  return rows;
}

const stat = diffStat(base);
const rows = parseStat(stat);
const totalFiles = rows.length;
const totalLines = rows.reduce((s, r) => s + r.changes, 0);
const maxFile = rows.reduce((m, r) => Math.max(m, r.changes), 0);

// 影响面分层（对照 dev.md §1 架构）
const touched = { core: [], features: [], web: [], docs: [], scripts: [], other: [] };
for (const r of rows) {
  const f = r.file;
  if (f.startsWith("apps/server/src/core/")) touched.core.push(f);
  else if (f.startsWith("apps/server/src/features/")) touched.features.push(f);
  else if (f.startsWith("apps/web/")) touched.web.push(f);
  else if (f.startsWith("docs/")) touched.docs.push(f);
  else if (f.startsWith("scripts/")) touched.scripts.push(f);
  else touched.other.push(f);
}

if (statOnly) {
  console.log(`文件数: ${totalFiles} | 总行数: ${totalLines} | 最大单文件: ${maxFile}`);
  console.log("分层: core=" + touched.core.length + " features=" + touched.features.length +
    " web=" + touched.web.length + " docs=" + touched.docs.length + " scripts=" + touched.scripts.length);
  process.exit(0);
}

// 分级判定
const issues = [];
let level = "PASS";

if (totalFiles > THRESHOLDS.filesFail || totalLines > THRESHOLDS.linesFail) {
  level = "FAIL";
  issues.push(`⚠️ 改动过大（${totalFiles} 文件 / ${totalLines} 行 > ${THRESHOLDS.filesFail} 文件 / ${THRESHOLDS.linesFail} 行）→ 建议拆分提交（R_max 截断思想），一次聚焦一个主题`);
} else if (totalFiles > THRESHOLDS.filesWarn) {
  if (level === "PASS") level = "WARN";
  issues.push(`⚠️ 改动偏大（${totalFiles} 文件）→ 建议仔细核对每处改动，考虑是否可拆分`);
}

if (touched.core.length > 0) {
  if (level === "PASS") level = "WARN";
  issues.push(`🔴 触及核心层 core/（${touched.core.length} 文件）→ 影响面大，强制 L3 全量冒烟 + 相关单测`);
}
if (touched.features.length > 0) {
  if (level === "PASS") level = "WARN";
  issues.push(`🟠 触及业务层 features/（${touched.features.length} 文件）→ 跑相关模块单测（test.mjs <模块>）+ 定向 API 断言（api-cli，§6.7）`);
}
if (touched.web.length > 0) {
  if (level === "PASS") level = "WARN";
  const uiFiles = touched.web.filter((f) => f.includes("/components/ui/") || f.includes("/lib/") || f.includes("/hooks/"));
  if (uiFiles.length > 0) {
    issues.push(`🟢 触及前端组件/共享层（${uiFiles.length} 文件）→ §5.1 影响面判定：grep 使用方（grep -rl "ui/${uiFiles[0].split("/").pop()?.replace(".tsx","")}" apps/web/src）→ 使用方页面定向冒烟（不因文件多而全量）`);
  } else {
    issues.push(`🟢 触及前端 web/（${touched.web.length} 文件）→ 目标页定向冒烟（smoke-pages.mjs --page /tools/x；页面加载逻辑改动则 L3）`);
  }
}

// 报告
console.log(`═══ 改动健康检查（base: ${base}）═══`);
console.log(`文件数: ${totalFiles} | 总行数: ${totalLines} | 最大单文件: ${maxFile} 行`);
console.log(`分层: core=${touched.core.length} features=${touched.features.length} web=${touched.web.length} docs=${touched.docs.length} scripts=${touched.scripts.length} other=${touched.other.length}`);
if (totalFiles === 0) {
  console.log("✅ 无改动（工作区与 base 一致）");
  process.exit(0);
}
if (issues.length === 0) {
  console.log("✅ PASS：小改动，按 §5.1 L2 定向验证即可");
} else {
  console.log(`🔶 ${level}`);
  issues.forEach((i) => console.log("  " + i));
  console.log("（提示不拦截——控制效率原则：提示成本极低，拦截要算账）");
}
process.exit(level === "FAIL" ? 2 : level === "WARN" ? 1 : 0);
