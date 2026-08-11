// ============================================================
// 待办清单（工具分组）：用户日常个人 todo（区别于改进备忘录）
// 新增 / 勾选完成 / 内联编辑 / 删除 / 清空已完成
// ============================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errMsg } from "../api";
import { PageHeader } from "../ui";
import type { TodoItem } from "@toolbox/shared";

const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.25rem 1.5rem",
  marginBottom: "1rem",
};

export default function TodoTool() {
  const [items, setItems] = useState<TodoItem[]>([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.todoList();
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

  const add = async () => {
    const t = text.trim();
    if (!t) return;
    setMsg(null);
    try {
      const r = await api.todoAdd(t);
      setItems(r.items);
      setText("");
      inputRef.current?.focus();
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  const toggle = async (it: TodoItem) => {
    try {
      const r = await api.todoUpdate(it.id, { done: !it.done });
      setItems(r.items);
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  const saveEdit = async (id: string) => {
    const t = editText.trim();
    setEditingId(null);
    if (!t) return;
    try {
      const r = await api.todoUpdate(id, { text: t });
      setItems(r.items);
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  const remove = async (id: string) => {
    if (!confirm("删除该待办？")) return;
    try {
      const r = await api.todoDelete(id);
      setItems(r.items);
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  const clearDone = async () => {
    if (!confirm("清空所有已完成待办？")) return;
    try {
      const r = await api.todoClearDone();
      setItems(r.items);
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  const done = items.filter((x) => x.done).length;
  const active = items.length - done;

  return (
    <div>
      <PageHeader title="待办清单" desc="日常个人任务清单（本地持久化，可在「本地数据」页查看）" />
      <div style={card}>
        <div style={{ display: "flex", gap: "0.6rem", marginBottom: "0.9rem" }}>
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
            placeholder="新增待办，回车确认…"
            style={{ flex: 1, padding: "0.55rem 0.75rem", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: "0.92rem" }}
          />
          <button
            onClick={() => void add()}
            disabled={!text.trim()}
            style={{ padding: "0.55rem 1.2rem", borderRadius: 8, border: "none", background: "#3b82f6", color: "#fff", fontSize: "0.92rem", fontWeight: 600, cursor: "pointer", opacity: text.trim() ? 1 : 0.5 }}
          >
            ＋ 添加
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", marginBottom: "0.7rem", fontSize: "0.8rem", color: "#64748b" }}>
          <span>
            共 <b>{items.length}</b> 项 · 待办 <b style={{ color: "#2563eb" }}>{active}</b> · 已完成 <b style={{ color: "#16a34a" }}>{done}</b>
          </span>
          {done > 0 && (
            <button onClick={() => void clearDone()} style={{ marginLeft: "auto", padding: "0.25rem 0.7rem", borderRadius: 6, border: "1px solid #e2e8f0", background: "#fff", color: "#64748b", fontSize: "0.78rem", cursor: "pointer" }}>
              🧹 清空已完成
            </button>
          )}
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: "2rem", color: "#94a3b8", fontSize: "0.9rem" }}>加载中…</div>
        ) : items.length === 0 ? (
          <div style={{ textAlign: "center", padding: "2.5rem 1rem", color: "#94a3b8", fontSize: "0.9rem" }}>
            暂无待办 🎉<br />
            <span style={{ fontSize: "0.8rem" }}>在上方输入内容，回车即可添加</span>
          </div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {items.map((it) => (
              <li
                key={it.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.6rem",
                  padding: "0.55rem 0.6rem",
                  borderRadius: 8,
                  marginBottom: "0.3rem",
                  background: it.done ? "#f8fafc" : "#fff",
                  border: "1px solid " + (it.done ? "#eef2f7" : "#e2e8f0"),
                }}
              >
                <input
                  type="checkbox"
                  checked={it.done}
                  onChange={() => void toggle(it)}
                  style={{ width: 17, height: 17, cursor: "pointer", accentColor: "#16a34a" }}
                />
                {editingId === it.id ? (
                  <input
                    autoFocus
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void saveEdit(it.id)}
                    onBlur={() => void saveEdit(it.id)}
                    style={{ flex: 1, padding: "0.35rem 0.55rem", borderRadius: 6, border: "1px solid #3b82f6", fontSize: "0.9rem" }}
                  />
                ) : (
                  <span
                    onDoubleClick={() => { setEditingId(it.id); setEditText(it.text); }}
                    title="双击编辑"
                    style={{ flex: 1, fontSize: "0.92rem", color: it.done ? "#94a3b8" : "#1e293b", textDecoration: it.done ? "line-through" : "none", cursor: "pointer", wordBreak: "break-all" }}
                  >
                    {it.text}
                  </span>
                )}
                <span style={{ fontSize: "0.7rem", color: "#94a3b8", flexShrink: 0 }}>{it.updatedAt.slice(0, 10)}</span>
                <button
                  onClick={() => void remove(it.id)}
                  title="删除"
                  style={{ flexShrink: 0, width: 26, height: 26, borderRadius: 6, border: "none", background: "transparent", color: "#f87171", fontSize: "0.85rem", cursor: "pointer" }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {msg && (
        <div style={{ padding: "0.7rem 1rem", borderRadius: 8, marginBottom: "0.8rem", border: "1px solid", borderColor: msg.kind === "ok" ? "#86efac" : "#fca5a5", background: msg.kind === "ok" ? "#f0fdf4" : "#fef2f2", color: msg.kind === "ok" ? "#15803d" : "#b91c1c", fontSize: "0.85rem" }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
