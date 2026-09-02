// ============================================================
// 下层公共模块：SQLite 持久化连接层
// - 底层使用 Node 内置 node:sqlite（DatabaseSync），零依赖、无需编译
// - 数据文件存放于数据目录 toolbox.db（已 .gitignore 隔离）
// - 统一提供 db 实例与 initSchema；tableStore / kvStore 基于此实现
// 环境隔离（2026-09-02）：prod（main 分支）用项目根 .file/（真实数据，路径不变）；
//   dev（开发分支）由 dev.mjs 注入 TOOLBOX_DATA_DIR=.file/envs/<id>/data，各分支互不干扰。
//   —— dev 分支可随意改表/写测试数据，绝不污染 prod。
// ============================================================

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

/** 默认数据目录（prod）：项目根 /.file（相对本模块位置解析，与 cwd 无关） */
const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".file");
/** 项目根（默认数据目录的上一级） */
const PROJECT_ROOT = join(DEFAULT_DATA_DIR, "..");
/**
 * 数据目录：TOOLBOX_DATA_DIR 覆盖（dev 环境隔离）。
 * 用 resolve 而非 join——join 遇到绝对路径会拼接成 `D:\proj\D:\env\data`，
 * 而 resolve 让绝对路径直接胜出（2026-09-02 修复，正是 dev 环境注入的绝对路径场景）。
 */
const rawDataDir = process.env.TOOLBOX_DATA_DIR?.trim();
export const DATA_DIR = rawDataDir ? resolve(PROJECT_ROOT, rawDataDir) : DEFAULT_DATA_DIR;
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
