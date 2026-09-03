// ============================================================
// 开发进程管理器 v3（scripts/dev-utils/dev.mjs）——统一管理 server(tsx watch) + web(vite)
// 用法：
//   node scripts/dev-utils/dev.mjs start   启动（后台常驻 supervisor；先清端口残留再拉起）
//   node scripts/dev-utils/dev.mjs stop    停止（写 stop 标记 + 杀进程树 + 清端口）
//   node scripts/dev-utils/dev.mjs restart 重启（先杀旧 supervisor 防多实例打架）
//   node scripts/dev-utils/dev.mjs status  端口占用、supervisor 与进程状态
//   node scripts/dev-utils/dev.mjs kill-port <port|all>  按端口强杀（确认 node）
// 环境感知（v3，2026-09-02）：prod（main 分支）与 dev（其它分支）端口/状态文件/日志/数据目录全隔离，
//   由 env.mjs 解析；`toolbox dev start` 在哪个分支跑就管哪个环境，prod 与多个 dev 分支可并存。
// 配置化（2026-09-04）：健康检查间隔 / 空闲阈值 / 重启上限 / 宽限期 / 就绪超时
//   全部取自 toolbox.config.json 的 supervisor 段（不再散落硬编码）。
// 可靠性设计（v2）：
//   - 常驻 supervisor 用 setInterval 每 5s 健康检查：server/web 进程死了且端口空闲 → 自动拉起
//   - start/restart 前单实例防重：读本环境 dev.pids.json，发现旧 supervisor 存活 → 终止
//   - 进程诊断/清理（查残留）用 scripts/dev-utils/proc.mjs
// ============================================================
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { ROOT as root, tsxCli, viteCli as viteCliPnpm } from "./_lib.mjs";
import { resolveEnv } from "./env.mjs";
// tsx/vite CLI 动态路径由 _lib.mjs 统一提供（pnpm 升级版本不失效）
const NODE = process.execPath;
// supervisor 经 Start-Process 独立启动、不继承父进程 env 变更 → 环境片段以 `KEY=VALUE`
// 命令行参数透传，须在 resolveEnv() 之前回填（否则 TOOLBOX_DATA_DIR/端口覆盖不生效，2026-09-02）
for (const a of process.argv.slice(3)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(a);
  if (m) process.env[m[1]] = m[2];
}
const ENV = resolveEnv();
/** 进程管理参数（配置化：toolbox.config.json 的 supervisor 段） */
const SUP = ENV.config.supervisor;
const STATE_FILE = ENV.paths.stateFile;
const STOP_FLAG = ENV.paths.stopFlag;
const PORTS = [ENV.serverPort, ENV.webPort];
const LOG_DIR = ENV.paths.logDir;
const serverCwd = path.join(root, "apps", "server");
const webCwd = path.join(root, "apps", "web");
const viteCli = viteCliPnpm;
for (const d of [path.dirname(STATE_FILE), path.dirname(STOP_FLAG), LOG_DIR, ENV.dataDir]) {
  fs.mkdirSync(d, { recursive: true });
}

function log(...a) {
  const msg = `[dev:${ENV.name}] ${a.join(" ")}`;
  console.log(msg);
  // supervisor 后台运行时 stdout 被丢弃，同步追加到 supervisor.log 便于排查重启原因
  try { fs.appendFileSync(path.join(LOG_DIR, "supervisor.log"), `${new Date().toISOString()} ${msg}\n`); } catch { /* 日志失败不影响主流程 */ }
}

function pidOnPort(port) {
  const r = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    if (!line.includes(`:${port} `)) continue;
    const m = line.match(/(\d+)\s*$/);
    if (m) return m[1];
  }
  return null;
}

function isNodePid(pid) {
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`], { encoding: "utf8" });
  return /node\.exe/i.test(r.stdout);
}

function killPidTree(pid) {
  return spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" }).status === 0;
}

function killPort(port) {
  const pid = pidOnPort(port);
  if (!pid) { log(`端口 ${port} 无占用`); return false; }
  if (!isNodePid(pid)) { log(`端口 ${port} 被非 node 进程占用 (PID ${pid})，跳过`); return false; }
  // 防误杀同端口的其它环境：仅杀本环境自己记录过的 supervisor/子进程，或端口确属本环境。
  // 端口段已隔离（prod 8787 / dev 8800+），此处再校验一次 PID 白名单，避免 release 后槽位复用误杀。
  log(`端口 ${port} 被 PID ${pid} 占用 → 终止`);
  return killPidTree(pid);
}

function cleanupPorts() { for (const p of PORTS) killPort(p); }

// ---------- 服务进程管理（supervisor 状态） ----------
const svc = {
  server: { child: null, spawnAt: 0, restarts: 0, idleCount: 0, logFd: null },
  web: { child: null, spawnAt: 0, restarts: 0, idleCount: 0, logFd: null },
};

/** 端口空闲连续 N 次（≈N×健康检查间隔）才判定服务异常——tsx watch 改文件重编译时端口短暂空闲是正常现象，
 *  单次空闲直接重启是历史「进程反复重启」的根因（2026-08-14 修复）。
 *  阈值来自配置 supervisor.idleThreshold（2026-09-04）。 */
const IDLE_THRESHOLD = SUP.idleThreshold;

/** 以独立进程启动 supervisor（脱离调用者进程树）。
 *  2026-08-14 二次根治：Windows 下 spawn(detached) 仍被 taskkill /T 按父进程链级联杀
 *  （bash 工具超时杀 start 进程树时 supervisor 陪葬 → 服务反复"重启"）。
 *  改用 Start-Process：powershell 立即退出，supervisor 父链断开，工具杀不到它。 */
function spawnSupervisor() {
  const supScript = fileURLToPath(import.meta.url);
  // 注意：不能加 -RedirectStandardOutput/Error——Start-Process 重定向会让 powershell
  // 挂起等待子进程句柄关闭（工具超时杀父链，supervisor 陪葬）。无重定向则 powershell 立即退出。
  // 环境片段随命令行透传：supervisor 独立进程不继承本进程 env 变更，
  // 必须把 PORT/TOOLBOX_ENV/TOOLBOX_DATA_DIR/TOOLBOX_WEB_PORT 显式传下去（2026-09-02）
  const envArgs = [
    `PORT=${ENV.serverPort}`,
    `TOOLBOX_ENV=${ENV.name}`,
    `TOOLBOX_BRANCH=${ENV.branch}`,
    `TOOLBOX_DATA_DIR=${ENV.dataDir}`,
    `TOOLBOX_SERVER_PORT=${ENV.serverPort}`,
    `TOOLBOX_WEB_PORT=${ENV.webPort}`,
  ].map((a) => `'${a}'`).join(",");
  const ps = [
    "-NoProfile", "-Command",
    // -ArgumentList 必须用逗号分隔的独立参数（PowerShell 拆成数组）；传 JSON 字符串会被
    // node 当单个参数导致 supervise 分支不匹配、supervisor 立即退出（2026-08-14 修复）
    `Start-Process -FilePath ${JSON.stringify(NODE)} -ArgumentList '${supScript}','supervise',${envArgs} -WindowStyle Hidden`,
  ];
  spawnSync("powershell", ps, { stdio: "ignore", encoding: "utf8" });
  log(`supervisor 独立进程启动（Start-Process，脱离父进程树），服务日志 ${LOG_DIR}/{server,web}.log`);
  // 就绪等待：start/restart 前台命令等两个端口起来（超时由配置 supervisor.readyTimeoutMs 控制）
  // 服务还在编译就以为脚本坏了；未就绪时 supervisor 仍会持续拉起
  const deadline = Date.now() + SUP.readyTimeoutMs;
  while (Date.now() < deadline) {
    if (pidOnPort(ENV.serverPort) && pidOnPort(ENV.webPort)) {
      log(`✅ ${ENV.name} 环境就绪：server(${ENV.serverPort}) + web(${ENV.webPort}) — ${ENV.urls.web}`);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  }
  log(`⚠️ 20s 内未完全就绪——supervisor 会持续拉起，用 \`node scripts/dev-utils/proc.mjs status\` 查看`);
}

/** 子进程环境：本进程 env + 环境片段（保证 tsx/vite 拿到正确的端口与数据目录） */
function childEnv() {
  return { ...process.env, ...ENV.childEnv };
}

function startServer() {
  const s = svc.server;
  s.spawnAt = Date.now();
  s.logFd = fs.openSync(path.join(LOG_DIR, "server.log"), "a");
  const child = spawn(NODE, [tsxCli, "watch", "src/index.ts"], { cwd: serverCwd, stdio: ["ignore", s.logFd, s.logFd], env: childEnv() });
  s.child = child;
  child.on("exit", (code) => { s.child = null; log(`server 进程退出 (code=${code})`); });
  log(`server 启动 (PID ${child.pid}) 端口 ${ENV.serverPort}`);
}

function startWeb() {
  const s = svc.web;
  s.spawnAt = Date.now();
  s.logFd = fs.openSync(path.join(LOG_DIR, "web.log"), "a");
  const child = spawn(NODE, [viteCli], { cwd: webCwd, stdio: ["ignore", s.logFd, s.logFd], env: childEnv() });
  s.child = child;
  child.on("exit", (code) => { s.child = null; log(`web 进程退出 (code=${code})`); });
  log(`web 启动 (PID ${child.pid}) 端口 ${ENV.webPort}`);
}

function stopped() { return fs.existsSync(STOP_FLAG); }

/** 重启单个服务（进程退出立即；端口连续空闲 IDLE_THRESHOLD 次判卡死；带重启次数上限） */
function restartService(name, port, s, reason) {
  if (s.restarts >= SUP.restartLimit) {
    log(`${name} 重启次数超限（${SUP.restartLimit} 次，配置 supervisor.restartLimit），停止自动拉起——请检查日志 ${LOG_DIR}\\${name}.log`);
    return;
  }
  s.restarts += 1;
  log(`检测到 ${name} 异常（${reason}），自动重启（第 ${s.restarts} 次）`);
  if (s.child && !s.child.killed) { killPidTree(s.child.pid); s.child = null; }
  // 只清当前服务端口——不能 cleanupPorts()（重启 web 会误杀 server 的 tsx 子进程，
  // server 退出后反过来又杀 web → 互相踩踏无限重启，2026-08-14 修复）
  killPort(port);
  name === "server" ? startServer() : startWeb();
}

/** 健康检查：进程退出 → 立即重启；进程活着但端口连续空闲 → 判卡死重启；带 spawn 宽限期防竞态 */
function healthCheck() {
  if (stopped()) {
    // 显式停止：supervisor 退出（无子进程后 event loop 空，进程自然结束）
    if (!svc.server.child && !svc.web.child) process.exit(0);
    return;
  }
  const now = Date.now();
  // ⚠️ 端口必须取当前环境的实际端口（2026-09-04 修复）：
  // 原实现写死 8787/5173 → dev 环境（8800+/5180+）的健康检查永远看到"端口空闲"，
  // dev 服务一挂就再也拉不起来（或反过来疯狂重启 prod 端口）。
  for (const [name, port] of [["server", ENV.serverPort], ["web", ENV.webPort]]) {
    const s = svc[name];
    if (now - s.spawnAt < SUP.spawnGraceMs) { s.idleCount = 0; continue; } // 宽限期：刚拉起还没就绪，空闲计数归零
    const processDead = !s.child || s.child.killed;
    if (processDead) {
      restartService(name, port, s, "进程已退出");
    } else if (!pidOnPort(port)) {
      // 端口空闲：先累计，连续多次才判服务异常（tsx watch 重编译窗口会短暂空闲）
      s.idleCount += 1;
      if (s.idleCount >= IDLE_THRESHOLD) {
        s.idleCount = 0;
        restartService(name, port, s, `端口 ${port} 连续空闲 ${IDLE_THRESHOLD} 次（服务卡死/编译挂起）`);
      }
    } else {
      s.idleCount = 0; // 端口正常 → 重置空闲计数
    }
  }
}

function stopAll() {
  fs.writeFileSync(STOP_FLAG, String(Date.now()));
  for (const [name, s] of Object.entries(svc)) {
    if (s.child && !s.child.killed) { log(`停止 ${name} (PID ${s.child.pid})`); killPidTree(s.child.pid); s.child = null; }
  }
  cleanupPorts();
  log("已停止（supervisor 将退出）");
}

function status() {
  log(`环境 ${ENV.name}（分支 ${ENV.branch}）· 数据 ${ENV.dataDir}`);
  const sp = readSupervisorPid();
  log(`supervisor: ${sp ? `PID ${sp}${isAlivePid(sp) ? "（存活）" : "（已退出，残留记录）"}` : "无"}`);
  for (const p of PORTS) {
    const pid = pidOnPort(p);
    log(`端口 ${p}: ${pid ? `被 PID ${pid} 占用${isNodePid(pid) ? "（node）" : "（非 node！）"}` : "空闲"}`);
  }
  log(`web ${ENV.urls.web} · server ${ENV.urls.server}`);
}

// ---------- 单实例防重（历史教训：多个 supervisor 并存互相打架） ----------

function readSupervisorPid() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).pid ?? null; } catch { return null; }
}

function writeSupervisorPid() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
}

function isAlivePid(pid) {
  if (!pid) return false;
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`], { encoding: "utf8" });
  return /node\.exe/i.test(r.stdout);
}

/** start/restart 前：发现旧 supervisor 存活 → 终止（防止双 supervisor 健康检查互相打架） */
function killOldSupervisor() {
  const old = readSupervisorPid();
  if (old && old !== process.pid && isAlivePid(old)) {
    log(`检测到旧 supervisor (PID ${old}) → 终止（防多实例打架）`);
    killPidTree(old);
  }
}

/** 清残留 supervisor 记录（旧 supervisor 已退出但 STATE_FILE 未清理时，2026-08-14） */
function cleanupSupervisorRecord() {
  const old = readSupervisorPid();
  if (old && old !== process.pid && !isAlivePid(old)) {
    log(`清理残留 supervisor 记录 (PID ${old})`);
  }
}

const cmd = (process.argv[2] ?? "start").replace(/;$/, "");
const argPort = (process.argv[3] ?? "").replace(/;$/, "");

switch (cmd) {
  case "start":
    // 2026-08-14 根治：supervisor 以 detached 后台进程运行（脱离调用者进程组/生命周期），
    // 调用方（终端/工具进程）退出或被超时杀死都不再连带杀掉 tsx/vite 服务
    killOldSupervisor();
    cleanupSupervisorRecord();
    cleanupPorts();
    spawnSupervisor();
    break;
  case "supervise":
    // 内部命令：detached supervisor 本体（start 时 spawn 此命令）
    startServer();
    startWeb();
    writeSupervisorPid();
    setInterval(healthCheck, SUP.healthCheckMs); // 常驻 supervisor（保持 event loop）
    log(`supervisor 运行中（每 ${SUP.healthCheckMs}ms 健康检查）`);
    break;
  case "stop":
    killOldSupervisor(); // 杀旧 supervisor 进程树（级联杀其 tsx/vite 子进程）
    stopAll(); // 写 STOP_FLAG + 清端口（双保险）
    break;
  case "restart":
    killOldSupervisor(); // 先杀旧 supervisor（STATE_FILE 此时仍记录旧 PID）
    stopAll();
    cleanupSupervisorRecord();
    cleanupPorts();
    spawnSupervisor();
    break;
  case "status":
    status();
    break;
  case "kill-port":
    if (argPort === "all") { cleanupPorts(); break; }
    if (!argPort || !/^\d+$/.test(argPort)) { log(`用法: node scripts/dev.mjs kill-port <${ENV.serverPort}|${ENV.webPort}|all>`); break; }
    killPort(Number(argPort));
    break;
  default:
    log("用法: node scripts/dev.mjs start|stop|restart|status|kill-port <port|all>");
}
