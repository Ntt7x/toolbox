// ============================================================
// 业务模块：康复（features/rehab）
// - 工具：rehab-medical（医学知识库，Chat 导入 + 问答）
// - register：GET/PUT/POST reset 单 KV 笔记（rehab:<id>）+ medical-kb 路由
// 依赖下层公共模块：core/kvStore、core/dataRegistry、core/knowledge、core/tasks
// ============================================================

import { Hono } from "hono";
import { API_PREFIX, type ToolMeta } from "@toolbox/shared";
import { registerDataSource } from "../../core/dataRegistry.js";
import { getNote, isKnownNote, PREFIX, resetNote, saveNote } from "./store.js";
import { createTask } from "../../core/tasks.js";
import { kbAsk, kbDelete, kbImportFromChat, kbList } from "../../core/knowledge.js";
import { knowledgeAgentAsk, knowledgeAgentImport } from "../../core/knowledgeSession.js";

// 注册数据源：康复笔记（本地数据管理页展示 tag 用）
registerDataSource({
  kind: "kv",
  name: PREFIX,
  page: "康复",
  tag: "个人笔记",
  description: "康复笔记（rehab:medical，历史数据保留，页面已改为医学知识库）",
});
// 医学知识库数据归属 core/knowledge 注册的 knowledge: 源（medical.* 实例；此处不再重复注册避免 0 条误导源）

export const meta: ToolMeta = {
  id: "rehab-medical",
  name: "医学知识库",
  description: "医学知识库：Chat 分享链接导入知识 + 知识问答（medical 实例，基于 core/knowledge）",
  path: "/tools/rehab-medical",
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

// ============================================================
// 医学知识库（medical 实例，基于 core/knowledge 公共模块）
// - Chat 分享链接导入（LLM 提取事实 → medical.* 实例）
// - 知识列表/删除
// - 知识问答（限定 medical 实例检索）
// ============================================================
export const MEDICAL_INSTANCE = "medical";

export function registerMedicalKb(app: Hono): void {
  // 导入：POST /api/tools/medical-kb/import { url } —— 后台任务（Reasonix Agent 执行，失败降级直调）
  app.post(`${API_PREFIX}/tools/medical-kb/import`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    const url = typeof raw?.url === "string" ? raw.url.trim() : "";
    if (!url) return c.json({ ok: false, message: "缺少分享链接 url" }, 400);
    const { taskId } = createTask(async () => {
      // 优先 Reasonix Agent（会话持久 + 前缀缓存，成本低）；不可用时降级服务端直调
      const r = await knowledgeAgentImport(MEDICAL_INSTANCE, url);
      if (!r.ok) {
        if (r.fallback) return kbImportFromChat(url, { instance: MEDICAL_INSTANCE });
        throw new Error(r.message ?? "知识导入失败");
      }
      return { ok: true, note: r.message, imported: r.imported };
    }, {
      timeoutMs: 8 * 60 * 1000,
      module: "medical-kb.import",
      name: `医学知识导入 · ${new Date().toISOString().slice(0, 10)}`,
    });
    return c.json({ ok: true, taskId, status: "running" }, 202);
  });

  // 列表：GET /api/tools/medical-kb（medical 实例内，新的在前）
  app.get(`${API_PREFIX}/tools/medical-kb`, (c) => {
    const entries = kbList({ prefix: `${MEDICAL_INSTANCE}.`, limit: 500 });
    return c.json({ ok: true, entries, total: entries.length });
  });

  // 删除：DELETE /api/tools/medical-kb/:key（key 必须属于 medical 实例）
  app.delete(`${API_PREFIX}/tools/medical-kb/:key`, (c) => {
    const key = c.req.param("key");
    if (!key.startsWith(`${MEDICAL_INSTANCE}.`)) return c.json({ ok: false, message: "key 不属于医学知识库" }, 400);
    const ok = kbDelete(key);
    if (!ok) return c.json({ ok: false, message: "知识条目不存在" }, 404);
    return c.json({ ok: true, deleted: 1 });
  });

  // 问答：POST /api/tools/medical-kb/ask { question } —— 后台任务（Reasonix Agent 执行，失败降级直调）
  app.post(`${API_PREFIX}/tools/medical-kb/ask`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { question?: unknown } | null;
    const question = typeof raw?.question === "string" ? raw.question.trim() : "";
    if (!question) return c.json({ ok: false, message: "缺少问题 question" }, 400);
    const { taskId } = createTask(async () => {
      // 优先 Reasonix Agent（会话持久 + 前缀缓存，成本低）；不可用时降级服务端直调
      const r = await knowledgeAgentAsk(MEDICAL_INSTANCE, question);
      if (!r.ok) {
        if (r.fallback) return kbAsk(question, { instance: MEDICAL_INSTANCE });
        throw new Error(r.message ?? "知识问答失败");
      }
      return { ok: true, answer: r.content };
    }, {
      timeoutMs: 8 * 60 * 1000,
      module: "medical-kb.ask",
      name: `医学知识问答 · ${question.slice(0, 24)}`,
    });
    return c.json({ ok: true, taskId, status: "running" }, 202);
  });
}
