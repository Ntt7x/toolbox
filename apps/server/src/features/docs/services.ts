// ============================================================
// 文档中心：Cordis 服务层（@deepseek-ai/cordis 4.x）
// 服务拆分（验证框架对纯数据模块的适用性）：
//   - DocStoreService（数据 CRUD：文件夹树 + 文档元数据 + md 内容）
//   - DocFileService（文件系统资源：pdf 读写 + 目录初始化 effect）
//   - DocIndexService（检索/聚合：tag 统计 + 文件夹/tag 过滤，消费 DocStore）
//   - DocImportService（导入：multipart 上传解析 + 知乎导入，消费 DocStore + DocFile）
// 存储：docs:folders / docs:meta / docs:content:<id>（KV）+ .file/docs/<id>.pdf（文件系统）
// ============================================================
import { Service, type Context } from "@deepseek-ai/cordis";
import fs from "node:fs";
import path from "node:path";
import { kvGet, kvSet, kvListRaw, kvDelete } from "../../core/kvStore.js";
import { parseShareId, extractShare } from "../../core/deepseekShare.js";
import type { DocFolder, DocItem, ShareMessage } from "@toolbox/shared";

export const DOCS_FOLDERS_KEY = "docs:folders";
export const DOCS_META_KEY = "docs:meta";
export const DOCS_CONTENT_PREFIX = "docs:content:";
/** pdf 二进制目录（相对项目根 .file/docs/） */
export const DOCS_FILE_DIR = ".file/docs";
const MAX_DOCS = 500;

// ---------- 基础工具（模块级，服务共享） ----------

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normFolder(f: Partial<DocFolder>): DocFolder | null {
  if (typeof f.id !== "string" || typeof f.name !== "string" || !f.name.trim()) return null;
  return {
    id: f.id,
    name: f.name.trim(),
    ...(typeof f.parentId === "string" ? { parentId: f.parentId } : {}),
    ...(typeof f.deletedAt === "string" ? { deletedAt: f.deletedAt } : {}),
    createdAt: typeof f.createdAt === "string" ? f.createdAt : new Date().toISOString(),
    updatedAt: typeof f.updatedAt === "string" ? f.updatedAt : new Date().toISOString(),
  };
}

function normItem(i: Partial<DocItem>): DocItem | null {
  if (typeof i.id !== "string" || typeof i.name !== "string" || !i.name.trim()) return null;
  return {
    id: i.id,
    name: i.name.trim(),
    type: i.type === "pdf" ? "pdf" : "md",
    ...(typeof i.folderId === "string" ? { folderId: i.folderId } : {}),
    ...(typeof i.deletedAt === "string" ? { deletedAt: i.deletedAt } : {}),
    tags: Array.isArray(i.tags) ? [...new Set(i.tags.filter((t): t is string => typeof t === "string"))] : [],
    size: typeof i.size === "number" ? i.size : 0,
    ...(i.source && typeof i.source.kind === "string" ? { source: i.source } : {}),
    createdAt: typeof i.createdAt === "string" ? i.createdAt : new Date().toISOString(),
    updatedAt: typeof i.updatedAt === "string" ? i.updatedAt : new Date().toISOString(),
  };
}

// ============================================================
// 服务 1：DocStoreService（数据 CRUD）
// ============================================================

export class DocStoreService extends Service {
  constructor(ctx: Context) {
    super(ctx, "docStore");
  }

  // ---------- 文件夹 ----------

  listFolders(mode: "normal" | "trash" | "all" = "normal"): DocFolder[] {
    const raw = kvGet<{ items?: unknown }>(DOCS_FOLDERS_KEY);
    const items = Array.isArray(raw?.items) ? raw.items : [];
    const all = items.map((f) => normFolder(f as Partial<DocFolder>)).filter((x): x is DocFolder => x !== null);
    if (mode === "all") return all;
    return all.filter((f) => (mode === "trash" ? !!f.deletedAt : !f.deletedAt));
  }

  createFolder(name: string, parentId?: string): DocFolder[] {
    const trimmed = name.trim();
    if (!trimmed) return this.listFolders();
    const folders = this.listFolders();
    if (parentId && !folders.some((f) => f.id === parentId)) parentId = undefined;
    const now = new Date().toISOString();
    folders.push({ id: genId(), name: trimmed, ...(parentId ? { parentId } : {}), createdAt: now, updatedAt: now });
    kvSet(DOCS_FOLDERS_KEY, { items: folders });
    return folders;
  }

  renameFolder(id: string, name: string): DocFolder[] | null {
    const trimmed = name.trim();
    const folders = this.listFolders();
    const f = folders.find((x) => x.id === id);
    if (!f) return null;
    if (!trimmed) return folders;
    f.name = trimmed;
    f.updatedAt = new Date().toISOString();
    kvSet(DOCS_FOLDERS_KEY, { items: folders });
    return folders;
  }

  /** 移动文件夹（改变 parentId；禁止移入自身/子孙——权威环校验） */
  moveFolder(id: string, parentId: string | null): DocFolder[] | null {
    const folders = this.listFolders("all");
    const f = folders.find((x) => x.id === id);
    if (!f) return null;
    if (parentId === id) return this.listFolders();
    // 子孙集合（环检测）
    if (parentId) {
      const subs = new Set<string>();
      let frontier = folders.filter((x) => x.parentId === id).map((x) => x.id);
      while (frontier.length > 0) {
        for (const s of frontier) subs.add(s);
        frontier = folders.filter((x) => x.parentId && subs.has(x.parentId) && !subs.has(x.id)).map((x) => x.id);
      }
      if (subs.has(parentId)) return this.listFolders();   // 拒绝，返回原列表
      if (!folders.some((x) => x.id === parentId)) return this.listFolders();
      f.parentId = parentId;
    } else {
      delete f.parentId;
    }
    f.updatedAt = new Date().toISOString();
    kvSet(DOCS_FOLDERS_KEY, { items: folders });
    return this.listFolders();
  }

  /** 删除文件夹（软删回收站）：子文件夹级联标记 deletedAt，其中文档同步进回收站 */
  deleteFolder(id: string): { folders: DocFolder[]; items: DocItem[] } | null {
    const folders = this.listFolders("all");
    if (!folders.some((f) => f.id === id)) return null;
    const rm = new Set<string>();
    let frontier = [id];
    while (frontier.length > 0) {
      for (const f of frontier) rm.add(f);
      frontier = folders.filter((f) => f.parentId && rm.has(f.parentId) && !rm.has(f.id)).map((f) => f.id);
    }
    const now = new Date().toISOString();
    kvSet(DOCS_FOLDERS_KEY, { items: folders.map((f) => (rm.has(f.id) ? { ...f, deletedAt: f.deletedAt ?? now } : f)) });
    const items = this.listItems("all").map((i) => (i.folderId && rm.has(i.folderId) ? { ...i, deletedAt: i.deletedAt ?? now } : i));
    kvSet(DOCS_META_KEY, { items });
    return { folders: this.listFolders(), items: this.listItems() };
  }

  /** 恢复文件夹整树（清该树所有 deletedAt） */
  restoreFolder(id: string): { folders: DocFolder[]; items: DocItem[] } | null {
    const folders = this.listFolders("all");
    if (!folders.some((f) => f.id === id)) return null;
    const tree = new Set<string>();
    let frontier = [id];
    while (frontier.length > 0) {
      for (const f of frontier) tree.add(f);
      frontier = folders.filter((f) => f.parentId && tree.has(f.parentId) && !tree.has(f.id)).map((f) => f.id);
    }
    kvSet(DOCS_FOLDERS_KEY, { items: folders.map((f) => (tree.has(f.id) ? { ...f, deletedAt: undefined } : f)) });
    const items = this.listItems("all").map((i) => (i.folderId && tree.has(i.folderId) ? { ...i, deletedAt: undefined } : i));
    kvSet(DOCS_META_KEY, { items });
    return { folders: this.listFolders(), items: this.listItems() };
  }

  /** 彻底删除文件夹整树（真删；返回 pdf 文档 id 供 DocFile 清理） */
  purgeFolder(id: string): { pdfIds: string[] } | null {
    const folders = this.listFolders("all");
    if (!folders.some((f) => f.id === id)) return null;
    const tree = new Set<string>();
    let frontier = [id];
    while (frontier.length > 0) {
      for (const f of frontier) tree.add(f);
      frontier = folders.filter((f) => f.parentId && tree.has(f.parentId) && !tree.has(f.id)).map((f) => f.id);
    }
    kvSet(DOCS_FOLDERS_KEY, { items: folders.filter((f) => !tree.has(f.id)) });
    const items = this.listItems("all");
    const pdfIds: string[] = [];
    for (const i of items) {
      if (i.folderId && tree.has(i.folderId)) {
        if (i.type === "md") kvDelete(DOCS_CONTENT_PREFIX + i.id);
        else pdfIds.push(i.id);
      }
    }
    kvSet(DOCS_META_KEY, { items: items.filter((i) => !(i.folderId && tree.has(i.folderId))) });
    return { pdfIds };
  }

  // ---------- 文档 ----------

  listItems(mode: "normal" | "trash" | "all" = "normal"): DocItem[] {
    const raw = kvGet<{ items?: unknown }>(DOCS_META_KEY);
    const items = Array.isArray(raw?.items) ? raw.items : [];
    const all = items.map((i) => normItem(i as Partial<DocItem>)).filter((x): x is DocItem => x !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (mode === "all") return all;
    return all.filter((i) => (mode === "trash" ? !!i.deletedAt : !i.deletedAt));
  }

  getItem(id: string): DocItem | null {
    return this.listItems("all").find((x) => x.id === id) ?? null;
  }

  getContent(id: string): string {
    return kvGet<string>(DOCS_CONTENT_PREFIX + id) ?? "";
  }

  /** 创建文档（md 内容存 KV；pdf 由 DocFileService 写文件后调此方法） */
  createItem(input: {
    name: string;
    type: "md" | "pdf";
    folderId?: string;
    tags?: string[];
    content?: string;
    size: number;
    source?: { kind: string; url?: string };
  }): DocItem | null {
    const items = this.listItems();
    if (items.length >= MAX_DOCS) return null;
    const now = new Date().toISOString();
    const item: DocItem = {
      id: genId(),
      name: input.name,
      type: input.type,
      ...(input.folderId && this.listFolders().some((f) => f.id === input.folderId) ? { folderId: input.folderId } : {}),
      tags: [...new Set((input.tags ?? []).filter((t) => t.trim()))],
      size: input.size,
      ...(input.source ? { source: input.source } : {}),
      createdAt: now,
      updatedAt: now,
    };
    if (input.type === "md" && input.content !== undefined) {
      kvSet(DOCS_CONTENT_PREFIX + item.id, input.content);
    }
    items.push(item);
    kvSet(DOCS_META_KEY, { items });
    return item;
  }

  updateItem(id: string, patch: { name?: string; tags?: string[]; folderId?: string | "none"; content?: string }): DocItem | null {
    const items = this.listItems();
    const it = items.find((x) => x.id === id);
    if (!it) return null;
    if (patch.name && patch.name.trim()) it.name = patch.name.trim();
    if (Array.isArray(patch.tags)) it.tags = [...new Set(patch.tags.filter((t) => t.trim()))];
    if (patch.folderId === "none") delete it.folderId;
    else if (patch.folderId) {
      it.folderId = this.listFolders().some((f) => f.id === patch.folderId) ? patch.folderId : undefined;
    }
    if (patch.content !== undefined && it.type === "md") kvSet(DOCS_CONTENT_PREFIX + it.id, patch.content);
    it.updatedAt = new Date().toISOString();
    kvSet(DOCS_META_KEY, { items });
    return it;
  }

  /** 删除文档（软删回收站：标记 deletedAt；pdf 文件保留，彻底删除时才清理） */
  deleteItem(id: string): DocItem | null {
    const items = this.listItems("all");
    const it = items.find((x) => x.id === id);
    if (!it) return null;
    if (!it.deletedAt) it.deletedAt = new Date().toISOString();
    it.updatedAt = new Date().toISOString();
    kvSet(DOCS_META_KEY, { items });
    return it;
  }

  /** 恢复文档（清 deletedAt） */
  restoreItem(id: string): DocItem | null {
    const items = this.listItems("all");
    const it = items.find((x) => x.id === id);
    if (!it || !it.deletedAt) return null;
    it.deletedAt = undefined;
    it.updatedAt = new Date().toISOString();
    kvSet(DOCS_META_KEY, { items });
    return it;
  }

  /** 彻底删除文档（真删 KV；pdf 由 DocFile 清理） */
  purgeItem(id: string): DocItem | null {
    const items = this.listItems("all");
    const it = items.find((x) => x.id === id);
    if (!it) return null;
    kvSet(DOCS_META_KEY, { items: items.filter((x) => x.id !== id) });
    if (it.type === "md") kvDelete(DOCS_CONTENT_PREFIX + id);
    return it;
  }

  /** 回收站列表（软删的文档 + 文件夹） */
  listTrash(): { items: DocItem[]; folders: DocFolder[] } {
    return { items: this.listItems("trash"), folders: this.listFolders("trash") };
  }

  /** 清空回收站（真删全部；返回 pdf 文档 id 供 DocFile 清理） */
  emptyTrash(): { pdfIds: string[] } {
    const trashItems = this.listItems("trash");
    const pdfIds: string[] = [];
    for (const i of trashItems) {
      if (i.type === "md") kvDelete(DOCS_CONTENT_PREFIX + i.id);
      else pdfIds.push(i.id);
    }
    kvSet(DOCS_META_KEY, { items: this.listItems("all").filter((i) => !i.deletedAt) });
    kvSet(DOCS_FOLDERS_KEY, { items: this.listFolders("all").filter((f) => !f.deletedAt) });
    return { pdfIds };
  }
}

// ============================================================
// 服务 2：DocFileService（文件系统资源：pdf 读写 + 目录初始化 effect）
// 抽象"存储后端"：未来换对象存储/DB BLOB 只需替换本服务实现
// ============================================================

export class DocFileService extends Service {
  constructor(ctx: Context) {
    super(ctx, "docFile");
    // 生命周期管理（Cordis 教程 02）：目录初始化作为 effect，卸载时自动 dispose
    ctx.effect(() => {
      fs.mkdirSync(this.fileDir(), { recursive: true });
      return () => { /* 目录共享，不删除；仅登记生命周期 */ };
    });
  }

  /** pdf 目录绝对路径（项目根 .file/docs/） */
  fileDir(): string {
    return path.join(path.resolve(process.cwd()), DOCS_FILE_DIR);
  }

  writePdf(id: string, buf: Buffer): void {
    const dir = this.fileDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.pdf`), buf);
  }

  readPdf(id: string): Buffer | null {
    const fp = path.join(this.fileDir(), `${id}.pdf`);
    if (!fs.existsSync(fp)) return null;
    return fs.readFileSync(fp);
  }

  deletePdf(id: string): void {
    try { fs.rmSync(path.join(this.fileDir(), `${id}.pdf`), { force: true }); } catch { /* ignore */ }
  }

  /** 导出文档到 .file/docs-edit/（供「在 VSCode 中打开」唤起本地编辑器，memo msuxceh7） */
  exportForEdit(item: DocItem): { ok: boolean; path?: string; message?: string } {
    const dir = path.join(path.resolve(process.cwd()), ".file", "docs-edit");
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, message: (e as Error).message }; }
    const safe = item.name.replace(/[\\/:*?"<>|]/g, "_");
    const target = path.join(dir, safe);
    try {
      if (item.type === "md") {
        const content = kvGet<string>(DOCS_CONTENT_PREFIX + item.id) ?? "";
        fs.writeFileSync(target, content, "utf8");
      } else {
        const buf = this.readPdf(item.id);
        if (!buf) return { ok: false, message: "pdf 文件不存在" };
        fs.writeFileSync(target, buf);
      }
      return { ok: true, path: target };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}

// ============================================================
// 服务 3：DocIndexService（检索/聚合：tag 统计 + 过滤，消费 DocStore）
// ============================================================

export class DocIndexService extends Service {
  constructor(ctx: Context) {
    super(ctx, "docIndex");
  }

  /** 全部 tag 聚合（去重计数） */
  listTags(): { name: string; count: number }[] {
    const map = new Map<string, number>();
    for (const i of this.ctx.docStore.listItems()) for (const t of i.tags) map.set(t, (map.get(t) ?? 0) + 1);
    return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }

  /** 过滤（文件夹 + tag；folderId=null 表示全部） */
  filter(items: DocItem[], opts: { folderId?: string | null; tag?: string | null }): DocItem[] {
    return items.filter((i) => {
      if (opts.folderId && i.folderId !== opts.folderId) return false;
      if (opts.tag && !i.tags.includes(opts.tag)) return false;
      return true;
    });
  }
}

// ============================================================
// 服务 4：DocImportService（导入：multipart 上传解析 + 知乎导入，消费 Store + File）
// ============================================================

export class DocImportService extends Service {
  constructor(ctx: Context) {
    super(ctx, "docImport");
  }

  /** multipart 上传解析：相对路径递归建文件夹；md 存 KV、pdf 写文件系统 */
  async uploadParse(
    form: FormData,
    opts: { folderId?: string; tags: string[] }
  ): Promise<{ created: { name: string; type: string }[]; errors: string[] }> {
    const store = this.ctx.docStore;
    const file = this.ctx.docFile;
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    const created: { name: string; type: string }[] = [];
    const errors: string[] = [];
    for (const f of files) {
      try {
        const relPath = (f as unknown as { webkitRelativePath?: string }).webkitRelativePath || f.name;
        const parts = relPath.split("/").filter(Boolean);
        const fileName = parts.pop() ?? f.name;
        if (!fileName || fileName.startsWith(".")) continue;
        const ext = path.extname(fileName).toLowerCase();
        if (![".md", ".markdown", ".pdf"].includes(ext)) { errors.push(`${fileName}: 仅支持 md/pdf`); continue; }
        let cur = opts.folderId;
        for (const dirName of parts) {
          const folders = store.listFolders();
          const exist = folders.find((x) => x.name === dirName && (x.parentId ?? null) === (cur ?? null));
          if (exist) cur = exist.id;
          else cur = store.createFolder(dirName, cur).find((x) => x.name === dirName)!.id;
        }
        const buf = Buffer.from(await f.arrayBuffer());
        const isPdf = ext === ".pdf";
        const item = store.createItem({
          name: fileName,
          type: isPdf ? "pdf" : "md",
          folderId: cur,
          tags: opts.tags,
          ...(isPdf ? { size: buf.length } : { content: buf.toString("utf8"), size: buf.length }),
        });
        if (!item) { errors.push(`${fileName}: 文档数已达上限`); continue; }
        if (isPdf) file.writePdf(item.id, buf);
        created.push({ name: fileName, type: item.type });
      } catch (e) {
        errors.push(`${f.name}: ${(e as Error).message}`);
      }
    }
    return { created, errors };
  }

  /** 知乎爬取结果列表（供导入选择） */
  zhihuResults(): { resultId: string; user: string; total: number; savedAt: string; items: { title: string; kind: string; url?: string }[] }[] {
    const keys = kvListRaw("zhihuCrawl:result:").map((x) => x.key);
    return keys
      .map((k) => {
        const v = kvGet<{ ok?: boolean; user?: string; items?: { title?: string; kind?: string; url?: string }[]; total?: number; savedAt?: string }>(k);
        if (!v) return null;
        return {
          resultId: k.replace("zhihuCrawl:result:", ""),
          user: v.user ?? "",
          total: v.items?.length ?? 0,
          savedAt: v.savedAt ?? "",
          items: (v.items ?? []).map((i) => ({ title: i.title ?? "", kind: i.kind ?? "", url: i.url })),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
      .slice(0, 30);
  }

  /** 知乎结果批量导入为文档 */
  importZhihu(resultIds: string[], folderId?: string, tags: string[] = []): { imported: number; errors: string[] } {
    const store = this.ctx.docStore;
    let imported = 0;
    const errors: string[] = [];
    for (const rid of resultIds) {
      const v = kvGet<{ items?: { title?: string; kind?: string; content?: string; url?: string }[] }>(`zhihuCrawl:result:${rid}`);
      if (!v || !Array.isArray(v.items)) { errors.push(`${rid}: 结果不存在`); continue; }
      for (const it of v.items) {
        const title = it.title?.trim();
        if (!title) continue;
        const item = store.createItem({
          name: `${title}.md`,
          type: "md",
          folderId,
          tags: [...new Set([...tags, "知乎", it.kind ?? ""].filter(Boolean))],
          content: it.content ?? "",
          size: (it.content ?? "").length,
          source: { kind: it.kind ?? "zhihu", url: it.url },
        });
        if (item) imported++;
      }
    }
    return { imported, errors };
  }

  /** DeepSeek Chat Share 导入为 md 文档（memo msuwx8k2）：
   *  提取分享对话 → 转 markdown（标题 + 消息序列 + 思考折叠）→ 存为文档 */
  async importFromDeepseek(
    url: string,
    folderId?: string,
    tags: string[] = []
  ): Promise<{ ok: boolean; message?: string; created?: { name: string; type: string }[] }> {
    const shareId = parseShareId(url);
    if (!shareId) return { ok: false, message: "无法解析 DeepSeek 分享链接或 share id" };
    const r = await extractShare(shareId);
    if (!r.ok) return { ok: false, message: r.message };
    const store = this.ctx.docStore;
    const title = r.title || `对话-${shareId.slice(0, 8)}`;
    const safeName = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) + ".md";
    const content = chatToMarkdown(title, r.url, r.messages);
    const item = store.createItem({
      name: safeName,
      type: "md",
      folderId,
      tags: [...new Set([...tags, "DeepSeek"].filter(Boolean))],
      content,
      size: content.length,
      source: { kind: "deepseek-share", url: r.url },
    });
    if (!item) return { ok: false, message: "文档数已达上限" };
    return { ok: true, created: [{ name: safeName, type: "md" }] };
  }
}

/** DeepSeek 对话 → markdown 文档（纯函数，供单测）：
 *  标题 + 来源 + 逐条消息（用户/助手徽标 + 思考折叠 + 正文） */
export function chatToMarkdown(title: string, url: string, messages: ShareMessage[]): string {
  const parts: string[] = [`# ${title}`, "", `> 来源：DeepSeek Chat 分享 · ${url}`, ""];
  for (const m of messages) {
    parts.push(m.role === "user" ? "## 🧑 用户" : "## 🤖 助手", "");
    if (m.thinking) {
      parts.push("<details>", "<summary>🧠 思考过程</summary>", "", m.thinking.trim(), "", "</details>", "");
    }
    parts.push(m.content.trim(), "");
  }
  return parts.join("\n");
}

// ============================================================
// declare module：四个服务加入 Context 接口（编译时类型安全）
// ============================================================

declare module "@deepseek-ai/cordis" {
  interface Context {
    docStore: DocStoreService;
    docFile: DocFileService;
    docIndex: DocIndexService;
    docImport: DocImportService;
  }
}
