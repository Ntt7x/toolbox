// ============================================================
// 下层公共模块：轻量消息队列（数据工程-消息层）
// 生命周期：enqueue（产生）→ dequeue（传递）→ ack（消费确认）→ TTL（过期清理）
// 语义：至少一次投递 + 幂等消费（消费方重放安全——本模块不保证 exactly-once）
// 存储：KV（node:sqlite），前缀 dataInfra:q:<name> → { items: QueueMessage[] }
// ============================================================
import { randomUUID } from "node:crypto";
import { kvDelete, kvGet, kvListRaw, kvSet } from "../kvStore.js";

export type QueueStatus = "pending" | "processing" | "done" | "failed";

export interface QueueMessage<T = unknown> {
  id: string;
  payload: T;
  enqueuedAt: number;
  status: QueueStatus;
  attempts: number;
  /** 过期时间（毫秒时间戳）；0/缺省 = 不过期 */
  ttlMs?: number;
  /** 开始处理时间（dequeue 时设置；供崩溃恢复判断处理超时） */
  processedAt?: number;
}

const PREFIX = "dataInfra:q:";
const AUDIT_PREFIX = "dataInfra:qAudit:";
const MAX_ATTEMPTS = 5;
const AUDIT_LIMIT = 200;

function key(name: string): string {
  return PREFIX + name;
}

function read<T>(name: string): QueueMessage<T>[] {
  return (kvGet<{ items: QueueMessage<T>[] }>(key(name))?.items ?? []) as QueueMessage<T>[];
}

function write<T>(name: string, items: QueueMessage<T>[]): void {
  kvSet(key(name), { items });
}

/** 入队（产生消息）。返回消息 id */
export function enqueue<T>(name: string, payload: T, opts?: { ttlMs?: number }): string {
  const msg: QueueMessage<T> = {
    id: randomUUID().slice(0, 12),
    payload,
    enqueuedAt: Date.now(),
    status: "pending",
    attempts: 0,
    ttlMs: opts?.ttlMs,
  };
  const items = read<T>(name);
  items.push(msg);
  write(name, items);
  return msg.id;
}

function isExpired(msg: QueueMessage<unknown>): boolean {
  return typeof msg.ttlMs === "number" && msg.ttlMs > 0 && Date.now() > msg.enqueuedAt + msg.ttlMs;
}

/** 取一条 pending 消息（过 TTL 丢弃），标记 processing。无则 null */
export function dequeue<T>(name: string): { id: string; payload: T } | null {
  const items = read<T>(name);
  const idx = items.findIndex((m) => m.status === "pending" && !isExpired(m));
  if (idx < 0) return null;
  items[idx].status = "processing";
  items[idx].attempts += 1;
  items[idx].processedAt = Date.now();
  write(name, items);
  return { id: items[idx].id, payload: items[idx].payload };
}

/** 查看队列消息（运管诊断；不改变状态）——返回最近 N 条 */
export function peekQueue<T>(name: string, limit = 20): { id: string; status: QueueStatus; attempts: number; enqueuedAt: number; processedAt?: number; payload: T }[] {
  return read<T>(name)
    .slice(-limit)
    .map((m) => ({ id: m.id, status: m.status, attempts: m.attempts, enqueuedAt: m.enqueuedAt, ...(m.processedAt ? { processedAt: m.processedAt } : {}), payload: m.payload }));
}

/** 恢复"处理超时"的 processing 消息为 pending（消费者崩溃/进程重启兜底——至少一次投递语义）。
 *  ageMs：处理超时阈值（默认 5min；正常消费远快于此） */
export function requeueStale(name: string, ageMs = 5 * 60 * 1000): number {
  const items = read<unknown>(name);
  const now = Date.now();
  let n = 0;
  for (const m of items) {
    // ageMs<=0 = 恢复全部 processing（测试/强制恢复）；无 processedAt = 旧版本消息（崩溃残留）也恢复；
    // 否则按处理时长超阈值
    if (m.status === "processing" && (ageMs <= 0 || !m.processedAt || now - m.processedAt > ageMs)) {
      m.status = "pending";
      n += 1;
    }
  }
  if (n > 0) write(name, items);
  return n;
}

/** 消费确认：ok=true 移除（完成）；ok=false 重投（failed→pending，超最大尝试丢弃）。
 *  每次 ack 记录消费审计（事件日志理念——消息处理可追溯，见 data-infra.md DDIA 对照） */
export function ack(name: string, id: string, ok: boolean): void {
  const items = read<unknown>(name);
  const idx = items.findIndex((m) => m.id === id);
  if (idx < 0) return;
  const m = items[idx];
  pushAudit(name, {
    id: m.id,
    status: ok ? "done" : "failed",
    at: Date.now(),
    attempts: m.attempts,
    ...(typeof (m.payload as { type?: unknown } | null)?.type === "string" ? { type: (m.payload as { type?: string }).type } : {}),
  });
  if (ok) {
    items.splice(idx, 1);
  } else {
    items[idx].status = items[idx].attempts >= MAX_ATTEMPTS ? "failed" : "pending";
  }
  write(name, items);
}

export interface QueueAuditEntry {
  id: string;
  status: "done" | "failed";
  at: number;
  attempts: number;
  type?: string;
}

function pushAudit(name: string, entry: QueueAuditEntry): void {
  const key = AUDIT_PREFIX + name;
  const cur = kvGet<{ entries: QueueAuditEntry[] }>(key)?.entries ?? [];
  cur.push(entry);
  if (cur.length > AUDIT_LIMIT) cur.splice(0, cur.length - AUDIT_LIMIT);
  kvSet(key, { entries: cur });
}

/** 队列消费审计（运管）：最近 done/failed 消息记录（默认最近 50 条） */
export function queueAudit(name: string, limit = 50): QueueAuditEntry[] {
  const entries = kvGet<{ entries: QueueAuditEntry[] }>(AUDIT_PREFIX + name)?.entries ?? [];
  return entries.slice(-limit);
}

/** 清空队列审计（运管/测试） */
export function clearQueueAudit(name: string): void {
  kvDelete(AUDIT_PREFIX + name);
}

/** 队列统计（运管：消息积压/处理中/完成/失败） */
export function queueStats(name: string): { name: string; pending: number; processing: number; done: number; failed: number; total: number } {
  const items = read<unknown>(name);
  const stats = { name, pending: 0, processing: 0, done: 0, failed: 0, total: items.length };
  for (const m of items) stats[m.status] += 1;
  return stats;
}

/** 全部队列名（运管） */
export function listQueues(): string[] {
  return kvListRaw(PREFIX).map((r) => r.key.slice(PREFIX.length));
}

/** 清空队列（运管/测试）：删除队列 key（列表不再显示空队列） */
export function clearQueue(name: string): void {
  kvDelete(key(name));
}
