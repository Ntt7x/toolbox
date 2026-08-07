// ============================================================
// 开发进程管理器 v2（scripts/dev.mjs）——统一管理 server(tsx watch) + web(vite)
// 用法：
//   node scripts/dev.mjs start   启动（后台常驻 supervisor；先清端口残留再拉起）
//   node scripts/dev.mjs stop    停止（写 stop 标记 + 杀进程树 + 清端口）
//   node scripts/dev.mjs restart 重启
//   node scripts/dev.mjs status  端口占用与进程状态
//   node scripts/dev.mjs kill-port <8787|5173|all>  按端口强杀（确认 node）
// 可靠性设计（v2）：
//   - 常驻 supervisor 用 setInterval 每 5s 健康检查：server/web 进程死了且端口空闲 → 自动拉起
//     （不依赖 exit 事件——taskkill /T 级联强杀等场景也能自愈；spawn 后 15s 宽限期防竞态）
//   - start 前清端口残留（netstat 找 PID → tasklist 确认 node → taskkill /T /F）
//   - stop 写 .file/dev.stop 标记，supervisor 见到后不再拉起并自行退出
//   - 子进程日志写 .file/dev-logs/*.log（父退出不 EPIPE）
// ============================================================
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const STATE_FILE = path.join(root, ".file", "dev.pids.json");
const STOP_FLAG = path.join(root, ".file", "dev.stop");
const PORTS = [8787, 5173];
const serverCwd = path.join(root, "apps", "server");
const webCwd = path.join(root, "apps", "web");
const tsxCli = path.join(root, "node_modules", ".pnpm", "tsx@4.23.5", "node_modules", "tsx", "dist", "cli.mjs");
const viteCli = path.join(webCwd, "node_modules", "vite", "bin", "vite.js");
const LOG_DIR = path.join(root, ".file", "dev-logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

function log(...a) { console.log("[dev]", ...a); }

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
  server: { child: null, spawnAt: 0, restarts: 0 },
  web: { child: null, spawnAt: 0, restarts: 0 },
};

function startServer() {
  const s = svc.server;
  s.spawnAt = Date.now();
  const logFd = fs.openSync(path.join(LOG_DIR, "server.log"), "a");
  const child = spawn(NODE, [tsxCli, "watch", "src/index.ts"], { cwd: serverCwd, stdio: ["ignore", logFd, logFd] });
  s.child = child;
  child.on("exit", (code) => { s.child = null; log(`server 进程退出 (code=${code})`); });
  log(`server 启动 (PID ${child.pid})`);
}

function startWeb() {
  const s = svc.web;
  s.spawnAt = Date.now();
  const logFd = fs.openSync(path.join(LOG_DIR, "web.log"), "a");
  const child = spawn(NODE, [viteCli], { cwd: webCwd, stdio: ["ignore", logFd, logFd] });
  s.child = child;
  child.on("exit", (code) => { s.child = null; log(`web 进程退出 (code=${code})`); });
  log(`web 启动 (PID ${child.pid})`);
}

function stopped() { return fs.existsSync(STOP_FLAG); }

/** 健康检查：进程死了（且端口空闲）→ 自动拉起；带 spawn 宽限期防竞态 */
function healthCheck() {
  if (stopped()) {
    // 显式停止：supervisor 退出（无子进程后 event loop 空，进程自然结束）
    if (!svc.server.child && !svc.web.child) process.exit(0);
    return;
  }
  const now = Date.now();
  for (const [name, port] of [["server", 8787], ["web", 5173]]) {
    const s = svc[name];
    const portFree = !pidOnPort(port);
    if (now - s.spawnAt < 15_000) continue; // 宽限期：刚拉起还没就绪
    const processDead = !s.child || s.child.killed;
    // ① 进程死了 → 重启；② 进程活着但端口空闲（服务子进程挂/卡死）→ 杀旧进程重启
    if (processDead || (s.child && portFree)) {
      if (s.restarts < 8) {
        s.restarts += 1;
        if (!processDead) { log(`检测到 ${name} 端口 ${port} 空闲（进程存活但服务异常），重启`); killPidTree(s.child.pid); s.child = null; }
        else log(`检测到 ${name} 进程已退出，自动重启（第 ${s.restarts} 次）`);
        name === "server" ? startServer() : startWeb();
      }
    }
  }
}

function stopAll() {
  fs.writeFileSync(STOP_FLAG, String(Date.now()));
  for (const [name, s] of Object.entries(svc)) {
    if (s.child && !s.child.killed) { log(`停止 ${name} (PID ${s.child.pid})`); killPidTree(s.child.pid); s.child = null; }
  }
  cleanupPorts();
  try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }
  log("已停止（supervisor 将退出）");
}

function status() {
  for (const p of PORTS) {
    const pid = pidOnPort(p);
    log(`端口 ${p}: ${pid ? `被 PID ${pid} 占用${isNodePid(pid) ? "（node）" : "（非 node！）"}` : "空闲"}`);
  }
}

const cmd = process.argv[2] ?? "start";
const argPort = process.argv[3];

switch (cmd) {
  case "start":
    try { fs.unlinkSync(STOP_FLAG); } catch { /* ignore */ }
    cleanupPorts();
    startServer();
    startWeb();
    setInterval(healthCheck, 5000); // 常驻 supervisor（保持 event loop）
    log("supervisor 运行中（每 5s 健康检查）");
    break;
  case "stop":
    stopAll();
    break;
  case "restart":
    stopAll();
    try { fs.unlinkSync(STOP_FLAG); } catch { /* ignore */ }
    cleanupPorts();
    startServer();
    startWeb();
    setInterval(healthCheck, 5000);
    log("supervisor 运行中（每 5s 健康检查）");
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
