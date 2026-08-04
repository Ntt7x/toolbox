// ============================================================
// 业务模块：本地数据管理（设置页，非工具）
// 查询全部本地表/KV 数据（含页面 tag），支持详情查看与删改。
// 依赖下层公共模块：core/dataRegistry / kvStore / tableStore
// ============================================================

import type { Context } from "hono";
import { Hono } from "hono";
import { API_PREFIX, type LocalDataResult } from "@toolbox/shared";
import { listDataSources } from "../../core/dataRegistry.js";
import { kvCount, kvDelete, kvGet, kvHas, kvListRaw, kvSet } from "../../core/kvStore.js";
import { deleteRows, queryRows } from "../../core/tableStore.js";

/** 统一业务错误响应（与全项目 {ok:false,message} 风格一致） */
function err(c: Context, msg: string, status: 400 | 404 = 400) {
  const body: LocalDataResult = { ok: false, message: msg };
  return c.json(body, status);
}

/** 表首列名（用于把行转成 key） */
function firstColOf(rows: Record<string, unknown>[]): string | undefined {
  return Object.keys(rows[0] ?? {})[0];
}

/** 按表列出条目（首列作为 key，带完整行供详情） */
function tableEntries(table: string): { key: string; updatedAt?: string; preview: string; row: Record<string, unknown> }[] {
  const rows = queryRows(table);
  return rows.map((r, i) => {
    const firstCol = firstColOf([r]);
    const preview = JSON.stringify(r);
    return {
      key: firstCol ? String(r[firstCol]) : `row-${i}`,
      updatedAt: undefined,
      preview: preview.length > 200 ? `${preview.slice(0, 200)}…` : preview,
      row: r,
    };
  });
}

export function register(app: Hono): void {
  // 数据源汇总（注册源 + 未标记自动发现）
  app.get(`${API_PREFIX}/data/local/sources`, (c) => {
    return c.json({ ok: true, sources: listDataSources() });
  });

  // 数据源条目列表：?source=<前缀> 或 ?table=<表名>
  app.get(`${API_PREFIX}/data/local/entries`, (c) => {
    const source = c.req.query("source");
    const table = c.req.query("table");
    if (!source && !table) return err(c, "缺少 source 或 table 参数");
    if (source !== undefined) {
      const rows = kvListRaw(source, 500);
      const entries = rows.map((r) => {
        let preview = r.value;
        if (preview.length > 200) preview = `${preview.slice(0, 200)}…`;
        return { key: r.key, updatedAt: r.updated_at, preview };
      });
      // total 用全量计数（与 sources 页 count 口径一致），而非截断后条目数
      return c.json({ ok: true, source: { kind: "kv", name: source }, entries, total: kvCount(source) });
    }
    try {
      const entries = tableEntries(table!);
      return c.json({ ok: true, source: { kind: "table", name: table! }, entries, total: entries.length });
    } catch {
      return err(c, `表不存在: ${table}`, 404);
    }
  });

  // 条目详情：KV ?source=<前缀>&key=<key>；表 ?table=<表名>&key=<首列值>
  app.get(`${API_PREFIX}/data/local/entry`, (c) => {
    const source = c.req.query("source");
    const table = c.req.query("table");
    const key = c.req.query("key") ?? "";
    if (!key) return err(c, "缺少 key 参数");
    if (source !== undefined) {
      const value = kvGet(key);
      if (value === null && !kvHas(key)) return err(c, "条目不存在", 404);
      return c.json({ ok: true, source: { kind: "kv", name: source }, key, value });
    }
    try {
      const rows = queryRows(table!);
      const firstCol = firstColOf(rows);
      if (!firstCol) return err(c, "空表", 404);
      const row = rows.find((r) => String(r[firstCol]) === key);
      if (!row) return err(c, "行不存在", 404);
      return c.json({ ok: true, source: { kind: "table", name: table! }, key, value: row });
    } catch {
      return err(c, `表不存在: ${table}`, 404);
    }
  });

  // 删除：KV ?source=<前缀>&key=<key>；表 ?table=<表名>&key=<首列值>
  app.delete(`${API_PREFIX}/data/local/entry`, (c) => {
    const source = c.req.query("source");
    const table = c.req.query("table");
    const key = c.req.query("key") ?? "";
    if (!key) return err(c, "缺少 key 参数");
    if (source !== undefined) {
      kvDelete(key);
      return c.json({ ok: true, deleted: 1 });
    }
    try {
      const rows = queryRows(table!);
      const firstCol = firstColOf(rows);
      if (!firstCol) return err(c, "空表", 404);
      const n = deleteRows(table!, { [firstCol]: key });
      return c.json({ ok: true, deleted: n });
    } catch {
      return err(c, `表不存在: ${table}`, 404);
    }
  });

  // 编辑：KV 更新值（body: { source, key, value }）
  app.put(`${API_PREFIX}/data/local/entry`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { source?: string; key?: string; value?: unknown } | null;
    if (!raw || !raw.source || !raw.key) return err(c, "缺少 source/key");
    if (!raw.key.startsWith(raw.source)) {
      return err(c, `key「${raw.key}」不属于数据源「${raw.source}」`, 400);
    }
    kvSet(raw.key, raw.value);
    return c.json({ ok: true });
  });
}
