// ============================================================
// 公共 LLM 能力 · 模式 3：Reasonix Go + ACP（core/reasonix）
// 启动官方 reasonix 二进制（v1.20.0+）的 ACP 服务（NDJSON JSON-RPC 2.0 over stdio），
// 享受其开源成果：append-only 会话、前缀稳定、自动压缩、会话持久化，
// 从而命中 DeepSeek 前缀缓存（同会话续接实测 98.8%，成本降 13.2x）。
//
// 协议要点（实测确认）：
//   initialize → session/new(cwd) → session/prompt({sessionId, prompt:[{type:"text",text}]})
//   → result { stopReason, transcriptPath }；回答从 transcript jsonl 末条 assistant.content 读取
//   → session/close；通知走 _reasonix.io/session/status_update（可忽略）
//
// 二进制解析：优先配置 settings:llm.reasonixBin，其次 require.resolve 官方 npm 包。
// ============================================================

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { loadApiKey } from "./llm.js";
import { getSetting } from "./settingsStore.js";

const require_ = createRequire(import.meta.url);

/** Reasonix 二进制解析：配置 → npm 包 → PATH */
function resolveBinary(): string | null {
  const fromConfig = getSetting<string>("llm.reasonixBin")?.trim();
  if (fromConfig) return fromConfig;
  try {
    return require_.resolve("@reasonix/cli-win32-x64/bin/reasonix.exe");
  } catch {
    try {
      return require_.resolve("@reasonix/cli-darwin-arm64/bin/reasonix");
    } catch {
      return null;
    }
  }
}

// ---------- ACP 连接（惰性单例） ----------

interface AcpClient {
  child: ChildProcess;
  nextId: number;
  pending: Map<number, (msg: { result?: unknown; error?: { message?: string } }) => void>;
  buffer: string;
  /** 当前活跃 prompt 的通知监听（session/update 流式分片） */
  promptListener: ((params: AcpSessionUpdate) => void) | null;
}

/** session/update 通知参数（streamed chunks） */
interface AcpSessionUpdate {
  sessionId?: string;
  update?: {
    sessionUpdate?: string;
    content?: { type?: string; text?: string };
  };
}

let acp: AcpClient | null = null;

function startAcp(): AcpClient {
  const bin = resolveBinary();
  if (!bin) throw new Error("reasonix 二进制未找到：请配置 llm.reasonixBin 或安装 @reasonix/cli-<platform>-<arch>");
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error("未配置 DeepSeek API key（模式 3 需 DEEPSEEK_API_KEY）");
  const child = spawn(bin, ["acp"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DEEPSEEK_API_KEY: apiKey },
    windowsHide: true,
  });
  const client: AcpClient = { child, nextId: 0, pending: new Map(), buffer: "", promptListener: null };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    client.buffer += chunk;
    let nl: number;
    while ((nl = client.buffer.indexOf("\n")) >= 0) {
      const line = client.buffer.slice(0, nl).trim();
      client.buffer = client.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 非 JSON（忽略）
      }
      if (msg.id !== undefined && client.pending.has(msg.id)) {
        const resolve = client.pending.get(msg.id)!;
        client.pending.delete(msg.id);
        resolve(msg);
      }
      // 流式通知（session/update → agent_message_chunk 文本分片）转发给当前 prompt 监听
      if (msg.method === "session/update" && client.promptListener) {
        try {
          client.promptListener(msg.params as AcpSessionUpdate);
        } catch {
          // 监听器异常不影响主流程
        }
      }
    }
  });
  child.stderr.on("data", (d: Buffer) => {
    const text = d.toString().trim();
    if (text && !text.includes("bash not found")) console.warn(`[reasonix-acp] ${text.slice(0, 200)}`);
  });
  child.on("exit", () => {
    // 进程退出：拒绝所有 pending
    for (const resolve of client.pending.values()) resolve({ error: { message: "reasonix acp 进程已退出" } });
    client.pending.clear();
    acp = null;
  });
  acp = client;
  return client;
}

function getAcp(): AcpClient {
  if (acp && acp.child.exitCode === null) return acp;
  return startAcp();
}

function rpc(method: string, params: Record<string, unknown>, timeoutMs = 90000): Promise<{ result?: unknown; error?: { message?: string } }> {
  const client = getAcp();
  const id = ++client.nextId;
  return new Promise((resolve) => {
    client.pending.set(id, resolve);
    client.child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (client.pending.has(id)) {
        client.pending.delete(id);
        resolve({ error: { message: `ACP ${method} 超时（${timeoutMs}ms）` } });
      }
    }, timeoutMs);
  });
}

// ---------- 会话 API ----------

export interface ReasonixSessionInfo {
  id: string;
  cwd: string;
  transcriptPath?: string;
  createdAt: number;
  lastAt: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000;

/** 初始化 ACP 并打开一个会话（workspace 根）；返回会话 id */
export async function createReasonixSession(cwd?: string): Promise<{ ok: boolean; sessionId?: string; message?: string }> {
  try {
    const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} }, 15000);
    if (init.error) return { ok: false, message: `reasonix initialize 失败：${init.error.message}` };
    const res = await rpc("session/new", { cwd: cwd ?? process.cwd() }, 15000);
    if (res.error) return { ok: false, message: `reasonix session/new 失败：${res.error.message}` };
    const sessionId = (res.result as { sessionId?: string } | undefined)?.sessionId;
    if (!sessionId) return { ok: false, message: "reasonix 未返回 sessionId" };
    return { ok: true, sessionId };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** 会话追加一轮查询（Reasonix 内部 append-only，前缀稳定）；回答从 session/update 流式分片收集 */
export async function reasonixAsk(
  sessionId: string,
  text: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; content?: string; stopReason?: string; message?: string }> {
  const client = getAcp();
  const chunks: string[] = [];
  const prevListener = client.promptListener;
  client.promptListener = (params) => {
    if (params.sessionId && params.sessionId !== sessionId) return;
    if (params.update?.sessionUpdate === "agent_message_chunk") {
      const t = params.update.content?.text ?? "";
      if (t) chunks.push(t);
    }
  };
  try {
    const res = await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, opts.timeoutMs ?? 90000);
    if (res.error) return { ok: false, message: `reasonix prompt 失败：${res.error.message}` };
    const result = res.result as { stopReason?: string } | undefined;
    const content = chunks.join("");
    if (!content) return { ok: false, message: "reasonix 未返回回答文本（无 agent_message_chunk）" };
    return { ok: true, content, stopReason: result?.stopReason };
  } finally {
    client.promptListener = prevListener;
  }
}

/** 关闭会话（释放资源；历史保留在 Reasonix 会话存储） */
export async function closeReasonixSession(sessionId: string): Promise<void> {
  await rpc("session/close", { sessionId }, 10000).catch(() => {});
}

/** 关闭 ACP 进程 */
export function shutdownReasonix(): void {
  if (acp && acp.child.exitCode === null) {
    try {
      acp.child.kill();
    } catch {
      // 忽略
    }
  }
  acp = null;
}

/** 会话存储根目录（Reasonix 持久化） */
export function reasonixSessionsDir(): string {
  return join(process.env.USERPROFILE ?? process.env.HOME ?? "", "AppData", "Roaming", "reasonix", "sessions");
}

export { SESSION_TTL_MS };
