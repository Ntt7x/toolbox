// ============================================================
// 下层公共模块：SQLite 持久化连接层
// - 底层使用 Node 内置 node:sqlite（DatabaseSync），零依赖、无需编译
// - 数据文件存放于数据目录 toolbox.db（已 .gitignore 隔离）
// - 统一提供 db 实例与 initSchema；tableStore / kvStore 基于此实现
// 环境隔离（2026-09-02）：prod（main 分支）用项目根 .file/（真实数据，路径不变）；
//   dev（开发分支）由 dev.mjs 注入 TOOLBOX_DATA_DIR=.file/envs/<id>/data，各分支互不干扰。
//   —— dev 分支可随意改表/写测试数据，绝不污染 prod。
// 配置化（2026-09-04）：数据目录与库文件名不再由本模块推断，统一取自配置内核
//   （toolbox.config.json 的 server.dataDir / server.dbFile，环境变量可覆盖）→ core/config.ts。
// ============================================================

import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

/**
 * 数据目录（配置化，2026-09-04）：来自 `server.dataDir`
 * （toolbox.config.json → toolbox.config.local.json → TOOLBOX_DATA_DIR）。
 * 绝对路径直接胜出——dev 环境注入绝对路径隔离数据就靠这条。
 * 导出名不变，所有消费方（docs / 浏览器 profile / 日志…）无需改动。
 */
export const DATA_DIR = config.paths.dataDir;
/**
 * SQLite 库文件绝对路径（配置化）：`server.dbFile`，相对 dataDir 解析（绝对路径直接指向别处）。
 * 换库/分库部署只改配置，不动代码。
 */
export const DB_PATH = config.paths.dbPath;

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
