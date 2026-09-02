// ============================================================
// 自选股：以「标的」为跟踪主体、以「分组」为组织单元
// ------------------------------------------------------------
// 布局（与仓位管理 v2 一致）：顶部横向分组切换（基础分组 / 聚合分段）+ 下方横向功能 Tab
// 四个功能面：行情跟踪（日/周/月）· 下沉分析（财报/新闻）· 提醒设置（点位）· 逻辑确认
// 逻辑围绕标的展开：标的增删改 / 优先级重排 / 跨分组流转集中在「标的管理」区
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errMsg } from "../api";
import { ErrorCard, PageHeader, card } from "../ui";
import type { WatchGroup, WatchGroupSummary, WatchItem } from "@toolbox/shared";
import { C, SegTabs, btn, btnGhost, btnSmall, fmtPct, input, pctColor, stockDetailUrl, table, th, thTd } from "./watchlist/shared";
import TrackPanel from "./watchlist/TrackPanel";
import DeepDivePanel from "./watchlist/DeepDivePanel";
import AlertsPanel from "./watchlist/AlertsPanel";
import LogicPanel from "./watchlist/LogicPanel";

type Tab = "track" | "deep" | "alerts" | "logic";
type GroupKind = "base" | "agg";

const TABS: { value: Tab; label: string; title: string }[] = [
  { value: "track", label: "📈 行情跟踪", title: "日度 / 周度 / 月度周期行情" },
  { value: "deep", label: "🔍 下沉分析", title: "财报（LLM）/ 新闻（关键词匹配）" },
  { value: "alerts", label: "🔔 提醒设置", title: "券商式点位与涨跌幅提醒" },
  { value: "logic", label: "🧭 逻辑确认", title: "入选理由与预期随时间是否成立" },
];

const SHARE_RE = /^https:\/\/chat\.deepseek\.com\/share\/[A-Za-z0-9_-]+$/;

export default function WatchlistTool() {
  const [groups, setGroups] = useState<WatchGroupSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [group, setGroup] = useState<WatchGroup | null>(null);
  const [items, setItems] = useState<WatchItem[]>([]);
  const [tab, setTab] = useState<Tab>("track");
  const [kind, setKind] = useState<GroupKind>("base");
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const autoSelected = useRef(false);

  // 新建分组（手动 / Chat 导入）
  const [showCreate, setShowCreate] = useState(false);
  const [createTab, setCreateTab] = useState<"manual" | "chat">("manual");
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newAgg, setNewAgg] = useState(false);
  const [newSources, setNewSources] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);

  // 分组属性编辑
  const [editingMeta, setEditingMeta] = useState(false);
  const [metaName, setMetaName] = useState("");
  const [metaDesc, setMetaDesc] = useState("");
  const [metaSources, setMetaSources] = useState<string[]>([]);

  // 标的管理
  const [showItems, setShowItems] = useState(true);
  const [addCode, setAddCode] = useState("");
  const [addName, setAddName] = useState("");
  const [addReason, setAddReason] = useState("");
  const [addExpect, setAddExpect] = useState("");
  const [addKind, setAddKind] = useState<"stock" | "fund">("stock");
  const [cands, setCands] = useState<{ code: string; name: string; market: string; type: string }[]>([]);
  const [candsOpen, setCandsOpen] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  // 移动/复制标的
  const [moveItem, setMoveItem] = useState<{ code: string; name?: string } | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const [moveCopy, setMoveCopy] = useState(false);
  const [moving, setMoving] = useState(false);

  // Chat 补充（追加标的到当前分组）
  const [appendUrl, setAppendUrl] = useState("");
  const [appending, setAppending] = useState(false);
  const [showAppend, setShowAppend] = useState(false);
  const [preview, setPreview] = useState<{ taskId: string; items: WatchItem[] } | null>(null);
  const [previewSel, setPreviewSel] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  // 延续思考（分组 → DeepSeek Chat 提示词）
  const [extending, setExtending] = useState(false);
  const [extendText, setExtendText] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const r = await api.watchlistList();
      if (r.ok) setGroups(r.groups);
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await api.watchlistDetail(id);
      if (r.ok) {
        setGroup(r.group);
        setItems(r.items ?? r.group.items);
      }
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // 首次加载自动选中第一个分组
  useEffect(() => {
    if (autoSelected.current || groups.length === 0) return;
    autoSelected.current = true;
    const first = groups.find((g) => (g.aggSources?.length ? "agg" : "base") === kind) ?? groups[0];
    setKind(first.aggSources?.length ? "agg" : "base");
    setSelectedId(first.id);
    void loadDetail(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  // 切换分组 → 重置面板态
  useEffect(() => {
    setErr(null);
    setInfo(null);
    setEditingMeta(false);
    setExtendText(null);
    setPreview(null);
  }, [selectedId]);

  const isAgg = !!group?.aggSources?.length;
  const baseGroups = groups.filter((g) => !g.aggSources?.length);
  const aggGroups = groups.filter((g) => !!g.aggSources?.length);
  const visible = kind === "agg" ? aggGroups : baseGroups;

  // ---------- 分组操作 ----------

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setErr(null);
    try {
      const r = await api.watchlistCreate({ name, ...(newDesc.trim() ? { description: newDesc.trim() } : {}), ...(newAgg && newSources.length > 0 ? { aggSources: newSources } : {}) });
      if (r.ok) {
        setNewName("");
        setNewDesc("");
        setNewAgg(false);
        setNewSources([]);
        setShowCreate(false);
        setKind(r.group.aggSources?.length ? "agg" : "base");
        setSelectedId(r.group.id);
        setItems([]);
        await refreshList();
      } else setErr(r.message ?? "创建失败");
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setCreating(false);
    }
  };

  const openMetaEdit = () => {
    if (!group) return;
    setMetaName(group.name);
    setMetaDesc(group.description ?? "");
    setMetaSources(group.aggSources ?? []);
    setEditingMeta(true);
  };

  const saveMeta = async () => {
    if (!group) return;
    setErr(null);
    try {
      const r = await api.watchlistUpdate(group.id, {
        name: metaName.trim() || group.name,
        description: metaDesc.trim() || undefined,
        ...(isAgg || metaSources.length > 0 ? { aggSources: metaSources.length > 0 ? metaSources : null } : {}),
      });
      if (r.ok) {
        setGroup(r.group);
        setItems(r.items ?? r.group.items);
        setEditingMeta(false);
        await refreshList();
      } else setErr(r.message ?? "保存失败");
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  const removeGroup = async () => {
    if (!group) return;
    const n = items.length;
    if (!window.confirm(`确定删除分组「${group.name}」？${isAgg ? "（仅删除分组本身，源分组及其标的保留）" : `其下 ${n} 个标的将一并删除。`}`)) return;
    setErr(null);
    try {
      const r = await api.watchlistDelete(group.id);
      if (r.ok) {
        setSelectedId(null);
        setGroup(null);
        setItems([]);
        await refreshList();
      } else setErr(r.message ?? "删除失败");
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  // ---------- 标的管理 ----------

  const searchCandsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchCands = (v: string) => {
    if (searchCandsTimer.current) clearTimeout(searchCandsTimer.current);
    const t = v.trim();
    if (!t || /^[\dhk/]+$/i.test(t) || addKind === "fund") {
      setCandsOpen(false);
      return;
    }
    searchCandsTimer.current = setTimeout(async () => {
      try {
        const r = await api.watchlistSearchStock(t, 8);
        if (r.ok) {
          setCands(r.items ?? []);
          setCandsOpen((r.items?.length ?? 0) > 0);
        }
      } catch {
        setCandsOpen(false);
      }
    }, 320);
  };

  const addItem = async () => {
    if (!group || isAgg) return;
    let code = addCode.trim();
    if (!/^(sh|sz|hk|bj)?\d{5,6}$/i.test(code) && addKind === "stock" && code) {
      try {
        const r = await api.watchlistSearchStock(code);
        if (r.ok && r.items.length > 0) {
          code = r.items[0].code;
          setAddCode(code);
          if (!addName) setAddName(r.items[0].name);
        } else {
          setErr(`未找到「${code}」对应的标的，请直接输入代码`);
          return;
        }
      } catch (e) {
        setErr(errMsg(e));
        return;
      }
    }
    if (!code) {
      setErr(addKind === "fund" ? "请输入基金代码（6 位数字，如 161725）" : "请输入标的代码（如 600519 / sh600519 / hk00700）");
      return;
    }
    if (!addReason.trim()) {
      setErr("请输入入选理由（逻辑确认的「前提」，可在逻辑确认中复核其是否成立）");
      return;
    }
    setAdding(true);
    setErr(null);
    try {
      let name = addName.trim();
      if (!name) {
        try {
          const r = await api.watchlistResolve(code, addKind);
          if (r.ok && r.name) name = r.name;
        } catch { /* 解析失败静默 */ }
      }
      const item: WatchItem = {
        code,
        ...(name ? { name } : {}),
        ...(addKind === "fund" ? { kind: "fund" as const } : {}),
        reason: addReason.trim(),
        ...(addExpect.trim() ? { expectation: addExpect.trim() } : {}),
        addedAt: new Date().toISOString(),
      };
      const r = await api.watchlistUpdate(group.id, { addItems: [item] });
      if (r.ok) {
        setGroup(r.group);
        setItems(r.items ?? r.group.items);
        setAddCode("");
        setAddName("");
        setAddReason("");
        setAddExpect("");
        await refreshList();
      } else setErr(r.message ?? "添加失败");
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setAdding(false);
    }
  };

  const removeItem = async (code: string) => {
    if (!group || isAgg) return;
    setErr(null);
    try {
      const r = await api.watchlistUpdate(group.id, { removeCodes: [code] });
      if (r.ok) {
        setGroup(r.group);
        setItems(r.items ?? r.group.items);
        await refreshList();
      } else setErr(r.message ?? "移除失败");
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  /** 拖拽重排（顺序 = 优先级；乐观更新 + 失败回滚） */
  const reorder = async (from: number, to: number) => {
    if (!group || isAgg || from === to) return;
    const prev = items;
    const next = items.slice();
    const [moved] = next.splice(from, 1);
    next.splice(from < to ? to - 1 : to, 0, moved);
    setItems(next);
    try {
      const r = await api.watchlistUpdate(group.id, { reorderCodes: next.map((s) => s.code) });
      if (r.ok) {
        setGroup(r.group);
        setItems(r.items ?? r.group.items);
      } else setErr(r.message ?? "重排失败");
    } catch (e) {
      setItems(prev);
      setErr(errMsg(e));
    }
  };

  const doMove = async () => {
    if (!group || !moveItem || !moveTo) return;
    setMoving(true);
    setErr(null);
    try {
      const r = await api.watchlistMoveItem(group.id, moveItem.code, moveTo, moveCopy);
      if (!r.ok || !r.toGroup) throw new Error(r.message || "移动/复制失败");
      setMoveItem(null);
      setMoveTo("");
      setMoveCopy(false);
      await refreshList();
      if (!moveCopy) {
        setGroup(r.fromGroup ?? null);
        setItems(r.fromGroup?.items ?? []);
      }
      setInfo(moveCopy ? `已复制 ${moveItem.name || moveItem.code}` : `已移动 ${moveItem.name || moveItem.code}`);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setMoving(false);
    }
  };

  // ---------- Chat 导入 / 补充 ----------

  const importChat = async () => {
    const url = importUrl.trim();
    if (!url) return;
    if (!SHARE_RE.test(url)) { setErr("链接格式无效，应为 https://chat.deepseek.com/share/<id>"); return; }
    setImporting(true);
    setErr(null);
    try {
      const t = await api.watchlistImport(url);
      if (!t.ok) { setErr(t.message || "导入失败"); return; }
      if (t.taskId) {
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const st = await api.dataInfraTask(t.taskId).catch(() => null);
          const dt = st?.ok ? st.task : undefined;
          if (dt?.status === "done" && dt.result) {
            setImportUrl("");
            setShowCreate(false);
            setSelectedId((dt.result as { id: string }).id);
            await refreshList();
            return;
          }
          if (dt && (dt.status === "failed" || dt.status === "cancelled")) { setErr(dt.lastResult || "导入失败"); return; }
        }
        setErr("导入超时，请稍后重试");
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setImporting(false);
    }
  };

  const appendPreview = async () => {
    if (!group) return;
    const url = appendUrl.trim();
    if (!url) return;
    if (!SHARE_RE.test(url)) { setErr("链接格式无效，应为 https://chat.deepseek.com/share/<id>"); return; }
    setAppending(true);
    setErr(null);
    try {
      const t = await api.watchlistAppendPreview(group.id, url);
      if (!t.ok) { setErr(t.message || "解析失败"); return; }
      if (t.taskId) {
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const st = await api.dataInfraTask(t.taskId).catch(() => null);
          const dt = st?.ok ? st.task : undefined;
          if (dt?.status === "done" && dt.result) {
            const cand = (dt.result as { items?: WatchItem[] }).items ?? [];
            if (cand.length === 0) { setErr("Chat 对话中未识别到可补充的标的"); return; }
            setPreview({ taskId: t.taskId, items: cand });
            setPreviewSel(new Set(cand.map((s) => s.code)));
            return;
          }
          if (dt && (dt.status === "failed" || dt.status === "cancelled")) { setErr(dt.lastResult || "解析失败"); return; }
        }
        setErr("解析超时，请稍后重试");
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setAppending(false);
    }
  };

  const confirmAppend = async () => {
    if (!group || !preview) return;
    const codes = [...previewSel];
    if (codes.length === 0) { setErr("请至少勾选一个标的"); return; }
    setConfirming(true);
    setErr(null);
    try {
      const r = await api.watchlistAppendConfirm(group.id, preview.taskId, codes);
      if (!r.ok || !r.group) throw new Error(r.message || "导入失败");
      setAppendUrl("");
      setShowAppend(false);
      setPreview(null);
      setPreviewSel(new Set());
      setGroup(r.group);
      setItems(r.items ?? r.group.items);
      setInfo(`已导入 ${r.imported ?? codes.length} 个标的`);
      await refreshList();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setConfirming(false);
    }
  };

  // ---------- 延续思考 ----------

  const extend = async () => {
    if (!group || extending) return;
    setExtending(true);
    setErr(null);
    try {
      const r = await api.watchlistExtendPrompt(group.id);
      if (r.ok && r.prompt) setExtendText(r.prompt);
      else setErr(r.message ?? "生成失败");
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setExtending(false);
    }
  };

  const goChat = async () => {
    if (!extendText) return;
    setErr(null);
    try {
      const r = await api.chatBrowserOpen(extendText, { send: true, deepThink: true, search: true });
      if (r.ok) setInfo(r.message ?? "已打开浏览器");
      else setErr(r.message ?? "打开失败");
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  const copyPrompt = async () => {
    if (!extendText) return;
    try {
      await navigator.clipboard.writeText(extendText);
      setInfo("✅ 提示词已复制");
    } catch { /* 忽略 */ }
  };

  return (
    <div>
      <PageHeader
        title="📌 自选股"
        desc="以标的为中心的跟踪与管理：分组（基础 / 聚合）组织标的，四个功能面覆盖「行情跟踪 · 下沉分析 · 提醒设置 · 逻辑确认」。"
      />
      {err && <ErrorCard>{err}</ErrorCard>}
      {info && (
        <div style={{ padding: "0.6rem 0.9rem", borderRadius: 8, background: "#ecfdf5", border: "1px solid #6ee7b7", color: "#047857", fontSize: "0.85rem", marginBottom: "0.6rem", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
          <span>ℹ️ {info}</span>
          <button type="button" onClick={() => setInfo(null)} style={{ border: "none", background: "none", color: "#047857", cursor: "pointer", fontSize: "0.8rem" }}>✕</button>
        </div>
      )}

      {/* 分组切换：基础 / 聚合 分段 + 横向分组条 */}
      <div style={{ ...card, paddingBottom: "0.9rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.4rem" }}>
          <SegTabs
            value={kind}
            options={[
              { value: "base", label: `基础分组（${baseGroups.length}）`, title: "自有标的的分组" },
              { value: "agg", label: `聚合分组（${aggGroups.length}）`, title: "由多个基础分组的标的并集组成" },
            ]}
            onChange={(v) => setKind(v as GroupKind)}
          />
          <span style={{ flex: 1 }} />
          <button
            type="button"
            style={{ ...btnSmall, background: showCreate ? "#1d4ed8" : "#3b82f6" }}
            onClick={() => setShowCreate((v) => !v)}
          >
            {showCreate ? "▾ 收起" : "➕ 新建分组"}
          </button>
        </div>

        {showCreate && (
          <div style={{ padding: "0.6rem 0.7rem", background: C.accentBg, border: `1px solid ${C.accentBorder}`, borderRadius: 8, marginBottom: "0.5rem" }}>
            <div style={{ display: "flex", gap: "0.3rem", marginBottom: "0.45rem" }}>
              <button type="button" style={{ ...btnSmall, flex: 1, background: createTab === "manual" ? "#2563eb" : "#93c5fd" }} onClick={() => setCreateTab("manual")}>✍️ 手动创建</button>
              <button type="button" style={{ ...btnSmall, flex: 1, background: createTab === "chat" ? "#7c3aed" : "#c4b5fd" }} onClick={() => setCreateTab("chat")}>🤖 Chat 导入</button>
            </div>
            {createTab === "manual" ? (
              <>
                <input style={{ ...input, width: "100%", boxSizing: "border-box", marginBottom: "0.35rem", fontSize: "0.82rem" }} placeholder="分组名称（如 商业航天 / AI 硬件）" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void create(); }} />
                <textarea style={{ ...input, width: "100%", resize: "vertical", minHeight: 44, fontSize: "0.8rem", boxSizing: "border-box", marginBottom: "0.35rem" }} placeholder="分组介绍（可选：主题逻辑 / 选股思路）" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
                <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.8rem", marginBottom: "0.35rem", cursor: "pointer" }}>
                  <input type="checkbox" checked={newAgg} onChange={(e) => { setNewAgg(e.target.checked); if (!e.target.checked) setNewSources([]); }} />
                  设为聚合分组（标的 = 所选基础分组的并集）
                </label>
                {newAgg && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.35rem" }}>
                    {baseGroups.length === 0 ? (
                      <span style={{ color: C.faintest, fontSize: "0.78rem" }}>暂无基础分组可选</span>
                    ) : baseGroups.map((g) => (
                      <label key={g.id} style={{ display: "flex", alignItems: "center", gap: "0.25rem", padding: "0.2rem 0.55rem", background: "#fff", border: `1px solid ${C.accentBorder}`, borderRadius: 6, fontSize: "0.78rem", cursor: "pointer" }}>
                        <input type="checkbox" checked={newSources.includes(g.id)} onChange={(e) => setNewSources((p) => (e.target.checked ? [...p, g.id] : p.filter((x) => x !== g.id)))} />
                        {g.name}
                      </label>
                    ))}
                  </div>
                )}
                <button type="button" style={{ ...btn, width: "100%", padding: "0.4rem", fontSize: "0.82rem" }} onClick={() => void create()} disabled={creating}>
                  {creating ? "创建中…" : "✓ 创建分组"}
                </button>
              </>
            ) : (
              <>
                <input style={{ ...input, width: "100%", fontSize: "0.8rem", boxSizing: "border-box", marginBottom: "0.35rem" }} placeholder="https://chat.deepseek.com/share/<id>" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void importChat(); }} />
                <button type="button" style={{ ...btn, width: "100%", padding: "0.4rem", fontSize: "0.82rem", background: "#7c3aed" }} onClick={() => void importChat()} disabled={importing}>
                  {importing ? "🔄 提取整理中…" : "📥 从 Chat 导入"}
                </button>
              </>
            )}
          </div>
        )}

        {visible.length === 0 ? (
          <div style={{ color: C.faintest, fontSize: "0.85rem", padding: "0.5rem 0" }}>
            {kind === "agg" ? "还没有聚合分组（聚合分组的标的 = 多个基础分组的并集）" : "还没有基础分组，先新建一个或由 Chat 导入"}
          </div>
        ) : (
          <div style={{ display: "flex", gap: "0.4rem", overflowX: "auto", paddingBottom: "0.25rem" }}>
            {visible.map((g) => {
              const active = g.id === selectedId;
              return (
                <button
                  key={g.id}
                  type="button"
                  title={g.description ?? g.name}
                  onClick={() => setSelectedId(g.id)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.1rem",
                    alignItems: "flex-start",
                    padding: "0.42rem 0.75rem",
                    borderRadius: 10,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    border: active ? `1px solid ${C.accent}` : `1px solid ${C.border}`,
                    background: active ? C.accentBg : "#fff",
                  }}
                >
                  <span style={{ fontWeight: active ? 700 : 600, fontSize: "0.88rem", color: active ? C.accent : C.text }}>
                    {g.name}
                    {g.description ? <span style={{ color: C.faintest, marginLeft: "0.25rem", fontSize: "0.75rem" }}>ℹ️</span> : null}
                  </span>
                  <span style={{ display: "flex", gap: "0.4rem", alignItems: "center", fontSize: "0.72rem", color: C.faint }}>
                    <span>{g.itemCount} 只</span>
                    {typeof g.avgPct === "number" ? (
                      <span style={{ color: pctColor(g.avgPct), fontWeight: 700 }} title={`当日平均涨跌幅（等权，${g.avgCount ?? 0} 只有行情）`}>{fmtPct(g.avgPct)}</span>
                    ) : null}
                    {g.reviewCount ? <span style={{ color: C.warn }} title="待复核 / 逻辑动摇的标的数">🧭{g.reviewCount}</span> : null}
                    {g.alertCount ? <span style={{ color: C.gain }} title="当前已触发的提醒条数">🔔{g.alertCount}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {!group ? (
        <div style={card}>
          <div style={{ color: C.faintest, padding: "1.5rem 0", textAlign: "center" }}>← 选择或新建一个分组</div>
        </div>
      ) : (
        <>
          {/* 分组头部：名称 / 聚合来源 / 操作 */}
          <div style={{ ...card, paddingBottom: "1rem" }}>
            {editingMeta ? (
              <div>
                <input style={{ ...input, fontWeight: 700, fontSize: "1rem", width: "100%", boxSizing: "border-box", marginBottom: "0.35rem" }} value={metaName} onChange={(e) => setMetaName(e.target.value)} placeholder="分组名称" />
                <textarea style={{ ...input, width: "100%", resize: "vertical", minHeight: 60, fontSize: "0.85rem", boxSizing: "border-box", marginBottom: "0.35rem" }} value={metaDesc} onChange={(e) => setMetaDesc(e.target.value)} placeholder="分组介绍（可选）" />
                {isAgg && (
                  <div style={{ marginBottom: "0.35rem" }}>
                    <div style={{ fontSize: "0.78rem", color: C.faint, marginBottom: "0.25rem" }}>聚合来源（标的 = 所选基础分组的并集；清空即降级为基础分组）：</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                      {baseGroups.map((g) => (
                        <label key={g.id} style={{ display: "flex", alignItems: "center", gap: "0.25rem", padding: "0.2rem 0.55rem", background: "#fff", border: `1px solid ${C.accentBorder}`, borderRadius: 6, fontSize: "0.78rem", cursor: "pointer" }}>
                          <input type="checkbox" checked={metaSources.includes(g.id)} onChange={(e) => setMetaSources((p) => (e.target.checked ? [...p, g.id] : p.filter((x) => x !== g.id)))} />
                          {g.name}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <div style={{ display: "flex", gap: "0.4rem" }}>
                  <button type="button" style={btnSmall} onClick={() => void saveMeta()}>✓ 保存</button>
                  <button type="button" style={{ ...btnSmall, background: "#fff", color: C.faint, border: `1px solid ${C.border}` }} onClick={() => setEditingMeta(false)}>取消</button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700, fontSize: "1.05rem" }}>{group.name}</span>
                {isAgg ? (
                  <span style={{ fontSize: "0.75rem", color: C.faint, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 999, padding: "0.1rem 0.5rem" }}>
                    聚合：{(group.aggSources ?? []).map((id) => baseGroups.find((g) => g.id === id)?.name ?? id).join(" + ")}
                  </span>
                ) : null}
                <span style={{ color: C.faintest, fontSize: "0.78rem" }}>更新于 {group.updatedAt.slice(0, 10)} · {items.length} 只</span>
                <span style={{ flex: 1 }} />
                <button type="button" style={{ ...btnSmall, background: "#fff", color: C.faint, border: `1px solid ${C.border}` }} onClick={openMetaEdit}>✏️ 编辑</button>
                {!isAgg ? (
                  <button type="button" style={{ ...btnSmall, background: "#7c3aed" }} onClick={() => setShowAppend((v) => !v)}>🤖 Chat 补充</button>
                ) : null}
                <button type="button" style={{ ...btnSmall, background: "#fff", color: C.accent, border: `1px solid ${C.accentBorder}` }} onClick={() => void extend()} disabled={extending}>
                  {extending ? "生成中…" : "🧠 延续思考"}
                </button>
                <button type="button" style={btnGhost} onClick={() => void removeGroup()}>删除分组</button>
              </div>
            )}

            {group.description && !editingMeta ? (
              <div style={{ marginTop: "0.4rem", padding: "0.45rem 0.65rem", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: "0.82rem", color: "#334155", whiteSpace: "pre-wrap" }}>
                📖 {group.description}
              </div>
            ) : null}

            {/* Chat 补充 */}
            {showAppend && !isAgg ? (
              <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap", marginTop: "0.6rem", padding: "0.5rem 0.6rem", background: "#f5f3ff", borderRadius: 8, border: "1px solid #ddd6fe" }}>
                <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "#6d28d9", whiteSpace: "nowrap" }}>📥 阅读 Chat 对话追加标的：</span>
                <input style={{ ...input, flex: 1, minWidth: 200, fontSize: "0.82rem" }} placeholder="https://chat.deepseek.com/share/<id>" value={appendUrl} onChange={(e) => setAppendUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void appendPreview(); }} />
                <button type="button" style={{ ...btn, background: "#7c3aed", padding: "0.4rem 0.9rem", fontSize: "0.82rem" }} onClick={() => void appendPreview()} disabled={appending}>
                  {appending ? "🔄 解析中…" : "解析候选"}
                </button>
              </div>
            ) : null}

            {/* Chat 补充候选预览（确认后才导入） */}
            {preview ? (
              <div style={{ marginTop: "0.6rem", padding: "0.6rem 0.8rem", background: "#f0fdf4", borderRadius: 8, border: "1px solid #bbf7d0" }}>
                <div style={{ fontSize: "0.84rem", fontWeight: 600, color: "#166534", marginBottom: "0.4rem" }}>📋 解析到 {preview.items.length} 个候选标的，勾选后确认导入：</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.6rem" }}>
                  {preview.items.map((s) => (
                    <label key={s.code} style={{ display: "flex", alignItems: "center", gap: "0.3rem", padding: "0.25rem 0.6rem", background: "#fff", border: "1px solid #bbf7d0", borderRadius: 6, fontSize: "0.82rem", cursor: "pointer" }}>
                      <input type="checkbox" checked={previewSel.has(s.code)} onChange={() => setPreviewSel((p) => { const n = new Set(p); if (n.has(s.code)) n.delete(s.code); else n.add(s.code); return n; })} />
                      <span>{s.name || s.code}</span>
                      <span style={{ color: C.faintest, fontSize: "0.75rem" }}>{s.code}</span>
                    </label>
                  ))}
                </div>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button type="button" style={{ ...btn, background: "#16a34a", padding: "0.35rem 1rem", fontSize: "0.82rem" }} onClick={() => void confirmAppend()} disabled={confirming || previewSel.size === 0}>
                    {confirming ? "导入中…" : `确认导入（${previewSel.size}）`}
                  </button>
                  <button type="button" style={{ ...btn, background: "#e2e8f0", color: "#475569", padding: "0.35rem 0.9rem", fontSize: "0.82rem" }} onClick={() => { setPreview(null); setPreviewSel(new Set()); }}>取消</button>
                </div>
              </div>
            ) : null}

            {/* 延续思考结果 */}
            {extendText ? (
              <div style={{ marginTop: "0.6rem", padding: "0.8rem 1rem", background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
                  <span style={{ fontWeight: 700, fontSize: "0.88rem" }}>🧠 延续思考提示词</span>
                  <span style={{ flex: 1 }} />
                  <button type="button" style={{ padding: "0.3rem 0.9rem", borderRadius: 8, border: "none", background: "#16a34a", color: "#fff", fontSize: "0.78rem", cursor: "pointer" }} onClick={() => void copyPrompt()}>📋 复制</button>
                  <button type="button" style={{ padding: "0.3rem 0.9rem", borderRadius: 8, border: "none", background: "#0891b2", color: "#fff", fontSize: "0.78rem", cursor: "pointer" }} onClick={() => void goChat()}>💬 去 Chat</button>
                  <button type="button" style={{ padding: "0.3rem 0.9rem", borderRadius: 8, border: `1px solid ${C.border}`, background: "#fff", color: C.faint, fontSize: "0.78rem", cursor: "pointer" }} onClick={() => setExtendText(null)}>🙈 收起</button>
                </div>
                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "0.82rem", lineHeight: 1.6, color: "#4c1d95", margin: 0, maxHeight: "40vh", overflowY: "auto" }}>{extendText}</pre>
              </div>
            ) : null}
          </div>

          {/* 标的管理（逻辑围绕标的展开：增 / 删 / 优先级重排 / 跨分组流转） */}
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, fontSize: "0.92rem" }}>🎯 标的管理（{items.length}）</span>
              <span style={{ flex: 1 }} />
              <button type="button" style={{ ...btnSmall, background: "#fff", color: C.faint, border: `1px solid ${C.border}` }} onClick={() => setShowItems((v) => !v)}>
                {showItems ? "收起 ▴" : "展开 ▾"}
              </button>
            </div>

            {showItems ? (
              isAgg ? (
                <div style={{ color: C.faint, fontSize: "0.82rem", padding: "0.6rem 0" }}>
                  聚合分组的标的来自源分组（并集，按代码去重）；请到源分组中增删改标的。
                </div>
              ) : (
                <>
                  {/* 添加标的 */}
                  <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "center", marginTop: "0.5rem" }}>
                    <select style={{ ...input, width: 104 }} value={addKind} onChange={(e) => setAddKind(e.target.value as "stock" | "fund")} title="股票/ETF 走腾讯行情；场外基金走天天基金净值">
                      <option value="stock">股票 / ETF</option>
                      <option value="fund">场外基金</option>
                    </select>
                    <div style={{ position: "relative", flex: 1, minWidth: 170 }}>
                      <input
                        style={{ ...input, width: "100%", boxSizing: "border-box" }}
                        placeholder={addKind === "fund" ? "代码 161725" : "代码或名称（如 600519 / 茅台）"}
                        value={addCode}
                        onChange={(e) => { setAddCode(e.target.value); setAddName(""); setCandsOpen(false); searchCands(e.target.value); }}
                        onBlur={() => setTimeout(() => setCandsOpen(false), 200)}
                        onKeyDown={(e) => { if (e.key === "Enter" && candsOpen && cands.length > 0) { setAddCode(cands[0].code); setAddName(cands[0].name); setCandsOpen(false); e.preventDefault(); } }}
                      />
                      {candsOpen && cands.length > 0 ? (
                        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(15,23,42,.14)", zIndex: 20, maxHeight: 240, overflowY: "auto" }}>
                          {cands.map((c) => (
                            <div key={`${c.market}-${c.code}`} onMouseDown={(e) => { e.preventDefault(); setAddCode(c.code); setAddName(c.name); setCandsOpen(false); }} style={{ padding: "0.4rem 0.7rem", cursor: "pointer", display: "flex", gap: "0.5rem", alignItems: "baseline", fontSize: "0.82rem" }}>
                              <span style={{ fontWeight: 600 }}>{c.name}</span>
                              <span style={{ color: C.faint, fontFamily: "monospace", fontSize: "0.76rem" }}>{c.market}{c.code}</span>
                              <span style={{ color: C.faintest, fontSize: "0.7rem" }}>{c.type}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <input style={{ ...input, flex: 1, minWidth: 170 }} placeholder="入选理由（必填，逻辑确认的「前提」）" value={addReason} onChange={(e) => setAddReason(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addItem(); }} />
                    <input style={{ ...input, flex: 1, minWidth: 150 }} placeholder="预期（可选：可验证的目标）" value={addExpect} onChange={(e) => setAddExpect(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addItem(); }} />
                    <button type="button" style={btn} onClick={() => void addItem()} disabled={adding}>{adding ? "加入中…" : "加入分组"}</button>
                  </div>

                  {/* 标的列表（拖动 ⠿ 调整优先级；顺序 = 优先级） */}
                  {items.length === 0 ? (
                    <div style={{ color: C.faintest, fontSize: "0.85rem", padding: "0.9rem 0", textAlign: "center" }}>暂无标的，请在上面添加。</div>
                  ) : (
                    <table style={{ ...table, marginTop: "0.6rem" }}>
                      <thead>
                        <tr>
                          <th style={{ ...th, width: 34 }}>⠿</th>
                          <th style={{ ...th, textAlign: "left" }}>名称 / 代码</th>
                          <th style={{ ...th, textAlign: "left" }}>入选理由</th>
                          <th style={{ ...th, textAlign: "left" }}>预期</th>
                          <th style={{ ...th, width: 90 }}>入选时间</th>
                          <th style={{ ...th, width: 120 }}>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((s, i) => (
                          <tr
                            key={s.code}
                            draggable
                            onDragStart={() => setDragIdx(i)}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={() => { if (dragIdx !== null) void reorder(dragIdx, i); setDragIdx(null); }}
                            onDragEnd={() => setDragIdx(null)}
                            style={{ cursor: "grab", ...(dragIdx === i ? { opacity: 0.35, background: C.bg } : {}), ...(dragIdx !== null && dragIdx !== i ? { borderTop: `2px dashed ${C.accentBorder}` } : {}) }}
                          >
                            <td style={{ ...thTd, color: C.faintest, fontSize: "1rem" }} title="拖动调整优先级">⠿</td>
                            <td style={{ ...thTd, textAlign: "left", whiteSpace: "nowrap" }}>
                              <a href={stockDetailUrl(s.code, s.kind)} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
                                <div style={{ fontWeight: 700, lineHeight: 1.3 }}>{s.name ?? "—"}</div>
                                <div style={{ color: C.accent, fontSize: "0.72rem", textDecoration: "underline" }}>{s.code} ↗</div>
                              </a>
                              {s.kind === "fund" ? <span style={{ fontSize: "0.68rem", color: C.faintest }}>场外</span> : null}
                            </td>
                            <td style={{ ...thTd, textAlign: "left", fontSize: "0.8rem" }}>{s.reason || <span style={{ color: C.faintest }}>—</span>}</td>
                            <td style={{ ...thTd, textAlign: "left", fontSize: "0.8rem" }}>
                              {s.expectation || <span style={{ color: C.faintest }}>—</span>}
                              {typeof s.targetPrice === "number" ? <span style={{ color: C.accent, marginLeft: "0.25rem" }}>｜{s.targetPrice}</span> : null}
                            </td>
                            <td style={{ ...thTd, fontSize: "0.75rem", color: C.faint }}>{(s.addedAt ?? "").slice(0, 10)}</td>
                            <td style={thTd}>
                              <button type="button" style={btnGhost} onClick={() => void removeItem(s.code)}>移除</button>
                              <button
                                type="button"
                                style={{ ...btnGhost, color: C.accent, borderColor: C.accentBorder, marginLeft: 4 }}
                                title="移动/复制到其他分组"
                                onClick={() => { setMoveItem({ code: s.code, name: s.name }); setMoveTo(""); setMoveCopy(false); }}
                              >
                                ⇄
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )
            ) : null}
          </div>

          {/* 功能 Tab（横向） */}
          <div style={{ ...card, paddingBottom: "1rem" }}>
            <div style={{ display: "flex", gap: "0.2rem", borderBottom: `1px solid ${C.border}`, marginBottom: "0.7rem", flexWrap: "wrap" }}>
              {TABS.map((t) => {
                const active = t.value === tab;
                return (
                  <button
                    key={t.value}
                    type="button"
                    title={t.title}
                    onClick={() => setTab(t.value)}
                    style={{
                      padding: "0.5rem 1rem",
                      border: "none",
                      background: "transparent",
                      borderBottom: active ? `2px solid ${C.accent}` : "2px solid transparent",
                      color: active ? C.accent : C.faint,
                      fontWeight: active ? 700 : 500,
                      fontSize: "0.9rem",
                      cursor: "pointer",
                      marginBottom: -1,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>

            {items.length === 0 && tab !== "track" ? (
              <div style={{ color: C.faintest, fontSize: "0.85rem", padding: "1rem 0", textAlign: "center" }}>该分组暂无标的，请先添加标的</div>
            ) : tab === "track" ? (
              <TrackPanel groupId={group.id} />
            ) : tab === "deep" ? (
              <DeepDivePanel groupId={group.id} items={items} />
            ) : tab === "alerts" ? (
              <AlertsPanel groupId={group.id} items={items} />
            ) : (
              <LogicPanel groupId={group.id} items={items} />
            )}
          </div>
        </>
      )}

      {/* 移动/复制标的弹窗（仅基础分组可作为目标） */}
      {moveItem ? (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={() => setMoveItem(null)}>
          <div style={{ background: "#fff", borderRadius: 12, padding: "1.2rem 1.4rem", width: 360, boxShadow: "0 10px 40px rgba(0,0,0,0.2)" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 700, marginBottom: "0.6rem", fontSize: "0.95rem" }}>
              {moveCopy ? "复制" : "移动"} <span style={{ color: C.accent }}>{moveItem.name || moveItem.code}</span>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.7rem", fontSize: "0.82rem" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", cursor: "pointer" }}>
                <input type="radio" checked={!moveCopy} onChange={() => setMoveCopy(false)} /> 移动到
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", cursor: "pointer" }}>
                <input type="radio" checked={moveCopy} onChange={() => setMoveCopy(true)} /> 复制到
              </label>
            </div>
            <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} style={{ width: "100%", padding: "0.5rem 0.6rem", borderRadius: 8, border: `1px solid ${C.border}`, fontSize: "0.88rem", marginBottom: "0.9rem" }}>
              <option value="">选择目标分组…</option>
              {baseGroups.filter((g) => g.id !== group?.id).map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button type="button" style={{ ...btn, background: "#e2e8f0", color: "#475569" }} onClick={() => setMoveItem(null)}>取消</button>
              <button type="button" style={{ ...btn, opacity: !moveTo || moving ? 0.6 : 1 }} disabled={!moveTo || moving} onClick={() => void doMove()}>
                {moving ? "处理中…" : "确认"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
