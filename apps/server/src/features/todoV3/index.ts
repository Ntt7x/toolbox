// ============================================================
// 业务模块：待办清单 v3（features/todoV3）
// 基于 @deepseek-ai/cordis 框架：服务 = 插件提供、ctx 消费的具名能力。
// Hono 路由只是薄壳：业务全部走 ctx 上的 Cordis 服务（store/scheduler/resolver）。
// 注意：ctx 初始化是异步的（fiber ACTIVE 后服务才可用），每个 handler await getTodoV3Ctx()
// ============================================================
import { Hono } from "hono";
import type { Context as HonoContext } from "hono";
import { API_PREFIX, type ToolMeta, type TodoV3UpdateRequest } from "@toolbox/shared";
import { registerDataSource } from "../../core/dataRegistry.js";
import { getTodoV3Ctx } from "./context.js";
import { TODO_V3_KEY, type Repeat } from "./services.js";

export const meta: ToolMeta = {
  id: "todo-v3",
  name: "待办事项 v3",
  description: "待办清单 v3：Cordis 框架驱动（Service 服务化 + DAG 依赖 + 周期调度）",
  path: "/tools/todo-v3",
};

export function registerTodoV3Feature(app: Hono) {
  registerDataSource({
    kind: "kv",
    name: TODO_V3_KEY,
    page: meta.name,
    tag: "日常数据",
    description: "待办清单 v3 条目（Cordis 框架，多依赖 DAG + 周期任务）",
  });

  // 列表（Cordis Resolver 服务计算 blocked）
  app.get(`${API_PREFIX}/tools/todo-v3`, async (c: HonoContext) => {
    const ctx = await getTodoV3Ctx();
    return c.json({ ok: true, items: ctx.todoV3Resolver.listView() });
  });

  // 归档区列表（静态路由必须在 /:id 前注册）
  app.get(`${API_PREFIX}/tools/todo-v3/archive`, async (c: HonoContext) => {
    const ctx = await getTodoV3Ctx();
    return c.json({ ok: true, items: ctx.todoV3Resolver.views(ctx.todoV3Store.listArchived()) });
  });

  // 手动归档（仅已完成）
  app.post(`${API_PREFIX}/tools/todo-v3/:id/archive`, async (c: HonoContext) => {
    const ctx = await getTodoV3Ctx();
    const r = ctx.todoV3Store.archive(c.req.param("id")!);
    if (r === null) return c.json({ ok: false, message: "待办不存在" }, 404);
    if (!r.ok) return c.json({ ok: false, message: r.message }, 400);
    return c.json({ ok: true, items: ctx.todoV3Resolver.views(r.items) });
  });

  // 恢复归档
  app.post(`${API_PREFIX}/tools/todo-v3/:id/restore`, async (c: HonoContext) => {
    const ctx = await getTodoV3Ctx();
    const r = ctx.todoV3Store.restore(c.req.param("id")!);
    if (r === null) return c.json({ ok: false, message: "待办不存在" }, 404);
    return c.json({ ok: true, items: ctx.todoV3Resolver.views(r.items) });
  });

  // 新增
  app.post(`${API_PREFIX}/tools/todo-v3`, async (c: HonoContext) => {
    const body = (await c.req.json().catch(() => null)) as { text?: unknown; dependencies?: unknown; repeat?: unknown; parentId?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ ok: false, message: "请输入待办内容" }, 400);
    const deps = Array.isArray(body?.dependencies) ? body.dependencies.filter((d): d is string => typeof d === "string") : [];
    const repeat = body?.repeat === "daily" || body?.repeat === "weekly" || body?.repeat === "monthly" ? body.repeat as Repeat : undefined;
    const parentId = typeof body?.parentId === "string" ? body.parentId : undefined;
    const ctx = await getTodoV3Ctx();
    const r = ctx.todoV3Store.create(text, { dependencies: deps, repeat, parentId });
    if (!r.ok) return c.json({ ok: false, message: r.message }, 400);
    return c.json({ ok: true, items: ctx.todoV3Resolver.views(r.items) });
  });

  // 更新
  app.put(`${API_PREFIX}/tools/todo-v3/:id`, async (c: HonoContext) => {
    const body = (await c.req.json().catch(() => null)) as { done?: unknown; text?: unknown; dependencies?: unknown; repeat?: unknown; parentId?: unknown } | null;
    const patch: { done?: boolean; text?: string; dependencies?: string[]; repeat?: Repeat | "none"; parentId?: string | "none" } = {};
    if (body && typeof body.done === "boolean") patch.done = body.done;
    if (body && typeof body.text === "string" && body.text.trim()) patch.text = body.text.trim();
    if (body && Array.isArray(body.dependencies)) patch.dependencies = body.dependencies.filter((d): d is string => typeof d === "string");
    if (body && (body.repeat === "daily" || body.repeat === "weekly" || body.repeat === "monthly" || body.repeat === "none")) patch.repeat = body.repeat;
    if (body && (typeof body.parentId === "string" || body.parentId === "none")) patch.parentId = body.parentId;
    if (!("done" in patch) && !("text" in patch) && !("dependencies" in patch) && !("repeat" in patch) && !("parentId" in patch)) {
      return c.json({ ok: false, message: "无有效更新字段" }, 400);
    }
    const ctx = await getTodoV3Ctx();
    const r = ctx.todoV3Store.update(c.req.param("id")!, patch);
    if (r === null) return c.json({ ok: false, message: "待办不存在" }, 404);
    if (!r.ok) return c.json({ ok: false, message: r.message }, 400);
    return c.json({ ok: true, items: ctx.todoV3Resolver.views(r.items) });
  });

  // 删除
  app.delete(`${API_PREFIX}/tools/todo-v3/:id`, async (c: HonoContext) => {
    const ctx = await getTodoV3Ctx();
    const r = ctx.todoV3Store.remove(c.req.param("id")!);
    if (r === null) return c.json({ ok: false, message: "待办不存在" }, 404);
    return c.json({ ok: true, items: ctx.todoV3Resolver.views(r.items) });
  });

  // 清空已完成
  app.post(`${API_PREFIX}/tools/todo-v3/clear-done`, async (c: HonoContext) => {
    const ctx = await getTodoV3Ctx();
    const r = ctx.todoV3Store.clearDone();
    return c.json({ ok: true, items: ctx.todoV3Resolver.views(r.items) });
  });
}
