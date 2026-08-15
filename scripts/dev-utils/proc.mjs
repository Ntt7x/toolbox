// ============================================================
// 开发辅助脚本：进程管理 CLI（scripts/dev-utils/proc.mjs）
// 固化「dev 进程诊断/清理」反复需求：多个 supervisor 并存打架、
// tsx watch 假 200（需重启 server）、端口被残留 node 占用等。
// 用法（node scripts/dev-utils/proc.mjs ...）：
//   status         端口 8787/5173 + dev supervisor + node 进程数
//   list           全部 node 进程（PID + 命令行摘要，找残留 supervisor/tsx/vite）
//   kill <pid>     杀进程树（taskkill /T /F）
//   kill-port <p>  杀端口占用（仅 node 进程，防误杀）
// ============================================================
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT as root } from "./_lib.mjs";

const STATE_FILE = path.join(root, ".file", "dev.pids.json");
const PORTS = [8787, 5173];

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};

function pidOnPort(port) {
  const { out } = run("netstat", ["-ano"]);
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    if (!line.includes(`:${port} `)) continue;
    const m = line.match(/(\d+)\s*$/);
    if (m) return m[1];
  }
  return null;
}

function isNodePid(pid) {
  const { out } = run("tasklist", ["/FI", `PID eq ${pid}`]);
  return /node\.exe/i.test(out);
}

function listNodeProcesses() {
  // wmic CSV 行形如: HOST,<CommandLine 可能含引号>,<PID>
  const { out } = run("wmic", ["process", "where", "name='node.exe'", "get", "ProcessId,CommandLine", "/format:csv"]);
  const rows = [];
  for (const line of out.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const m = line.match(/^(.*?),(.*),"?(\d+)"?\s*$/);
    if (!m) continue;
    const cmdline = m[2].replace(/^"|"$/g, "");
    rows.push({ pid: m[3], cmdline });
  }
  return rows;
}

function supervisorInfo() {
  try {
    const { pid } = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    const alive = isNodePid(pid);
    return `PID ${pid}${alive ? "（存活）" : "（已退出，残留记录）"}`;
  } catch {
    return "无";
  }
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === "status") {
  console.log(`dev supervisor: ${supervisorInfo()}`);
  for (const p of PORTS) {
    const pid = pidOnPort(p);
    console.log(`端口 ${p}: ${pid ? `被 PID ${pid} 占用${isNodePid(pid) ? "（node）" : "（非 node！）"}` : "空闲"}`);
  }
  const nodes = listNodeProcesses();
  console.log(`node 进程数: ${nodes.length}`);
} else if (cmd === "list") {
  const nodes = listNodeProcesses();
  console.log(`node 进程 ${nodes.length} 个：`);
  for (const n of nodes) {
    const brief = n.cmdline.replace(/^.*?\\node\.exe\s*/, "").slice(0, 90) || "(无参数)";
    console.log(`  ${n.pid}  ${brief}`);
  }
} else if (cmd === "kill") {
  if (!arg || !/^\d+$/.test(arg)) { console.error("用法: proc.mjs kill <pid>"); process.exit(1); }
  const r = run("taskkill", ["/PID", arg, "/T", "/F"]);
  console.log(r.status === 0 ? `已杀 PID ${arg} 进程树` : `杀失败: ${r.err.trim() || r.out.trim()}`);
} else if (cmd === "kill-port") {
  if (!arg || !/^\d+$/.test(arg)) { console.error("用法: proc.mjs kill-port <port>"); process.exit(1); }
  const pid = pidOnPort(Number(arg));
  if (!pid) { console.log(`端口 ${arg} 无占用`); process.exit(0); }
  if (!isNodePid(pid)) { console.log(`端口 ${arg} 被非 node 进程 (PID ${pid}) 占用，跳过`); process.exit(0); }
  const r = run("taskkill", ["/PID", pid, "/T", "/F"]);
  console.log(r.status === 0 ? `已杀端口 ${arg} 占用 (PID ${pid})` : `杀失败: ${r.err.trim()}`);
} else {
  console.log("用法: node scripts/dev-utils/proc.mjs {status | list | kill <pid> | kill-port <port>}");
  process.exit(1);
}
