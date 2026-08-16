// ============================================================
// 统一开发工具入口（scripts/dev-utils/toolbox.mjs）
// 用途：Agent / Vibe Coding 只需记住一个命令即可枚举与调用全部开发工具：
//   node scripts/dev-utils/toolbox.mjs <cmd> [args...]
//   node scripts/dev-utils/toolbox.mjs list          → 枚举全部工具（速查）
//   node scripts/dev-utils/toolbox.mjs help <cmd>    → 某工具用法
//   node scripts/dev-utils/toolbox.mjs dev start     → 转发到 dev.mjs start
// 底层脚本仍在 scripts/dev-utils/ 原位置可直接调用（本入口仅做分发，不改变实现）。
// ============================================================
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 工具注册表（唯一真相；scripts/README.md 与之同步） */
const TOOLS = [
  // ---- 开发进程 ----
  { cmd: "dev", script: "dev.mjs", group: "进程", desc: "开发进程管理（server tsx watch + web vite supervisor）", example: "toolbox dev start|stop|restart|status|kill-port <port>" },
  { cmd: "proc", script: "proc.mjs", group: "进程", desc: "进程诊断/清理（端口占用、残留 supervisor/tsx/vite）", example: "toolbox proc status|list|kill <pid>|kill-port <port>" },
  // ---- 验证 ----
  { cmd: "test", script: "test.mjs", group: "验证", desc: "模块单测（自动定位测试文件 / 空=全量）", example: "toolbox test tradePlan" },
  { cmd: "typecheck", script: "typecheck.mjs", group: "验证", desc: "TypeScript 类型检查（server + web + shared；L0 必跑）", example: "toolbox typecheck [--app server|web]" },
  { cmd: "share", script: "share-extract.mjs", group: "小工具", desc: "DeepSeek 分享链接对话提取 CLI（memo msvpddmz；ts hook 自动加载）", example: "toolbox share <url|id> [--json]", ts: true },
  { cmd: "smoke", script: "smoke-pages.mjs", group: "验证", desc: "页面冒烟（18 页；--page 定向单页配合 L2）", example: "toolbox smoke [--page /tools/x]" },
  { cmd: "api", script: "api-cli.mjs", group: "验证", desc: "API CLI（curl 替代，Windows 引号安全；自动加 /api 前缀）", example: "toolbox api GET /health" },
  { cmd: "check", script: "check-change.mjs", group: "验证", desc: "改动健康检查（文件数/行数/触及分层 → 建议验证级别）", example: "toolbox check [--base main]" },
  { cmd: "probe", script: "browser-probe.mjs", group: "验证", desc: "浏览器探针（launch 系统 Chrome + 选择器状态检查）", example: "toolbox probe <url> --check 'textarea:主输入框'" },
  { cmd: "browser", script: "browser-run.mjs", group: "验证", desc: "浏览器冒烟运行器（playwright 模板固化：TMP/日志/Chrome 自动处理）", example: "toolbox browser <script.mjs> [url]" },
  // ---- 数据 ----
  { cmd: "kv", script: "kv.mjs", group: "数据", desc: "KV/DB 检查与备份（list/count/get/backup/restore）", example: "toolbox kv count|list|get <key>" },
  { cmd: "memo", script: "memo.mjs", group: "数据", desc: "改进备忘录 CLI（每轮「处理备忘录」必用）", example: "toolbox memo list|stats|bypage <关键词>|done <id>...|add <text>" },
  // ---- 提交 ----
  { cmd: "commit", script: "commit.mjs", group: "提交", desc: "git 提交包装（消息引号安全，自动 add+commit+push）", example: "toolbox commit 'feat(x): 说明'" },
  // ---- 文本/工具维护 ----
  { cmd: "patch", script: "patch.mjs", group: "文本", desc: "文件文本替换执行器（patch.json 驱动，dry-run/原子写盘，CRLF 感知）", example: "toolbox patch <patch.json> [--apply]" },
  { cmd: "self-test", script: "self-test.mjs", group: "维护", desc: "dev-utils 工具自测（工具改动后必跑）", example: "toolbox self-test" },
];

/** 库模块（不提供 CLI，仅被脚本 import） */
const LIBS = [
  { cmd: "api", script: "api.mjs", desc: "通用 API 客户端（fetch+json 包装，非 2xx 抛带 message 的 Error）" },
  { cmd: "e2e", script: "e2e.mjs", desc: "API E2E 断言脚手架（用例列表 + 统计 + 失败 exit 1）" },
  { cmd: "_lib", script: "_lib.mjs", desc: "共享库（ROOT/tsxCli/viteCli 动态路径）" },
  { cmd: "ts-hook", script: "ts-resolve-hook.mjs", desc: "TS resolve hook（免 spawn 跑 TS 单测，--no-spawn 模式用）" },
];

const byCmd = new Map(TOOLS.map((t) => [t.cmd, t]));

function printList() {
  console.log("Toolbox 统一开发工具入口：node scripts/dev-utils/toolbox.mjs <cmd> [args...]\n");
  const groups = [...new Set(TOOLS.map((t) => t.group))];
  for (const g of groups) {
    console.log("── " + g + " ──");
    for (const t of TOOLS.filter((x) => x.group === g)) {
      console.log("  " + t.cmd.padEnd(10) + " " + t.desc);
      console.log("             例: " + t.example);
    }
    console.log("");
  }
  console.log("库模块（仅脚本内 import，不提供 CLI）：" + LIBS.map((l) => l.cmd).join(", "));
  console.log("\n底层脚本仍可直接调用：node scripts/dev-utils/<脚本>.mjs ...（见 scripts/README.md）");
}

function printHelp(cmd) {
  if (!cmd) { printList(); return; }
  const t = byCmd.get(cmd);
  if (!t) {
    console.error("未知命令: " + cmd + "（用 toolbox list 查看全部）");
    process.exit(1);
  }
  console.log("toolbox " + t.cmd + " — " + t.desc);
  console.log("  底层脚本: scripts/dev-utils/" + t.script);
  console.log("  用法: " + t.example);
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "help") { printHelp(rest[0]); process.exit(0); }
if (cmd === "list") { printList(); process.exit(0); }

const t = byCmd.get(cmd);
if (!t) {
  console.error("未知命令: " + cmd);
  printList();
  process.exit(1);
}

const scriptPath = path.join(SCRIPT_DIR, t.script);
const pre = t.ts ? ["--import", pathToFileURL(path.join(SCRIPT_DIR, "ts-resolve-hook.mjs")).href] : [];
const r = spawnSync(process.execPath, [...pre, scriptPath, ...rest], { stdio: "inherit", cwd: path.resolve(SCRIPT_DIR, "..", "..") });
process.exit(r.status ?? 1);