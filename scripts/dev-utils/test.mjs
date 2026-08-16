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
import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { ROOT as root, tsxCli as TSX } from "./_lib.mjs";

const SERVER_TESTS = path.join(root, "apps", "server", "src");
const WEB_TESTS = path.join(root, "apps", "web", "src"); // web 纯函数单测（tradeV2Parse 等，无 React 依赖）

function findTests(arg) {
  if (!arg) {
    // 全部单测（server + web 纯函数）
    const out = [];
    const walk = (d) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.test\.ts$/.test(f.name)) out.push(p);
      }
    };
    walk(SERVER_TESTS);
    if (existsSync(WEB_TESTS)) walk(WEB_TESTS);
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
    path.join(WEB_TESTS, arg + ".test.ts"),
    path.join(WEB_TESTS, arg),
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
  // web 纯函数测试：递归按文件名匹配（tools/settings/components 等子目录）
  const webHit = (() => {
    if (!existsSync(WEB_TESTS)) return null;
    const walk = (d) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) { const r = walk(p); if (r) return r; }
        else if (f.name === arg + ".test.ts") return p;
      }
      return null;
    };
    return walk(WEB_TESTS);
  })();
  if (webHit) return [webHit];
  return null;
}


// 能力探测：workspace-write 沙盒禁 pipe 模式 spawn（node:test 子进程隔离会 EPERM），
// 此时自动回退 --no-spawn（resolve hook 免 spawn）。FullAccess 下 tsx --test 可直跑。
const args0 = process.argv.slice(2);
const noSpawn = args0.includes("--no-spawn");
const HOOK = path.join(root, "scripts", "dev-utils", "ts-resolve-hook.mjs");
const args = args0.filter((a) => a !== "--no-spawn");
const arg = args[0];

function canSpawnPipe() {
  try {
    // ESM 下不可用 require（曾导致恒 false 总是回退）——直接复用已导入的 spawnSync
    const r = spawnSync(process.execPath, ["-e", "setTimeout(()=>{},50)"], { stdio: "pipe", timeout: 5000 });
    return r.status === 0;
  } catch { return false; }
}

const tests = findTests(arg);
if (!tests) {
  console.error(`未找到 ${arg || ""} 对应的单测（支持：模块名 / features/x / core/x / 全量）`);
  process.exit(1);
}
console.log(`跑 ${tests.length} 个测试文件${arg ? `（${arg}）` : "（全量）"}`);

// 执行：--no-spawn 用 resolve hook（node --import + --test-isolation=none，免 tsx spawn）；
// 默认用 tsx --test。全量时逐文件串行（多文件共享 SQLite，node:test 并行会写锁）。
let status = 0;
// 显式 --no-spawn 或沙盒禁 pipe spawn → resolve hook 模式；否则 tsx --test
const useHook = noSpawn || !canSpawnPipe();
if (useHook && !noSpawn) console.log("⚠ 沙盒禁 pipe spawn，自动回退 --no-spawn（resolve hook 免 tsx）");
const runOne = (t) => {
  if (useHook) {
    return spawnSync(process.execPath, ["--import", "file:///" + HOOK.replace(/\\/g, "/"), "--test-isolation=none", "--test", t], { stdio: "inherit", env: { ...process.env, TOOLBOX_TEST: "1" } }).status ?? 1;
  }
  return spawnSync(process.execPath, [TSX, "--test", t], { stdio: "inherit" }).status ?? 1;
};
if (tests.length === 1) {
  status = runOne(tests[0]);
} else {
  for (const t of tests) {
    console.log(`\n── ${path.relative(SERVER_TESTS, t)} ──`);
    const s = runOne(t);
    if (s !== 0) status = s;
  }
}
process.exit(status);
