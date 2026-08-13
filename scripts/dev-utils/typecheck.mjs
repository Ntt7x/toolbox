// ============================================================
// 开发辅助脚本：TypeScript 类型检查（scripts/dev-utils/typecheck.mjs）
// 固化 L0 验证（dev.md §5.1）：改动后必跑全仓 typecheck（server + web + shared）。
// 用法（node scripts/dev-utils/typecheck.mjs [--app server|web]）：
//   typecheck            全仓（pnpm -r run typecheck）
//   typecheck --app web  仅 web（定向提速，配合单页改动）
// 退出码：tsc 失败 → 非 0。
// ============================================================
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const appIdx = args.indexOf("--app");
const app = appIdx >= 0 ? args[appIdx + 1] : null;

// Windows 上 pnpm 是 .cmd；用 shell:true 保证可用；cwd 固定为仓库根
function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", shell: true });
  return r.status ?? 1;
}

if (app === "server" || app === "web") {
  process.exit(run("pnpm", ["--filter", "@toolbox/" + app, "run", "typecheck"]));
}
process.exit(run("pnpm", ["-r", "run", "typecheck"]));
