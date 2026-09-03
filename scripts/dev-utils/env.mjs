// ============================================================
// 环境管理（scripts/dev-utils/env.mjs）——prod / dev 双环境模型
// ------------------------------------------------------------
// 模型（2026-09-02 引入）：
//   prod  = main 分支     —— 日常使用的稳定实例：固定端口 8787/5173，数据 .file/（真实数据，不动）
//   dev   = 其它开发分支  —— 每个分支一套独立端口 + 独立数据目录，可与 prod 及其它分支**同时运行**
//
// 端口分配：dev 按「槽位」分配（server 8800+slot / web 5180+slot），槽位写入注册表
//   .file/envs/registry.json → 分支 ↔ 槽位 稳定映射（重启不变、可列表发现、可释放）
// 数据隔离：dev 数据目录 .file/envs/<id>/data/（toolbox.db / 知乎 & Chat profile / docs / 知识库…）
//   —— dev 分支可随意写入/改表，绝不污染 prod 真实数据；需要真实数据用 `env sync-data` 快照。
//
// 用法（node scripts/dev-utils/env.mjs ...）：
//   status               当前分支的环境详情 + 端口存活
//   list                 全部已注册环境 + 端口存活（跨分支总览）
//   start|stop|restart   管理「当前分支」环境（转发 dev.mjs）
//   sync-data            从 prod 快照数据到当前 dev 环境（须先 stop）
//   url                  打印当前环境的 web/server URL
//   release [branch]     释放某分支的端口槽位（默认当前分支；须先 stop）
// ============================================================
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./_lib.mjs";
import { loadConfig } from "./config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = ROOT;

// ---------- 常量（配置化） ----------
// 2026-09-04：端口段 / 数据目录 / envs 根目录 / 主分支名全部取自 toolbox.config.json
// （server.port、web.port、env.*、server.dataDir），不再散落硬编码——改配置即改部署。
//
// ⚠️ **必须惰性读取**（每次用的时候 loadConfig()），不能提到模块顶层求值：
// dev.mjs 在 import 完成后才把命令行 `KEY=VALUE` 回填进 process.env，
// 顶层求值会让 TOOLBOX_DATA_DIR / 端口覆盖失效（与 2026-09-02 同款的时序坑）。
const cfg = () => loadConfig();

/** prod 环境端口（server/web） */
export const prodPorts = (C) => ({ server: C.server.port, web: C.web.port });
/** dev 环境端口段起点与槽位上限 */
const devPortBase = (C) => ({ server: C.env.devServerPortBase, web: C.env.devWebPortBase });
/** 环境注册表文件（在 envs 根目录下） */
const registryFile = (C) => path.join(C.paths.envsDir, "registry.json");

// ---------- 基础工具 ----------

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** 当前 git 分支（失败返回 null：非 git 目录/未初始化） */
export function gitBranch() {
  const r = run("git", ["--no-pager", "rev-parse", "--abbrev-ref", "HEAD"]);
  if (r.status !== 0) return null;
  const b = r.out.trim();
  return b && b !== "HEAD" ? b : null;
}

/** 分支名 → 文件系统安全 id（/ \ : 等非法字符替换） */
export function branchToId(branch) {
  return String(branch).trim().replace(/[^\w.\-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
}

/** 端口占用 PID（netstat，Windows） */
export function pidOnPort(port) {
  const { out } = run("netstat", ["-ano"]);
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    if (!line.includes(`:${port} `)) continue;
    const m = line.match(/(\d+)\s*$/);
    if (m) return m[1];
  }
  return null;
}

export function isNodePid(pid) {
  if (!pid) return false;
  const { out } = run("tasklist", ["/FI", `PID eq ${pid}`]);
  return /node\.exe/i.test(out);
}

// ---------- 注册表（分支 ↔ 槽位） ----------

function readRegistry(C) {
  try {
    const j = JSON.parse(readFileSync(registryFile(C), "utf8"));
    return j && typeof j === "object" && j.slots && typeof j.slots === "object" ? j : { slots: {} };
  } catch {
    return { slots: {} };
  }
}

function writeRegistry(C, reg) {
  mkdirSync(C.paths.envsDir, { recursive: true });
  writeFileSync(registryFile(C), JSON.stringify(reg, null, 2));
}

/**
 * 取得（必要时分配）分支的端口槽位。
 * 分配策略：取「当前未被其它分支占用」的最小槽位；已注册的分支沿用原槽位（重启/重开终端不变）。
 */
function allocateSlot(C, branch) {
  const maxSlots = C.env.maxSlots;
  const reg = readRegistry(C);
  const existing = reg.slots[branch];
  if (existing && typeof existing.slot === "number" && existing.slot >= 0 && existing.slot < maxSlots) {
    return { slot: existing.slot, reg, allocated: false };
  }
  const used = new Set(Object.values(reg.slots).map((v) => v?.slot).filter((n) => typeof n === "number"));
  let slot = 0;
  while (slot < maxSlots && used.has(slot)) slot += 1;
  if (slot >= maxSlots) throw new Error(`dev 环境槽位已满（${maxSlots}，见配置 env.maxSlots）；先释放不用的分支：node scripts/dev-utils/env.mjs release <branch>`);
  reg.slots[branch] = { slot, id: branchToId(branch), createdAt: new Date().toISOString() };
  writeRegistry(C, reg);
  return { slot, reg, allocated: true };
}

/** 释放分支槽位（不影响其数据目录，数据需手工删） */
function releaseSlot(C, branch) {
  const reg = readRegistry(C);
  if (!reg.slots[branch]) return false;
  delete reg.slots[branch];
  writeRegistry(C, reg);
  return true;
}

// ---------- 环境解析（核心） ----------

/**
 * 解析当前环境。
 * 优先级：显式环境变量 TOOLBOX_ENV / TOOLBOX_BRANCH 覆盖 > git 分支推断。
 * 返回结构同时给出「传给子进程的 env 片段」（childEnv），供 dev.mjs 注入 server/web。
 */
export function resolveEnv(opts = {}) {
  // 配置惰性加载（见上方常量说明：必须在调用时读，不能提到模块顶层）
  const C = cfg();
  const MAIN_BRANCH = C.env.prodBranch;
  const branch = opts.branch ?? process.env.TOOLBOX_BRANCH?.trim() ?? gitBranch() ?? "unknown";
  const forced = opts.name ?? process.env.TOOLBOX_ENV?.trim();
  const isProd = forced ? forced === "prod" : branch === MAIN_BRANCH;
  const name = isProd ? "prod" : "dev";
  const id = isProd ? "prod" : branchToId(branch);

  // 端口来自配置：prod 用 server.port/web.port；dev 用 env.devServerPortBase/devWebPortBase + 槽位
  // （环境变量 PORT/TOOLBOX_SERVER_PORT/TOOLBOX_WEB_PORT 的覆盖已由配置内核完成，此处直接取结果）
  let serverPort;
  let webPort;
  let slot = null;
  if (isProd) {
    serverPort = C.server.port;
    webPort = C.web.port;
  } else {
    const a = allocateSlot(C, branch);
    slot = a.slot;
    serverPort = C.env.devServerPortBase + slot;
    webPort = C.env.devWebPortBase + slot;
    // 环境变量显式覆盖端口（临时调试用；不写注册表）——prod 侧已由配置内核处理，
    // dev 侧端口是算出来的，需在此叠加
    if (process.env.TOOLBOX_SERVER_PORT) serverPort = Number(process.env.TOOLBOX_SERVER_PORT) || serverPort;
    if (process.env.TOOLBOX_WEB_PORT) webPort = Number(process.env.TOOLBOX_WEB_PORT) || webPort;
  }

  // 数据目录：prod 用 server.dataDir；dev 用 <envsDir>/<id>/data
  const dataDir = isProd ? C.paths.dataDir : path.join(C.paths.envsDir, id, "data");
  // 环境私有目录（supervisor 状态/stop 标记/日志）
  const envDir = isProd ? C.paths.dataDir : path.join(C.paths.envsDir, id);

  return {
    name,
    id,
    branch,
    isProd,
    slot,
    serverPort,
    webPort,
    dataDir: process.env.TOOLBOX_DATA_DIR?.trim() || dataDir,
    envDir,
    root: ROOT_DIR,
    urls: {
      web: `http://localhost:${webPort}`,
      server: `http://localhost:${serverPort}`,
      health: `http://localhost:${serverPort}/api/health`,
      api: `http://127.0.0.1:${serverPort}/api`,
    },
    /** 子进程环境片段：dev.mjs 注入 tsx server / vite */
    childEnv: {
      PORT: String(serverPort),
      TOOLBOX_ENV: name,
      TOOLBOX_BRANCH: branch,
      TOOLBOX_DATA_DIR: process.env.TOOLBOX_DATA_DIR?.trim() || dataDir,
      TOOLBOX_SERVER_PORT: String(serverPort),
      TOOLBOX_WEB_PORT: String(webPort),
    },
    /** 本环境的状态文件与日志目录（与 prod 隔离，互不干扰） */
    paths: {
      stateFile: path.join(envDir, "dev.pids.json"),
      stopFlag: path.join(envDir, "dev.stop"),
      logDir: path.join(envDir, "logs"),
      // 库文件名取自配置 server.dbFile（绝对路径则整体指向别处的库）
      db: path.join(process.env.TOOLBOX_DATA_DIR?.trim() || dataDir, C.server.dbFile),
    },
    /** 生效配置（端口段/目录等来源，供排障与 `toolbox config` 展示） */
    config: C,
  };
}

/** 列出全部已注册 dev 环境（含 prod），附带端口存活状态 */
export function listEnvs() {
  const C = cfg();
  const base = devPortBase(C);
  const reg = readRegistry(C);
  const now = resolveEnv();
  const rows = [];
  rows.push({
    name: "prod",
    id: "prod",
    branch: C.env.prodBranch,
    slot: null,
    serverPort: C.server.port,
    webPort: C.web.port,
    dataDir: C.paths.dataDir,
    current: now.isProd,
  });
  for (const [branch, v] of Object.entries(reg.slots)) {
    const slot = typeof v?.slot === "number" ? v.slot : 0;
    rows.push({
      name: "dev",
      id: v?.id ?? branchToId(branch),
      branch,
      slot,
      serverPort: base.server + slot,
      webPort: base.web + slot,
      dataDir: path.join(C.paths.envsDir, v?.id ?? branchToId(branch), "data"),
      current: !now.isProd && now.branch === branch,
    });
  }
  return rows;
}

// ---------- 数据快照（prod → 当前 dev 环境） ----------

/**
 * 把 prod 数据快照到当前 dev 环境：复制 SQLite 主库 + WAL/SHM + docs 目录。
 * 安全约束（防「dev 实验污染 prod 真实数据」红线）：
 *   - 仅 prod → dev 单向；dev → prod 拒绝（避免把实验数据写回真实库）
 *   - 目标环境 server 必须在运行中会持有 WAL 句柄 → 要求先 stop
 */
export function syncData(env, opts = {}) {
  if (env.isProd) throw new Error("sync-data 只用于 dev 环境（prod 是数据源，不能被覆盖）");
  const dbFile = env.config.server.dbFile;
  const srcDir = env.config.paths.dataDir;
  const dstDir = env.dataDir;
  if (!existsSync(path.join(srcDir, dbFile))) throw new Error(`prod 数据不存在：${path.join(srcDir, dbFile)}`);

  const serverPid = pidOnPort(env.serverPort);
  if (serverPid && !opts.force) {
    throw new Error(`dev server 正在运行（端口 ${env.serverPort}，PID ${serverPid}）→ 先 \`toolbox env stop\` 再同步（运行中复制 SQLite 会拿到不一致快照）`);
  }

  mkdirSync(dstDir, { recursive: true });
  const copied = [];
  // ⚠️ 先清掉目标残留的 WAL/SHM（2026-09-04 修复，血泪）：
  // `env stop` 用 taskkill /T /F 强杀，server 来不及 checkpoint → 目标目录留下**旧 WAL**。
  // 若只覆盖主库而留着旧 WAL，SQLite 打开时会**回放旧 WAL 覆盖刚复制进来的新数据**——
  // 实测新库 2577 条被回滚成 35 条，冒烟 22 页全挂且极难定位。复制前三件套必须先清干净。
  const cleaned = [];
  for (const suffix of ["-wal", "-shm"]) {
    const stale = path.join(dstDir, `${dbFile}${suffix}`);
    if (existsSync(stale)) { rmSync(stale, { force: true }); cleaned.push(`${dbFile}${suffix}`); }
  }
  // SQLite 三件套（db + WAL + SHM）：缺一不可，否则 WAL 未回放导致数据缺失
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = path.join(srcDir, `${dbFile}${suffix}`);
    if (!existsSync(src)) continue;
    copyFileSync(src, path.join(dstDir, `${dbFile}${suffix}`));
    copied.push(`${dbFile}${suffix || ""}`);
  }
  // docs PDF 二进制目录（递归复制）
  const srcDocs = path.join(srcDir, "docs");
  const dstDocs = path.join(dstDir, "docs");
  if (existsSync(srcDocs)) {
    mkdirSync(dstDocs, { recursive: true });
    for (const f of readdirSync(srcDocs)) {
      try {
        copyFileSync(path.join(srcDocs, f), path.join(dstDocs, f));
        copied.push(`docs/${f}`);
      } catch { /* 单个文件失败不阻断 */ }
    }
  }
  return { from: srcDir, to: dstDir, copied, cleaned };
}

// ---------- CLI ----------

function fmtRow(e) {
  const live = { server: pidOnPort(e.serverPort), web: pidOnPort(e.webPort) };
  const mark = e.current ? " ← 当前分支" : "";
  return [
    `${e.name.padEnd(4)} ${e.branch}${mark}`,
    `    端口 server=${e.serverPort}${live.server ? ` (PID ${live.server})` : " (空闲)"}  web=${e.webPort}${live.web ? ` (PID ${live.web})` : " (空闲)"}`,
    `    数据 ${e.dataDir}${existsSync(path.join(e.dataDir, "toolbox.db")) ? " [有数据]" : " [空]"}`,
  ].join("\n");
}

function cmdStatus(env) {
  console.log(`环境        ${env.name}${env.isProd ? "（main 分支 · 真实数据）" : "（开发分支 · 独立端口与数据）"}`);
  console.log(`分支        ${env.branch}`);
  console.log(`环境 id     ${env.id}`);
  if (env.slot !== null) console.log(`端口槽位    #${env.slot}`);
  console.log(`server      ${env.urls.server}  端口 ${env.serverPort} → ${pidOnPort(env.serverPort) ? `PID ${pidOnPort(env.serverPort)} 运行中` : "空闲"}`);
  console.log(`web         ${env.urls.web}  端口 ${env.webPort} → ${pidOnPort(env.webPort) ? `PID ${pidOnPort(env.webPort)} 运行中` : "空闲"}`);
  console.log(`数据目录    ${env.dataDir}${existsSync(env.paths.db) ? " [有数据]" : " [空]"}`);
  console.log(`日志目录    ${env.paths.logDir}`);
}

function cmdList() {
  const rows = listEnvs();
  console.log(`已注册环境 ${rows.length} 个（prod 1 + dev ${rows.length - 1}）：\n`);
  for (const r of rows) console.log(fmtRow(r));
  console.log("\n提示：dev 环境随分支自动分配槽位；切换分支后 `toolbox env status` 看到的就是该分支的环境。");
}

function forwardToDev(action) {
  const r = spawnSync(process.execPath, [path.join(HERE, "dev.mjs"), action], { stdio: "inherit", cwd: ROOT_DIR });
  process.exit(r.status ?? 1);
}

/**
 * 仅在「直接运行本文件」时执行 CLI；被 import（dev/proc/api/smoke/browser-run）时跳过。
 * 不加这道闸门的话，import 方自己的 argv（如 `--page`）会掉进 else 分支打印用法——
 * 冒烟输出里混进「用法: …」就是这个原因（2026-09-02 修复）。
 */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const cmd = (process.argv[2] ?? "status").replace(/;$/, "");
const arg = (process.argv[3] ?? "").replace(/;$/, "");

if (!isMain) {
  // 作为库被引用：不执行任何 CLI 逻辑
} else if (cmd === "list") {
  cmdList();
} else if (cmd === "start" || cmd === "stop" || cmd === "restart") {
  forwardToDev(cmd);
} else if (cmd === "url") {
  const env = resolveEnv();
  console.log(`${env.name} (${env.branch})`);
  console.log(`  web    ${env.urls.web}`);
  console.log(`  server ${env.urls.server}`);
} else if (cmd === "sync-data") {
  const env = resolveEnv();
  try {
    const r = syncData(env, { force: arg === "--force" });
    console.log(`✅ 已从 prod 快照数据 → ${r.to}`);
    console.log(`   复制 ${r.copied.length} 项${r.copied.length <= 6 ? `：${r.copied.join(", ")}` : ""}`);
  } catch (e) {
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
} else if (cmd === "release") {
  const branch = arg || gitBranch();
  if (!branch) { console.error("❌ 无法确定分支"); process.exit(1); }
  const env = resolveEnv();
  if (branch === env.config.env.prodBranch) { console.error(`❌ prod 槽位不可释放（prodBranch=${env.config.env.prodBranch}）`); process.exit(1); }
  if (arg === "" && pidOnPort(env.serverPort)) { console.error(`❌ 当前环境仍在运行（端口 ${env.serverPort}）→ 先 \`toolbox env stop\``); process.exit(1); }
  console.log(releaseSlot(env.config, branch) ? `✅ 已释放分支槽位：${branch}` : `（分支 ${branch} 未注册槽位）`);
} else if (cmd === "clean-data") {
  // 危险操作：仅删 dev 环境数据，prod 一律拒绝
  const env = resolveEnv();
  if (env.isProd) { console.error("❌ 拒绝清理 prod 数据（真实数据，只能手工删）"); process.exit(1); }
  if (pidOnPort(env.serverPort)) { console.error(`❌ 先 \`toolbox env stop\``); process.exit(1); }
  if (arg !== "--yes") { console.error(`将删除 ${env.dataDir} —— 确认请加 --yes`); process.exit(1); }
  rmSync(env.dataDir, { recursive: true, force: true });
  console.log(`✅ 已清空 dev 数据目录：${env.dataDir}`);
} else if (cmd === "status" || cmd === "") {
  cmdStatus(resolveEnv());
} else {
  console.log("用法: node scripts/dev-utils/env.mjs status|list|start|stop|restart|sync-data|url|release [branch]|clean-data --yes");
}
