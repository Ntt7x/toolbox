// ============================================================
// 业务模块：本地数据管理（设置页，非工具）
// 查询全部本地表/KV 数据（含页面 tag），支持详情查看与删改。
// 依赖下层公共模块：core/dataRegistry / kvStore / tableStore
// ============================================================

import type { Context } from "hono";
import { Hono } from "hono";
import { API_PREFIX, type LocalDataResult } from "@toolbox/shared";
import { listDataSources, unmarkedKvEntries } from "../../core/dataRegistry.js";
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
function tableEntries(table: string): { key: string; updatedAt?: string; preview: string; size: number; row: Record<string, unknown> }[] {
  const rows = queryRows(table);
  return rows.map((r, i) => {
    const firstCol = firstColOf([r]);
    const preview = JSON.stringify(r);
    return {
      key: firstCol ? String(r[firstCol]) : `row-${i}`,
      updatedAt: undefined,
      preview: preview.length > 200 ? `${preview.slice(0, 200)}…` : preview,
      size: Buffer.byteLength(preview, "utf8"),
      row: r,
    };
  });
}

export function register(app: Hono): void {
  // 数据源汇总（注册源 + 未标记自动发现；KV 源附总字节数）
  app.get(`${API_PREFIX}/data/local/sources`, (c) => {
    const sources = listDataSources();
    const withSize = sources.map((s) => {
      if (s.kind === "table") return { ...s, sizeBytes: 0 };
      try {
        const rows = kvListRaw(s.name, 5000);
        let bytes = 0;
        for (const r of rows) bytes += Buffer.byteLength(r.value, "utf8");
        return { ...s, sizeBytes: bytes };
      } catch {
        return { ...s, sizeBytes: 0 };
      }
    });
    return c.json({ ok: true, sources: withSize });
  });

  // 数据源条目列表：?source=<前缀> 或 ?table=<表名>；支持 ?search=<包含匹配>、?limit=&offset= 分页
  app.get(`${API_PREFIX}/data/local/entries`, (c) => {
    const source = c.req.query("source");
    const table = c.req.query("table");
    if (!source && !table) return err(c, "缺少 source 或 table 参数");
    const search = (c.req.query("search") ?? "").trim().toLowerCase();
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 200) || 200, 1), 500);
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
    if (source !== undefined) {
      // 「未标记」源：聚合所有未注册前缀的 key（不能按前缀 kvListRaw）
      const rows = source === "未标记" || source === "(未标记)" ? unmarkedKvEntries() : kvListRaw(source, 2000);
      let filtered = rows;
      if (search) {
        filtered = rows.filter((r) => r.key.toLowerCase().includes(search) || r.value.toLowerCase().includes(search));
      }
      const total = filtered.length;
      const page = filtered.slice(offset, offset + limit);
      const entries = page.map((r) => {
        let preview = r.value;
        if (preview.length > 200) preview = `${preview.slice(0, 200)}…`;
        return { key: r.key, updatedAt: (r as { updated_at?: string }).updated_at, preview, size: Buffer.byteLength(r.value, "utf8") };
      });
      return c.json({ ok: true, source: { kind: "kv", name: source }, entries, total, offset, limit });
    }
    try {
      const entries = tableEntries(table!);
      const filtered = search ? entries.filter((e) => e.key.toLowerCase().includes(search) || e.preview.toLowerCase().includes(search)) : entries;
      return c.json({
        ok: true,
        source: { kind: "table", name: table! },
        entries: filtered.slice(offset, offset + limit),
        total: filtered.length,
        offset,
        limit,
      });
    } catch {
      return err(c, `表不存在: ${table}`, 404);
    }
  });

  // 批量清空数据源（缓存/分析类）：DELETE ?source=<前缀>（key 归属校验）
  app.delete(`${API_PREFIX}/data/local/entries`, (c) => {
    const source = c.req.query("source")?.trim() ?? "";
    if (!source) return err(c, "缺少 source 参数");
    const rows = kvListRaw(source, 5000);
    let deleted = 0;
    for (const r of rows) {
      if (r.key.startsWith(source)) {
        kvDelete(r.key);
        deleted++;
      }
    }
    return c.json({ ok: true, deleted });
  });

  // 条目详情：KV ?source=<前缀>&key=<key>；表 ?table=<表名>&key=<首列值>
  app.get(`${API_PREFIX}/data/local/entry`, (c) => {
    const source = c.req.query("source");
    const table = c.req.query("table");
    const key = c.req.query("key") ?? "";
    if (!key) return err(c, "缺少 key 参数");
    if (source !== undefined) {
      // 归属校验（2026-08 修复：与 PUT 分支一致，防跨源读）
      if (!key.startsWith(source)) return err(c, `key「${key}」不属于数据源「${source}」`);
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
      // 归属校验（2026-08 修复：与 PUT 分支一致，防跨源删）
      if (!key.startsWith(source)) return err(c, `key「${key}」不属于数据源「${source}」`);
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
