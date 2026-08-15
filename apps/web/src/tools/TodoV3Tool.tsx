// ============================================================
// 待办事项 v3（工具分组）：Cordis 框架驱动 + 分解树
//   - 分解（parentId 包含树）：父任务可拆分子任务，父完成=子全部完成，
//     父任务显示完成进度条；可折叠展开
//   - 依赖（dependencies 前置 DAG）：跨树前置，未完成 → 🔒 阻塞不可勾选
//   - 周期任务（每日/每周/每月）：跨期自动视为待做
// ============================================================
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg } from "../api";
import { PageHeader } from "../ui";
import type { TodoItemV3, TodoItemV3View } from "@toolbox/shared";

const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.25rem 1.5rem",
  marginBottom: "1rem",
};

const REPEAT_LABEL: Record<string, string> = { daily: "每日", weekly: "每周", monthly: "每月" };
const REPEAT_COLOR: Record<string, string> = { daily: "#2563eb", weekly: "#7c3aed", monthly: "#db2777" };

export default function TodoV3Tool() {
  const [items, setItems] = useState<TodoItemV3View[]>([]);
  const [text, setText] = useState("");
  const [repeat, setRepeat] = useState<"daily" | "weekly" | "monthly" | undefined>(undefined);
  const [depSel, setDepSel] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editDeps, setEditDeps] = useState<Set<string>>(new Set());
  const [editRepeat, setEditRepeat] = useState<"daily" | "weekly" | "monthly" | "none">("none");
  // 树：折叠状态 + 子任务输入框
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [subText, setSubText] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.todoV3List();
      setItems(r.items);
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** id → 文本映射（依赖 chips 显示用） */
  const textOf = useMemo(() => new Map(items.map((x) => [x.id, x.text])), [items]);

  const add = async (parentId?: string) => {
    const t = (parentId ? subText[parentId] : text).trim();
    if (!t) return;
    setMsg(null);
    try {
      const r = await api.todoV3Add(t, [...depSel], repeat, parentId);
      setItems(r.items);
      if (parentId) setSubText((s) => { const n = { ...s }; delete n[parentId]; return n; });
      else { setText(""); setDepSel(new Set()); setRepeat(undefined); inputRef.current?.focus(); }
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  const toggle = async (it: TodoItemV3View) => {
    if (!it.done && it.blocked) {
      setMsg({ kind: "err", text: `🔒 前置任务未完成（${it.blockedBy.length} 个），无法完成` });
      return;
    }
    try {
      const r = await api.todoV3Update(it.id, { done: !it.done });
      setItems(r.items);
      if (it.repeat && !it.done) setMsg({ kind: "ok", text: `✅ 已完成本期（${REPEAT_LABEL[it.repeat]}）` });
      else setMsg(null);
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  const saveEdit = async (id: string) => {
    const t = editText.trim();
    setEditingId(null);
    if (!t) return;
    try {
      const r = await api.todoV3Update(id, { text: t, dependencies: [...editDeps], repeat: editRepeat });
      setItems(r.items);
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  const remove = async (it: TodoItemV3View) => {
    const dependents = items.filter((x) => x.dependencies.includes(it.id)).length;
    const subCount = it.children.length;
    const msg0 = subCount > 0
      ? `删除该待办及其 ${subCount} 个子任务？${dependents > 0 ? ` ${dependents} 个任务将自动解除对它的依赖` : ""}`
      : dependents > 0 ? `删除该待办？${dependents} 个任务将自动解除对它的依赖` : "删除该待办？";
    if (!confirm(msg0)) return;
    try {
      const r = await api.todoV3Delete(it.id);
      setItems(r.items);
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  const clearDone = async () => {
    if (!confirm("清空所有已完成待办？（子任务随父一并删除，依赖自动解除）")) return;
    try {
      const r = await api.todoV3ClearDone();
      setItems(r.items);
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  // ---------- closed todo 归档（手动 + 到期自动） ----------
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<TodoItemV3View[]>([]);

  const loadArchived = async () => {
    try {
      const r = await api.todoV3ArchiveList();
      setArchived(r.items);
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  const archiveItem = async (it: TodoItemV3View) => {
    if (!it.done) { setMsg({ kind: "err", text: "仅已完成的待办可归档" }); return; }
    try {
      const r = await api.todoV3Archive(it.id);
      setItems(r.items);
      void loadArchived();
      setMsg({ kind: "ok", text: "🗄 已归档（可在归档区查看/恢复）" });
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  const restoreItem = async (it: TodoItemV3View) => {
    try {
      const r = await api.todoV3Restore(it.id);
      setItems(r.items);
      setArchived((a) => a.filter((x) => x.id !== it.id));
      setMsg({ kind: "ok", text: "↩ 已恢复到主列表" });
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  const done = items.filter((x) => x.done).length;
  const active = items.length - done;
  const blockedCount = items.filter((x) => !x.done && x.blocked).length;

  const toggleDep = (id: string) => {
    setDepSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const toggleEditDep = (id: string) => {
    setEditDeps((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  /** 树状渲染单行（含递归子项） */
  const renderItem = (it: TodoItemV3View, depth: number) => {
    const depNames = it.dependencies.map((d) => textOf.get(d) ?? d);
    const hasChildren = it.children.length > 0;
    const isCollapsed = collapsed[it.id];
    return (
      <Fragment key={it.id}>
        <li
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.5rem 0.6rem",
            paddingLeft: `${0.6 + depth * 1.4}rem`,
            borderRadius: 8,
            marginBottom: "0.25rem",
            background: it.done ? "#f8fafc" : it.blocked ? "#fffbeb" : "#fff",
            border: "1px solid " + (it.done ? "#eef2f7" : it.blocked ? "#fde68a" : "#e2e8f0"),
          }}
        >
          {/* 折叠箭头 / 子任务指示 */}
          {hasChildren ? (
            <button
              onClick={() => setCollapsed((c) => ({ ...c, [it.id]: !c[it.id] }))}
              title={isCollapsed ? "展开子任务" : "折叠子任务"}
              style={{ flexShrink: 0, width: 18, height: 18, border: "none", background: "transparent", cursor: "pointer", fontSize: "0.7rem", color: "#64748b", padding: 0 }}
            >
              {isCollapsed ? "▶" : "▼"}
            </button>
          ) : (
            <span style={{ flexShrink: 0, width: 18 }} />
          )}
          <input
            type="checkbox"
            checked={it.done}
            disabled={!it.done && it.blocked}
            onChange={() => void toggle(it)}
            title={it.blocked ? "前置任务未完成，暂不可勾选" : hasChildren ? "完成父任务 = 全部子任务完成" : undefined}
            style={{ width: 16, height: 16, cursor: it.blocked && !it.done ? "not-allowed" : "pointer", accentColor: "#16a34a", opacity: it.blocked && !it.done ? 0.4 : 1 }}
          />
          {editingId === it.id ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.35rem" }}>
              <input
                autoFocus
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void saveEdit(it.id)}
                onBlur={() => void saveEdit(it.id)}
                style={{ padding: "0.35rem 0.55rem", borderRadius: 6, border: "1px solid #3b82f6", fontSize: "0.9rem" }}
              />
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem", alignItems: "center" }}>
                <span style={{ fontSize: "0.72rem", color: "#94a3b8" }}>依赖：</span>
                {items.filter((x) => x.id !== it.id).map((x) => (
                  <button
                    key={x.id}
                    onMouseDown={(e) => { e.preventDefault(); toggleEditDep(x.id); }}
                    style={{ fontSize: "0.68rem", padding: "0.15rem 0.5rem", borderRadius: 999, border: editDeps.has(x.id) ? "1px solid #3b82f6" : "1px solid #e2e8f0", background: editDeps.has(x.id) ? "#eff6ff" : "#fff", color: editDeps.has(x.id) ? "#2563eb" : "#64748b", cursor: "pointer" }}
                  >
                    {x.text.slice(0, 12)}
                  </button>
                ))}
                <select
                  value={editRepeat}
                  onChange={(e) => setEditRepeat(e.target.value as "daily" | "weekly" | "monthly" | "none")}
                  style={{ fontSize: "0.72rem", padding: "0.15rem 0.3rem", borderRadius: 6, border: "1px solid #e2e8f0" }}
                >
                  <option value="none">周期：无</option>
                  <option value="daily">每日</option>
                  <option value="weekly">每周</option>
                  <option value="monthly">每月</option>
                </select>
              </div>
            </div>
          ) : (
            <>
              <span
                onDoubleClick={() => { setEditingId(it.id); setEditText(it.text); setEditDeps(new Set(it.dependencies)); setEditRepeat(it.repeat ?? "none"); }}
                title={hasChildren ? "包含子任务，双击编辑" : "双击编辑"}
                style={{ flex: 1, fontSize: "0.92rem", color: it.done ? "#94a3b8" : "#1e293b", textDecoration: it.done ? "line-through" : "none", cursor: "pointer", wordBreak: "break-all" }}
              >
                {it.blocked && !it.done && <span style={{ marginRight: "0.3rem" }}>🔒</span>}
                {it.text}
              </span>
              {/* 子任务进度条 */}
              {it.progress && (
                <span style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: "0.3rem", fontSize: "0.66rem", color: "#64748b" }}>
                  <span style={{ width: 42, height: 5, borderRadius: 3, background: "#e2e8f0", overflow: "hidden", display: "inline-block" }}>
                    <span style={{ display: "block", height: "100%", width: `${Math.round((it.progress.done / it.progress.total) * 100)}%`, background: it.progress.done === it.progress.total ? "#16a34a" : "#3b82f6" }} />
                  </span>
                  {it.progress.done}/{it.progress.total}
                </span>
              )}
              {depNames.length > 0 && (
                <span title={`前置：${depNames.join("、")}`} style={{ flexShrink: 0, fontSize: "0.68rem", color: it.blocked && !it.done ? "#d97706" : "#64748b", background: it.blocked && !it.done ? "#fef3c7" : "#f1f5f9", border: "1px solid " + (it.blocked && !it.done ? "#fcd34d" : "#e2e8f0"), borderRadius: 999, padding: "0.08rem 0.5rem", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {it.blocked && !it.done ? `⛓ ${depNames.join("、")}` : `依赖 ${depNames.length}`}
                </span>
              )}
              <span style={{ fontSize: "0.7rem", color: "#94a3b8", flexShrink: 0 }}>{it.updatedAt.slice(0, 10)}</span>
              {it.repeat && (
                <span style={{ flexShrink: 0, fontSize: "0.68rem", color: REPEAT_COLOR[it.repeat], background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 999, padding: "0.08rem 0.5rem" }}>
                  {REPEAT_LABEL[it.repeat]}{it.done && it.lastDoneAt ? ` ✓${it.lastDoneAt.slice(5, 10)}` : ""}
                </span>
              )}
              <button onClick={() => setSubText((s) => ({ ...s, [it.id]: s[it.id] ?? "" }))} title="添加子任务（分解）" style={{ flexShrink: 0, fontSize: "0.75rem", border: "1px solid #e2e8f0", background: "#fff", color: "#64748b", cursor: "pointer", padding: "0.12rem 0.45rem", borderRadius: 6 }}>＋子</button>
              {it.done && (
                <button onClick={() => void archiveItem(it)} title="归档（closed todo）" style={{ flexShrink: 0, fontSize: "0.78rem", border: "1px solid #e2e8f0", background: "#fff", color: "#64748b", cursor: "pointer", padding: "0.12rem 0.4rem", borderRadius: 6 }}>🗄</button>
              )}
              <button onClick={() => void remove(it)} title="删除" style={{ flexShrink: 0, fontSize: "0.78rem", border: "none", background: "transparent", color: "#94a3b8", cursor: "pointer", padding: "0.1rem 0.3rem" }}>✕</button>
            </>
          )}
        </li>
        {/* 子任务输入框（展开时显示） */}
        {subText[it.id] !== undefined && (
          <li style={{ listStyle: "none", display: "flex", gap: "0.4rem", paddingLeft: `${1.6 + depth * 1.4}rem`, marginBottom: "0.25rem" }}>
            <input
              autoFocus
              value={subText[it.id]}
              onChange={(e) => setSubText((s) => ({ ...s, [it.id]: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && void add(it.id)}
              placeholder={`在「${it.text.slice(0, 12)}」下添加子任务，回车…`}
              style={{ flex: 1, padding: "0.35rem 0.55rem", borderRadius: 6, border: "1px solid #cbd5e1", fontSize: "0.85rem" }}
            />
            <button onClick={() => void add(it.id)} style={{ padding: "0.35rem 0.9rem", borderRadius: 6, border: "none", background: "#3b82f6", color: "#fff", fontSize: "0.82rem", cursor: "pointer" }}>添加</button>
            <button onClick={() => setSubText((s) => { const n = { ...s }; delete n[it.id]; return n; })} style={{ padding: "0.35rem 0.6rem", borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", color: "#64748b", fontSize: "0.8rem", cursor: "pointer" }}>取消</button>
          </li>
        )}
        {/* 递归子任务 */}
        {!isCollapsed && it.children.map((cid) => {
          const child = items.find((x) => x.id === cid);
          return child ? renderItem(child, depth + 1) : null;
        })}
      </Fragment>
    );
  };

  const topItems = items.filter((x) => !x.parentId);

  return (
    <div>
      <PageHeader title="待办事项 v3" desc="分解树（子任务）+ 依赖（前置 DAG）+ 周期 · @deepseek-ai/cordis 框架" />
      <div style={card}>
        {/* 新增表单 */}
        <div style={{ display: "flex", gap: "0.6rem", marginBottom: "0.6rem" }}>
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
            placeholder="新增待办，回车确认…（＋子 可在任务下分解）"
            style={{ flex: 1, padding: "0.55rem 0.75rem", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: "0.92rem" }}
          />
          <select
            value={repeat ?? "none"}
            onChange={(e) => setRepeat(e.target.value === "none" ? undefined : (e.target.value as "daily" | "weekly" | "monthly"))}
            title="周期"
            style={{ flexShrink: 0, fontSize: "0.82rem", padding: "0.5rem 0.5rem", borderRadius: 8, border: "1px solid #cbd5e1", background: repeat ? "#eff6ff" : "#fff", color: repeat ? REPEAT_COLOR[repeat] : "#94a3b8", cursor: "pointer" }}
          >
            <option value="none">周期：无</option>
            <option value="daily">每日</option>
            <option value="weekly">每周</option>
            <option value="monthly">每月</option>
          </select>
          <button
            onClick={() => void add()}
            disabled={!text.trim()}
            style={{ padding: "0.55rem 1.2rem", borderRadius: 8, border: "none", background: "#3b82f6", color: "#fff", fontSize: "0.92rem", fontWeight: 600, cursor: "pointer", opacity: text.trim() ? 1 : 0.5 }}
          >
            ＋ 添加
          </button>
        </div>
        {/* 依赖选择（可选前置任务） */}
        {items.length > 0 && (
          <div style={{ marginBottom: "0.9rem", display: "flex", flexWrap: "wrap", gap: "0.35rem", alignItems: "center" }}>
            <span style={{ fontSize: "0.76rem", color: "#94a3b8", marginRight: "0.2rem" }}>前置依赖：</span>
            {items.map((x) => (
              <button
                key={x.id}
                onClick={() => toggleDep(x.id)}
                title={`设为前置：完成 ${x.text} 后新任务才可勾选`}
                style={{ fontSize: "0.72rem", padding: "0.2rem 0.55rem", borderRadius: 999, border: depSel.has(x.id) ? "1px solid #3b82f6" : "1px solid #e2e8f0", background: depSel.has(x.id) ? "#eff6ff" : "#fff", color: depSel.has(x.id) ? "#2563eb" : "#64748b", cursor: "pointer" }}
              >
                {x.done ? "✅" : "⬜"} {x.text.slice(0, 14)}
              </button>
            ))}
            {depSel.size > 0 && (
              <button onClick={() => setDepSel(new Set())} style={{ fontSize: "0.7rem", padding: "0.2rem 0.5rem", borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", color: "#94a3b8", cursor: "pointer" }}>清空</button>
            )}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", marginBottom: "0.7rem", fontSize: "0.8rem", color: "#64748b" }}>
          <span>
            共 <b>{items.length}</b> 项 · 待办 <b style={{ color: "#2563eb" }}>{active}</b> · 已完成 <b style={{ color: "#16a34a" }}>{done}</b>
            {blockedCount > 0 && <> · 等待前置 <b style={{ color: "#d97706" }}>🔒 {blockedCount}</b></>}
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: "0.4rem" }}>
            {done > 0 && (
              <button onClick={() => void clearDone()} style={{ padding: "0.25rem 0.7rem", borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", color: "#64748b", fontSize: "0.78rem", cursor: "pointer" }}>
                🧹 清空已完成
              </button>
            )}
            <button
              onClick={() => { const next = !showArchived; setShowArchived(next); if (next) void loadArchived(); }}
              style={{ padding: "0.25rem 0.7rem", borderRadius: 6, border: "1px solid " + (showArchived ? "#3b82f6" : "#e2e8f0"), background: showArchived ? "#eff6ff" : "#fff", color: showArchived ? "#2563eb" : "#64748b", fontSize: "0.78rem", cursor: "pointer" }}
            >
              🗄 归档{archived.length > 0 ? `（${archived.length}）` : ""}
            </button>
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: "2rem", color: "#94a3b8", fontSize: "0.9rem" }}>加载中…</div>
        ) : items.length === 0 ? (
          <div style={{ textAlign: "center", padding: "2.5rem 1rem", color: "#94a3b8", fontSize: "0.9rem" }}>
            暂无待办 🎉<br />
            <span style={{ fontSize: "0.8rem" }}>在上方输入内容；「＋子」可分解任务，「前置依赖」可构建任务链</span>
          </div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {topItems.map((it) => renderItem(it, 0))}
          </ul>
        )}

        {/* 归档区（closed todo） */}
        {showArchived && (
          <div style={{ marginTop: "0.8rem", borderTop: "1px dashed #e2e8f0", paddingTop: "0.6rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.4rem", fontSize: "0.8rem", color: "#64748b" }}>
              <b>🗄 归档区（已完成并归档）</b>
              <span style={{ fontSize: "0.72rem", color: "#94a3b8" }}>手动归档或超过 3 天保留期自动归档；可恢复</span>
            </div>
            {archived.length === 0 ? (
              <div style={{ padding: "1rem", textAlign: "center", color: "#94a3b8", fontSize: "0.82rem" }}>暂无归档</div>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {archived.map((x) => (
                  <li key={x.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.45rem 0.6rem", borderRadius: 8, marginBottom: "0.25rem", background: "#f8fafc", border: "1px solid #eef2f7" }}>
                    <span style={{ flex: 1, fontSize: "0.88rem", color: "#94a3b8", textDecoration: "line-through", wordBreak: "break-all" }}>{x.text}</span>
                    {x.repeat && <span style={{ fontSize: "0.68rem", color: "#a78bfa" }}>{x.repeat === "daily" ? "每日" : x.repeat === "weekly" ? "每周" : "每月"}</span>}
                    <span style={{ fontSize: "0.7rem", color: "#94a3b8" }}>{x.archivedAt ? x.archivedAt.slice(0, 10) : ""}</span>
                    <button onClick={() => void restoreItem(x)} title="恢复到主列表" style={{ fontSize: "0.74rem", padding: "0.15rem 0.5rem", borderRadius: 6, border: "1px solid #3b82f6", background: "#eff6ff", color: "#2563eb", cursor: "pointer" }}>↩ 恢复</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {msg && (
        <div style={{ padding: "0.6rem 1rem", borderRadius: 8, fontSize: "0.85rem", marginBottom: "1rem", background: msg.kind === "ok" ? "#f0fdf4" : "#fef2f2", color: msg.kind === "ok" ? "#16a34a" : "#dc2626", border: "1px solid " + (msg.kind === "ok" ? "#bbf7d0" : "#fecaca") }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
