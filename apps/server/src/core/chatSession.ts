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

/** KV key 前缀 */
export const SESSION_PREFIX = "chatSession:";

/** 默认会话 TTL：30 分钟（DeepSeek 缓存 TTL 数小时，会话不宜跨天） */
const DEFAULT_TTL_MS = 30 * 60 * 1000;
/** 历史压缩阈值：保留最近轮数（system 恒定，永不删除） */
const KEEP_RECENT_TURNS = 6;

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
  /** 已交换的 user/assistant 消息（append-only） */
  history: LlmChatMessage[];
  /** 压缩时丢弃的轮次计数（统计用） */
  droppedTurns: number;
  createdAt: number;
  lastAt: number;
  ttlMs: number;
}

export interface CreateSessionOptions {
  module: string;
  system: string;
  model?: string;
  search?: boolean;
  json?: boolean;
  ttlMs?: number;
}

function genId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function keyOf(id: string): string {
  return `${SESSION_PREFIX}${id}`;
}

function isExpired(s: ChatSession, now = Date.now()): boolean {
  return now - s.lastAt > s.ttlMs;
}

/** 新建会话（KV 持久化） */
export function createChatSession(opts: CreateSessionOptions): ChatSession {
  const now = Date.now();
  const session: ChatSession = {
    id: genId(),
    module: opts.module,
    system: opts.system,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.search !== undefined ? { search: opts.search } : {}),
    ...(opts.json !== undefined ? { json: opts.json } : {}),
    history: [],
    droppedTurns: 0,
    createdAt: now,
    lastAt: now,
    ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
  };
  kvSet(keyOf(session.id), session);
  return session;
}

function loadSession(id: string): ChatSession | null {
  const s = kvGet<ChatSession>(keyOf(id));
  if (!s || typeof s.system !== "string") return null;
  if (isExpired(s)) {
    kvDelete(keyOf(id)); // TTL 过期自动清理
    return null;
  }
  return s;
}

/** 压缩历史：超长时保留 system + 最近 N 轮，丢弃更早（统计 droppedTurns） */
export function compactSession(id: string): ChatSession | null {
  const s = loadSession(id);
  if (!s) return null;
  const kept = s.history.slice(-KEEP_RECENT_TURNS * 2); // user+assistant 成对
  const dropped = s.history.length - kept.length;
  if (dropped > 0) {
    s.history = kept;
    s.droppedTurns += Math.round(dropped / 2);
  }
  kvSet(keyOf(id), s);
  return s;
}

/**
 * 会话追加一轮查询（append-only，前缀稳定）：
 * messages = [system, ...history, user]；成功才 append，失败不动历史。
 */
export async function chatSessionAsk(sessionId: string, userMessage: string): Promise<LlmChatResult> {
  const s = loadSession(sessionId);
  if (!s) {
    return { ok: false, message: "会话不存在或已过期（TTL 30 分钟）" };
  }
  const messages: LlmChatMessage[] = [
    { role: "system", content: s.system },
    ...s.history,
    { role: "user", content: userMessage },
  ];
  const opts: ChatOptions = {
    module: s.module,
    ...(s.model ? { model: s.model } : {}),
    ...(s.search ? { search: true } : {}),
    ...(s.json ? { json: true } : {}),
  };
  const result = await chat(messages, opts);
  if (result.ok) {
    s.history.push({ role: "user", content: userMessage }, { role: "assistant", content: result.content });
    s.lastAt = Date.now();
    kvSet(keyOf(s.id), s);
  }
  return result;
}

/** 会话列表（未过期） */
export function listChatSessions(): { id: string; module: string; turns: number; droppedTurns: number; createdAt: number; lastAt: number }[] {
  const rows = kvListAll(SESSION_PREFIX);
  const out: { id: string; module: string; turns: number; droppedTurns: number; createdAt: number; lastAt: number }[] = [];
  for (const r of rows) {
    const s = r.value as ChatSession;
    if (!s || typeof s.system !== "string") continue;
    if (isExpired(s)) {
      kvDelete(r.key);
      continue;
    }
    out.push({
      id: s.id,
      module: s.module,
      turns: Math.round(s.history.length / 2),
      droppedTurns: s.droppedTurns,
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
  return kvListRaw(prefix, 500).map((r) => ({ key: r.key, value: r.value ? JSON.parse(r.value) : undefined }));
}
