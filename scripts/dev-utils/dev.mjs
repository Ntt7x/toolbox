// ============================================================
// 开发进程管理器 v2（scripts/dev-utils/dev.mjs）——统一管理 server(tsx watch) + web(vite)
// 用法：
//   node scripts/dev-utils/dev.mjs start   启动（后台常驻 supervisor；先清端口残留再拉起）
//   node scripts/dev-utils/dev.mjs stop    停止（写 stop 标记 + 杀进程树 + 清端口）
//   node scripts/dev-utils/dev.mjs restart 重启（先杀旧 supervisor 防多实例打架）
//   node scripts/dev-utils/dev.mjs status  端口占用、supervisor 与进程状态
//   node scripts/dev-utils/dev.mjs kill-port <8787|5173|all>  按端口强杀（确认 node）
// 可靠性设计（v2）：
//   - 常驻 supervisor 用 setInterval 每 5s 健康检查：server/web 进程死了且端口空闲 → 自动拉起
//   - start/restart 前单实例防重：读 .file/dev.pids.json，发现旧 supervisor 存活 → 终止
//   - 进程诊断/清理（查残留）用 scripts/dev-utils/proc.mjs
// ============================================================
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { ROOT as root, tsxCli, viteCli as viteCliPnpm } from "./_lib.mjs";
// tsx/vite CLI 动态路径由 _lib.mjs 统一提供（pnpm 升级版本不失效）
const NODE = process.execPath;
const STATE_FILE = path.join(root, ".file", "dev.pids.json");
const STOP_FLAG = path.join(root, ".file", "dev.stop");
const PORTS = [8787, 5173];
const serverCwd = path.join(root, "apps", "server");
const webCwd = path.join(root, "apps", "web");
const viteCli = viteCliPnpm;
const LOG_DIR = path.join(root, ".file", "dev-logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

function log(...a) {
  const msg = `[dev] ${a.join(" ")}`;
  console.log(msg);
  // supervisor 后台运行时 stdout 被丢弃，同步追加到 supervisor.log 便于排查重启原因
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
  log(`端口 ${port} 被 PID ${pid} 占用 → 终止`);
  return killPidTree(pid);
}

function cleanupPorts() { for (const p of PORTS) killPort(p); }

// ---------- 服务进程管理（supervisor 状态） ----------
const svc = {
  server: { child: null, spawnAt: 0, restarts: 0, idleCount: 0, logFd: null },
  web: { child: null, spawnAt: 0, restarts: 0, idleCount: 0, logFd: null },
};

/** 端口空闲连续 N 次（≈N×5s）才判定服务异常——tsx watch 改文件重编译时端口短暂空闲是正常现象，
 *  单次空闲直接重启是历史「进程反复重启」的根因（2026-08-14 修复） */
const IDLE_THRESHOLD = 3;

/** 以独立进程启动 supervisor（脱离调用者进程树）。
 *  2026-08-14 二次根治：Windows 下 spawn(detached) 仍被 taskkill /T 按父进程链级联杀
 *  （bash 工具超时杀 start 进程树时 supervisor 陪葬 → 服务反复"重启"）。
 *  改用 Start-Process：powershell 立即退出，supervisor 父链断开，工具杀不到它。 */
function spawnSupervisor() {
  const supScript = fileURLToPath(import.meta.url);
  // 注意：不能加 -RedirectStandardOutput/Error——Start-Process 重定向会让 powershell
  // 挂起等待子进程句柄关闭（工具超时杀父链，supervisor 陪葬）。无重定向则 powershell 立即退出。
  const ps = [
    "-NoProfile", "-Command",
    // -ArgumentList 必须用逗号分隔的独立参数（PowerShell 拆成数组）；传 JSON 字符串会被
    // node 当单个参数导致 supervise 分支不匹配、supervisor 立即退出（2026-08-14 修复）
    `Start-Process -FilePath ${JSON.stringify(NODE)} -ArgumentList '${supScript}','supervise' -WindowStyle Hidden`,
  ];
  spawnSync("powershell", ps, { stdio: "ignore", encoding: "utf8" });
  log("supervisor 独立进程启动（Start-Process，脱离父进程树），服务日志 .file/dev-logs/{server,web}.log");
  // 就绪等待：start/restart 前台命令等两个端口起来（最多 20s），避免用户 start 后
  // 服务还在编译就以为脚本坏了；未就绪时 supervisor 仍会持续拉起
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (pidOnPort(8787) && pidOnPort(5173)) {
      log("✅ server(8787) + web(5173) 已就绪");
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  }
  log("⚠️ 20s 内未完全就绪——supervisor 会持续拉起，用 `node scripts/dev-utils/proc.mjs status` 查看");
}

function startServer() {
  const s = svc.server;
  s.spawnAt = Date.now();
  s.logFd = fs.openSync(path.join(LOG_DIR, "server.log"), "a");
  const child = spawn(NODE, [tsxCli, "watch", "src/index.ts"], { cwd: serverCwd, stdio: ["ignore", s.logFd, s.logFd] });
  s.child = child;
  child.on("exit", (code) => { s.child = null; log(`server 进程退出 (code=${code})`); });
  log(`server 启动 (PID ${child.pid})`);
}

function startWeb() {
  const s = svc.web;
  s.spawnAt = Date.now();
  s.logFd = fs.openSync(path.join(LOG_DIR, "web.log"), "a");
  const child = spawn(NODE, [viteCli], { cwd: webCwd, stdio: ["ignore", s.logFd, s.logFd] });
  s.child = child;
  child.on("exit", (code) => { s.child = null; log(`web 进程退出 (code=${code})`); });
  log(`web 启动 (PID ${child.pid})`);
}

function stopped() { return fs.existsSync(STOP_FLAG); }

/** 重启单个服务（进程退出立即；端口连续空闲 IDLE_THRESHOLD 次判卡死；带重启次数上限） */
function restartService(name, port, s, reason) {
  if (s.restarts >= 12) {
    log(`${name} 重启次数超限（12 次），停止自动拉起——请检查日志 .file/dev-logs/${name}.log`);
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
  for (const [name, port] of [["server", 8787], ["web", 5173]]) {
    const s = svc[name];
    if (now - s.spawnAt < 15_000) { s.idleCount = 0; continue; } // 宽限期：刚拉起还没就绪，空闲计数归零
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
  const sp = readSupervisorPid();
  log(`supervisor: ${sp ? `PID ${sp}${isAlivePid(sp) ? "（存活）" : "（已退出，残留记录）"}` : "无"}`);
  for (const p of PORTS) {
    const pid = pidOnPort(p);
    log(`端口 ${p}: ${pid ? `被 PID ${pid} 占用${isNodePid(pid) ? "（node）" : "（非 node！）"}` : "空闲"}`);
  }
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

const cmd = process.argv[2] ?? "start";
const argPort = process.argv[3];

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
    setInterval(healthCheck, 5000); // 常驻 supervisor（保持 event loop）
    log("supervisor 运行中（每 5s 健康检查）");
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
    if (!argPort || !/^\d+$/.test(argPort)) { log("用法: node scripts/dev.mjs kill-port <8787|5173|all>"); break; }
    killPort(Number(argPort));
    break;
  default:
    log("用法: node scripts/dev.mjs start|stop|restart|status|kill-port <port|all>");
}
