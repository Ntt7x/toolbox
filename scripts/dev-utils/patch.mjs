// ============================================================
// 开发辅助脚本：文件文本替换执行器（scripts/dev-utils/patch.mjs）
// 固化「反复手写的 tmp_patch_*.mjs」：readFileSync → indexOf 锚点 → replace → writeFileSync
// 的整套流程。用法：
//   node scripts/dev-utils/patch.mjs <patch.json> [--apply]
// patch.json 格式（数组，顺序执行）：
//   [
//     {
//       "file": "apps/web/src/tools/X.tsx",
//       "find": "精确文本（支持 \\n 自动匹配 CRLF）",
//       "replace": "替换文本",
//       "count": 1          // 期望出现次数（默认 1；0 = 只检查存在不替换）
//     }
//   ]
// 行为：
//   - 默认 dry-run：逐条检查并报告 ✓/✗，不写盘；--apply 才写盘（全部通过才写，原子）
//   - find 的 \n 自动尝试 CRLF 版本（文件是 CRLF 时）
//   - 全部通过 → 写盘并报告；任一失败 → 不写盘并 exit 1
// ============================================================
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const patchFile = args.find((a) => !a.startsWith("--"));
if (!patchFile || !existsSync(patchFile)) {
  console.error("用法: node scripts/dev-utils/patch.mjs <patch.json> [--apply]");
  process.exit(1);
}

const patches = JSON.parse(readFileSync(patchFile, "utf8"));
if (!Array.isArray(patches)) {
  console.error("patch.json 必须是数组");
  process.exit(1);
}

let allOk = true;
const contents = new Map(); // file → 当前（累积）content
const results = []; // 写盘清单（file 去重）
for (let i = 0; i < patches.length; i++) {
  const p = patches[i];
  if (!p?.file || typeof p.find !== "string") {
    console.log(`  [${i + 1}] ❌ 缺 file/find`);
    allOk = false;
    continue;
  }
  const file = p.file;
  if (!existsSync(file)) {
    console.log(`  [${i + 1}] ❌ ${file} 不存在`);
    allOk = false;
    continue;
  }
  // 同文件多补丁 → 基于累积 content 应用（避免后者覆盖前者）
  let content = contents.get(file);
  if (content === undefined) {
    content = readFileSync(file, "utf8");
    results.push(file);
  }
  const want = typeof p.count === "number" ? p.count : 1;
  // 尝试 find 原样 + CRLF 版
  const tryFind = content.includes(p.find) ? p.find : content.includes(p.find.replace(/\n/g, "\r\n")) ? p.find.replace(/\n/g, "\r\n") : p.find;
  const found = content.split(tryFind).length - 1;
  if (want === 0) {
    // count=0：仅确认存在（≥1 处）不替换
    if (found < 1) {
      console.log(`  [${i + 1}] ❌ ${file}：「${p.find.slice(0, 50)}...」未找到（期望存在）`);
      allOk = false;
    } else {
      console.log(`  [${i + 1}] ✅ ${file}：确认存在 ${found} 处（count=0 不替换）`);
    }
    continue;
  }
  if (found !== want) {
    console.log(`  [${i + 1}] ❌ ${file}：「${p.find.slice(0, 50)}...」期望 ${want} 处，实际 ${found} 处`);
    allOk = false;
    continue;
  }
  content = content.replace(tryFind, p.replace);
  contents.set(file, content); // 累积更新
  console.log(`  [${i + 1}] ✅ ${file}：替换 ${found} 处`);
}

if (!allOk) {
  console.log(`═══ 补丁失败（未写盘）═══`);
  process.exit(1);
}
if (!apply) {
  console.log(`═══ 全部通过（dry-run，未写盘）；加 --apply 应用 ═══`);
  process.exit(0);
}
for (const file of results) writeFileSync(file, contents.get(file));
console.log(`═══ 已写盘 ${results.length} 个文件 ═══`);
