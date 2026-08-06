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
  updateVirtKb,
  deleteVirtKb,
  listDomains,
  getDomainMeta,
  setDomainMeta,
  createDomain,
  deleteDomain,
  generateDomainTemplates,
  seedMedicalTemplates,
  askVirtKb,
  importToVirtKb,
} from "../../core/knowledgeHub.js";
import { kbListInstances, kbAsk, kbImportFromChat, kbDelete, kbList } from "../../core/knowledge.js";

/** 虚拟库数据区聚合扫描上限（每领域） */
const KB_ENTRIES_SCAN = 500;

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

  // 动态调整虚拟库引用的领域库（增删/替换）
  route.put("/virt/:name", async (c: Context) => {
    const body = await c.req.json().catch(() => ({}));
    const r = updateVirtKb(c.req.param("name") ?? "", {
      domains: Array.isArray(body.domains) ? body.domains.map((d: unknown) => String(d)) : undefined,
      desc: body.desc !== undefined ? String(body.desc) : undefined,
    });
    if (!r.ok) return c.json({ ok: false, message: r.message }, 400);
    return c.json({ ok: true, virt: r.virt });
  });

  // 删除领域知识库（彻底：清空实例条目 + 删元数据）
  route.delete("/domain/:name", (c: Context) => {
    const r = deleteDomain(c.req.param("name") ?? "");
    if (!r.ok) return c.json({ ok: false, message: "删除失败" }, 400);
    return c.json({ ok: true, deleted: true, removedEntries: r.removedEntries, ...(r.cleanedVirts ? { cleanedVirts: r.cleanedVirts } : {}) });
  });

  // 领域库数据区：分页列出该实例知识条目（prefix 过滤；total 为全量）
  route.get("/domain/:name/entries", (c: Context) => {
    const name = c.req.param("name") ?? "";
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
    const all = kbList({ prefix: `${name}.`, limit: 5000 });
    const page = all.slice(offset, offset + limit);
    return c.json({ ok: true, total: all.length, entries: page, offset, limit });
  });

  // 领域库数据区：删除单条知识条目
  route.delete("/domain/:name/entry/:key", (c: Context) => {
    const name = c.req.param("name") ?? "";
    const key = c.req.param("key") ?? "";
    if (!key.startsWith(`${name}.`)) return c.json({ ok: false, message: `key「${key}」不属于领域「${name}」` }, 400);
    const ok = kbDelete(key);
    if (!ok) return c.json({ ok: false, message: "知识条目不存在" }, 404);
    return c.json({ ok: true, deleted: 1 });
  });

  // 虚拟库数据区：聚合其全部领域的条目（跨前缀，limit/offset）
  route.get("/virt/:name/entries", (c: Context) => {
    const virt = getVirtKb(c.req.param("name") ?? "");
    if (!virt) return c.json({ ok: false, message: "虚拟知识库不存在" }, 404);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
    const all = virt.domains.flatMap((d) => kbList({ prefix: `${d}.`, limit: KB_ENTRIES_SCAN }));
    const page = all.slice(offset, offset + limit);
    return c.json({ ok: true, total: all.length, entries: page, offset, limit });
  });

  // 虚拟库聚合问答
  route.post("/virt/:name/ask", async (c: Context) => {
    const body = await c.req.json().catch(() => ({}));
    const question = String(body.question ?? "").trim();
    if (!question) return c.json({ ok: false, message: "请输入问题" }, 400);
    const r = await askVirtKb(c.req.param("name") ?? "", question);
    return c.json(r.ok ? { ok: true, answer: r.answer, ...(r.routed ? { routed: r.routed } : {}) } : { ok: false, message: r.message }, r.ok ? 200 : 400);
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

  // 新建领域知识库（显式建库；空库也可先建后导入；可选 LLM 自动生成领域模板）
  route.post("/domain", async (c: Context) => {
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name ?? "");
    const keywords = Array.isArray(body.keywords) ? body.keywords.map((k: unknown) => String(k)) : undefined;
    const r = createDomain(name, {
      desc: body.desc ? String(body.desc) : undefined,
      keywords,
    });
    if (!r.ok) return c.json({ ok: false, message: r.message }, 400);
    let warning: string | undefined;
    if (body.generateTemplates === true) {
      try {
        const tpl = await generateDomainTemplates({
          name: r.domain!.name,
          desc: r.domain!.desc || undefined,
          keywords: r.domain!.keywords,
        });
        setDomainMeta(r.domain!.name, { askTemplate: tpl.askTemplate, extractTemplate: tpl.extractTemplate });
      } catch (e) {
        warning = `领域已创建，但模板自动生成失败：${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return c.json({ ok: true, domain: getDomainMeta(r.domain!.name), ...(warning ? { warning } : {}) });
  });

  // 领域元数据（描述/关键词/领域特化模板，供自动匹配导入与领域问答）
  route.put("/domain/:name", async (c: Context) => {
    const body = await c.req.json().catch(() => ({}));
    const d = setDomainMeta(c.req.param("name") ?? "", {
      desc: body.desc ? String(body.desc) : undefined,
      keywords: Array.isArray(body.keywords) ? body.keywords.map((k: unknown) => String(k)) : undefined,
      askTemplate: body.askTemplate !== undefined ? String(body.askTemplate) : undefined,
      extractTemplate: body.extractTemplate !== undefined ? String(body.extractTemplate) : undefined,
    });
    return c.json({ ok: true, domain: d });
  });

  // 医学领域模板 seed（幂等初始化；force 强制重置为内置医学模板）
  route.post("/domain/medical/seed", async (c: Context) => {
    const body = await c.req.json().catch(() => ({}));
    seedMedicalTemplates(body.force === true);
    return c.json({ ok: true, domain: getDomainMeta("medical") });
  });

  app.route(`${API_PREFIX}/tools/knowledge-hub`, route);
}
