// ============================================================
// 开发辅助脚本：进程管理 CLI（scripts/dev-utils/proc.mjs）
// 固化「dev 进程诊断/清理」反复需求：多个 supervisor 并存打架、
// tsx watch 假 200（需重启 server）、端口被残留 node 占用等。
// 用法（node scripts/dev-utils/proc.mjs ...）：
//   status         当前环境（prod/dev）端口 + supervisor + node 进程数
//   envs           全部环境端口总览（跨分支并存时看谁占着谁）
//   list           全部 node 进程（PID + 命令行摘要，找残留 supervisor/tsx/vite）
//   kill <pid>     杀进程树（taskkill /T /F）
//   kill-port <p>  杀端口占用（仅 node 进程，防误杀）
// 环境感知（2026-09-02）：端口/状态文件由 env.mjs 解析，prod 与多个 dev 分支并存时各管各的。
// ============================================================
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT as root } from "./_lib.mjs";
import { resolveEnv, listEnvs, pidOnPort, isNodePid } from "./env.mjs";

const ENV = resolveEnv();
const STATE_FILE = ENV.paths.stateFile;
const PORTS = [ENV.serverPort, ENV.webPort];

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};

// pidOnPort / isNodePid 由 env.mjs 提供（2026-09-04 修复）：
// 本文件原先在 import 同名符号后又重复声明一遍 → SyntaxError，整个 proc CLI 直接不可用。

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

const [cmdRaw, argRaw] = process.argv.slice(2);
const cmd = (cmdRaw ?? "").replace(/;$/, "");
const arg = (argRaw ?? "").replace(/;$/, "");

if (cmd === "status") {
  console.log(`环境 ${ENV.name}（分支 ${ENV.branch}）· 数据 ${ENV.dataDir}`);
  console.log(`${ENV.name} supervisor: ${supervisorInfo()}`);
  for (const p of PORTS) {
    const pid = pidOnPort(p);
    console.log(`端口 ${p}: ${pid ? `被 PID ${pid} 占用${isNodePid(pid) ? "（node）" : "（非 node！）"}` : "空闲"}`);
  }
  const nodes = listNodeProcesses();
  console.log(`node 进程数: ${nodes.length}`);
} else if (cmd === "envs") {
  // 跨环境总览：多分支并存时一眼看清哪个环境活着、端口是谁
  console.log(`全部环境（当前分支：${ENV.branch}）：\n`);
  for (const e of listEnvs()) {
    const sp = pidOnPort(e.serverPort);
    const wp = pidOnPort(e.webPort);
    const state = sp || wp ? `🟢 运行中 (server PID ${sp ?? "-"} / web PID ${wp ?? "-"})` : "⚪ 空闲";
    console.log(`  ${e.name.padEnd(4)} ${e.branch}${e.current ? " ←当前" : ""}`);
    console.log(`       server ${e.serverPort} · web ${e.webPort} · ${state}`);
    console.log(`       data   ${e.dataDir}${existsSync(path.join(e.dataDir, "toolbox.db")) ? " [有数据]" : " [空]"}`);
  }
  console.log("\n切换分支后 `toolbox proc status` 显示的就是该分支的环境；`toolbox env list` 等价。");
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
  console.log("用法: node scripts/dev-utils/proc.mjs {status | envs | list | kill <pid> | kill-port <port>}");
  process.exit(1);
}
