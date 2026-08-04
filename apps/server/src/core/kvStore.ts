// ============================================================
// 下层公共模块：Key-结构化 Value 数据模型（类似 MongoDB）
// 基于 SQLite 单表（key → JSON value），value 可为任意可 JSON 序列化结构，
// 支持前缀列举。适合文档式存储、缓存、配置等场景。
// 用法：
//   kvSet("cbRate:v2:month::", { summary: "…" })
//   const v = kvGet<{summary:string}>("cbRate:v2:month::")
//   kvListRaw("cbRate:")         // 前缀列举（数据管理用）
//   kvDelete("cbRate:v2:month::")
// ============================================================

import { getDb, initSchema } from "./db.js";

interface KvRow {
  key: string;
  value: string;
  updated_at: string;
}

/** 写入/覆盖一个 key（value 任意可 JSON 序列化结构） */
export function kvSet(key: string, value: unknown): void {
  initSchema();
  const d = getDb();
  d.prepare(
    `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value ?? null), new Date().toISOString());
}

/** 读取一个 key；不存在返回 null */
export function kvGet<T = unknown>(key: string): T | null {
  initSchema();
  const row = getDb().prepare("SELECT value FROM kv_store WHERE key = ?").get(key) as Pick<KvRow, "value"> | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

/** 判断 key 是否存在（不解析 value） */
export function kvHas(key: string): boolean {
  initSchema();
  const row = getDb().prepare("SELECT 1 AS n FROM kv_store WHERE key = ?").get(key) as { n: number } | undefined;
  return row !== undefined;
}

/** 删除一个 key */
export function kvDelete(key: string): void {
  initSchema();
  getDb().prepare("DELETE FROM kv_store WHERE key = ?").run(key);
}

/** 按前缀列举（可选 limit）；返回 key 与解析后的 value */
/** 按前缀统计条目数（无前缀则统计全部） */
export function kvCount(prefix = ""): number {
  initSchema();
  const r = getDb()
    .prepare("SELECT COUNT(*) AS n FROM kv_store WHERE key LIKE ?")
    .get(`${prefix}%`) as { n: number | bigint };
  return Number(r.n);
}

/** 列出全部 key（带 updated_at 与原始 value 文本，供数据管理） */
export function kvListRaw(prefix = "", limit = 200): { key: string; value: string; updated_at: string }[] {
  initSchema();
  return getDb()
    .prepare("SELECT key, value, updated_at FROM kv_store WHERE key LIKE ? ORDER BY key LIMIT ?")
    .all(`${prefix}%`, limit) as { key: string; value: string; updated_at: string }[];
}
