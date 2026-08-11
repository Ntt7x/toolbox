// ============================================================
// 业务模块：待办清单（features/todo）
// 用户日常个人 todo（区别于开发者驱动的改进备忘录）。
// 单 KV 文档持久化，遵循本地数据治理原则。
// ============================================================
import { Hono } from "hono";
import type { Context } from "hono";
import { API_PREFIX, type ToolMeta, type TodoUpdateRequest } from "@toolbox/shared";
import { registerDataSource } from "../../core/dataRegistry.js";
import { TODO_KEY, addTodo, clearDone, deleteTodo, listTodos, updateTodo } from "./store.js";

export const meta: ToolMeta = {
  id: "todo",
  name: "待办清单",
  description: "用户日常个人待办清单（新增/勾选/删除，区别于改进备忘录）",
  path: "/tools/todo",
};

export function registerTodoFeature(app: Hono) {
  registerDataSource({
    kind: "kv",
    name: TODO_KEY,
    page: meta.name,
    tag: "日常数据",
    description: "待办清单条目（用户日常 todo）",
  });

  // 列表
  app.get(`${API_PREFIX}/tools/todo`, (c: Context) => c.json({ ok: true, items: listTodos() }));

  // 新增
  app.post(`${API_PREFIX}/tools/todo`, async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ ok: false, message: "请输入待办内容" }, 400);
    return c.json({ ok: true, items: addTodo(text) });
  });

  // 更新（切换完成 / 改文本）
  app.put(`${API_PREFIX}/tools/todo/:id`, async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as TodoUpdateRequest | null;
    const patch: { done?: boolean; text?: string } = {};
    if (body && typeof body.done === "boolean") patch.done = body.done;
    if (body && typeof body.text === "string" && body.text.trim()) patch.text = body.text.trim();
    if (!("done" in patch) && !("text" in patch)) return c.json({ ok: false, message: "无有效更新字段" }, 400);
    const items = updateTodo(c.req.param("id")!, patch);
    if (!items) return c.json({ ok: false, message: "待办不存在" }, 404);
    return c.json({ ok: true, items });
  });

  // 删除
  app.delete(`${API_PREFIX}/tools/todo/:id`, (c: Context) => {
    const items = deleteTodo(c.req.param("id")!);
    if (!items) return c.json({ ok: false, message: "待办不存在" }, 404);
    return c.json({ ok: true, items });
  });

  // 清空已完成
  app.post(`${API_PREFIX}/tools/todo/clear-done`, (c: Context) => c.json({ ok: true, items: clearDone() }));
}
