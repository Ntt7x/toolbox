// ============================================================
// 公共 LLM 能力 · 模式 3：Reasonix Go + ACP（core/reasonix）
// 启动官方 reasonix 二进制（v1.20.0+）的 ACP 服务（NDJSON JSON-RPC 2.0 over stdio），
// 享受其开源成果：append-only 会话、前缀稳定、自动压缩、会话持久化，
// 从而命中 DeepSeek 前缀缓存（同会话续接实测 98.8%，成本降 13.2x）。
//
// 服务端状态管理（stateful）：
// - 会话注册表 KV 持久化（reasonixSession:<业务id> → { reasonixSessionId, cwd, module, ... }），
//   服务端重启 / ACP 进程崩溃后可通过注册表恢复（session/resume 不重放历史）
// - ACP 进程惰性单例；崩溃自动重启（pending 拒绝 + 下次调用重建）
// - 多会话并发：通知按 sessionId 分发（promptListeners Map），互不干扰
// - 用量采集：status_update 的 usage 事件（含 cacheHit/cacheMiss/cost）记录到 llmUsage 统一监控
//
// 协议要点（实测确认）：
//   initialize → session/new(cwd) → session/prompt({sessionId, prompt:[{type:"text",text}]})
//   → 回答从 session/update 通知的 agent_message_chunk 收集（transcript .jsonl 不实时更新，勿读）
//   → session/close；通知 _reasonix.io/session/status_update（phase/usage/completion）
// ============================================================

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadApiKey, recordLlmUsage } from "./llm.js";
import { getSetting } from "./settingsStore.js";
import { DATA_DIR } from "./db.js";
import { kvGet, kvSet, kvDelete, kvListRaw } from "./kvStore.js";

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

// ---------- ACP 连接（惰性单例，崩溃自动重建） ----------

interface PendingEntry {
  resolve: (msg: { result?: unknown; error?: { message?: string } }) => void;
  timer: NodeJS.Timeout;
}

interface AcpClient {
  child: ChildProcess;
  nextId: number;
  /** 未决请求（含超时定时器引用，响应/退出/超时时统一清理，避免定时器泄漏） */
  pending: Map<number, PendingEntry>;
  buffer: string;
  /** 按 reasonix sessionId 分发的通知监听（多会话并发互不干扰） */
  promptListeners: Map<string, (params: AcpSessionUpdate) => void>;
}

/** session/update 通知参数（streamed chunks） */
interface AcpSessionUpdate {
  sessionId?: string;
  update?: {
    sessionUpdate?: string;
    content?: { type?: string; text?: string };
  };
}

/** status_update 通知参数（phase/usage/completion） */
interface AcpStatusUpdate {
  sessionId?: string;
  event?: string;
  status?: {
    usage?: {
      turn?: ReasonixUsageShape;
      cumulative?: ReasonixUsageShape;
    };
  };
}

interface ReasonixUsageShape {
  promptTokens?: number;
  completionTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  estimatedCost?: number;
}

let acp: AcpClient | null = null;

// ---------- ACP 启动与消息处理 ----------

function startAcp(): AcpClient {
  const bin = resolveBinary();
  if (!bin) throw new Error("reasonix 二进制未找到：请配置 llm.reasonixBin 或安装 @reasonix/cli-<platform>-<arch>");
  if (!existsSync(bin)) throw new Error(`reasonix 二进制不存在：${bin}`);
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error("未配置 DeepSeek API key（模式 3 需 DEEPSEEK_API_KEY）");
  const child = spawn(bin, ["acp"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DEEPSEEK_API_KEY: apiKey },
    windowsHide: true,
  });
  const client: AcpClient = { child, nextId: 0, pending: new Map(), buffer: "", promptListeners: new Map() };
  // spawn 运行时错误（权限/被杀等）：拒绝未决请求并标记重建，避免 uncaughtException
  child.on("error", (err) => {
    for (const entry of client.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ error: { message: `reasonix 启动失败：${err.message}` } });
    }
    client.pending.clear();
    acp = null;
  });
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
        continue;
      }
      if (msg.id !== undefined && client.pending.has(msg.id)) {
        const entry = client.pending.get(msg.id)!;
        client.pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
      if (msg.method === "session/update" || msg.method === "_reasonix.io/session/status_update") {
        const params = msg.params as AcpSessionUpdate & AcpStatusUpdate;
        const listener = params.sessionId ? client.promptListeners.get(params.sessionId) : undefined;
        if (process.env.REASONIX_ACP_DEBUG) {
          console.log(`[reasonix-acp] ${msg.method}`, JSON.stringify(params).slice(0, 2000));
        }
        if (listener) {
          try {
            listener(params);
          } catch {
            // 监听器异常不影响主流程
          }
        }
        // ACP 精细控制：host 拦截 Agent 的内置 fs 工具调用（read/write/edit/delete），
        // 文件类放行、非文件类拒绝；批准后 reasonix 自行执行（yolo 下通常不触发）。
        if (params.update?.sessionUpdate === "tool_call" && params.sessionId) {
          void handleToolCall(params);
        }
      }
      // Reasonix 权限请求兜底：默认拒绝（防止 Agent 卡在 bash 等权限等待；知识库访问走 read_file 无需权限）
      if (msg.method === "session/request_permission") {
        const p = msg.params as {
          sessionId?: string;
          toolCall?: {
            name?: string;
            rawInput?: Record<string, unknown>;
            locations?: { path?: string }[];
            _meta?: { "reasonix.io"?: { approvalId?: string; tool?: string } };
          };
        };
        const approvalId = p.toolCall?._meta?.["reasonix.io"]?.approvalId;
        const sessionId = p.sessionId;
        // 权限决策（本地个人站点：文件类工具全放行；bash/网络等非文件类拒绝）
        const tool = p.toolCall?._meta?.["reasonix.io"]?.tool ?? p.toolCall?.name ?? "";
        const isFileOp = ["read_file", "write_file", "edit_file", "delete_file", "fs.readTextFile", "fs.writeTextFile", "fs.deleteFile"].includes(tool);
        if (approvalId && sessionId) {
          // fire-and-forget：决策后 Agent 继续（不阻塞主流程）
          void rpc("session/grant_permission", { sessionId, permissionID: approvalId, allow: isFileOp }, 8000).catch(() => {});
        }
      }
    }
  });
  child.stderr.on("data", (d: Buffer) => {
    const text = d.toString().trim();
    if (text && !text.includes("bash not found")) console.warn(`[reasonix-acp] ${text.slice(0, 200)}`);
  });
  child.on("exit", () => {
    for (const entry of client.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ error: { message: "reasonix acp 进程已退出" } });
    }
    client.pending.clear();
    acp = null; // 下次调用自动重建
  });
  acp = client;
  return client;
}

function getAcp(): AcpClient {
  if (acp && acp.child.exitCode === null) return acp;
  return startAcp();
}

/** ACP 工具调用拦截（兜底；tool_approval=yolo 下通常不触发）：
 * Agent 的 fs 工具若仍以 tool_call(pending) 发来（waiting_permission），
 * host 用 session/grant_permission 决策：文件类工具全放行，非文件类拒绝。
 * 批准后由 reasonix 在 cwd 内自行执行（无需 host 执行/回 tool_result）。 */
async function handleToolCall(params: AcpSessionUpdate & AcpStatusUpdate): Promise<void> {
  const sessionId = params.sessionId ?? "";
  const tc = params.update as {
    toolCallId?: string;
    title?: string;
    kind?: string;
    rawInput?: { path?: string; content?: string };
    locations?: { path?: string }[];
    _meta?: { "reasonix.io"?: { tool?: string } };
  };
  const toolCallId = tc.toolCallId ?? "";
  if (!sessionId || !toolCallId) return;
  // 工具名：优先 _meta 内嵌，其次 title（如 write_file），再次 kind（read/edit）
  const tool = tc._meta?.["reasonix.io"]?.tool ?? tc.title ?? tc.kind ?? "";
  const targetPath = tc.locations?.[0]?.path ?? tc.rawInput?.path ?? "";
  const allowed = ["read_file", "write_file", "edit_file", "delete_file", "fs.readTextFile", "fs.writeTextFile", "fs.deleteFile"].includes(tool);
  if (!allowed) {
    console.warn(`[reasonix-acp] 拒绝非文件工具 ${tool}（路径 ${targetPath}）`);
  }
  await rpc("session/grant_permission", { sessionId, permissionID: toolCallId, allow: allowed }, 8000).catch(() => {});
}

function rpc(method: string, params: Record<string, unknown>, timeoutMs = 90000): Promise<{ result?: unknown; error?: { message?: string } }> {
  let client: AcpClient;
  try {
    client = getAcp();
  } catch (e) {
    // 二进制缺失 / API key 缺失等：转为 error 返回，调用方无需 try/catch
    return Promise.resolve({ error: { message: e instanceof Error ? e.message : String(e) } });
  }
  const id = ++client.nextId;
  return new Promise((resolve) => {
    const entry: PendingEntry = {
      resolve,
      timer: setTimeout(() => {
        if (client.pending.has(id)) {
          client.pending.delete(id);
          resolve({ error: { message: `ACP ${method} 超时（${timeoutMs}ms）` } });
        }
      }, timeoutMs),
    };
    client.pending.set(id, entry);
    client.child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// ---------- 会话注册表（KV 持久化，服务端状态） ----------

const REG_PREFIX = "reasonixSession:";
/** 活跃期：30 天（reasonix 会话保持打开，可续问；期间缓存友好） */
const ACTIVE_MS = 30 * 24 * 60 * 60 * 1000;
/** 归档期：360 天（注册表保留，reasonix 侧会话自动 close 释放资源；续用时 resume 恢复） */
const ARCHIVE_MS = 360 * 24 * 60 * 60 * 1000;

export interface ReasonixSessionReg {
  /** 业务会话 id（注册表 key 段，对外暴露） */
  id: string;
  /** reasonix 侧 sessionId */
  reasonixSessionId: string;
  cwd: string;
  module: string;
  createdAt: number;
  lastAt: number;
  ttlMs: number;
}

function regKey(id: string): string {
  return `${REG_PREFIX}${id}`;
}

function genRegId(): string {
  return `rx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadReg(id: string): ReasonixSessionReg | null {
  const r = kvGet<ReasonixSessionReg>(regKey(id));
  if (!r || typeof r.reasonixSessionId !== "string") return null;
  const age = Date.now() - r.lastAt;
  if (age > ARCHIVE_MS) {
    kvDelete(regKey(id)); // 超归档期：清理
    return null;
  }
  return r;
}

function saveReg(r: ReasonixSessionReg): void {
  kvSet(regKey(r.id), r);
}

/** 初始化 ACP 并打开一个会话；注册表 KV 持久化（服务端重启/进程崩溃后可恢复）
 * 默认 cwd = 数据目录 /.file（git 隔离）：Agent 文件资源集中在 .file 内，
 * 与本地数据（SQLite KV）同区，便于资源统一管理。 */
export async function createReasonixSession(opts: { cwd?: string; module?: string } = {}): Promise<{ ok: boolean; id?: string; message?: string }> {
  try {
    const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} }, 15000);
    if (init.error) return { ok: false, message: `reasonix initialize 失败：${init.error.message}` };
    const cwd = opts.cwd ?? DATA_DIR;
    const res = await rpc("session/new", { cwd }, 15000);
    if (res.error) return { ok: false, message: `reasonix session/new 失败：${res.error.message}` };
    const reasonixSessionId = (res.result as { sessionId?: string } | undefined)?.sessionId;
    if (!reasonixSessionId) return { ok: false, message: "reasonix 未返回 sessionId" };
    // 本地个人站点：工具批准全自动（yolo）——Agent 可自由读写文件（含 /k/ 知识库），
    // 不再逐次等待 host 批准；非文件类（bash/网络）仍由 request_permission 兜底拒绝。
    await rpc("session/set_config_option", { sessionId: reasonixSessionId, configId: "tool_approval", value: "yolo" }, 10000).catch(() => {});
    const now = Date.now();
    const reg: ReasonixSessionReg = {
      id: genRegId(),
      reasonixSessionId,
      cwd,
      module: opts.module ?? "reasonix",
      createdAt: now,
      lastAt: now,
      ttlMs: ACTIVE_MS,
    };
    saveReg(reg);
    return { ok: true, id: reg.id };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 会话追加一轮查询（Reasonix 内部 append-only，前缀稳定）。
 * 回答从 session/update 的 agent_message_chunk 收集；usage 从 status_update 采集并记录；
 * 若 reasonix 侧会话失效（进程崩溃/重启），自动 session/resume 恢复重试一次。
 */
export async function reasonixAsk(
  regId: string,
  text: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; content?: string; stopReason?: string; usage?: ReasonixUsageShape; message?: string }> {
  const reg = loadReg(regId);
  if (!reg) return { ok: false, message: "会话不存在或已过期（归档期 360 天）" };

  const doAsk = async (sid: string): Promise<{ ok: boolean; content?: string; stopReason?: string; usage?: ReasonixUsageShape; message?: string; sessionGone?: boolean }> => {
    let client: AcpClient;
    try {
      client = getAcp();
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    const chunks: string[] = [];
    let usage: ReasonixUsageShape | undefined;
    const listener = (params: AcpSessionUpdate & AcpStatusUpdate) => {
      if (params.update?.sessionUpdate === "agent_message_chunk") {
        const t = params.update.content?.text ?? "";
        if (t) chunks.push(t);
      }
      // status_update 的 usage 事件（turn/cumulative，含缓存命中）
      if (params.event === "usage" && params.status?.usage?.cumulative) {
        const c = params.status.usage.cumulative;
        usage = {
          promptTokens: c.promptTokens ?? 0,
          completionTokens: c.completionTokens ?? 0,
          cacheHitTokens: c.cacheHitTokens ?? 0,
          cacheMissTokens: c.cacheMissTokens ?? 0,
          ...(c.estimatedCost !== undefined ? { estimatedCost: c.estimatedCost } : {}),
        };
      }
    };
    client.promptListeners.set(sid, listener);
    try {
      const res = await rpc("session/prompt", { sessionId: sid, prompt: [{ type: "text", text }] }, opts.timeoutMs ?? 90000);
      if (res.error) {
        const msg = res.error.message ?? "";
        // 会话丢失（reasonix 侧失效）或 ACP 进程崩溃退出 → 标记 sessionGone，走 resume 恢复
        return { ok: false, message: `reasonix prompt 失败：${msg}`, sessionGone: /unknown session|not found|no such|进程已退出|exited/i.test(msg) };
      }
      // usage：从本次 prompt 的 status_update 采集（在 listener 内不好同步，这里补一次 status 查询兜底可选）
      const content = chunks.join("");
      if (!content) return { ok: false, message: "reasonix 未返回回答文本（无 agent_message_chunk）" };
      return { ok: true, content, stopReason: (res.result as { stopReason?: string } | undefined)?.stopReason, usage };
    } finally {
      client.promptListeners.delete(sid);
    }
  };

  let r = await doAsk(reg.reasonixSessionId);
  // 崩溃恢复：reasonix 侧会话丢失 → session/resume（不重放历史）重试一次
  if (!r.ok && r.sessionGone) {
    const resume = await rpc("session/resume", { sessionId: reg.reasonixSessionId }, 15000).catch(() => ({ error: { message: "resume failed" } }));
    if (!resume.error) r = await doAsk(reg.reasonixSessionId);
  }
  if (r.ok) {
    reg.lastAt = Date.now();
    saveReg(reg);
    if (r.usage) recordLlmUsage(reg.module, "reasonix", r.usage, "reasonix");
  }
  return r;
}

/** 关闭会话（释放资源；reasonix 持久化历史保留）；删除注册表 */
export async function closeReasonixSession(regId: string): Promise<void> {
  const reg = loadReg(regId);
  if (reg) {
    await rpc("session/close", { sessionId: reg.reasonixSessionId }, 10000).catch(() => {});
    kvDelete(regKey(regId));
  }
}

/** 会话注册表列表（两级生命周期：活跃 30 天 / 归档 360 天 / 过期清理）
 * 归档态（>30 天未用）自动 close reasonix 侧会话释放资源（注册表保留，续用时 resume） */
export function listReasonixSessions(): { id: string; module: string; cwd: string; createdAt: number; lastAt: number }[] {
  const out: { id: string; module: string; cwd: string; createdAt: number; lastAt: number }[] = [];
  for (const r of kvListRaw(REG_PREFIX, 200)) {
    let reg: ReasonixSessionReg | null = null;
    try {
      reg = r.value ? (JSON.parse(r.value) as ReasonixSessionReg) : null;
    } catch {
      continue; // 损坏数据跳过
    }
    if (!reg || typeof reg.reasonixSessionId !== "string") continue;
    const age = Date.now() - reg.lastAt;
    if (age > ARCHIVE_MS) {
      kvDelete(r.key);
      continue;
    }
    if (age > ACTIVE_MS) {
      // 归档态：释放 reasonix 侧会话资源（fire-and-forget；失败静默，注册表保留）
      void rpc("session/close", { sessionId: reg.reasonixSessionId }, 8000).catch(() => {});
    }
    out.push({ id: reg.id, module: reg.module, cwd: reg.cwd, createdAt: reg.createdAt, lastAt: reg.lastAt });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

/** 关闭 ACP 进程（注册表保留，重启后可恢复） */
export function shutdownReasonix(): void {
  if (acp && acp.child.exitCode === null) {
    try {
      acp.child.kill();
      // Windows：kill 进程树（reasonix 可能派生子进程，需一并终止以释放 stdio 管道）
      if (process.platform === "win32" && acp.child.pid) {
        try {
          spawnSync("taskkill", ["/pid", String(acp.child.pid), "/T", "/F"], { stdio: "ignore" });
        } catch {
          // taskkill 不可用时忽略
        }
      }
    } catch {
      // 忽略
    }
  }
  acp = null;
}

/** Reasonix 会话存储根目录（其持久化 transcript） */
export function reasonixSessionsDir(): string {
  return join(process.env.USERPROFILE ?? process.env.HOME ?? "", "AppData", "Roaming", "reasonix", "sessions");
}

export { ACTIVE_MS, ARCHIVE_MS };
