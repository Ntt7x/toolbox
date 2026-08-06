// ============================================================
// 业务模块：改进备忘录（features/memo）
// 设置分组子页面：TODO list（用户记录问题 → Agent 驱动修复）
// 单 KV 文档 memo:items，数据源注册「改进备忘录」tag。
// ============================================================

import { Hono } from "hono";
import { API_PREFIX, type MemoUpdateRequest } from "@toolbox/shared";
import { registerDataSource } from "../../core/dataRegistry.js";
import { createItem, deleteItem, isMemoKind, isMemoStatus, listItems, MEMO_KEY, updateItem } from "./store.js";

registerDataSource({
  kind: "kv",
  name: MEMO_KEY,
  page: "改进备忘录",
  tag: "改进备忘录",
  description: "改进备忘录 TODO（open/doing/done，用户记录问题 → Agent 驱动修复）",
});

export function register(app: Hono): void {
  // 全部条目（已排序：open → doing → done）
  app.get(`${API_PREFIX}/tools/memo`, (c) => {
    return c.json({ ok: true, items: listItems() });
  });

  // 新增条目（kind：fix 修复型默认 / feature 需求型）
  app.post(`${API_PREFIX}/tools/memo`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { text?: unknown; kind?: unknown } | null;
    const text = typeof raw?.text === "string" ? raw.text.trim() : "";
    if (!text) return c.json({ ok: false, message: "缺少记录内容" }, 400);
    const kind = raw?.kind && isMemoKind(raw.kind) ? raw.kind : "fix";
    const item = createItem(text, kind);
    return c.json({ ok: true, item }, 201);
  });

  // 更新条目（文本/状态/类型）
  app.put(`${API_PREFIX}/tools/memo/:id`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as MemoUpdateRequest | null;
    const patch: MemoUpdateRequest = {};
    if (typeof raw?.text === "string" && raw.text.trim()) patch.text = raw.text.trim();
    if (raw?.status && isMemoStatus(raw.status)) patch.status = raw.status;
    if (raw?.kind && isMemoKind(raw.kind)) patch.kind = raw.kind;
    if (Object.keys(patch).length === 0) return c.json({ ok: false, message: "没有可更新的字段" }, 400);
    const item = updateItem(c.req.param("id"), patch);
    if (!item) return c.json({ ok: false, message: "条目不存在" }, 404);
    return c.json({ ok: true, item });
  });

  // 删除条目
  app.delete(`${API_PREFIX}/tools/memo/:id`, (c) => {
    const ok = deleteItem(c.req.param("id"));
    if (!ok) return c.json({ ok: false, message: "条目不存在" }, 404);
    return c.json({ ok: true, deleted: 1 });
  });
}
