// ============================================================
// 改进备忘录（设置分组）：TODO list
// 用户在使用页面过程中记录的小问题 → 开发者驱动 Agent 修复
// 状态：待处理(open) / 修复中(doing) / 已完成(done)
// ============================================================

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { api, errMsg } from "../api";
import { ErrorCard, PageHeader } from "../ui";
import type { MemoItem, MemoStatus } from "@toolbox/shared";

const card: CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.25rem 1.5rem",
  marginBottom: "1rem",
};

const btn: CSSProperties = {
  padding: "0.5rem 1.1rem",
  borderRadius: 8,
  border: "none",
  background: "#3b82f6",
  color: "#fff",
  fontSize: "0.9rem",
  fontWeight: 600,
  cursor: "pointer",
};

const input: CSSProperties = {
  padding: "0.5rem 0.7rem",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  fontSize: "0.9rem",
  outline: "none",
  flex: 1,
  minWidth: 0,
};

const STATUS_META: Record<MemoStatus, { label: string; color: string; bg: string; next: MemoStatus }> = {
  open: { label: "待处理", color: "#b45309", bg: "#fef3c7", next: "doing" },
  doing: { label: "修复中", color: "#1d4ed8", bg: "#dbeafe", next: "done" },
  done: { label: "已完成", color: "#15803d", bg: "#dcfce7", next: "open" },
};

const STATUS_ORDER: MemoStatus[] = ["open", "doing", "done"];

export default function MemoTool() {
  const [items, setItems] = useState<MemoItem[]>([]);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const refresh = useCallback(async () => {
    try {
      const r = await api.memoList();
      if (r.ok) setItems(r.items);
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async () => {
    const t = text.trim();
    if (!t) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await api.memoCreate(t);
      if (r.ok) {
        setText("");
        await refresh();
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  const cycleStatus = async (item: MemoItem) => {
    const next = STATUS_META[item.status].next;
    setErr(null);
    try {
      const r = await api.memoUpdate(item.id, { status: next });
      if (r.ok) await refresh();
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  const saveEdit = async (id: string) => {
    const t = editText.trim();
    if (!t) return;
    setErr(null);
    try {
      const r = await api.memoUpdate(id, { text: t });
      if (r.ok) {
        setEditingId(null);
        await refresh();
      }
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("删除这条改进记录？")) return;
    setErr(null);
    try {
      const r = await api.memoDelete(id);
      if (r.ok) await refresh();
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  const count = (s: MemoStatus) => items.filter((i) => i.status === s).length;

  return (
    <div>
      <PageHeader
        title="📝 改进备忘录"
        desc="TODO list：把使用页面过程中遇到的小问题记录在这里，开发者会驱动 Agent 逐一修复。点击状态按钮可流转 待处理 → 修复中 → 已完成。"
      />
      {err && <ErrorCard>{err}</ErrorCard>}

      <div style={card}>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.8rem" }}>
          <input
            style={input}
            placeholder="记录一个改进点 / 问题，例如：某某页面按钮文案不清晰…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
          />
          <button style={btn} onClick={() => void add()} disabled={loading} type="button">
            ➕ 记录
          </button>
        </div>
        <div style={{ display: "flex", gap: "1rem", fontSize: "0.82rem", color: "#64748b" }}>
          <span>📋 待处理 {count("open")}</span>
          <span>🔧 修复中 {count("doing")}</span>
          <span>✅ 已完成 {count("done")}</span>
        </div>
      </div>

      {items.length === 0 && (
        <div style={card}>
          <div style={{ color: "#94a3b8", textAlign: "center", padding: "1rem 0" }}>暂无改进记录，使用中遇到问题就记一条吧。</div>
        </div>
      )}

      {STATUS_ORDER.map((s) => {
        const group = items.filter((i) => i.status === s);
        if (group.length === 0) return null;
        const meta = STATUS_META[s];
        return (
          <div key={s} style={card}>
            <div style={{ fontWeight: 700, marginBottom: "0.6rem", color: meta.color }}>
              {meta.label}（{group.length}）
            </div>
            {group.map((item) => (
              <div
                key={item.id}
                style={{
                  display: "flex",
                  gap: "0.6rem",
                  alignItems: "flex-start",
                  padding: "0.55rem 0",
                  borderBottom: "1px solid #f1f5f9",
                }}
              >
                <button
                  style={{ ...btn, background: meta.bg, color: meta.color, padding: "0.35rem 0.7rem", fontSize: "0.8rem", whiteSpace: "nowrap" }}
                  onClick={() => void cycleStatus(item)}
                  title={`点击切换到「${STATUS_META[meta.next].label}」`}
                  type="button"
                >
                  {meta.label} →
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {editingId === item.id ? (
                    <div style={{ display: "flex", gap: "0.4rem" }}>
                      <input style={input} value={editText} onChange={(e) => setEditText(e.target.value)} autoFocus />
                      <button style={btn} onClick={() => void saveEdit(item.id)} type="button">保存</button>
                      <button style={{ ...btn, background: "#64748b" }} onClick={() => setEditingId(null)} type="button">取消</button>
                    </div>
                  ) : (
                    <div
                      style={{ cursor: "text", fontSize: "0.92rem", wordBreak: "break-word" }}
                      onDoubleClick={() => { setEditingId(item.id); setEditText(item.text); }}
                      title="双击编辑"
                    >
                      {item.text}
                      <div style={{ color: "#94a3b8", fontSize: "0.72rem", marginTop: "0.2rem" }}>
                        创建 {item.createdAt.slice(0, 10)} · 更新 {item.updatedAt.slice(0, 10)}
                      </div>
                    </div>
                  )}
                </div>
                <button
                  style={{ padding: "0.3rem 0.7rem", borderRadius: 8, border: "1px solid #fca5a5", background: "transparent", color: "#dc2626", fontSize: "0.8rem", cursor: "pointer" }}
                  onClick={() => void remove(item.id)}
                  type="button"
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
