// scripts/dev-utils/self-test.mjs：dev-utils 工具自测（patch.mjs：多补丁同文件/不同文件/dry-run/count/CRLF）
// 工具改动后必跑：node scripts/dev-utils/self-test.mjs
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

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

// 6. memo CLI 冒烟（读操作，不 done 不改数据——防漂移）
const MEMO = "node scripts/dev-utils/memo.mjs";
const memoList = execSync(`${MEMO} list`, { stdio: "pipe" }).toString();
t("memo list 可用（open 统计输出）", /open: \d+ 条/.test(memoList), memoList.split("\n")[0] ?? "");
const memoStats = execSync(`${MEMO} stats`, { stdio: "pipe" }).toString();
t("memo stats 可用（open/doing/done 统计）", /memo 统计：open \d+/.test(memoStats), memoStats.split("\n")[0] ?? "");
const memoBypage = execSync(`${MEMO} bypage 页面不存在xyz`, { stdio: "pipe" }).toString();
t("memo bypage 可用（空关键词 0 条不崩）", /0 条/.test(memoBypage), memoBypage.split("\n")[0] ?? "");

// 7. 配置内核（packages/shared/config.mjs）回归——配置化是部署基线，必须锁死优先级与容错
const { loadConfig } = await import("./config.mjs");
const os = await import("node:os");
const tmp = mkdtempSync(join(os.tmpdir(), "toolbox-cfg-"));
const cfgPath = join(tmp, "toolbox.config.json");
const localPath = join(tmp, "toolbox.config.local.json");
const badPath = join(tmp, "bad.json");
const noEnv = {}; // 隔离真实环境变量，保证断言确定性

const d1 = loadConfig({ root: tmp, env: noEnv });
t("配置：无配置文件 → 内置默认", d1.server.port === 8787 && d1.paths.dbPath === join(tmp, ".file", "toolbox.db"), d1.paths.dbPath);

writeFileSync(cfgPath, "{\n // 行注释\n /* 块注释 */\n \"server\": { \"port\": 9001, \"dbFile\": \"a.db\", },\n}\n");
const d2 = loadConfig({ root: tmp, env: noEnv });
t("配置：主配置生效（注释 + 尾逗号容错）", d2.server.port === 9001 && d2.paths.dbPath === join(tmp, ".file", "a.db"), d2.paths.dbPath);

writeFileSync(localPath, "{ \"server\": { \"port\": 9002 } }");
const d3 = loadConfig({ root: tmp, env: noEnv });
t("配置：本地覆盖 > 主配置（未覆盖字段沿用）", d3.server.port === 9002 && d3.server.dbFile === "a.db");

const d4 = loadConfig({ root: tmp, env: { TOOLBOX_SERVER_PORT: "9003", TOOLBOX_DB_FILE: "env.db" } });
t("配置：环境变量覆盖最高", d4.server.port === 9003 && d4.paths.dbPath === join(tmp, ".file", "env.db"), d4.paths.dbPath);

const d5 = loadConfig({ root: tmp, env: { TOOLBOX_DATA_DIR: join(tmp, "absdata") } });
t("配置：绝对路径 dataDir 直接胜出", d5.paths.dataDir === join(tmp, "absdata"), d5.paths.dataDir);

let e6 = "";
writeFileSync(badPath, "{ \"server\": { \"prt\": 9000 } }");
try { loadConfig({ root: tmp, env: noEnv, extraConfigFile: badPath }); } catch (e) { e6 = e.message; }
t("配置：未知字段报错（拼错不静默生效）", e6.includes("配置字段未知"), e6);

let e7 = "";
writeFileSync(badPath, "{ \"server\": { \"port\": 99999 } }");
try { loadConfig({ root: tmp, env: noEnv, extraConfigFile: badPath }); } catch (e) { e7 = e.message; }
t("配置：端口越界报错", e7.includes("超出上界"), e7);

rmSync(tmp, { recursive: true, force: true });

// 清理
for (const f of ["_t_p1.txt", "_t_p2.txt", "_t_crlf.txt", "_t_crlf2.txt", "_t_patch.json", "_t_crlf_patch.json", "_t_c0.json", "_t_bad.json"]) if (existsSync(f)) unlinkSync(f);

console.log(fail === 0 ? "\n═══ dev-utils 自测 ALL-PASS（patch + memo + config）═══" : `\n═══ ${fail} 项失败 ═══`);
process.exit(fail === 0 ? 0 : 1);
