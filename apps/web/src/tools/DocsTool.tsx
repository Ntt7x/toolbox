// ============================================================
// 文档中心（工具分组）：markdown / pdf 管理与浏览
//   - 左栏：文件夹树（右键菜单/拖拽/新建/改名/删除）+ tag 过滤 + 回收站入口
//   - 右栏：文档列表 + 预览（md 渲染 / pdf iframe）+ 右键菜单 + 拖拽移动
//   - 上传：本地文件/文件夹（webkitdirectory 递归建文件夹）
//   - 知乎导入：爬虫历史结果批量导入为文档
//   - 回收站：软删除可恢复（文档/文件夹），支持整树恢复/彻底删除/清空
// ============================================================
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg } from "../api";
import { PageHeader } from "../ui";
import { MarkdownView } from "../MarkdownView";
import type { DocFolder, DocItem, ZhihuCrawlBrief } from "@toolbox/shared";

const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1rem 1.25rem",
  marginBottom: "1rem",
};

const TYPE_LABEL: Record<string, string> = { md: "MD", pdf: "PDF" };
const TYPE_COLOR: Record<string, string> = { md: "#2563eb", pdf: "#dc2626" };

/** 右键菜单项 */
interface MenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  onClick: () => void;
}

export default function DocsTool() {
  const [folders, setFolders] = useState<DocFolder[]>([]);
  const [items, setItems] = useState<DocItem[]>([]);
  const [tags, setTags] = useState<{ name: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // 筛选
  const [curFolder, setCurFolder] = useState<string | null>(null);   // null = 全部
  const [curTag, setCurTag] = useState<string | null>(null);
  // 预览（vscode 风格多 tab + 内容缓存，memo msuxb24k/msuxe7hg）
  //  - openTabs 保留会话内打开过的文档（含缓存内容）；activeTabId=null 时预览收起（遮罩/Esc）
  //  - 关闭 tab 从列表移除但内容留在 contentCache，重新打开不重复请求
  const [openTabs, setOpenTabs] = useState<{ item: DocItem; content?: string; busy?: boolean }[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const contentCache = useRef<Map<string, string>>(new Map());
  // 上传
  const [uploadTags, setUploadTags] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  // 知乎导入
  const [zhihuOpen, setZhihuOpen] = useState(false);
  const [zhihuResults, setZhihuResults] = useState<ZhihuCrawlBrief[]>([]);
  const [zhihuSel, setZhihuSel] = useState<Set<string>>(new Set());
  // DeepSeek Chat 导入
  const [chatOpen, setChatOpen] = useState(false);
  const [chatUrl, setChatUrl] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  // 新建文件夹
  const [newFolderName, setNewFolderName] = useState("");
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [editFolderName, setEditFolderName] = useState("");
  // 右键菜单
  const [menu, setMenu] = useState<{ x: number; y: number; kind: "folder" | "item"; id: string } | null>(null);
  // 拖拽
  const [dragOver, setDragOver] = useState<string | null>(null);   // 高亮目标文件夹
  // 折叠
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());   // 已折叠的文件夹 id
  const [trashView, setTrashView] = useState(false);
  const [trash, setTrash] = useState<{ items: DocItem[]; folders: DocFolder[] }>({ items: [], folders: [] });

  const load = useCallback(async () => {
    try {
      const r = await api.docsList();
      setFolders(r.folders);
      setItems(r.items);
      setTags(r.tags);
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTrash = useCallback(async () => {
    try {
      const r = await api.docsTrash();
      setTrash({ items: r.items, folders: r.folders });
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadTrash(); }, [loadTrash]);
  // Escape 收起预览（vscode 习惯；保留 openTabs 与缓存）
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setActiveTabId(null); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ---------- 文件夹树工具 ----------
  const childrenOf = useCallback((parentId: string | null) =>
    folders.filter((f) => (f.parentId ?? null) === parentId), [folders]);

  const folderName = useMemo(() => new Map(folders.map((f) => [f.id, f.name])), [folders]);

  // ---------- 筛选 ----------
  const visibleItems = useMemo(() => {
    return items.filter((i) => {
      if (curFolder && i.folderId !== curFolder) return false;
      if (curTag && !i.tags.includes(curTag)) return false;
      return true;
    });
  }, [items, curFolder, curTag]);

  // ---------- 上传 ----------
  const doUpload = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setMsg(null);
    try {
      const tagsArr = uploadTags.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
      const r = await api.docsUpload(files, curFolder ?? undefined, tagsArr);
      setItems(r.items);
      setFolders(r.folders);
      setTags(r.tags);
      const errs = r.errors ?? [];
      setMsg({ kind: errs.length ? "err" : "ok", text: errs.length ? `部分失败：${errs.join("；")}` : `✅ 已上传 ${r.created.length} 个文档` });
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
      if (dirInput.current) dirInput.current.value = "";
    }
  };

  // ---------- 预览 ----------
  const openPreview = async (it: DocItem) => {
    const exist = openTabs.find((t) => t.item.id === it.id);
    if (exist) { setActiveTabId(it.id); return; }
    // 内容缓存命中 → 直接展示不请求（memo msuxb24k）
    const cached = contentCache.current.get(it.id);
    if (cached !== undefined) {
      setOpenTabs((p) => [...p, { item: it, content: cached }]);
      setActiveTabId(it.id);
      return;
    }
    setOpenTabs((p) => [...p, { item: it, busy: it.type === "md" }]);
    setActiveTabId(it.id);
    if (it.type !== "md") return;
    try {
      const r = await api.docsDetail(it.id);
      contentCache.current.set(it.id, r.content ?? "");
      setOpenTabs((p) => p.map((t) => (t.item.id === it.id ? { item: it, content: r.content, busy: false } : t)));
    } catch (e) {
      setOpenTabs((p) => p.map((t) => (t.item.id === it.id ? { item: it, content: "❌ 加载失败：" + errMsg(e), busy: false } : t)));
    }
  };

  const closeTab = (id: string) => {
    setOpenTabs((p) => {
      const idx = p.findIndex((t) => t.item.id === id);
      const next = p.filter((t) => t.item.id !== id);
      if (activeTabId === id) setActiveTabId(next[Math.min(idx, next.length - 1)]?.item.id ?? null);
      return next;
    });
  };

  // 收起预览（遮罩/Esc）：保留 openTabs 与缓存，方便继续打开新文档（vscode 式多 tab）
  const collapsePreview = () => setActiveTabId(null);

  const activeTab = openTabs.find((t) => t.item.id === activeTabId) ?? null;

  // 复制当前文档内容（md 源码）
  const copyActive = async () => {
    if (!activeTab) return;
    if (activeTab.item.type === "pdf") { setMsg({ kind: "err", text: "PDF 不支持复制内容，请在新窗口查看" }); return; }
    try { await navigator.clipboard.writeText(activeTab.content ?? ""); setMsg({ kind: "ok", text: `✅ 已复制「${activeTab.item.name}」内容` }); }
    catch (e) { setMsg({ kind: "err", text: "复制失败：" + errMsg(e) }); }
  };

  // 在 VSCode 中打开（导出到本地文件后唤起）
  const openInVscode = async () => {
    if (!activeTab) return;
    try {
      const r = await api.docsExportFile(activeTab.item.id);
      if (r.ok && r.path) {
        const vscodeUrl = "vscode://file/" + r.path.replace(/\\/g, "/");
        window.open(vscodeUrl, "_blank");
        setMsg({ kind: "ok", text: "✅ 已唤起 VSCode（如未打开，请确认已安装 VSCode 并允许 vscode:// 协议）" });
      } else setMsg({ kind: "err", text: r.message ?? "导出失败" });
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
  };

  // 编辑模式（tab 内切换 浏览/编辑，保存后更新缓存）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const toggleEdit = () => {
    if (!activeTab || activeTab.item.type !== "md") return;
    if (editingId === activeTab.item.id) { void saveEdit(); }
    else { setEditText(activeTab.content ?? ""); setEditingId(activeTab.item.id); }
  };
  const saveEdit = async () => {
    if (!activeTab) return;
    try {
      const r = await api.docsUpdate(activeTab.item.id, { content: editText });
      contentCache.current.set(activeTab.item.id, editText);
      setOpenTabs((p) => p.map((t) => (t.item.id === activeTab.item.id ? { ...t, content: editText, busy: false } : t)));
      setItems(r.items);
      setEditingId(null);
      setMsg({ kind: "ok", text: "✅ 已保存" });
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
  };

  // ---------- 操作（软删回收站） ----------
  const removeItem = async (it: DocItem) => {
    if (!confirm(`将「${it.name}」移到回收站？可恢复`)) return;
    try {
      const r = await api.docsDelete(it.id);
      setItems(r.items); setFolders(r.folders); setTags(r.tags);
      await loadTrash();
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
  };

  const moveItem = async (it: DocItem, folderId: string | "none") => {
    try {
      const r = await api.docsUpdate(it.id, { folderId });
      setItems(r.items); setFolders(r.folders); setTags(r.tags);
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
  };

  const moveFolderTo = async (fid: string, folderId: string | "none") => {
    // 禁止拖进自身/子孙（树环）
    const target = folderId === "none" ? null : folderId;
    if (target === fid) return;
    const all = [fid, ...folders.filter((f) => f.parentId === fid).map((f) => f.id)];
    if (target && all.includes(target)) { setMsg({ kind: "err", text: "不能把文件夹移入自身或子文件夹" }); return; }
    try {
      const r = await api.docsFolderMove(fid, target);
      setFolders(r.folders);
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
  };

  const addTagToItem = async (it: DocItem, tag: string) => {
    if (!tag.trim()) return;
    try {
      const r = await api.docsUpdate(it.id, { tags: [...new Set([...it.tags, tag.trim()])] });
      setItems(r.items); setFolders(r.folders); setTags(r.tags);
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
  };

  const removeTagFromItem = async (it: DocItem, tag: string) => {
    try {
      const r = await api.docsUpdate(it.id, { tags: it.tags.filter((t) => t !== tag) });
      setItems(r.items); setFolders(r.folders); setTags(r.tags);
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
  };

  // ---------- 文件夹操作 ----------
  const createFolder = async (parentId?: string) => {
    const name = (parentId ? newFolderName : newFolderName).trim();
    if (!name) return;
    try {
      const r = await api.docsFolderCreate(name, parentId ?? curFolder ?? undefined);
      setFolders(r.folders);
      setNewFolderName("");
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
  };

  const renameFolder = async (id: string) => {
    try {
      const r = await api.docsFolderRename(id, editFolderName.trim());
      setFolders(r.folders);
      setEditingFolder(null);
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
  };

  const removeFolder = async (f: DocFolder) => {
    const subCount = folders.filter((x) => x.parentId === f.id).length;
    if (!confirm(`将文件夹「${f.name}」移到回收站？${subCount > 0 ? ` ${subCount} 个子文件夹及其中文档一并移入，` : ""}可恢复`)) return;
    try {
      const r = await api.docsFolderDelete(f.id);
      setFolders(r.folders); setItems(r.items); setTags(r.tags);
      await loadTrash();
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
  };

  // ---------- 回收站操作 ----------
  const restoreItem = async (it: DocItem) => {
    try {
      const r = await api.docsRestore(it.id);
      setItems(r.items); setFolders(r.folders); setTags(r.tags);
      await loadTrash();
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
  };
  const purgeItem = async (it: DocItem) => {
    if (!confirm(`彻底删除「${it.name}」？不可恢复`)) return;
    try {
      const r = await api.docsPurge(it.id);
      setItems(r.items); setFolders(r.folders); setTags(r.tags);
      await loadTrash();
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
  };
  const restoreFolder = async (f: DocFolder) => {
    try {
      const r = await api.docsFolderRestore(f.id);
      setFolders(r.folders); setItems(r.items); setTags(r.tags);
      await loadTrash();
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
  };
  const purgeFolder = async (f: DocFolder) => {
    if (!confirm(`彻底删除文件夹「${f.name}」整树？不可恢复`)) return;
    try {
      const r = await api.docsFolderPurge(f.id);
      setFolders(r.folders); setItems(r.items); setTags(r.tags);
      await loadTrash();
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
  };
  const emptyTrash = async () => {
    if (!confirm(`清空回收站（${trash.items.length} 文档 / ${trash.folders.length} 文件夹）？不可恢复`)) return;
    try {
      const r = await api.docsEmptyTrash();
      setItems(r.items); setFolders(r.folders); setTags(r.tags);
      await loadTrash();
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
  };

  // ---------- 知乎导入 ----------
  const loadZhihu = async () => {
    try {
      const r = await api.docsZhihuResults();
      setZhihuResults(r.results);
      setZhihuOpen(true);
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
  };

  const zhihuImport = async () => {
    if (zhihuSel.size === 0) return;
    try {
      const r = await api.docsZhihuImport([...zhihuSel], curFolder ?? undefined);
      setItems(r.items); setFolders(r.folders); setTags(r.tags);
      setMsg({ kind: r.imported > 0 ? "ok" : "err", text: r.imported > 0 ? `✅ 已导入 ${r.imported} 篇` : `未导入任何文档${r.errors?.length ? `：${r.errors.join("；")}` : ""}` });
      setZhihuOpen(false);
      setZhihuSel(new Set());
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
  };

  // DeepSeek Chat Share 导入
  const deepseekImport = async () => {
    const url = chatUrl.trim();
    if (!url || chatBusy) return;
    setChatBusy(true);
    try {
      const r = await api.docsDeepseekImport(url, curFolder ?? undefined);
      setItems(r.items); setFolders(r.folders); setTags(r.tags);
      setMsg({ kind: r.created && r.created.length > 0 ? "ok" : "err", text: r.created && r.created.length > 0 ? `✅ 已导入 ${r.created.length} 个文档` : (r.message ?? "导入失败") });
      setChatOpen(false);
    } catch (e) { setMsg({ kind: "err", text: errMsg(e) }); }
    finally { setChatBusy(false); }
  };

  // ---------- 右键菜单 ----------
  const openMenu = (e: React.MouseEvent, kind: "folder" | "item", id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, kind, id });
  };

  const menuItems = (): MenuItem[] => {
    if (!menu) return [];
    if (menu.kind === "folder") {
      const f = folders.find((x) => x.id === menu.id);
      if (!f) return [];
      return [
        { label: "设为当前", icon: "📍", onClick: () => { setCurFolder(f.id); setTrashView(false); } },
        { label: "新建子文件夹", icon: "📁", onClick: () => { setCurFolder(f.id); setNewFolderName(""); setTimeout(() => { document.getElementById("new-folder-input")?.focus(); }, 0); } },
        { label: "重命名", icon: "✎", onClick: () => { setEditingFolder(f.id); setEditFolderName(f.name); } },
        { label: "移到回收站", icon: "🗑️", danger: true, onClick: () => void removeFolder(f) },
      ];
    }
    const it = items.find((x) => x.id === menu.id);
    if (!it) return [];
    return [
      { label: "预览", icon: "👁️", onClick: () => void openPreview(it) },
      { label: "添加标签", icon: "#", onClick: () => { const t = prompt("添加标签", ""); if (t) void addTagToItem(it, t); } },
      { label: "移到回收站", icon: "🗑️", danger: true, onClick: () => void removeItem(it) },
    ];
  };

  // ---------- 拖拽 ----------
  const onDropToFolder = (e: React.DragEvent, folderId: string | null) => {
    e.preventDefault();
    setDragOver(null);
    const docId = e.dataTransfer.getData("text/doc");
    const fid = e.dataTransfer.getData("text/folder");
    if (docId) {
      const it = items.find((x) => x.id === docId);
      if (it) void moveItem(it, folderId ?? "none");
    } else if (fid) {
      void moveFolderTo(fid, folderId ?? "none");
    }
  };

  // ---------- 渲染：文件夹树行 ----------
  /** 文件夹内文档叶子（vscode 资源管理器式；tag 过滤时只显示匹配） */
  const folderDocs = (fid: string | null) =>
    items.filter((i) => (i.folderId ?? null) === fid && (!curTag || i.tags.includes(curTag)));

  /** 文档叶子行：点击在编辑器区打开 */
  const renderDocLeaf = (it: DocItem, depth: number) => (
    <div
      key={it.id}
      onClick={() => { setTrashView(false); void openPreview(it); }}
      onContextMenu={(e) => openMenu(e, "item", it.id)}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData("text/doc", it.id); e.dataTransfer.effectAllowed = "move"; }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(it.id); }}
      onDragLeave={() => setDragOver((d) => (d === it.id ? null : d))}
      onDrop={(e) => { e.stopPropagation(); void onDropToFolder(e, it.id); }}
      style={{
        display: "flex", alignItems: "center", gap: "0.35rem", cursor: "pointer",
        padding: "0.28rem 0.45rem", paddingLeft: `${0.45 + depth * 0.9}rem`, borderRadius: 6,
        background: dragOver === it.id ? "#dbeafe" : openTabs.some((t) => t.item.id === it.id) && activeTabId === it.id ? "#eff6ff" : "transparent",
        fontSize: "0.85rem", color: activeTabId === it.id ? "#2563eb" : "#475569",
        outline: dragOver === it.id ? "1px dashed #3b82f6" : "none",
      }}
      title={`${it.name}（右键更多操作，可拖拽）`}
    >
      <span style={{ width: 14, textAlign: "center", flexShrink: 0 }}>{it.type === "pdf" ? "📕" : "📄"}</span>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
      {it.source?.kind === "answer" || it.source?.kind === "article" ? (
        <span style={{ fontSize: "0.62rem", color: "#94a3b8" }}>{it.source.kind === "answer" ? "答" : "文"}</span>
      ) : null}
    </div>
  );

  /** 文档叶子（vscode 资源管理器式）：在 renderFolder 之后渲染该文件夹下文档 */
  const renderFolder = (f: DocFolder, depth: number) => {
    const childCount = folders.filter((x) => x.parentId === f.id).length;
    return (
      <Fragment key={f.id}>
        <div
          onClick={() => { setCurFolder(curFolder === f.id ? null : f.id); setTrashView(false); }}
          onContextMenu={(e) => openMenu(e, "folder", f.id)}
          draggable
          onDragStart={(e) => { e.dataTransfer.setData("text/folder", f.id); e.dataTransfer.effectAllowed = "move"; }}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(f.id); }}
          onDragLeave={() => setDragOver((d) => (d === f.id ? null : d))}
          onDrop={(e) => { e.stopPropagation(); void onDropToFolder(e, f.id); }}
          style={{
            display: "flex", alignItems: "center", gap: "0.35rem", cursor: "pointer",
            padding: "0.3rem 0.45rem", paddingLeft: `${0.45 + depth * 0.9}rem`, borderRadius: 6,
            background: dragOver === f.id ? "#dbeafe" : curFolder === f.id ? "#eff6ff" : "transparent",
            fontSize: "0.86rem", color: curFolder === f.id ? "#2563eb" : "#334155",
            outline: dragOver === f.id ? "1px dashed #3b82f6" : "none",
          }}
        >
          {childCount > 0 ? (
            <span
              onClick={(e) => { e.stopPropagation(); setCollapsed((c) => { const n = new Set(c); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; }); }}
              style={{ fontSize: "0.6rem", color: "#64748b", width: 14, textAlign: "center", cursor: "pointer", userSelect: "none" }}
              title={collapsed.has(f.id) ? "展开" : "收起"}
            >
              {collapsed.has(f.id) ? "▶" : "▼"}
            </span>
          ) : (
            <span style={{ width: 14 }} />
          )}
          <span>📁</span>
          {editingFolder === f.id ? (
            <input
              autoFocus
              value={editFolderName}
              onChange={(e) => setEditFolderName(e.target.value)}
              onBlur={() => void renameFolder(f.id)}
              onKeyDown={(e) => e.key === "Enter" && void renameFolder(f.id)}
              onClick={(e) => e.stopPropagation()}
              style={{ flex: 1, fontSize: "0.82rem", padding: "0.15rem 0.4rem", borderRadius: 4, border: "1px solid #3b82f6" }}
            />
          ) : (
            <span style={{ flex: 1 }} title={`${f.name}（右键更多操作，可拖拽）`}>{f.name}</span>
          )}
          <span style={{ fontSize: "0.7rem", color: "#94a3b8" }}>{items.filter((i) => i.folderId === f.id).length}</span>
        </div>
        {!collapsed.has(f.id) ? childrenOf(f.id).map((c) => renderFolder(c, depth + 1)) : null}
        {!collapsed.has(f.id) ? folderDocs(f.id).map((it) => renderDocLeaf(it, depth + 1)) : null}
      </Fragment>
    );
  };

  const rootFolders = folders.filter((f) => !f.parentId);
  const trashCount = trash.items.length + trash.folders.length;

  return (
    <div>
      <PageHeader title="文档中心" desc="markdown / pdf 管理与浏览 · 文件夹 + tag · 右键/拖拽 · 回收站" />
      {/* 工具栏 */}
      <div style={card}>
        <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
          <input type="file" ref={fileInput} multiple accept=".md,.markdown,.pdf" style={{ display: "none" }} onChange={(e) => void doUpload([...(e.target.files ?? [])])} />
          <input
            type="file" ref={dirInput} multiple
            // @ts-expect-error webkitdirectory 非标准属性
            webkitdirectory=""
            style={{ display: "none" }}
            onChange={(e) => void doUpload([...(e.target.files ?? [])])}
          />
          <button onClick={() => fileInput.current?.click()} disabled={uploading} style={{ padding: "0.5rem 1rem", borderRadius: 8, border: "none", background: "#3b82f6", color: "#fff", fontSize: "0.88rem", fontWeight: 600, cursor: "pointer", opacity: uploading ? 0.6 : 1 }}>
            {uploading ? "上传中…" : "📄 上传文件"}
          </button>
          <button onClick={() => dirInput.current?.click()} disabled={uploading} style={{ padding: "0.5rem 1rem", borderRadius: 8, border: "1px solid #cbd5e1", background: "#fff", color: "#334155", fontSize: "0.88rem", cursor: "pointer" }}>
            📁 上传文件夹
          </button>
          <input
            value={uploadTags}
            onChange={(e) => setUploadTags(e.target.value)}
            placeholder="上传标签（逗号分隔）"
            style={{ flex: 1, minWidth: 160, padding: "0.5rem 0.7rem", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: "0.86rem" }}
          />
          <button onClick={() => void loadZhihu()} style={{ padding: "0.5rem 1rem", borderRadius: 8, border: "1px solid #cbd5e1", background: "#fff", color: "#334155", fontSize: "0.88rem", cursor: "pointer" }}>
            🤖 知乎导入
          </button>
          <button onClick={() => { setChatUrl(""); setChatOpen(true); }} style={{ padding: "0.5rem 1rem", borderRadius: 8, border: "1px solid #cbd5e1", background: "#fff", color: "#334155", fontSize: "0.88rem", cursor: "pointer" }}>
            🔗 Chat 导入
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.6rem", flexWrap: "wrap" }}>
          <button onClick={() => { setCurFolder(null); setTrashView(false); }} style={{ padding: "0.3rem 0.7rem", borderRadius: 999, border: "1px solid " + (!trashView && curFolder === null ? "#3b82f6" : "#e2e8f0"), background: !trashView && curFolder === null ? "#eff6ff" : "#fff", color: !trashView && curFolder === null ? "#2563eb" : "#64748b", fontSize: "0.76rem", cursor: "pointer" }}>
            全部 {items.length}
          </button>
          {!trashView && tags.map((t) => (
            <button key={t.name} onClick={() => setCurTag(curTag === t.name ? null : t.name)} style={{ padding: "0.3rem 0.7rem", borderRadius: 999, border: "1px solid " + (curTag === t.name ? "#3b82f6" : "#e2e8f0"), background: curTag === t.name ? "#eff6ff" : "#fff", color: curTag === t.name ? "#2563eb" : "#64748b", fontSize: "0.76rem", cursor: "pointer" }}>
              #{t.name} {t.count}
            </button>
          ))}
          <button onClick={() => { setTrashView(!trashView); setCurFolder(null); setCurTag(null); }} style={{ marginLeft: "auto", padding: "0.3rem 0.7rem", borderRadius: 999, border: "1px solid " + (trashView ? "#dc2626" : "#e2e8f0"), background: trashView ? "#fef2f2" : "#fff", color: trashView ? "#dc2626" : "#64748b", fontSize: "0.76rem", cursor: "pointer" }}>
            🗑️ 回收站 {trashCount > 0 ? `(${trashCount})` : ""}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start" }}>
        {/* 左栏：文件夹树 */}
        <div style={{ ...card, width: 240, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.5rem" }}>
            <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "#334155", flex: 1 }}>文件夹</span>
            <button onClick={() => void createFolder()} disabled={!newFolderName.trim()} title="在当前选中文件夹下新建" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: "0.85rem", color: "#3b82f6" }}>＋</button>
          </div>
          <div
            onClick={() => { setCurFolder(null); setTrashView(false); }}
            onDragOver={(e) => { e.preventDefault(); setDragOver("__root__"); }}
            onDragLeave={() => setDragOver((d) => (d === "__root__" ? null : d))}
            onDrop={(e) => void onDropToFolder(e, null)}
            style={{ cursor: "pointer", padding: "0.3rem 0.45rem", borderRadius: 6, background: dragOver === "__root__" ? "#dbeafe" : curFolder === null && !trashView ? "#eff6ff" : "transparent", fontSize: "0.86rem", color: curFolder === null && !trashView ? "#2563eb" : "#334155", outline: dragOver === "__root__" ? "1px dashed #3b82f6" : "none" }}
            title="拖文档到此处 = 移到根目录"
          >
            🗂️ 根目录
          </div>
          {folderDocs(null).map((it) => renderDocLeaf(it, 0))}
          {rootFolders.map((f) => renderFolder(f, 0))}
          <input
            id="new-folder-input"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void createFolder()}
            placeholder="新文件夹名（回车）"
            style={{ width: "100%", boxSizing: "border-box", marginTop: "0.5rem", padding: "0.35rem 0.5rem", borderRadius: 6, border: "1px solid #cbd5e1", fontSize: "0.8rem" }}
          />
        </div>

        {/* 右栏：编辑器区（vscode 风格：tab 栏 + 内容，非弹窗；memo msuxq76n） */}
        <div style={{ ...card, flex: 1, display: "flex", flexDirection: "column", minWidth: 0, padding: 0, overflow: "hidden" }}>
          {trashView ? (
            <div style={{ padding: "1rem 1.25rem", overflow: "auto", flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.6rem", fontSize: "0.85rem", color: "#334155" }}>
                <span style={{ fontWeight: 600 }}>🗑️ 回收站</span>
                <span style={{ fontSize: "0.75rem", color: "#94a3b8" }}>删除后保留，可恢复；彻底删除不可恢复</span>
                {(trash.items.length > 0 || trash.folders.length > 0) && (
                  <button onClick={() => void emptyTrash()} style={{ marginLeft: "auto", padding: "0.3rem 0.8rem", borderRadius: 6, border: "1px solid #fecaca", background: "#fef2f2", color: "#dc2626", fontSize: "0.78rem", cursor: "pointer" }}>清空回收站</button>
                )}
              </div>
              {trash.items.length === 0 && trash.folders.length === 0 ? (
                <div style={{ textAlign: "center", padding: "2rem", color: "#94a3b8", fontSize: "0.9rem" }}>回收站是空的</div>
              ) : (
                <>
                  {trash.folders.map((f) => (
                    <div key={f.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.45rem 0.55rem", borderRadius: 8, marginBottom: "0.3rem", border: "1px solid #fecaca", background: "#fff7f7" }}>
                      <span>📁</span>
                      <span style={{ flex: 1, fontSize: "0.88rem", color: "#334155" }}>{f.name}</span>
                      <span style={{ fontSize: "0.7rem", color: "#94a3b8" }}>{f.deletedAt?.slice(0, 10)}</span>
                      <button onClick={() => void restoreFolder(f)} style={{ padding: "0.25rem 0.7rem", borderRadius: 6, border: "1px solid #bbf7d0", background: "#f0fdf4", color: "#16a34a", fontSize: "0.76rem", cursor: "pointer" }}>恢复</button>
                      <button onClick={() => void purgeFolder(f)} title="彻底删除整树" style={{ padding: "0.25rem 0.6rem", borderRadius: 6, border: "1px solid #fecaca", background: "#fff", color: "#dc2626", fontSize: "0.76rem", cursor: "pointer" }}>彻底删除</button>
                    </div>
                  ))}
                  {trash.items.map((it) => (
                    <div key={it.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.45rem 0.55rem", borderRadius: 8, marginBottom: "0.3rem", border: "1px solid #eef2f7", background: "#fff" }}>
                      <span style={{ flexShrink: 0, fontSize: "0.66rem", fontWeight: 700, color: "#fff", background: TYPE_COLOR[it.type], borderRadius: 4, padding: "0.1rem 0.35rem" }}>{TYPE_LABEL[it.type]}</span>
                      <span style={{ flex: 1, fontSize: "0.88rem", color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
                      <span style={{ fontSize: "0.7rem", color: "#94a3b8" }}>{it.deletedAt?.slice(0, 10)}</span>
                      <button onClick={() => void restoreItem(it)} style={{ padding: "0.25rem 0.7rem", borderRadius: 6, border: "1px solid #bbf7d0", background: "#f0fdf4", color: "#16a34a", fontSize: "0.76rem", cursor: "pointer" }}>恢复</button>
                      <button onClick={() => void purgeItem(it)} style={{ padding: "0.25rem 0.6rem", borderRadius: 6, border: "1px solid #fecaca", background: "#fff", color: "#dc2626", fontSize: "0.76rem", cursor: "pointer" }}>彻底删除</button>
                    </div>
                  ))}
                </>
              )}
            </div>
          ) : (
            <>
              {/* tab 栏（vscode 风格，常驻编辑器区顶部） */}
              {openTabs.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid #e2e8f0", background: "#f8fafc", flexShrink: 0, overflowX: "auto" }}>
                  {openTabs.map((t) => (
                    <div key={t.item.id} onClick={() => setActiveTabId(t.item.id)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "0.45rem 0.9rem", cursor: "pointer", borderRight: "1px solid #e2e8f0", background: t.item.id === activeTabId ? "#fff" : "transparent", borderTop: t.item.id === activeTabId ? "2px solid #2563eb" : "2px solid transparent", fontSize: "0.8rem", color: t.item.id === activeTabId ? "#1e293b" : "#64748b", fontWeight: t.item.id === activeTabId ? 600 : 400, maxWidth: 220, whiteSpace: "nowrap", overflow: "hidden", flexShrink: 0 }} title={t.item.name}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.item.type === "pdf" ? "📕" : "📄"} {t.item.name}</span>
                      <span role="button" onClick={(e) => { e.stopPropagation(); closeTab(t.item.id); }} style={{ color: "#94a3b8", fontSize: "0.75rem", padding: "0 2px", borderRadius: 4, flexShrink: 0 }} title="关闭">✕</span>
                    </div>
                  ))}
                  <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, padding: "0 0.6rem", flexShrink: 0 }}>
                    {activeTab?.item.type === "md" && (
                      <>
                        <button onClick={toggleEdit} title="编辑/保存" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: "0.8rem", color: editingId === activeTab.item.id ? "#16a34a" : "#475569", padding: "0.3rem 0.5rem", borderRadius: 6 }}>{editingId === activeTab.item.id ? "💾 保存" : "✏️ 编辑"}</button>
                        <button onClick={() => void copyActive()} title="复制内容" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: "0.8rem", color: "#475569", padding: "0.3rem 0.5rem", borderRadius: 6 }}>📋 复制</button>
                        <button onClick={() => void openInVscode()} title="在 VSCode 中打开编辑" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: "0.8rem", color: "#475569", padding: "0.3rem 0.5rem", borderRadius: 6 }}>💻 VSCode</button>
                      </>
                    )}
                    {activeTab?.item.type === "pdf" && (
                      <a href={"/api/tools/docs/" + activeTab.item.id + "/file"} target="_blank" rel="noreferrer" style={{ fontSize: "0.78rem", color: "#2563eb", textDecoration: "none", padding: "0.3rem 0.5rem" }}>新窗口打开 ↗</a>
                    )}
                  </div>
                </div>
              )}
              {/* 内容区：md 居中阅读 / pdf 全幅 / 编辑模式 */}
              {activeTab ? (
                activeTab.item.type === "pdf" ? (
                  <iframe src={"/api/tools/docs/" + activeTab.item.id + "/file"} title={activeTab.item.name} style={{ flex: 1, width: "100%", border: "none", background: "#525659" }} />
                ) : activeTab.busy ? (
                  <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#94a3b8", fontSize: "0.9rem" }}>加载中…</div>
                ) : editingId === activeTab.item.id ? (
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
                    <textarea value={editText} onChange={(e) => setEditText(e.target.value)} spellCheck={false} style={{ flex: 1, width: "100%", boxSizing: "border-box", border: "none", outline: "none", padding: "1rem 1.25rem", fontFamily: "'Cascadia Code', Consolas, monospace", fontSize: "0.85rem", lineHeight: 1.7, resize: "none", background: "#fff", color: "#334155" }} />
                  </div>
                ) : (
                  <div style={{ flex: 1, overflow: "auto" }}>
                    <div style={{ maxWidth: 820, margin: "0 auto", padding: "1.25rem 1.5rem 3rem" }}>
                      <MarkdownView>{activeTab.content ?? ""}</MarkdownView>
                    </div>
                  </div>
                )
              ) : (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#94a3b8", fontSize: "0.9rem", gap: "0.4rem" }}>
                  <div style={{ fontSize: "2rem" }}>📄</div>
                  <div>从左侧文件夹选择文档，在编辑器区打开</div>
                  <div style={{ fontSize: "0.78rem" }}>上传 md/pdf 或从知乎 / DeepSeek Chat 导入；右键 / 拖拽管理</div>
                </div>
              )}
            </>
          )}        </div>
      </div>

      {/* 右键菜单 */}
      {menu && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 90 }}
          onClick={() => setMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
        >
          <div
            style={{
              position: "fixed", left: menu.x, top: menu.y, zIndex: 95,
              background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 8px 24px rgba(15,23,42,0.12)",
              padding: "0.3rem", minWidth: 160,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {menuItems().map((mi) => (
              <button
                key={mi.label}
                onClick={() => { mi.onClick(); setMenu(null); }}
                style={{
                  display: "flex", alignItems: "center", gap: "0.5rem", width: "100%", textAlign: "left",
                  padding: "0.45rem 0.7rem", borderRadius: 6, border: "none", background: "transparent",
                  fontSize: "0.84rem", cursor: "pointer", color: mi.danger ? "#dc2626" : "#334155",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#f1f5f9")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span>{mi.icon}</span> {mi.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* DeepSeek Chat 导入模态 */}
      {chatOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fff", borderRadius: 12, width: "min(560px, 95vw)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", padding: "0.7rem 1rem", borderBottom: "1px solid #e2e8f0" }}>
              <span style={{ flex: 1, fontSize: "0.92rem", fontWeight: 600, color: "#1e293b" }}>🔗 从 DeepSeek Chat 导入</span>
              <button onClick={() => setChatOpen(false)} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: "1rem", color: "#64748b" }}>✕</button>
            </div>
            <div style={{ padding: "0.9rem 1rem" }}>
              <div style={{ fontSize: "0.78rem", color: "#64748b", marginBottom: "0.4rem" }}>输入 DeepSeek 分享链接（或 share id），对话将转换为 markdown 文档（含思考过程折叠）。</div>
              <input
                autoFocus
                value={chatUrl}
                onChange={(e) => setChatUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void deepseekImport(); }}
                placeholder="https://chat.deepseek.com/share/xxxx 或裸 share id"
                style={{ width: "100%", boxSizing: "border-box", padding: "0.5rem 0.7rem", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: "0.86rem" }}
              />
            </div>
            <div style={{ padding: "0.7rem 1rem", borderTop: "1px solid #e2e8f0", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button onClick={() => setChatOpen(false)} style={{ padding: "0.45rem 1rem", borderRadius: 8, border: "1px solid #e2e8f0", background: "#fff", color: "#475569", fontSize: "0.86rem", cursor: "pointer" }}>取消</button>
              <button onClick={() => void deepseekImport()} disabled={!chatUrl.trim() || chatBusy} style={{ padding: "0.45rem 1.2rem", borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", fontSize: "0.86rem", fontWeight: 600, cursor: chatUrl.trim() && !chatBusy ? "pointer" : "not-allowed", opacity: chatUrl.trim() && !chatBusy ? 1 : 0.6 }}>
                {chatBusy ? "提取中…" : "导入为文档"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 知乎导入模态 */}
      {zhihuOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem" }} onClick={() => setZhihuOpen(false)}>
          <div style={{ background: "#fff", borderRadius: 12, width: "min(720px, 95vw)", maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", padding: "0.7rem 1rem", borderBottom: "1px solid #e2e8f0", flexShrink: 0 }}>
              <span style={{ flex: 1, fontSize: "0.92rem", fontWeight: 600, color: "#1e293b" }}>🤖 知乎爬取结果导入</span>
              <button onClick={() => setZhihuOpen(false)} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: "1rem", color: "#64748b" }}>✕</button>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "0.75rem 1rem" }}>
              {zhihuResults.length === 0 ? (
                <div style={{ textAlign: "center", padding: "1.5rem", color: "#94a3b8", fontSize: "0.88rem" }}>暂无爬取历史（先到「知乎爬虫」页面爬取）</div>
              ) : zhihuResults.map((r) => (
                <label key={r.resultId} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", padding: "0.45rem 0.4rem", borderRadius: 8, border: "1px solid #eef2f7", marginBottom: "0.35rem", cursor: "pointer" }}>
                  <input type="checkbox" checked={zhihuSel.has(r.resultId)} onChange={() => setZhihuSel((s) => { const n = new Set(s); if (n.has(r.resultId)) n.delete(r.resultId); else n.add(r.resultId); return n; })} style={{ marginTop: 4 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "0.84rem", color: "#334155" }}>@{r.user} · {r.total} 篇 · {r.savedAt.slice(0, 16).replace("T", " ")}</div>
                    <div style={{ fontSize: "0.72rem", color: "#94a3b8", marginTop: "0.15rem" }}>{r.items.slice(0, 3).map((i) => i.title).join("；")}{r.items.length > 3 ? `…等 ${r.items.length} 篇` : ""}</div>
                  </div>
                </label>
              ))}
            </div>
            <div style={{ padding: "0.7rem 1rem", borderTop: "1px solid #e2e8f0", display: "flex", justifyContent: "flex-end", gap: "0.6rem", flexShrink: 0 }}>
              <button onClick={() => setZhihuOpen(false)} style={{ padding: "0.45rem 1rem", borderRadius: 8, border: "1px solid #e2e8f0", background: "#fff", color: "#64748b", fontSize: "0.85rem", cursor: "pointer" }}>取消</button>
              <button onClick={() => void zhihuImport()} disabled={zhihuSel.size === 0} style={{ padding: "0.45rem 1.2rem", borderRadius: 8, border: "none", background: "#3b82f6", color: "#fff", fontSize: "0.85rem", fontWeight: 600, cursor: "pointer", opacity: zhihuSel.size ? 1 : 0.5 }}>
                导入选中（{zhihuSel.size} 个结果）
              </button>
            </div>
          </div>
        </div>
      )}

      {msg && (
        <div style={{ padding: "0.6rem 1rem", borderRadius: 8, fontSize: "0.85rem", marginBottom: "1rem", background: msg.kind === "ok" ? "#f0fdf4" : "#fef2f2", color: msg.kind === "ok" ? "#16a34a" : "#dc2626", border: "1px solid " + (msg.kind === "ok" ? "#bbf7d0" : "#fecaca") }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
