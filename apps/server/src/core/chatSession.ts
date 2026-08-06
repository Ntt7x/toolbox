// ============================================================
// 公共 LLM 能力 · 模式 2：自研 Cache 会话（core/chatSession）
// 借鉴 Reasonix "Context Append Only for Cache" 设计：
// - system 固定（前缀锚点），每轮只 append user+assistant
// - 同会话连续调用：前缀（system+历史）命中 DeepSeek 前缀缓存（价 1/50）
// - 历史超阈值自动压缩（保留 system + 最近 N 轮，丢弃更早轮次）
// - KV 持久化（chatSession:<id>），TTL 过期自动清理
// 用法：
//   const sid = createChatSession({ module: "watchlist.fundamental.session", system })
//   await chatSessionAsk(sid, "分析标的 A…")   // 第 1 轮
//   await chatSessionAsk(sid, "分析标的 B…")   // 第 2 轮起前缀命中缓存
// ============================================================

import { kvGet, kvSet, kvDelete, kvListRaw } from "./kvStore.js";
import { chat, type ChatOptions } from "./llm.js";
import type { LlmChatMessage, LlmChatResult } from "@toolbox/shared";
import { registerDataSource } from "./dataRegistry.js";

registerDataSource({
  kind: "kv",
  name: "chatSession:",
  page: "LLM 缓存会话",
  tag: "运行状态",
  description: "LLM Cache 会话（模式 2 自研会话，前缀缓存降本）",
});

/** chat 实现（可注入，测试用 mock；生产保持 chat） */
let chatImpl: (messages: LlmChatMessage[], opts?: ChatOptions) => Promise<LlmChatResult> = chat;

/** 测试注入：替换 chat 实现（返回 ok 的假结果） */
export function __setChatImplForTest(fn: (messages: LlmChatMessage[], opts?: ChatOptions) => Promise<LlmChatResult>): void {
  chatImpl = fn;
}

/** 恢复默认 chat 实现 */
export function __resetChatImplForTest(): void {
  chatImpl = chat;
}

/** KV key 前缀 */
export const SESSION_PREFIX = "chatSession:";

/** 活跃期：30 天（完整历史 + 缓存友好，可继续追问） */
const ACTIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 归档期：360 天（历史折叠为摘要，可查看/恢复） */
const ARCHIVE_TTL_MS = 360 * 24 * 60 * 60 * 1000;
/** 历史压缩触发阈值（估算 tokens；借鉴 Reasonix compact：达到预算即压缩） */
const COMPACT_TRIGGER_TOKENS = 6000;
/** 压缩后保留的 verbatim 尾部预算（tokens） */
const TAIL_BUDGET_TOKENS = 4000;
/** 至少保留的最近轮数（用户/助手成对，即使超过预算） */
const MIN_RECENT_TURNS = 2;
/** 字符→token 估算系数（Reasonix fallbackTokPerChar=0.25） */
const TOK_PER_CHAR = 0.25;

/** 估算文本 tokens（仅用于压缩决策，非计费） */
function estTokens(text: string): number {
  return Math.ceil(text.length * TOK_PER_CHAR);
}

/** 折叠标记（类似 Reasonix summaryTag，机械折叠不用 LLM） */
const COMPACTED_MARKER = "[compacted 早期历史]";

export interface ChatSession {
  id: string;
  /** 归属模块（用量/命中率统计；建议带 .session 后缀与直调区分） */
  module: string;
  /** 稳定 system prompt（前缀锚点，会话内不可变） */
  system: string;
  /** 固定模型/搜索/JSON（切换会破坏前缀，禁止中途变更） */
  model?: string;
  search?: boolean;
  json?: boolean;
  /** 温度（固定，避免中途变更破坏前缀语义） */
  temperature?: number;
  /** 已交换的 user/assistant 消息（append-only） */
  history: LlmChatMessage[];
  /** 压缩时丢弃的轮次计数（统计用） */
  droppedTurns: number;
  createdAt: number;
  lastAt: number;
  /** 已归档（活跃期后自动折叠历史为摘要；归档期内可恢复/续用） */
  archived?: boolean;
  /** 归档时折叠的历史摘要（最近内容 + 折叠标记） */
  summary?: string;
}

export interface CreateSessionOptions {
  module: string;
  system: string;
  model?: string;
  search?: boolean;
  json?: boolean;
  /** 温度（固定） */
  temperature?: number;
  /** 业务确定性 id（幂等复用）：存在且 system 相同 → 复用；system 不同 → 旧会话作废重建 */
  id?: string;
}

function genId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 业务确定性 id 合法性（KV key 段安全） */
const BIZ_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

function keyOf(id: string): string {
  return `${SESSION_PREFIX}${id}`;
}

/** 新建会话（KV 持久化）；opts.id 提供时幂等复用（system 一致）或重建（system 变更） */
export function createChatSession(opts: CreateSessionOptions): ChatSession {
  const now = Date.now();
  if (opts.id) {
    if (!BIZ_ID_RE.test(opts.id)) throw new Error(`非法业务会话 id：${opts.id}`);
    const existing = kvGet<ChatSession>(keyOf(opts.id));
    if (existing && typeof existing.system === "string") {
      if (existing.system === opts.system) {
        // 幂等复用：刷新活跃时间，保留历史（前缀缓存友好）
        existing.lastAt = now;
        kvSet(keyOf(opts.id), existing);
        return existing;
      }
      // system 变更（提示词升级）：旧会话作废重建
      kvDelete(keyOf(opts.id));
    }
  }
  const session: ChatSession = {
    id: opts.id ?? genId(),
    module: opts.module,
    system: opts.system,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.search !== undefined ? { search: opts.search } : {}),
    ...(opts.json !== undefined ? { json: opts.json } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    history: [],
    droppedTurns: 0,
    createdAt: now,
    lastAt: now,
  };
  kvSet(keyOf(session.id), session);
  return session;
}

/** 会话生命周期：活跃 30 天 → 归档 360 天 → 过期清理
 * - 活跃（≤30 天）：完整历史 + 缓存友好
 * - 归档（30~360 天）：历史折叠为摘要（archived=true + summary），可查看/恢复续用
 * - 过期（>360 天）：删除 */
function loadSession(id: string): ChatSession | null {
  const s = kvGet<ChatSession>(keyOf(id));
  if (!s || typeof s.system !== "string") return null;
  const age = Date.now() - s.lastAt;
  if (age > ARCHIVE_TTL_MS) {
    kvDelete(keyOf(id)); // 超归档期：清理
    return null;
  }
  if (age > ACTIVE_TTL_MS && !s.archived) {
    // 进入归档期：折叠历史为摘要（保留最近 2 轮 verbatim，早期折叠）
    archiveSessionInternal(s);
  }
  return s;
}

/** 归档：折叠 history 为摘要（保留最近 2 轮 verbatim + 早期折叠标记） */
function archiveSessionInternal(s: ChatSession): void {
  const recent = s.history.slice(-4); // 最近 2 轮（user+assistant 成对）
  const early = s.history.slice(0, -4);
  const earlyLen = Math.round(early.length / 2);
  const summary = [earlyLen > 0 ? `${COMPACTED_MARKER} 早期 ${earlyLen} 轮` : "", ...recent.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content.slice(0, 200)}`)].join("\n");
  s.summary = summary.trim();
  s.history = [];
  s.archived = true;
  kvSet(keyOf(s.id), s);
}

/** 恢复归档会话（摘要注入为历史上下文，重新进入活跃期）；无则 null */
export function restoreArchivedSession(id: string): ChatSession | null {
  const s = loadSession(id);
  if (!s) return null;
  if (s.archived) {
    const summary = s.summary ?? "";
    s.history = summary ? [{ role: "user" as const, content: `[历史摘要]\n${summary}` }] : [];
    s.summary = undefined;
    s.archived = false;
    s.lastAt = Date.now();
    kvSet(keyOf(s.id), s);
  }
  return s;
}

/** 压缩历史（借鉴 Reasonix compact：按 token 预算）：
 * 超触发阈值时保留 system + 最近 verbatim tail（预算内且至少 MIN_RECENT_TURNS 轮），
 * 更早轮次折叠为一行标记（机械折叠，不调 LLM）。system 恒定为前缀锚点，永不删除。 */
export function compactSession(id: string, loaded?: ChatSession): ChatSession | null {
  const s = loaded ?? loadSession(id);
  if (!s) return null;
  const total = s.history.reduce((sum, m) => sum + estTokens(m.content), 0);
  if (total <= COMPACT_TRIGGER_TOKENS) return s; // 未达触发阈值，无需压缩

  // 从尾部向前累计保留（verbatim tail），至少 MIN_RECENT_TURNS 轮
  let keep = 0;
  let budget = 0;
  for (let i = s.history.length - 1; i >= 0; i--) {
    budget += estTokens(s.history[i].content);
    keep++;
    if (budget >= TAIL_BUDGET_TOKENS && keep >= MIN_RECENT_TURNS * 2) break;
    if (keep >= s.history.length) break;
  }
  const kept = s.history.slice(s.history.length - keep);
  const dropped = s.history.length - kept.length;
  if (dropped > 0) {
    s.history = [
      { role: "user" as const, content: COMPACTED_MARKER }, // 折叠标记（保前缀锚点语义）
      ...kept,
    ];
    s.droppedTurns += Math.round(dropped / 2);
    kvSet(keyOf(id), s);
  }
  return s;
}

/**
 * 会话追加一轮查询（append-only，前缀稳定）：
 * messages = [system, ...history, user]；成功才 append，失败不动历史。
 * askOpts.signal 透传给 LLM（任务取消中断）。
 */
export async function chatSessionAsk(
  sessionId: string,
  userMessage: string,
  askOpts: { signal?: AbortSignal } = {},
): Promise<LlmChatResult> {
  // 归档会话自动恢复（摘要注入上下文后继续，重新进入活跃期）；restore 内部已 loadSession
  const s = restoreArchivedSession(sessionId);
  if (!s) {
    return { ok: false, message: "会话不存在或已过期（归档期 360 天）" };
  }
  const messages: LlmChatMessage[] = [
    { role: "system", content: s.system },
    ...s.history,
    { role: "user", content: userMessage },
  ];
  const opts: ChatOptions = {
    module: s.module,
    mode: "chat-session",
    ...(s.model ? { model: s.model } : {}),
    ...(s.search ? { search: true } : {}),
    ...(s.json ? { json: true } : {}),
    ...(s.temperature !== undefined ? { temperature: s.temperature } : {}),
    ...(askOpts.signal ? { signal: askOpts.signal } : {}),
  };
  const result = await chatImpl(messages, opts);
  if (result.ok) {
    s.history.push({ role: "user", content: userMessage }, { role: "assistant", content: result.content });
    s.lastAt = Date.now();
    kvSet(keyOf(s.id), s);
    // 历史超预算 → 压缩（保留 verbatim tail）
    compactSession(s.id, s);
  }
  return result;
}

/** 会话列表（含状态：active/archived；过期清理） */
export function listChatSessions(): { id: string; module: string; turns: number; droppedTurns: number; status: "active" | "archived"; createdAt: number; lastAt: number }[] {
  const rows = kvListAll(SESSION_PREFIX);
  const out: { id: string; module: string; turns: number; droppedTurns: number; status: "active" | "archived"; createdAt: number; lastAt: number }[] = [];
  for (const r of rows) {
    const s = r.value as ChatSession;
    if (!s || typeof s.system !== "string") continue;
    const age = Date.now() - s.lastAt;
    if (age > ARCHIVE_TTL_MS) {
      kvDelete(r.key); // 超归档期：清理
      continue;
    }
    if (age > ACTIVE_TTL_MS && !s.archived) {
      archiveSessionInternal(s); // 进入归档期：折叠历史为摘要
    }
    out.push({
      id: s.id,
      module: s.module,
      turns: Math.round(s.history.length / 2),
      droppedTurns: s.droppedTurns,
      status: s.archived ? "archived" : "active",
      createdAt: s.createdAt,
      lastAt: s.lastAt,
    });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

/** 删除会话 */
export function deleteChatSession(id: string): boolean {
  if (!kvGet<ChatSession>(keyOf(id))) return false;
  kvDelete(keyOf(id));
  return true;
}

// 复用 kvListRaw（前缀列举）
function kvListAll(prefix: string): { key: string; value: unknown }[] {
  return kvListRaw(prefix, 500).map((r) => {
    let v: unknown = undefined;
    try {
      v = r.value ? JSON.parse(r.value) : undefined;
    } catch {
      v = undefined; // 损坏数据视为空
    }
    return { key: r.key, value: v };
  });
}
