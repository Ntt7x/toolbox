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
// 注册数据源：医学知识库（knowledge:medical. 子前缀实例，独立成源便于本地数据管理定位）
registerDataSource({
  kind: "kv",
  name: "knowledge:medical.",
  page: "医学知识库",
  tag: "知识数据",
  description: "医学知识库条目（medical 实例，knowledge: 源子集）：Chat 分享导入 + 知识问答（Reasonix Agent / 直调兜底）",
});
// 医学知识库通用部分（knowledge: 源内其余实例）不再单独注册，归 knowledge: 源展示

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
  // 导入：POST /api/tools/medical-kb/import { urls: string[] | url: string } —— 后台任务（支持批量，Reasonix 执行，失败降级直调）
  app.post(`${API_PREFIX}/tools/medical-kb/import`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { url?: unknown; urls?: unknown } | null;
    // 单条 url 兼容 + 批量 urls 数组
    const urls = (
      Array.isArray(raw?.urls)
        ? raw.urls.filter((u): u is string => typeof u === "string")
        : typeof raw?.url === "string"
          ? [raw.url]
          : []
    )
      .map((u) => u.trim())
      .filter(Boolean);
    if (urls.length === 0) return c.json({ ok: false, message: "缺少分享链接 url/urls" }, 400);
    const single = urls.length === 1;
    const { taskId } = createTask(async () => {
      // 串行逐条导入（同一实例 Reasonix 会话天然串行）；单条返回原结构，批量返回 items 数组
      const items: { url: string; ok: boolean; imported: number; title?: string; message?: string }[] = [];
      for (let i = 0; i < urls.length; i++) {
        const u = urls[i];
        try {
          // 优先 Reasonix Agent（会话持久 + 前缀缓存，成本低）；不可用时降级服务端直调
          const r = await knowledgeAgentImport(MEDICAL_INSTANCE, u, { module: "medical-kb.import" });
          if (!r.ok) {
            if (r.fallback) {
              // 直调兜底：失败会 throw，由外层 catch 收集为单条失败
              const direct = await kbImportFromChat(u, { instance: MEDICAL_INSTANCE, module: "medical-kb.import" });
              items.push({ url: u, ok: true, imported: direct.imported ?? 0, title: direct.title });
            } else {
              items.push({ url: u, ok: false, imported: 0, message: r.message ?? "导入失败" });
            }
          } else {
            items.push({ url: u, ok: true, imported: r.imported ?? 0, message: r.message });
          }
        } catch (e) {
          items.push({ url: u, ok: false, imported: 0, message: e instanceof Error ? e.message : String(e) });
        }
      }
      if (single) return { ok: items[0].ok, imported: items[0].imported, title: items[0].title, message: items[0].message, note: items[0].message };
      const okCount = items.filter((x) => x.ok).length;
      return { ok: okCount > 0, imported: items.reduce((s, x) => s + x.imported, 0), items, summary: `成功 ${okCount}/${items.length}` };
    }, {
      timeoutMs: 8 * 60 * 1000 * Math.max(urls.length, 1),
      module: "medical-kb.import",
      name: `医学知识导入 · ${urls.length} 条`,
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
      const r = await knowledgeAgentAsk(MEDICAL_INSTANCE, question, { module: "medical-kb.ask" });
      if (!r.ok) {
        if (r.fallback) return kbAsk(question, { instance: MEDICAL_INSTANCE, module: "medical-kb.ask" });
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
