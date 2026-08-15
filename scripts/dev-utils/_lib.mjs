// ============================================================
// 开发辅助脚本共享库（scripts/dev-utils/_lib.mjs）
// 统一：仓库根解析 + tsx/vite CLI 动态路径查找（pnpm 升级版本后写死路径会失效）。
// 用法：import { ROOT, tsxCli, viteCli } from "./_lib.mjs";
// ============================================================
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（scripts/dev-utils/ 上两级） */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** pnpm 包目录（node_modules/.pnpm） */
function pnpmDir() {
  return path.join(ROOT, "node_modules", ".pnpm");
}

/** 动态查找某包（如 tsx@、vite@）的 CLI 入口：取最新版本目录，存在即返回；否则回退指定版本。 */
function findCli(pkgPrefix, cliRel, fallbackVer) {
  const dir = pnpmDir();
  try {
    const dirs = readdirSync(dir).filter((d) => d.startsWith(pkgPrefix));
    if (dirs.length) {
      dirs.sort().reverse(); // 版本号字符串排序近似最新
      const p = path.join(dir, dirs[0], "node_modules", ...cliRel);
      if (existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  return path.join(dir, pkgPrefix + fallbackVer, "node_modules", ...cliRel);
}

/** tsx CLI 入口（动态查找最新 tsx@ 目录） */
export const tsxCli = findCli("tsx@", ["tsx", "dist", "cli.mjs"], "4.23.5");

/** vite CLI 入口（动态查找最新 vite@ 目录） */
export const viteCli = findCli("vite@", ["vite", "bin", "vite.js"], "7.2.2");
