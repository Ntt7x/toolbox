// ============================================================
// 本地数据管理：查看与维护本地持久化数据（SQLite KV/表）
// 增强：源列表按 tag 分组、条目搜索/分页、缓存类源一键清空、
//       详情 JSON 格式化查看 + 编辑
// ============================================================

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { api, errMsg } from "../api";
import { PageHeader } from "../ui";
import type { LocalDataSource, LocalDataEntry } from "@toolbox/shared";

const card: CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.1rem 1.3rem",
  marginBottom: "0.8rem",
};

const btn: CSSProperties = {
  padding: "0.4rem 0.9rem",
  borderRadius: 8,
  border: "none",
  background: "#3b82f6",
  color: "#fff",
  fontSize: "0.82rem",
  fontWeight: 600,
  cursor: "pointer",
};

const chip = (bg: string, fg: string): CSSProperties => ({
  background: bg,
  color: fg,
  padding: "0.15rem 0.55rem",
  borderRadius: 999,
  fontSize: "0.72rem",
  fontWeight: 700,
  whiteSpace: "nowrap",
});

const thTd: CSSProperties = {
  border: "1px solid #e2e8f0",
  padding: "0.4rem 0.55rem",
  textAlign: "left",
  fontSize: "0.8rem",
  verticalAlign: "top",
};

const th: CSSProperties = { ...thTd, background: "#f1f5f9", fontWeight: 600 };

const input: CSSProperties = {
  padding: "0.4rem 0.7rem",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  fontSize: "0.82rem",
  outline: "none",
};

/** tag 颜色映射 */
const TAG_COLOR: Record<string, [string, string]> = {
  设置数据: ["#eff6ff", "#1d4ed8"],
  自选数据: ["#f5f3ff", "#6d28d9"],
  分析缓存: ["#fef3c7", "#b45309"],
  分析数据: ["#ecfdf5", "#047857"],
  知识数据: ["#ede9fe", "#7c3aed"],
  存量数据: ["#fef2f2", "#b91c1c"],
  运行状态: ["#f0f9ff", "#0369a1"],
  改进备忘录: ["#fffbeb", "#a16207"],
  未标记: ["#f1f5f9", "#475569"],
};

function tagStyle(tag: string): CSSProperties {
  const [bg, fg] = TAG_COLOR[tag] ?? ["#f1f5f9", "#475569"];
  return chip(bg, fg);
}

const TAG_ORDER = ["设置数据", "自选数据", "分析缓存", "分析数据", "知识数据", "存量数据", "运行状态", "改进备忘录", "未标记"];

const PAGE_SIZE = 50;

/** 字节数格式化（B/KB/MB 自适应） */
function fmtBytes(n: number): string {
  if (!n || n <= 0) return "0 B";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export default function LocalData() {
  const [sources, setSources] = useState<LocalDataSource[] | null>(null);
  const [active, setActive] = useState<LocalDataSource | null>(null);
  const [entries, setEntries] = useState<LocalDataEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [searchText, setSearchText] = useState("");
  const [detail, setDetail] = useState<{ key: string; value: unknown; updatedAt?: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const loadSources = useCallback(async () => {
    try {
      const r = await api.localSources();
      if (r.ok && "sources" in r) setSources(r.sources);
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  }, []);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  /** 加载条目（分页：offset 指定页首；page=0 表示首屏） */
  const loadEntries = useCallback(async (s: LocalDataSource, search: string, off: number) => {
    setLoading(true);
    setMsg(null);
    try {
      const q = s.kind === "kv"
        ? { source: s.name, search: search || undefined, limit: PAGE_SIZE, offset: off }
        : { table: s.name, search: search || undefined, limit: PAGE_SIZE, offset: off };
      const r = await api.localEntries(q);
      if (r.ok && "entries" in r) {
        setEntries(r.entries as LocalDataEntry[]);
        setTotal(r.total);
        setOffset(off);
      } else if (!r.ok) {
        setMsg({ kind: "err", text: r.message });
      }
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  const openSource = async (s: LocalDataSource) => {
    setActive(s);
    setDetail(null);
    setEditing(false);
    setEntries([]);
    setTotal(0);
    setOffset(0);
    setSearchText("");
    await loadEntries(s, "", 0);
  };

  const applySearch = async () => {
    if (!active) return;
    setEntries([]);
    setTotal(0);
    setOffset(0);
    await loadEntries(active, searchText.trim(), 0);
  };

  /** 翻页 */
  const goPage = async (page: number) => {
    if (!active) return;
    if (page < 0 || page * PAGE_SIZE >= total) return;
    await loadEntries(active, searchText.trim(), page * PAGE_SIZE);
  };

  const currentPage = total > 0 ? Math.floor(offset / PAGE_SIZE) + 1 : 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const clearSource = async () => {
    if (!active || active.kind !== "kv") return;
    if (!window.confirm(`确定清空数据源「${active.name}」全部 ${total} 条？\n（缓存/分析类可重新生成；请确认非重要数据）`)) return;
    setMsg(null);
    try {
      const r = await api.localClearSource(active.name);
      if (r.ok) {
        setMsg({ kind: "ok", text: `已清空 ${r.deleted} 条` });
        setEntries([]);
        setTotal(0);
        setOffset(0);
        await loadSources();
      }
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  const openDetail = async (key: string) => {
    if (!active) return;
    setLoading(true);
    setMsg(null);
    try {
      const r = active.kind === "kv"
        ? await api.localEntry({ source: active.name, key })
        : await api.localEntry({ table: active.name, key });
      if (r.ok && "value" in r) {
        setDetail({ key, value: r.value, updatedAt: r.updatedAt });
        setEditText(JSON.stringify(r.value, null, 2));
        setEditing(false);
      } else if (!r.ok) {
        setMsg({ kind: "err", text: r.message });
      }
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    } finally {
      setLoading(false);
    }
  };

  const removeEntry = async (key: string) => {
    if (!active) return;
    if (!window.confirm(`确定删除 ${key} ？`)) return;
    setMsg(null);
    try {
      const r = active.kind === "kv"
        ? await api.localDelete({ source: active.name, key })
        : await api.localDelete({ table: active.name, key });
      if (r.ok) {
        setMsg({ kind: "ok", text: `已删除 ${key}` });
        setDetail(null);
        await loadEntries(active, searchText.trim(), 0);
        await loadSources();
      } else {
        setMsg({ kind: "err", text: r.message });
      }
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  const saveEdit = async () => {
    if (!active || !detail) return;
    let value: unknown;
    try {
      value = JSON.parse(editText);
    } catch {
      setMsg({ kind: "err", text: "JSON 格式错误，无法保存" });
      return;
    }
    setMsg(null);
    try {
      const r = await api.localUpdate({ source: active.name, key: detail.key, value });
      if (r.ok) {
        setMsg({ kind: "ok", text: `已更新 ${detail.key}` });
        setEditing(false);
        await loadEntries(active, searchText.trim(), 0);
        await loadSources();
      } else {
        setMsg({ kind: "err", text: r.message });
      }
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  /** 源列表按 tag 分组（已知 tag 按 TAG_ORDER 排序优先；未列出的 tag 按出现顺序追加末尾，避免漏显） */
  const groups = useCallback(() => {
    if (!sources) return [];
    const grouped = new Map<string, LocalDataSource[]>();
    for (const s of sources) {
      const list = grouped.get(s.tag) ?? [];
      list.push(s);
      grouped.set(s.tag, list);
    }
    const known = TAG_ORDER.filter((t) => grouped.has(t));
    const extra = [...grouped.keys()].filter((t) => !TAG_ORDER.includes(t));
    return [...known, ...extra].map((t) => ({ tag: t, items: grouped.get(t)! }));
  }, [sources]);

  return (
    <div>
      <PageHeader
        title="🗄️ 本地数据"
        desc="查看与维护本地持久化数据（SQLite：表模型 + Key-结构化 Value）。数据带「页面 tag」标记来源与场景；支持搜索、分页、缓存类源一键清空。"
      />

      {msg && (
        <div style={{ ...card, borderColor: msg.kind === "ok" ? "#86efac" : "#fca5a5", background: msg.kind === "ok" ? "#f0fdf4" : "#fef2f2", color: msg.kind === "ok" ? "#15803d" : "#b91c1c" }}>
          {msg.text}
        </div>
      )}

      {/* 概览条 */}
      {sources && (
        <div style={{ ...card, display: "flex", gap: "1.4rem", flexWrap: "wrap", padding: "0.6rem 1.1rem", marginBottom: "0.8rem", background: "#f8fafc" }}>
          <span style={{ fontSize: "0.78rem", color: "#475569" }}>
            <b style={{ fontSize: "1rem", color: "#1e293b" }}>{sources.length}</b> 个数据源
          </span>
          <span style={{ fontSize: "0.78rem", color: "#475569" }}>
            <b style={{ fontSize: "1rem", color: "#1e293b" }}>{sources.reduce((s, x) => s + (x.count ?? 0), 0)}</b> 条数据
          </span>
          <span style={{ fontSize: "0.78rem", color: "#475569" }}>
            存储 <b style={{ color: "#1e293b" }}>{fmtBytes(sources.reduce((s, x) => s + (x.sizeBytes ?? 0), 0))}</b>
          </span>
          <span style={{ flex: 1 }} />
          <button style={{ ...btn, background: "#64748b", padding: "0.25rem 0.7rem", fontSize: "0.75rem" }} onClick={() => void loadSources()} type="button">⟳ 刷新</button>
        </div>
      )}

      {/* 数据源列表（按 tag 分组，可折叠） */}
      {!active && (
        <div>
          {sources === null ? (
            <div style={card}>加载中…</div>
          ) : (
            groups().map((g) => (
              <details key={g.tag} open style={{ marginBottom: "0.5rem" }}>
                <summary style={{ cursor: "pointer", fontSize: "0.82rem", fontWeight: 700, color: "#334155", padding: "0.35rem 0.1rem", userSelect: "none" }}>
                  🏷 {g.tag}
                  <span style={{ fontWeight: 400, color: "#94a3b8", fontSize: "0.72rem", marginLeft: "0.4rem" }}>
                    {g.items.length} 源 · {g.items.reduce((s, x) => s + (x.count ?? 0), 0)} 条 · {fmtBytes(g.items.reduce((s, x) => s + (x.sizeBytes ?? 0), 0))}
                  </span>
                </summary>
                {g.items.map((s) => (
                  <div key={`${s.kind}:${s.name}`} style={{ ...card, padding: "0.7rem 1rem", cursor: "pointer" }} onClick={() => void openSource(s)}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                      <span style={chip(s.kind === "kv" ? "#eff6ff" : "#f5f3ff", s.kind === "kv" ? "#1d4ed8" : "#6d28d9")}>
                        {s.kind === "kv" ? "KV" : "表"}
                      </span>
                      <b style={{ fontSize: "0.88rem" }}>{s.name}</b>
                      <span style={chip("#fef3c7", "#b45309")}>📄 {s.page}</span>
                      <span style={{ marginLeft: "auto", color: "#64748b", fontSize: "0.78rem" }}>
                        {s.count} 条{s.sizeBytes ? ` · ${fmtBytes(s.sizeBytes)}` : ""} →
                      </span>
                    </div>
                    <div style={{ color: "#94a3b8", fontSize: "0.74rem", marginTop: "0.2rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }} title={s.description}>
                      {s.description}
                    </div>
                  </div>
                ))}
              </details>
            ))
          )}
        </div>
      )}

      {/* 数据源条目列表（搜索 + 分页 + 清空） */}
      {active && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
            <button style={{ ...btn, background: "#64748b" }} onClick={() => { setActive(null); setDetail(null); setEntries([]); void loadSources(); }} type="button">
              ← 返回
            </button>
            <span style={chip(active.kind === "kv" ? "#eff6ff" : "#f5f3ff", active.kind === "kv" ? "#1d4ed8" : "#6d28d9")}>{active.kind === "kv" ? "KV" : "表"}</span>
            <b>{active.name}</b>
            <span style={tagStyle(active.tag)}>🏷 {active.tag}</span>
            <span style={{ color: "#64748b", fontSize: "0.8rem" }}>{total} 条</span>
            {active.kind === "kv" && (
              <button style={{ ...btn, background: "#dc2626", marginLeft: "auto" }} onClick={() => void clearSource()} type="button">
                🗑 清空数据源
              </button>
            )}
          </div>

          {/* 搜索 */}
          <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.6rem", alignItems: "center" }}>
            <input
              style={{ ...input, flex: 1, maxWidth: 360 }}
              placeholder="搜索 key / 值内容（包含匹配）"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void applySearch(); }}
            />
            <button style={btn} onClick={() => void applySearch()} type="button">🔍 搜索</button>
            <button style={{ ...btn, background: "#64748b" }} onClick={() => { setSearchText(""); void applySearch(); }} type="button">清空</button>
          </div>

          {loading && entries.length === 0 ? (
            <div style={card}>加载中…</div>
          ) : entries.length === 0 ? (
            <div style={card}>（空）</div>
          ) : (
            <div style={{ ...card, padding: 0, overflow: "hidden" }}>
              <table className="table" style={{ margin: 0 }}>
                <thead>
                  <tr>
                    <th>key</th>
                    <th>更新时间</th>
                    <th style={{ width: 70 }}>大小</th>
                    <th>预览</th>
                    <th style={{ width: 130 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.key}>
                      <td><b>{e.key}</b></td>
                      <td style={{ fontSize: "0.76rem", color: "#64748b" }}>{e.updatedAt ? new Date(e.updatedAt).toLocaleString() : "—"}</td>
                      <td style={{ fontSize: "0.72rem", color: "#64748b" }} title={`${e.size ?? 0} 字节`}>
                        {(e.size ?? 0) >= 1024 ? ((e.size ?? 0) / 1024).toFixed(1) + " KB" : (e.size ?? 0) + " B"}
                      </td>
                      <td style={{ padding: "0.5rem 0.7rem" }}>
                        <code style={{ fontSize: "0.75rem", color: "#475569" }}>{e.preview}</code>
                      </td>
                      <td style={{ padding: "0.5rem 0.7rem" }}>
                        <button style={{ ...btn, background: "#0891b2", padding: "0.25rem 0.6rem" }} onClick={() => void openDetail(e.key)} type="button">
                          查看
                        </button>{" "}
                        <button style={{ ...btn, background: "#dc2626", padding: "0.25rem 0.6rem" }} onClick={() => void removeEntry(e.key)} type="button">
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {totalPages > 1 && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.6rem", marginTop: "0.7rem" }}>
                  <button style={{ ...btn, background: "#64748b" }} onClick={() => void goPage(currentPage - 2)} disabled={currentPage <= 1} type="button">
                    ← 上一页
                  </button>
                  <span style={{ color: "#64748b", fontSize: "0.85rem" }}>
                    第 <b>{currentPage}</b> / {totalPages} 页 · 共 {total} 条（每页 {PAGE_SIZE}）
                  </span>
                  <button style={{ ...btn, background: "#64748b" }} onClick={() => void goPage(currentPage)} disabled={currentPage >= totalPages} type="button">
                    下一页 →
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 详情 / 编辑 */}
      {detail && active && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
            <b style={{ fontSize: "0.92rem" }}>📄 {detail.key}</b>
            {detail.updatedAt && <span style={{ color: "#94a3b8", fontSize: "0.78rem" }}>更新于 {new Date(detail.updatedAt).toLocaleString()}</span>}
            <span style={{ marginLeft: "auto" }}>
              {!editing ? (
                <button style={{ ...btn, background: "#0891b2" }} onClick={() => setEditing(true)} type="button">✏️ 编辑</button>
              ) : (
                <>
                  <button style={{ ...btn, background: "#16a34a" }} onClick={saveEdit} type="button">💾 保存</button>{" "}
                  <button style={{ ...btn, background: "#64748b" }} onClick={() => setEditing(false)} type="button">取消</button>
                </>
              )}
            </span>
          </div>
          {editing ? (
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={12}
              style={{ width: "100%", marginTop: "0.6rem", fontFamily: "monospace", fontSize: "0.8rem", borderRadius: 8, border: "1px solid #cbd5e1", padding: "0.6rem", boxSizing: "border-box" }}
            />
          ) : (
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", background: "#0f172a", color: "#e2e8f0", padding: "0.8rem 1rem", borderRadius: 8, marginTop: "0.6rem", fontSize: "0.78rem", maxHeight: "24rem", overflowY: "auto" }}>
              {JSON.stringify(detail.value, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
