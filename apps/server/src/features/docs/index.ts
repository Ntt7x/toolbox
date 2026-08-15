// ============================================================
// 业务模块：文档中心（features/docs）——Hono 路由薄壳
// 业务全部走 ctx 上的 Cordis 服务（docStore/docFile/docIndex/docImport）
// ============================================================
import { Hono } from "hono";
import type { Context } from "hono";
import { API_PREFIX, type ToolMeta } from "@toolbox/shared";
import { registerDataSource } from "../../core/dataRegistry.js";
import { getDocsCtx } from "./context.js";
import { DOCS_CONTENT_PREFIX, DOCS_FOLDERS_KEY, DOCS_META_KEY } from "./services.js";

export const meta: ToolMeta = {
  id: "docs",
  name: "文档中心",
  description: "markdown / pdf 文档管理与浏览（文件夹 + tag + 文件上传 + 知乎导入）",
  path: "/tools/docs",
};

export function registerDocsFeature(app: Hono) {
  registerDataSource({
    kind: "kv",
    name: "docs:",
    page: meta.name,
    tag: "文档数据",
    description: "文档中心元数据（docs:folders / docs:meta / docs:content:）",
  });
  void DOCS_FOLDERS_KEY, DOCS_META_KEY, DOCS_CONTENT_PREFIX;

  // 列表（文件夹 + 文档 + tag 聚合）
  app.get(`${API_PREFIX}/tools/docs`, async (c: Context) => {
    const ctx = await getDocsCtx();
    return c.json({ ok: true, folders: ctx.docStore.listFolders(), items: ctx.docStore.listItems(), tags: ctx.docIndex.listTags() });
  });

  // 知乎爬取历史（供导入）——静态路由必须在 /:id 之前注册
  app.get(`${API_PREFIX}/tools/docs/zhihu-results`, async (c: Context) => {
    const ctx = await getDocsCtx();
    return c.json({ ok: true, results: ctx.docImport.zhihuResults() });
  });


  // 回收站列表（静态路由必须在 /:id 前注册）
  app.get(`${API_PREFIX}/tools/docs/trash`, async (c: Context) => {
    const ctx = await getDocsCtx();
    return c.json({ ok: true, ...ctx.docStore.listTrash() });
  });

  // 清空回收站（真删全部 + 清 pdf 文件）
  app.post(`${API_PREFIX}/tools/docs/trash/empty`, async (c: Context) => {
    const ctx = await getDocsCtx();
    const { pdfIds } = ctx.docStore.emptyTrash();
    for (const pid of pdfIds) ctx.docFile.deletePdf(pid);
    return c.json({ ok: true, items: ctx.docStore.listItems(), folders: ctx.docStore.listFolders(), tags: ctx.docIndex.listTags() });
  });


  // 详情（md 返回内容）
  app.get(`${API_PREFIX}/tools/docs/:id`, async (c: Context) => {
    const ctx = await getDocsCtx();
    const it = ctx.docStore.getItem(c.req.param("id")!);
    if (!it) return c.json({ ok: false, message: "文档不存在" }, 404);
    return c.json({ ok: true, item: it, ...(it.type === "md" ? { content: ctx.docStore.getContent(it.id) } : {}) });
  });

  // pdf 二进制下载/预览
  app.get(`${API_PREFIX}/tools/docs/:id/file`, async (c: Context) => {
    const ctx = await getDocsCtx();
    const it = ctx.docStore.getItem(c.req.param("id")!);
    if (!it || it.type !== "pdf") return c.json({ ok: false, message: "非 pdf 文档" }, 404);
    const buf = ctx.docFile.readPdf(it.id);
    if (!buf) return c.json({ ok: false, message: "文件丢失" }, 404);
    return new Response(new Uint8Array(buf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${encodeURIComponent(it.name)}"` },
    });
  });

  // 上传（multipart → DocImportService 解析）
  app.post(`${API_PREFIX}/tools/docs/upload`, async (c: Context) => {
    let form: FormData;
    try { form = await c.req.formData(); } catch { return c.json({ ok: false, message: "解析表单失败" }, 400); }
    const folderId = typeof form.get("folderId") === "string" && form.get("folderId") ? form.get("folderId") as string : undefined;
    const tags = form.getAll("tags").map((t) => String(t)).filter(Boolean);
    const ctx = await getDocsCtx();
    const r = await ctx.docImport.uploadParse(form, { folderId, tags });
    return c.json({ ok: true, ...r, items: ctx.docStore.listItems(), folders: ctx.docStore.listFolders(), tags: ctx.docIndex.listTags() });
  });

  // 新建文件夹
  app.post(`${API_PREFIX}/tools/docs/folder`, async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; parentId?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ ok: false, message: "请输入文件夹名" }, 400);
    const parentId = typeof body?.parentId === "string" ? body.parentId : undefined;
    const ctx = await getDocsCtx();
    return c.json({ ok: true, folders: ctx.docStore.createFolder(name, parentId) });
  });

  // 改文件夹名
  app.put(`${API_PREFIX}/tools/docs/folder/:id`, async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const ctx = await getDocsCtx();
    const folders = ctx.docStore.renameFolder(c.req.param("id")!, name);
    if (!folders) return c.json({ ok: false, message: "文件夹不存在" }, 404);
    return c.json({ ok: true, folders });
  });

  // 移动文件夹（改变 parentId；拖拽用；禁止移入自身/子孙）
  app.put(`${API_PREFIX}/tools/docs/folder/:id/move`, async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as { parentId?: unknown } | null;
    const parentId = body?.parentId === null || body?.parentId === undefined ? null : typeof body?.parentId === "string" ? body.parentId : null;
    const ctx = await getDocsCtx();
    const folders = ctx.docStore.moveFolder(c.req.param("id")!, parentId);
    if (!folders) return c.json({ ok: false, message: "文件夹不存在" }, 404);
    return c.json({ ok: true, folders });
  });

  // 删文件夹（软删回收站：级联子文件夹 + 文档进回收站）
  app.delete(`${API_PREFIX}/tools/docs/folder/:id`, async (c: Context) => {
    const ctx = await getDocsCtx();
    const r = ctx.docStore.deleteFolder(c.req.param("id")!);
    if (!r) return c.json({ ok: false, message: "文件夹不存在" }, 404);
    return c.json({ ok: true, ...r, tags: ctx.docIndex.listTags() });
  });

  // 恢复文件夹整树
  app.post(`${API_PREFIX}/tools/docs/folder/:id/restore`, async (c: Context) => {
    const ctx = await getDocsCtx();
    const r = ctx.docStore.restoreFolder(c.req.param("id")!);
    if (!r) return c.json({ ok: false, message: "文件夹不存在" }, 404);
    return c.json({ ok: true, ...r, tags: ctx.docIndex.listTags() });
  });

  // 彻底删除文件夹整树（真删 + 清 pdf 文件）
  app.delete(`${API_PREFIX}/tools/docs/folder/:id/purge`, async (c: Context) => {
    const ctx = await getDocsCtx();
    const r = ctx.docStore.purgeFolder(c.req.param("id")!);
    if (!r) return c.json({ ok: false, message: "文件夹不存在" }, 404);
    for (const pid of r.pdfIds) ctx.docFile.deletePdf(pid);
    return c.json({ ok: true, items: ctx.docStore.listItems(), folders: ctx.docStore.listFolders(), tags: ctx.docIndex.listTags() });
  });

  // 导出到本地文件（VSCode 唤起编辑，memo msuxceh7）——静态路由在 :id 之前
  app.post(`${API_PREFIX}/tools/docs/:id/export-file`, async (c: Context) => {
    const ctx = await getDocsCtx();
    const it = ctx.docStore.getItem(c.req.param("id")!);
    if (!it) return c.json({ ok: false, message: "文档不存在" }, 404);
    return c.json(ctx.docFile.exportForEdit(it));
  });

  // 更新文档（name/tags/folderId/content）
  app.put(`${API_PREFIX}/tools/docs/:id`, async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; tags?: unknown; folderId?: unknown; content?: unknown } | null;
    const patch: { name?: string; tags?: string[]; folderId?: string | "none"; content?: string } = {};
    if (body && typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (body && Array.isArray(body.tags)) patch.tags = body.tags.filter((t): t is string => typeof t === "string");
    if (body && (typeof body.folderId === "string" || body.folderId === "none")) patch.folderId = body.folderId;
    if (body && typeof body.content === "string") patch.content = body.content;
    if (!("name" in patch) && !("tags" in patch) && !("folderId" in patch) && !("content" in patch)) {
      return c.json({ ok: false, message: "无有效更新字段" }, 400);
    }
    const ctx = await getDocsCtx();
    const it = ctx.docStore.updateItem(c.req.param("id")!, patch);
    if (!it) return c.json({ ok: false, message: "文档不存在" }, 404);
    return c.json({ ok: true, items: ctx.docStore.listItems(), folders: ctx.docStore.listFolders(), tags: ctx.docIndex.listTags() });
  });

  // 删除文档（软删回收站）
  app.delete(`${API_PREFIX}/tools/docs/:id`, async (c: Context) => {
    const ctx = await getDocsCtx();
    const it = ctx.docStore.deleteItem(c.req.param("id")!);
    if (!it) return c.json({ ok: false, message: "文档不存在" }, 404);
    return c.json({ ok: true, items: ctx.docStore.listItems(), folders: ctx.docStore.listFolders(), tags: ctx.docIndex.listTags() });
  });

  // 恢复文档
  app.post(`${API_PREFIX}/tools/docs/:id/restore`, async (c: Context) => {
    const ctx = await getDocsCtx();
    const it = ctx.docStore.restoreItem(c.req.param("id")!);
    if (!it) return c.json({ ok: false, message: "文档不存在或不在回收站" }, 404);
    return c.json({ ok: true, items: ctx.docStore.listItems(), folders: ctx.docStore.listFolders(), tags: ctx.docIndex.listTags() });
  });

  // 彻底删除文档（真删 + 清 pdf 文件）
  app.delete(`${API_PREFIX}/tools/docs/:id/purge`, async (c: Context) => {
    const ctx = await getDocsCtx();
    const it = ctx.docStore.purgeItem(c.req.param("id")!);
    if (!it) return c.json({ ok: false, message: "文档不存在" }, 404);
    if (it.type === "pdf") ctx.docFile.deletePdf(it.id);
    return c.json({ ok: true, items: ctx.docStore.listItems(), folders: ctx.docStore.listFolders(), tags: ctx.docIndex.listTags() });
  });

  // DeepSeek Chat Share 导入为 md 文档（memo msuwx8k2）——静态路由，在 /:id 之前
  app.post(`${API_PREFIX}/tools/docs/deepseek-import`, async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as { url?: unknown; folderId?: unknown; tags?: unknown } | null;
    const url = typeof body?.url === "string" ? body.url.trim() : "";
    if (!url) return c.json({ ok: false, message: "请输入 DeepSeek 分享链接" }, 400);
    const folderId = typeof body?.folderId === "string" ? body.folderId : undefined;
    const tags = Array.isArray(body?.tags) ? body.tags.filter((t): t is string => typeof t === "string") : [];
    const ctx = await getDocsCtx();
    const r = await ctx.docImport.importFromDeepseek(url, folderId, tags);
    return c.json({ ...r, items: ctx.docStore.listItems(), folders: ctx.docStore.listFolders(), tags: ctx.docIndex.listTags() });
  });

  // 知乎结果导入为文档
  app.post(`${API_PREFIX}/tools/docs/zhihu-import`, async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as { resultIds?: unknown; folderId?: unknown; tags?: unknown } | null;
    const resultIds = Array.isArray(body?.resultIds) ? body.resultIds.filter((x): x is string => typeof x === "string") : [];
    if (resultIds.length === 0) return c.json({ ok: false, message: "请选择要导入的爬取结果" }, 400);
    const folderId = typeof body?.folderId === "string" ? body.folderId : undefined;
    const tags = Array.isArray(body?.tags) ? body.tags.filter((t): t is string => typeof t === "string") : [];
    const ctx = await getDocsCtx();
    const r = ctx.docImport.importZhihu(resultIds, folderId, tags);
    return c.json({ ok: true, ...r, items: ctx.docStore.listItems(), folders: ctx.docStore.listFolders(), tags: ctx.docIndex.listTags() });
  });
}
