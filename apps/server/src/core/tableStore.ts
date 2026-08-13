// ============================================================
// 下层公共模块：表数据模型（类似传统 SQL）
// 基于 SQLite 提供通用表的建表与增删改查，字段为平面键值。
// 用法：
//   queryRows("users", { age: 30 })            // 等值条件
//   deleteRows("users", { id: "u1" })
// 注意：值类型仅支持 SQLite 标量（TEXT/INTEGER/REAL/NULL）；复杂结构请用 kvStore。
// 建表/删表/插入/更新暂无调用方（当前业务以 kvStore 为主），需要时按 createTable 模式补齐。
// ============================================================

import { getDb } from "./db.js";
import type { SQLInputValue } from "node:sqlite";

/** 列出全部业务表（排除 SQLite 内部表与 kv_store 内部存储表） */
export function listTables(): string[] {
  const rows = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'kv_store' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

/** 按等值条件查询；where 省略则查全部 */
export function queryRows(table: string, where: Record<string, unknown> = {}): Record<string, unknown>[] {
  const { sql, values } = buildWhere(where);
  const stmt = getDb().prepare(`SELECT * FROM ${quote(table)}${sql}`);
  return stmt.all(...values) as Record<string, unknown>[];
}

/** 删除满足条件的行；返回受影响行数 */
export function deleteRows(table: string, where: Record<string, unknown> = {}): number {
  // 2026-08-14：空 where 拒绝执行（DELETE 全表是危险操作，须显式条件）
  if (Object.keys(where).length === 0) throw new Error("deleteRows 必须带 where 条件（防误清空整表）");
  const { sql, values } = buildWhere(where);
  const stmt = getDb().prepare(`DELETE FROM ${quote(table)}${sql}`);
  return Number(stmt.run(...values).changes);
}

/** 计数 */
export function countRows(table: string, where: Record<string, unknown> = {}): number {
  const { sql, values } = buildWhere(where);
  const stmt = getDb().prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}${sql}`);
  const r = stmt.get(...values) as { n: number | bigint };
  return Number(r.n);
}

// ---------- 内部工具 ----------

function quote(ident: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    throw new Error(`非法标识符: ${ident}`);
  }
  return `"${ident}"`;
}

/** 通用值 → SQLite 标量（boolean→0/1，其它非标量抛错提示用 kvStore） */
function toSqlValue(v: unknown): SQLInputValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new Error("tableStore 仅支持标量值；复杂结构请使用 kvStore（Key-结构化 Value）");
}

function buildWhere(where: Record<string, unknown>): { sql: string; values: SQLInputValue[] } {
  const keys = Object.keys(where);
  if (keys.length === 0) return { sql: "", values: [] };
  const clauses = keys.map((k) => `${quote(k)} = ?`);
  return { sql: ` WHERE ${clauses.join(" AND ")}`, values: keys.map((k) => toSqlValue(where[k])) };
}
