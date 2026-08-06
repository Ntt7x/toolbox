// ============================================================
// 业务模块：知识库中心（features/knowledgeHub）
// 虚拟知识库（多个领域库的集合）+ 领域元数据（描述/关键词自动匹配）
// 依赖 core/knowledgeHub（虚拟库 CRUD/聚合问答/匹配导入）
// ============================================================
import { Hono } from "hono";
import type { Context } from "hono";
import { API_PREFIX, type ToolMeta } from "@toolbox/shared";
import {
  listVirtKbs,
  getVirtKb,
  createVirtKb,
  deleteVirtKb,
  listDomains,
  getDomainMeta,
  setDomainMeta,
  askVirtKb,
  importToVirtKb,
} from "../../core/knowledgeHub.js";
import { kbListInstances, kbAsk, kbImportFromChat } from "../../core/knowledge.js";

export const meta: ToolMeta = { id: "knowledge-hub", name: "知识库中心", description: "虚拟知识库与领域知识库管理", path: "/tools/knowledge-hub" };

export function register(app: Hono): void {
  const route = new Hono();

  // 总览：领域实例（含条目数）+ 领域元数据 + 虚拟库
  route.get("/overview", (c: Context) => {
    const instances = kbListInstances().map((it) => ({ ...it, meta: getDomainMeta(it.instance) ?? undefined }));
    return c.json({ ok: true, instances, domains: listDomains(), virst: listVirtKbs() });
  });

  // 虚拟库
  route.post("/virt", async (c: Context) => {
    const body = await c.req.json().catch(() => ({}));
    const r = createVirtKb(String(body.name ?? ""), Array.isArray(body.domains) ? body.domains : [], body.desc ? String(body.desc) : undefined);
    if (!r.ok) return c.json({ ok: false, message: r.message }, 400);
    return c.json({ ok: true, virt: r.virt });
  });

  route.delete("/virt/:name", (c: Context) => {
    deleteVirtKb(c.req.param("name") ?? "");
    return c.json({ ok: true, deleted: true });
  });

  // 虚拟库聚合问答
  route.post("/virt/:name/ask", async (c: Context) => {
    const body = await c.req.json().catch(() => ({}));
    const question = String(body.question ?? "").trim();
    if (!question) return c.json({ ok: false, message: "请输入问题" }, 400);
    const r = await askVirtKb(c.req.param("name") ?? "", question);
    return c.json(r.ok ? { ok: true, answer: r.answer } : { ok: false, message: r.message }, r.ok ? 200 : 400);
  });

  // 虚拟库导入（自动匹配领域）
  route.post("/virt/:name/import", async (c: Context) => {
    const body = await c.req.json().catch(() => ({}));
    const url = String(body.url ?? "").trim();
    if (!url) return c.json({ ok: false, message: "请输入 Chat 分享链接" }, 400);
    try {
      const r = await importToVirtKb(c.req.param("name") ?? "", url);
      return c.json(r);
    } catch (e) {
      return c.json({ ok: false, message: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // 领域库问答（通用：任意实例直接检索问答；医学库仍走 rehab 的 Agent 会话特化路径）
  route.post("/domain/:name/ask", async (c: Context) => {
    const body = await c.req.json().catch(() => ({}));
    const question = String(body.question ?? "").trim();
    if (!question) return c.json({ ok: false, message: "请输入问题" }, 400);
    const r = await kbAsk(question, { instance: c.req.param("name") ?? "", module: "knowledge-hub.ask" });
    return c.json(r.ok ? { ok: true, answer: r.answer } : { ok: false, message: r.message }, r.ok ? 200 : 400);
  });

  // 领域库导入（任意实例；医学库仍走 rehab 特化批量路径）
  route.post("/domain/:name/import", async (c: Context) => {
    const body = await c.req.json().catch(() => ({}));
    const url = String(body.url ?? "").trim();
    const conflict = String(body.conflict ?? "skip") as "skip" | "overwrite" | "merge";
    if (!url) return c.json({ ok: false, message: "请输入 Chat 分享链接" }, 400);
    try {
      const r = await kbImportFromChat(url, { instance: c.req.param("name") ?? "", conflict, module: "knowledge-hub.import" });
      return c.json(r);
    } catch (e) {
      return c.json({ ok: false, message: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // 领域元数据（描述/关键词，供自动匹配导入）
  route.put("/domain/:name", async (c: Context) => {
    const body = await c.req.json().catch(() => ({}));
    const d = setDomainMeta(c.req.param("name") ?? "", {
      desc: body.desc ? String(body.desc) : undefined,
      keywords: Array.isArray(body.keywords) ? body.keywords.map((k: unknown) => String(k)) : undefined,
    });
    return c.json({ ok: true, domain: d });
  });

  app.route(`${API_PREFIX}/tools/knowledge-hub`, route);
}
