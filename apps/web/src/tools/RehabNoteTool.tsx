// ============================================================
// 康复笔记（通用）：分区知识展示 + 编辑 + 重置
// - 数据 KV 持久化（rehab:<id>），页面/本地数据管理均可编辑
// - 展示：分区卡片（title → items[name+detail]）
// - 编辑：每分区增删条目、改文本；保存整体回写服务端
// ============================================================

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { api, errMsg } from "../api";
import { ErrorCard, PageHeader } from "../ui";
import type { RehabNote, RehabNoteSection } from "@toolbox/shared";

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
  fontSize: "0.88rem",
  fontWeight: 600,
  cursor: "pointer",
};

const input: CSSProperties = {
  padding: "0.45rem 0.65rem",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  fontSize: "0.85rem",
};

const EMPTY: RehabNote = { id: "", title: "", updatedAt: "", sections: [] };

export default function RehabNoteTool({ id, title, desc }: { id: string; title: string; desc: string }) {
  const [note, setNote] = useState<RehabNote | null>(null);
  const [editing, setEditing] = useState(false);
  // 编辑草稿
  const [draftTitle, setDraftTitle] = useState("");
  const [draftSections, setDraftSections] = useState<RehabNoteSection[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.rehabGet(id);
      if (r.ok) setNote(r.note ?? null);
      else setErr(r.message ?? "加载失败");
    } catch (e) {
      setErr(errMsg(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const startEdit = () => {
    if (!note) return;
    setDraftTitle(note.title);
    setDraftSections(JSON.parse(JSON.stringify(note.sections)) as RehabNoteSection[]);
    setErr(null);
    setEditing(true);
  };

  /** 更新草稿中某分区的某条目字段 */
  const patchItem = (si: number, ii: number, field: "name" | "detail", value: string) => {
    setDraftSections((prev) => {
      const next = prev.map((s) => ({ ...s, items: s.items.map((it) => ({ ...it })) }));
      next[si].items[ii] = { ...next[si].items[ii], [field]: value };
      return next;
    });
  };

  const addItem = (si: number) => {
    setDraftSections((prev) => prev.map((s, i) => (i === si ? { ...s, items: [...s.items, { name: "", detail: "" }] } : s)));
  };

  const removeItem = (si: number, ii: number) => {
    setDraftSections((prev) => prev.map((s, i) => (i === si ? { ...s, items: s.items.filter((_, j) => j !== ii) } : s)));
  };

  const addSection = () => {
    setDraftSections((prev) => [...prev, { title: "", items: [{ name: "", detail: "" }] }]);
  };

  const removeSection = (si: number) => {
    setDraftSections((prev) => prev.filter((_, i) => i !== si));
  };

  const save = async () => {
    const sections = draftSections
      .map((s) => ({
        title: s.title.trim(),
        items: s.items.filter((it) => it.detail.trim() || (it.name ?? "").trim()).map((it) => ({
          ...((it.name ?? "").trim() ? { name: it.name!.trim() } : {}),
          detail: it.detail.trim(),
        })),
      }))
      .filter((s) => s.title && s.items.length > 0);
    if (sections.length === 0) {
      setErr("至少保留一个分区");
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const r = await api.rehabSave(id, { title: draftTitle.trim() || note?.title, sections });
      if (r.ok) {
        setNote(r.note ?? null);
        setEditing(false);
      } else {
        setErr(r.message ?? "保存失败");
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  const reset = async () => {
    if (!window.confirm("重置为默认内容？当前编辑内容将被覆盖。")) return;
    setErr(null);
    try {
      const r = await api.rehabReset(id);
      if (r.ok) {
        setNote(r.note ?? null);
        setEditing(false);
      } else {
        setErr(r.message ?? "重置失败");
      }
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  const cur = editing ? { title: draftTitle, sections: draftSections } : (note ?? EMPTY);

  return (
    <div>
      <PageHeader title={title} desc={desc} />

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
          {editing ? (
            <input
              style={{ ...input, flex: 1, minWidth: 200, fontWeight: 700 }}
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
            />
          ) : (
            <span style={{ fontWeight: 700, fontSize: "1.02rem" }}>{note?.title ?? "加载中…"}</span>
          )}
          <span style={{ flex: 1 }} />
          {!editing && (
            <>
              <button style={{ ...btn, background: "#0891b2" }} onClick={startEdit} type="button">
                ✏️ 编辑
              </button>
              <button style={{ ...btn, background: "#dc2626" }} onClick={() => void reset()} type="button">
                ↺ 重置默认
              </button>
            </>
          )}
          {editing && (
            <>
              <button style={btn} onClick={() => void save()} disabled={loading} type="button">
                {loading ? "保存中…" : "💾 保存"}
              </button>
              <button style={{ ...btn, background: "#64748b" }} onClick={() => setEditing(false)} type="button">
                取消
              </button>
            </>
          )}
        </div>
        {note && (
          <div style={{ color: "#94a3b8", fontSize: "0.75rem", marginBottom: "0.8rem" }}>
            数据存于本地数据管理（rehab:{id}），最后更新 {new Date(note.updatedAt).toLocaleString()}
          </div>
        )}
      </div>

      {err && <ErrorCard>{err}</ErrorCard>}

      {/* 分区 */}
      {cur.sections.map((s, si) => (
        <div key={si} style={card}>
          {editing ? (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.6rem" }}>
              <input
                style={{ ...input, flex: 1, minWidth: 200, fontWeight: 700 }}
                placeholder="分区标题"
                value={s.title}
                onChange={(e) =>
                  setDraftSections((prev) => prev.map((x, i) => (i === si ? { ...x, title: e.target.value } : x)))
                }
              />
              <button style={{ ...btn, background: "#dc2626", padding: "0.4rem 0.8rem", fontSize: "0.8rem" }} onClick={() => removeSection(si)} type="button">
                删除分区
              </button>
            </div>
          ) : (
            <div style={{ fontWeight: 700, marginBottom: "0.6rem", fontSize: "1rem", color: "#1e293b" }}>{s.title}</div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
            {s.items.map((it, ii) =>
              editing ? (
                <div key={ii} style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    style={{ ...input, width: 150 }}
                    placeholder="名称（可选）"
                    value={it.name ?? ""}
                    onChange={(e) => patchItem(si, ii, "name", e.target.value)}
                  />
                  <input
                    style={{ ...input, flex: 1, minWidth: 220 }}
                    placeholder="内容"
                    value={it.detail}
                    onChange={(e) => patchItem(si, ii, "detail", e.target.value)}
                  />
                  <button style={{ ...btn, background: "#dc2626", padding: "0.35rem 0.7rem", fontSize: "0.78rem" }} onClick={() => removeItem(si, ii)} type="button">
                    ✕
                  </button>
                </div>
              ) : (
                <div
                  key={ii}
                  style={{
                    display: "flex",
                    gap: "0.6rem",
                    padding: "0.5rem 0.7rem",
                    borderRadius: 8,
                    background: "#f8fafc",
                    border: "1px solid #e2e8f0",
                    fontSize: "0.88rem",
                    lineHeight: 1.55,
                  }}
                >
                  {it.name ? (
                    <>
                      <span style={{ fontWeight: 700, color: "#334155", whiteSpace: "nowrap", flexShrink: 0 }}>{it.name}：</span>
                      <span style={{ color: "#475569" }}>{it.detail}</span>
                    </>
                  ) : (
                    <span style={{ color: "#475569" }}>{it.detail}</span>
                  )}
                </div>
              ),
            )}
          </div>

          {editing && (
            <button style={{ ...btn, background: "#16a34a", padding: "0.35rem 0.9rem", fontSize: "0.8rem", marginTop: "0.6rem" }} onClick={() => addItem(si)} type="button">
              ＋ 添加条目
            </button>
          )}
        </div>
      ))}

      {editing && (
        <div style={card}>
          <button style={{ ...btn, background: "#7c3aed" }} onClick={addSection} type="button">
            ＋ 添加分区
          </button>
        </div>
      )}
    </div>
  );
}
