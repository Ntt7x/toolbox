// ============================================================
// 开发辅助脚本：git 提交包装（scripts/dev-utils/commit.mjs）
// 固化「写 .git/COMMIT_MSG_TMP.txt + git commit -F」模式——cmd 引号/分号
// 导致 git 提交消息被拆解的历史痛点（dev.md §4）。
// 用法（node scripts/dev-utils/commit.mjs <消息>）：
//   node scripts/dev-utils/commit.mjs "feat(x): 说明"
// 多行：消息内用 \n 分隔；自动 git add -A → commit → push（--no-add 跳过 add）。
// push 失败不丢提交：保留本地提交、报告原因、exit 非 0（§4.2「提交即推送」）。
// 2026-08-16 增强：垃圾文件检测（cmd 产物畸形文件名防混入提交）+ 尾部引号清理。
// 2026-09-03 增强：--file 读消息（根治 Windows 控制台中文参数编码破坏，见下）。
// ============================================================
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT as root } from "./_lib.mjs";

const MSG = path.join(root, ".git", "COMMIT_MSG_TMP.txt");
const args = process.argv.slice(2);
const noAdd = args.includes("--no-add");
const noPush = args.includes("--no-push");

// ---------- 提交消息来源 ----------
// ⚠️ Windows 控制台编码坑（2026-09-03 实测）：cmd/PowerShell 以 GBK(936) 向 node 传参时，
// process.argv 拿到的是「UTF-8 字节被按 GBK 解释」的乱码（"首屏"→"棣栧睆"、"→"→"鈫?"），
// 写进 commit message 即永久损坏历史。Node 侧无法可靠还原（需 GBK 编码器），
// **根治办法是绕开命令行传参**：把消息写成 UTF-8 文件，用 --file 读取。
//   用法：node scripts/dev-utils/commit.mjs --file <消息文件> [--amend] [--no-add] [--no-push]
const fileIdx = args.indexOf("--file");
const msgFile = fileIdx >= 0 ? args[fileIdx + 1] : null;
const reserved = new Set(["--no-add", "--no-push", "--amend"]);
if (fileIdx >= 0) { reserved.add("--file"); reserved.add(msgFile); }
const amend = args.includes("--amend");
const msg = (
  msgFile
    ? readFileSync(msgFile, "utf8")
    : args.filter((a) => !reserved.has(a)).join(" ")
).replace(/\\n/g, "\n").trim();

if (!msg) {
  console.error("用法: node scripts/dev-utils/commit.mjs <提交消息> [--file <消息文件>] [--amend] [--no-add] [--no-push]\n多行用 \\n 分隔；中文消息建议用 --file（UTF-8 文件）避免控制台编码破坏");
  process.exit(1);
}
// 编码哨兵：命令行传入的中文若已被破坏，大多会体现为替换字符/异常连续的私用区字符
if (!msgFile && /\uFFFD/.test(msg)) {
  console.error("❌ 提交消息含 U+FFFD 替换字符（命令行中文编码已破坏）。请改用 --file <UTF-8 消息文件> 传入。");
  process.exit(1);
}

// ---------- 垃圾文件检测（2026-08-16） ----------
// Windows cmd 下 node -e 失败 / 重定向 / 引号剥离常产生畸形文件（$null、{xxx、含括号引号），
// 曾多次混入提交后 amend/清理。提交前拦截，避免污染历史。
const JUNK_RE = /^\$null$|^\{|^m\[|\$\{|\}'|'|"|`|\)$/;
const st = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
const junk = (st.stdout || "")
  .split("\n")
  .filter((l) => l.startsWith("??"))
  .map((l) => l.slice(3).trim())
  .filter((f) => f && JUNK_RE.test(f));
if (junk.length > 0) {
  console.error(`❌ 检测到 ${junk.length} 个疑似垃圾文件（cmd 畸形产物），中止提交。请先清理：`);
  for (const f of junk) console.error(`   ${f}`);
  console.error('   删除示例：node -e "const fs=require(\'fs\');fs.rmSync(process.argv[1],{force:true})" <路径>');
  process.exit(1);
}

if (!noAdd) {
  const a = spawnSync("git", ["add", "-A"], { cwd: root, stdio: "inherit" });
  if (a.status !== 0) { console.error("git add 失败"); process.exit(1); }
}
writeFileSync(MSG, msg, "utf8");
const c = spawnSync("git", ["commit", ...(amend ? ["--amend"] : []), "-F", MSG], { cwd: root, stdio: "inherit" });
try { unlinkSync(MSG); } catch { /* ignore */ }
if (c.status !== 0) process.exit(c.status ?? 1);

// 提交即推送（§4.2 强制规则）；branch 未设 upstream 时用 -u origin <分支>
if (!noPush) {
  const br = spawnSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" });
  const branch = (br.stdout || "").trim();
  // amend 改写历史 → 需强制推送（仅限本分支、刚推送无他人协作的场景）
  const args2 = branch ? ["push", ...(amend ? ["--force-with-lease"] : []), "-u", "origin", branch] : ["push"];
  const p = spawnSync("git", args2, { cwd: root, stdio: "inherit" });
  if (p.status !== 0) {
    console.error(`\n⚠️ push 失败（提交已保留在本地 ${branch}），稍后重推：git push${branch ? " origin " + branch : ""}`);
    process.exit(p.status ?? 1);
  }
}
process.exit(0);
