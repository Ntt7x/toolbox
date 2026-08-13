// ============================================================
// 下层公共模块：数据源注册表（本地数据管理用）
// 业务模块注册自己的持久化数据（KV 前缀 / 表名）并打上
// 「页面 tag」标签，标记来源与使用场景；未注册数据自动归入
// 「未标记」分组，保证「查询全部本地数据」的能力。
// ============================================================

import type { LocalDataSource } from "@toolbox/shared";
import { kvCount, kvListRaw } from "./kvStore.js";
import { countRows, listTables } from "./tableStore.js";

interface DataSourceMeta {
  kind: "kv" | "table";
  name: string;
  page: string;
  tag: string;
  description: string;
}

export type { DataSourceMeta };

const registered: DataSourceMeta[] = [];

/** 注册一个数据源（kv: name 为 key 前缀；table: name 为表名） */
export function registerDataSource(meta: DataSourceMeta): void {
  registered.push(meta);
}

/** 查询数据源实时列表：注册源 + 自动发现的未标记项 */
export function listDataSources(): LocalDataSource[] {
  const out: LocalDataSource[] = [];

  // KV：注册前缀源（去重）
  const kvPrefixes = new Set<string>();
  for (const m of registered.filter((m) => m.kind === "kv")) {
    kvPrefixes.add(m.name);
    out.push({
      kind: "kv",
      name: m.name,
      page: m.page,
      tag: m.tag,
      description: m.description,
      count: kvCount(m.name),
    });
  }
  // 未标记 KV：存在的 key 前缀不在注册表（逐 key 判定，子前缀源不重复计数）
  const registeredKvPrefixes = [...kvPrefixes];
  let unmarkedCount = 0;
  if (registeredKvPrefixes.length > 0) {
    // 2026-08-14 注：20 万 key 扫描上限对个人工具足够；超限时未标记计数偏低（可后续改 SQL 聚合）
    for (const r of kvListRaw("", 200000)) {
      if (!registeredKvPrefixes.some((p) => r.key.startsWith(p))) unmarkedCount++;
    }
  }
  if (unmarkedCount > 0) {
    out.push({
      kind: "kv",
      name: "(未标记)",
      page: "—",
      tag: "未标记",
      description: "key 前缀未被任何模块注册的 KV 数据",
      count: unmarkedCount,
    });
  }

  // 表：注册表源 + 自动发现业务表
  const tables = listTables();
  const tableMeta = new Map(registered.filter((m) => m.kind === "table").map((m) => [m.name, m]));
  for (const t of tables) {
    const m = tableMeta.get(t);
    if (m) {
      out.push({ kind: "table", name: t, page: m.page, tag: m.tag, description: m.description, count: countRows(t) });
    } else {
      out.push({ kind: "table", name: t, page: "—", tag: "未标记", description: "未被模块注册的表", count: countRows(t) });
    }
  }

  return out;
}

/** 未标记 KV 的全部条目（未注册前缀的 key+原始值，供「未标记」源查询；不解析 JSON 保持与 kvListRaw 一致） */
export function unmarkedKvEntries(): { key: string; value: string }[] {
  const registeredKvPrefixes = registered.filter((m) => m.kind === "kv").map((m) => m.name);
  if (registeredKvPrefixes.length === 0) return [];
  return kvListRaw("", 200000).filter((r) => !registeredKvPrefixes.some((p) => r.key.startsWith(p)));
}
