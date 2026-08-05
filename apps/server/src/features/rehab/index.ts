// ============================================================
// 业务模块：康复笔记（features/rehab）
// - 两个工具：rehab-medical（医疗经验）、rehab-muscle（肌肉训练）
// - register：GET/PUT/POST reset 单 KV 笔记（rehab:<id>）
// 依赖下层公共模块：core/kvStore、core/dataRegistry
// ============================================================

import { Hono } from "hono";
import { API_PREFIX, type ToolMeta } from "@toolbox/shared";
import { registerDataSource } from "../../core/dataRegistry.js";
import { getNote, isKnownNote, PREFIX, resetNote, saveNote } from "./store.js";

// 注册数据源：康复笔记（本地数据管理页展示 tag 用）
registerDataSource({
  kind: "kv",
  name: PREFIX,
  page: "康复",
  tag: "个人笔记",
  description: "康复经验笔记（rehab:medical 医疗经验 / rehab:muscle 肌肉训练），可编辑",
});

export const meta: ToolMeta = {
  id: "rehab-medical",
  name: "医疗经验",
  description: "后新冠时期感冒治疗方案 + SIBO 方案（个人经验笔记，可编辑）",
  path: "/tools/rehab-medical",
};

export const muscleMeta: ToolMeta = {
  id: "rehab-muscle",
  name: "肌肉训练",
  description: "小腿肌肉训练方案（个人经验笔记，可编辑）",
  path: "/tools/rehab-muscle",
};

export function register(app: Hono): void {
  // 读取笔记（自动 seed 默认）
  app.get(`${API_PREFIX}/tools/rehab/:id`, (c) => {
    const id = c.req.param("id");
    if (!isKnownNote(id)) return c.json({ ok: false, message: "笔记不存在" }, 404);
    return c.json({ ok: true, note: getNote(id) });
  });

  // 保存笔记（整体覆盖）
  app.put(`${API_PREFIX}/tools/rehab/:id`, async (c) => {
    const id = c.req.param("id");
    if (!isKnownNote(id)) return c.json({ ok: false, message: "笔记不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { title?: unknown; sections?: unknown } | null;
    if (!raw || typeof raw !== "object") return c.json({ ok: false, message: "请求体无效" }, 400);
    const note = saveNote(id, {
      title: typeof raw.title === "string" ? raw.title : undefined,
      sections: raw.sections,
    });
    if (!note) return c.json({ ok: false, message: "笔记数据结构无效（sections 格式不正确）" }, 400);
    return c.json({ ok: true, note });
  });

  // 重置为默认种子
  app.post(`${API_PREFIX}/tools/rehab/:id/reset`, (c) => {
    const id = c.req.param("id");
    if (!isKnownNote(id)) return c.json({ ok: false, message: "笔记不存在" }, 404);
    const note = resetNote(id);
    if (!note) return c.json({ ok: false, message: "重置失败" }, 400);
    return c.json({ ok: true, note });
  });
}
