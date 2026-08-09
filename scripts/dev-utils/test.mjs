// ============================================================
// 开发辅助脚本：模块单测快捷（scripts/dev-utils/test.mjs）
// 固化「手拼 tsx --test 长命令」的重复操作。
// 用法（node scripts/dev-utils/test.mjs [模块名|路径]）：
//   test                     跑 server 全部 *.test.ts（node:test）
//   test tradePlan           跑 features/tradePlan 单测
//   test core/tasks          跑 core/tasks.test.ts
// 路径自动补全：参数支持 模块名 / features/模块 / core/模块 / 相对路径。
// ============================================================
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = path.join(root, "node_modules", ".pnpm", "tsx@4.23.5", "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_TESTS = path.join(root, "apps", "server", "src");

function findTests(arg) {
  if (!arg) {
    // 全部 server 单测
    const out = [];
    const walk = (d) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.test\.ts$/.test(f.name)) out.push(p);
      }
    };
    walk(SERVER_TESTS);
    return out;
  }
  // 参数 → 定位测试文件
  const cands = [
    path.join(SERVER_TESTS, arg),
    path.join(SERVER_TESTS, "features", arg),
    path.join(SERVER_TESTS, "core", arg),
    path.join(SERVER_TESTS, arg + ".test.ts"),
    path.join(SERVER_TESTS, "features", arg + ".test.ts"),
    path.join(SERVER_TESTS, "core", arg + ".test.ts"),
  ];
  // 目录 → 目录内全部 .test.ts
  for (const c of cands) {
    if (existsSync(c)) {
      if (c.endsWith(".test.ts")) return [c];
      const out = readdirSync(c, { withFileTypes: true }).filter((f) => f.isFile() && /\.test\.ts$/.test(f.name)).map((f) => path.join(c, f.name));
      if (out.length) return out;
    }
  }
  // features/模块/模块.test.ts 模式
  const featTest = path.join(SERVER_TESTS, "features", arg, arg + ".test.ts");
  if (existsSync(featTest)) return [featTest];
  return null;
}

const arg = process.argv[2];
const tests = findTests(arg);
if (!tests) {
  console.error(`未找到 ${arg || ""} 对应的单测（支持：模块名 / features/x / core/x / 全量）`);
  process.exit(1);
}
console.log(`跑 ${tests.length} 个测试文件${arg ? `（${arg}）` : "（全量）"}`);
// 全量时逐文件串行：多个测试文件共享同一 SQLite DB，node:test 默认并行会写锁
// （曾出现 "database is locked"）；单文件直接跑。
let status = 0;
if (tests.length === 1) {
  status = spawnSync(process.execPath, [TSX, "--test", ...tests], { stdio: "inherit" }).status ?? 1;
} else {
  for (const t of tests) {
    const name = path.relative(SERVER_TESTS, t);
    console.log(`\n── ${name} ──`);
    const r = spawnSync(process.execPath, [TSX, "--test", t], { stdio: "inherit" });
    if ((r.status ?? 1) !== 0) status = r.status ?? 1;
  }
}
process.exit(status);
