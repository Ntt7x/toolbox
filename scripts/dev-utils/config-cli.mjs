// ============================================================
// 配置 CLI（scripts/dev-utils/config-cli.mjs）
// 用途：部署与服务管理时**一眼看清服务到底用的哪套配置**——读的哪个配置文件、
//   库文件在哪个绝对路径、端口多少、环境变量覆盖了什么。
// 用法（node scripts/dev-utils/config-cli.mjs ...）：
//   show [--json]    生效配置全貌（分层来源 + 解析后的路径 + 环境变量覆盖）
//   paths            只打印关键绝对路径（root / dataDir / dbFile / envsDir），供脚本取用
//   check            校验配置文件（合法 → 退出码 0；字段拼错/类型错 → 报错并退出 1）
//   init [--force]   生成 toolbox.config.local.json 模板（本地私有覆盖，已 gitignore）
// ============================================================
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./_lib.mjs";
import { loadConfig, CONFIG_FILE_NAME, LOCAL_CONFIG_FILE_NAME } from "./config.mjs";
import { resolveEnv } from "./env.mjs";

const cmd = (process.argv[2] ?? "show").replace(/;$/, "");
const flag = (process.argv[3] ?? "").replace(/;$/, "");
const isJson = process.argv.includes("--json");

// ---------- show ----------

function cmdShow() {
  const c = loadConfig();
  const env = resolveEnv();
  if (isJson) {
    console.log(JSON.stringify({ config: c, env: { name: env.name, branch: env.branch, serverPort: env.serverPort, webPort: env.webPort, dataDir: env.dataDir } }, null, 2));
    return;
  }
  console.log("生效配置（优先级：内置默认 → 主配置 → 本地覆盖 → 额外配置 → 环境变量）\n");

  console.log("配置文件：");
  for (const s of c.sources) {
    console.log(`  ${s.loaded ? "●" : "○"} ${s.label}${s.loaded ? "" : "（未找到，跳过）"}`);
    console.log(`      ${s.file}`);
  }
  if (c.paths.extraConfigFile) console.log(`  额外配置文件（TOOLBOX_CONFIG_FILE）：${c.paths.extraConfigFile}`);

  console.log("\nserver（服务端）：");
  console.log(`  监听        ${c.server.host ?? "(默认，Node 双栈)"}:${c.server.port}`);
  console.log(`  数据目录    ${c.paths.dataDir}`);
  console.log(`  SQLite 库   ${c.paths.dbPath}`);
  console.log(`  CORS        ${JSON.stringify(c.server.cors)}`);

  console.log("\nweb（前端 dev server）：");
  console.log(`  监听        ${c.web.host}:${c.web.port}`);

  console.log("\nenv（多环境）：");
  console.log(`  prod 分支   ${c.env.prodBranch}`);
  console.log(`  dev 端口段  server ${c.env.devServerPortBase}+slot · web ${c.env.devWebPortBase}+slot`);
  console.log(`  槽位上限    ${c.env.maxSlots}`);
  console.log(`  envs 根目录 ${c.paths.envsDir}`);

  console.log("\nsupervisor（进程管理）：");
  console.log(`  健康检查    ${c.supervisor.healthCheckMs}ms · 空闲阈值 ${c.supervisor.idleThreshold} 次 · 重启上限 ${c.supervisor.restartLimit} 次`);
  console.log(`  拉起宽限    ${c.supervisor.spawnGraceMs}ms · 就绪超时 ${c.supervisor.readyTimeoutMs}ms`);

  if (c.envOverrides.length > 0) {
    console.log("\n环境变量覆盖（最高优先级）：");
    for (const o of c.envOverrides) console.log(`  ${o.name}=${o.value}  →  ${o.path}`);
  } else {
    console.log("\n环境变量覆盖：无");
  }

  console.log(`\n当前环境：${env.name}（分支 ${env.branch}）· server ${env.serverPort} · web ${env.webPort} · 数据 ${env.dataDir}`);
}

// ---------- paths ----------

function cmdPaths() {
  const c = loadConfig();
  if (isJson) { console.log(JSON.stringify(c.paths, null, 2)); return; }
  console.log(`root       ${c.paths.root}`);
  console.log(`dataDir    ${c.paths.dataDir}`);
  console.log(`dbPath     ${c.paths.dbPath}`);
  console.log(`envsDir    ${c.paths.envsDir}`);
  console.log(`config     ${c.paths.configFile}`);
  console.log(`local      ${c.paths.localConfigFile}${existsSync(c.paths.localConfigFile) ? "" : "（未创建）"}`);
}

// ---------- check ----------

function cmdCheck() {
  try {
    const c = loadConfig();
    const loaded = c.sources.filter((s) => s.loaded).map((s) => s.label);
    console.log("✅ 配置合法");
    console.log(`   生效来源：${loaded.length > 0 ? loaded.join(" → ") : "(全部内置默认)"}`);
    console.log(`   库文件  ：${c.paths.dbPath}`);
    console.log(`   端口    ：server ${c.server.port} · web ${c.web.port}`);
  } catch (e) {
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

// ---------- init ----------

const LOCAL_TEMPLATE = `// 本地私有配置覆盖（不提交，已在 .gitignore）
// 只需写**与 toolbox.config.json 不同**的字段；相对路径相对仓库根，绝对路径直接生效。
{
  "server": {
    // 换库/分库部署示例："dbFile": "toolbox-dev.db"
    // 端口冲突时改："port": 8788
  }
}
`;

function cmdInit() {
  const file = path.join(ROOT, LOCAL_CONFIG_FILE_NAME);
  if (existsSync(file) && flag !== "--force") {
    console.log(`已存在，未覆盖：${file}（需要重建加 --force）`);
    return;
  }
  writeFileSync(file, LOCAL_TEMPLATE, "utf8");
  console.log(`✅ 已生成 ${file}`);
  console.log("   改完用 `toolbox config check` 校验、`toolbox config show` 看生效结果。");
}

// ---------- 分发 ----------

if (cmd === "show" || cmd === "") cmdShow();
else if (cmd === "paths") cmdPaths();
else if (cmd === "check") cmdCheck();
else if (cmd === "init") cmdInit();
else console.log("用法: node scripts/dev-utils/config-cli.mjs show|paths|check|init [--json|--force]");
