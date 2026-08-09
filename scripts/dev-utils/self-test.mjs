// scripts/dev-utils/self-test.mjs：dev-utils 工具自测（patch.mjs：多补丁同文件/不同文件/dry-run/count/CRLF）
// 工具改动后必跑：node scripts/dev-utils/self-test.mjs
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";

const PATCH = "node scripts/dev-utils/patch.mjs";
let fail = 0;
const t = (name, cond, extra) => {
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) fail++;
};

// 准备测试文件（LF + 一个含 CRLF 的文件）
writeFileSync("_t_p1.txt", "AAA\nBBB\nCCC\n");
writeFileSync("_t_p2.txt", "X\nY\nZ\n");
writeFileSync("_t_crlf.txt", "AAA\r\nBBB\r\nCCC\r\n");
writeFileSync("_t_patch.json", JSON.stringify([
  { file: "_t_p1.txt", find: "AAA", replace: "A1", count: 1 },
  { file: "_t_p1.txt", find: "CCC", replace: "C1", count: 1 },
  { file: "_t_p2.txt", find: "Y", replace: "Y1", count: 1 },
]));

// 1. dry-run 不写盘
execSync(`${PATCH} _t_patch.json`, { stdio: "pipe" });
t("dry-run 不写盘", readFileSync("_t_p1.txt", "utf8") === "AAA\nBBB\nCCC\n");

// 2. --apply 多补丁同文件累积 + 不同文件
execSync(`${PATCH} _t_patch.json --apply`, { stdio: "pipe" });
t("同文件多补丁累积（AAA→A1 且 CCC→C1）", readFileSync("_t_p1.txt", "utf8") === "A1\nBBB\nC1\n", "核心 bug 回归测试");
t("不同文件独立应用", readFileSync("_t_p2.txt", "utf8") === "X\nY1\nZ\n");

// 3. CRLF 文件匹配
writeFileSync("_t_crlf2.txt", readFileSync("_t_crlf.txt", "utf8"));
writeFileSync("_t_crlf_patch.json", JSON.stringify([
  { file: "_t_crlf2.txt", find: "AAA\nBBB", replace: "A1\nB1", count: 1 },
]));
execSync(`${PATCH} _t_crlf_patch.json --apply`, { stdio: "pipe" });
t("CRLF 文件 find 含 \\n 自动匹配", readFileSync("_t_crlf2.txt", "utf8") === "A1\r\nB1\r\nCCC\r\n");

// 4. count=0 存在性检查（不替换）
writeFileSync("_t_c0.json", JSON.stringify([
  { file: "_t_p2.txt", find: "Y1", replace: "忽略", count: 0 },
]));
const out = execSync(`${PATCH} _t_c0.json`, { stdio: "pipe" }).toString();
t("count=0 确认存在", out.includes("确认存在 1 处"), out.trim().split("\n")[0] ?? "");
t("count=0 不写盘", readFileSync("_t_p2.txt", "utf8") === "X\nY1\nZ\n");

// 5. count 不匹配报错（不写盘）
writeFileSync("_t_bad.json", JSON.stringify([
  { file: "_t_p2.txt", find: "NO_SUCH", replace: "x", count: 1 },
]));
let badExit = null;
try { execSync(`${PATCH} _t_bad.json --apply`, { stdio: "pipe" }); } catch (e) { badExit = e.status; }
t("count 不匹配 → 失败不写盘", badExit !== 0 && readFileSync("_t_p2.txt", "utf8") === "X\nY1\nZ\n");

// 清理
for (const f of ["_t_p1.txt", "_t_p2.txt", "_t_crlf.txt", "_t_crlf2.txt", "_t_patch.json", "_t_crlf_patch.json", "_t_c0.json", "_t_bad.json"]) if (existsSync(f)) unlinkSync(f);

console.log(fail === 0 ? "\n═══ patch.mjs 自测 ALL-PASS ═══" : `\n═══ ${fail} 项失败 ═══`);
process.exit(fail === 0 ? 0 : 1);
