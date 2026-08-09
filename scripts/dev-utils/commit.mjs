// ============================================================
// 开发辅助脚本：git 提交包装（scripts/dev-utils/commit.mjs）
// 固化「写 .git/COMMIT_MSG_TMP.txt + git commit -F」模式——cmd 引号/分号
// 导致 git 提交消息被拆解的历史痛点（dev.md §6）。
// 用法（node scripts/dev-utils/commit.mjs <消息>）：
//   node scripts/dev-utils/commit.mjs "feat(x): 说明"
// 多行：消息内用 \n 分隔；自动 git add -A 后提交（--no-add 跳过 add）。
// ============================================================
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MSG = path.join(root, ".git", "COMMIT_MSG_TMP.txt");
const args = process.argv.slice(2);
const noAdd = args.includes("--no-add");
const msg = args.filter((a) => !a.startsWith("--")).join(" ").replace(/\\n/g, "\n").trim();

if (!msg) {
  console.error("用法: node scripts/dev-utils/commit.mjs <提交消息> [--no-add]\n多行用 \\n 分隔");
  process.exit(1);
}

if (!noAdd) {
  const a = spawnSync("git", ["add", "-A"], { cwd: root, stdio: "inherit" });
  if (a.status !== 0) { console.error("git add 失败"); process.exit(1); }
}
writeFileSync(MSG, msg, "utf8");
const c = spawnSync("git", ["commit", "-F", MSG], { cwd: root, stdio: "inherit" });
try { unlinkSync(MSG); } catch { /* ignore */ }
process.exit(c.status ?? 1);
