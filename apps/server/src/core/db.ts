// ============================================================
// 下层公共模块：SQLite 持久化连接层
// - 底层使用 Node 内置 node:sqlite（DatabaseSync），零依赖、无需编译
// - 数据文件存放于项目根 .file/toolbox.db（已 .gitignore 隔离）
// - 统一提供 db 实例与 initSchema；tableStore / kvStore 基于此实现
// ============================================================

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

/** 数据目录：项目根 /.file（相对本模块位置解析，与 cwd 无关） */
export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".file");
export const DB_PATH = join(DATA_DIR, "toolbox.db");

let db: DatabaseSync | null = null;

/** 获取（并惰性初始化）数据库实例 */
export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // 并发写等待（并行跑多测试文件共享同一 DB 时避免 "database is locked"）
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** 初始化内置表（kvStore 使用；tableStore 表由调用方自行创建） */
export function initSchema(): void {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}
