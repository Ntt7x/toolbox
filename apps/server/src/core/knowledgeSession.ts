// ============================================================
// 公共模块：知识库 × Reasonix Agent 会话封装
// 知识管理执行者 = Reasonix Agent（会话持久、前缀缓存，成本低）：
//   - 会话挂载 stdio MCP（core/knowledgeMcp），Agent 经 mcp__kb__* 工具直接读写 KV（无文件视图）
//   - 实例级会话（knowledgeSession:<instance> 注册表 KV 持久化），同一实例多次问答/导入共享上下文
//   - Reasonix 不可用（二进制/API key 缺失）时调用方降级到服务端直调（kbAsk/kbImportFromChat）
// ============================================================
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createReasonixSession, reasonixAsk } from "./reasonix.js";
import { kvGet, kvSet, kvDelete } from "./kvStore.js";
import { extractShare } from "./deepseekShare.js";
import { registerDataSource } from "./dataRegistry.js";

const require_ = createRequire(import.meta.url);
/** MCP 子进程入口：node + tsx CLI（支持 .ts 直跑；./cli 为 exports 入口） */
const TSX_CLI = require_.resolve("tsx/cli");
/** 脚本用正斜杠路径传 tsx（Windows 反斜杠会被 Node ESM loader 误判为 d: 协议；file:// URL 又会被 tsx 拼接错乱） */
const KB_MCP_SCRIPT = fileURLToPath(new URL("./knowledgeMcp.ts", import.meta.url)).replace(/\\/g, "/");

export const KNOWLEDGE_SESSION_PREFIX = "knowledgeSession:";

registerDataSource({
  kind: "kv",
  name: "knowledgeSession:",
  page: "知识库",
  tag: "运行状态",
  description: "知识库实例的 Reasonix Agent 会话注册表（KV 持久化，续用/恢复）",
});

/** Reasonix 会话挂载的知识库 MCP server（stdio） */
function kbMcpServer(): { name: string; command: string; args: string[]; env: Record<string, string> } {
  return {
    name: "kb",
    command: process.execPath,
    args: [TSX_CLI, KB_MCP_SCRIPT],
    env: { PATH: process.env.PATH ?? "" },
  };
}

function sessionKey(instance: string): string {
  return `${KNOWLEDGE_SESSION_PREFIX}${instance}`;
}

interface KnowledgeSessionReg {
  regId: string;
  instance: string;
  createdAt: number;
  lastAt: number;
}

/** 获取（或创建）某实例的 Reasonix 会话；失败返回 ok:false（调用方降级直调） */
export async function ensureKnowledgeSession(instance: string): Promise<{ ok: boolean; regId?: string; message?: string }> {
  const key = sessionKey(instance);
  const existing = kvGet<KnowledgeSessionReg>(key);
  if (existing && typeof existing.regId === "string") {
    return { ok: true, regId: existing.regId };
  }
  const s = await createReasonixSession({ module: `knowledge.${instance}`, mcpServers: [kbMcpServer()] });
  if (!s.ok || !s.id) return { ok: false, message: s.message ?? "reasonix 会话创建失败" };
  kvSet(key, { regId: s.id, instance, createdAt: Date.now(), lastAt: Date.now() } satisfies KnowledgeSessionReg);
  return { ok: true, regId: s.id };
}

/** 会话失效（reasonix 注册表被清/重建失败）时清理注册表 */
function dropSession(instance: string): void {
  kvDelete(sessionKey(instance));
}

/** Agent 引导词（每次 prompt 注入：说明知识工具与约束，压制探索类工具） */
function guideFor(instance: string, action: string): string {
  return [
    `你是知识库助手。本会话已挂载知识库 MCP（工具 mcp__kb__*），直接调用即可，不要使用 bash/glob/ls/docs 等其他工具。`,
    `本次任务：${action}。`,
    `知识实例为 ${instance}（key 首段必须是 ${instance}，如 ${instance}.topic.subtopic）。`,
  ].join("\n");
}

/**
 * 知识问答（Reasonix 执行）：Agent 用 kb_search/kb_get 检索实例知识后回答。
 * 失败时返回 { ok:false, fallback:true }，调用方降级 kbAsk。
 */
export async function knowledgeAgentAsk(
  instance: string,
  question: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; content?: string; usage?: unknown; message?: string; fallback?: boolean }> {
  const s = await ensureKnowledgeSession(instance);
  if (!s.ok || !s.regId) return { ok: false, message: s.message, fallback: true };
  const prompt = `${guideFor(instance, "回答用户问题")}\n回答前必须先用 kb_search（question 取用户问题，instance 为 ${instance}）检索知识库；基于检索到的条目回答，并标注引用条目 key；检索无结果时如实说明。\n\n【用户问题】\n${question}`;
  const r = await reasonixAsk(s.regId, prompt, opts);
  if (!r.ok) {
    dropSession(instance); // 会话可能失效 → 下次重建
    return { ok: false, message: r.message, fallback: true };
  }
  return { ok: true, content: r.content, usage: r.usage };
}

/**
 * 知识导入（Reasonix 执行）：服务端取分享对话原文 → Agent 整理为条目 → kb_set 写入实例。
 * 失败时返回 { ok:false, fallback:true }，调用方降级 kbImportFromChat。
 */
export async function knowledgeAgentImport(
  instance: string,
  shareUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; imported?: number; message?: string; fallback?: boolean }> {
  const conv = await extractShare(shareUrl);
  if (!conv.ok || !Array.isArray(conv.messages) || conv.messages.length === 0) {
    return { ok: false, message: "分享链接对话提取失败", fallback: true };
  }
  const s = await ensureKnowledgeSession(instance);
  if (!s.ok || !s.regId) return { ok: false, message: s.message, fallback: true };
  const dialog = conv.messages
    .map((m, i) => `${i + 1}. [${m.role}] ${typeof m.content === "string" ? m.content.slice(0, 2000) : JSON.stringify(m.content).slice(0, 2000)}`)
    .join("\n");
  const prompt =
    `${guideFor(instance, "把对话内容整理为知识条目并写入知识库")}\n` +
    `步骤：1) 先用 kb_count（instance=${instance}）和 kb_list（instance=${instance}）查看已有条目，避免重复；` +
    `2) 对每个独立知识点用 kb_set 写入：key 分层（${instance}.主题.子主题），value 为简洁完整、可独立理解的事实文本；` +
    `3) 所有 kb_set 的 source 参数统一用分享链接。\n\n【对话原文】\n${dialog}`;
  const r = await reasonixAsk(s.regId, prompt, { timeoutMs: opts.timeoutMs ?? 5 * 60 * 1000 });
  if (!r.ok) {
    dropSession(instance);
    return { ok: false, message: r.message, fallback: true };
  }
  return { ok: true, imported: 0, message: r.content };
}

/** 关闭某实例的会话并删注册表（本地数据管理清理用） */
export function dropKnowledgeSession(instance: string): void {
  dropSession(instance);
}
