// ============================================================
// 开发辅助脚本：git 提交包装（scripts/dev-utils/commit.mjs）
// 固化「写 .git/COMMIT_MSG_TMP.txt + git commit -F」模式——cmd 引号/分号
// 导致 git 提交消息被拆解的历史痛点（dev.md §4）。
// 用法（node scripts/dev-utils/commit.mjs <消息>）：
//   node scripts/dev-utils/commit.mjs "feat(x): 说明"
// 多行：消息内用 \n 分隔；自动 git add -A → commit → push（--no-add 跳过 add）。
// push 失败不丢提交：保留本地提交、报告原因、exit 非 0（§4.2「提交即推送」）。
// ============================================================
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MSG = path.join(root, ".git", "COMMIT_MSG_TMP.txt");
const args = process.argv.slice(2);
const noAdd = args.includes("--no-add");
const noPush = args.includes("--no-push");
const msg = args.filter((a) => !a.startsWith("--")).join(" ").replace(/\\n/g, "\n").trim();

if (!msg) {
  console.error("用法: node scripts/dev-utils/commit.mjs <提交消息> [--no-add] [--no-push]\n多行用 \\n 分隔");
  process.exit(1);
}

if (!noAdd) {
  const a = spawnSync("git", ["add", "-A"], { cwd: root, stdio: "inherit" });
  if (a.status !== 0) { console.error("git add 失败"); process.exit(1); }
}
writeFileSync(MSG, msg, "utf8");
const c = spawnSync("git", ["commit", "-F", MSG], { cwd: root, stdio: "inherit" });
try { unlinkSync(MSG); } catch { /* ignore */ }
if (c.status !== 0) process.exit(c.status ?? 1);

// 提交即推送（§4.2 强制规则）；branch 未设 upstream 时用 -u origin <分支>
if (!noPush) {
  const br = spawnSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" });
  const branch = (br.stdout || "").trim();
  const args2 = branch ? ["push", "-u", "origin", branch] : ["push"];
  const p = spawnSync("git", args2, { cwd: root, stdio: "inherit" });
  if (p.status !== 0) {
    console.error(`\n⚠️ push 失败（提交已保留在本地 ${branch}），稍后重推：git push${branch ? " origin " + branch : ""}`);
    process.exit(p.status ?? 1);
  }
}
process.exit(0);
