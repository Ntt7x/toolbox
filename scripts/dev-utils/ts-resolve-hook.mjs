// ============================================================
// TS resolve hook（scripts/dev-utils/ts-resolve-hook.mjs）
// 免 spawn 跑 TS 单测/脚本的核心：把 .js 引用映射回 .ts 源文件
// （node --import + --test-isolation=none 时，import "./x.js" 实际加载 ./x.ts）。
// 用法：node --import ./scripts/dev-utils/ts-resolve-hook.mjs <file.ts>
// 背景：沙盒/受限环境无法 spawn tsx（EPERM），此 hook 让纯 node 直接跑 TS。
// ============================================================
import { register } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

register(new URL(import.meta.url));

/** 将相对 .js 导入解析为同目录 .ts（若存在） */
export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : undefined;
    if (parent) {
      const abs = path.resolve(path.dirname(parent), specifier);
      const tsPath = abs.slice(0, -3) + ".ts";
      if (existsSync(tsPath)) {
        return { url: pathToFileURL(tsPath).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
