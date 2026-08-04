import { useEffect, useState, type CSSProperties } from "react";
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
});

const thTd: CSSProperties = {
  border: "1px solid #e2e8f0",
  padding: "0.4rem 0.55rem",
  textAlign: "left",
  fontSize: "0.8rem",
  verticalAlign: "top",
};

const th: CSSProperties = { ...thTd, background: "#f1f5f9", fontWeight: 600 };

export default function LocalData() {
  const [sources, setSources] = useState<LocalDataSource[] | null>(null);
  const [active, setActive] = useState<LocalDataSource | null>(null);
  const [entries, setEntries] = useState<LocalDataEntry[]>([]);
  const [detail, setDetail] = useState<{ key: string; value: unknown; updatedAt?: string } | null>(null);
  const [editText, setEditText] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const loadSources = async () => {
    try {
      const r = await api.localSources();
      if (r.ok && "sources" in r) setSources(r.sources);
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  useEffect(() => {
    void loadSources();
  }, []);

  const openSource = async (s: LocalDataSource) => {
    setActive(s);
    setDetail(null);
    setLoading(true);
    setMsg(null);
    try {
      const r = s.kind === "kv"
        ? await api.localEntries({ source: s.name })
        : await api.localEntries({ table: s.name });
      if (r.ok && "entries" in r) setEntries(r.entries);
      else if (!r.ok) setMsg({ kind: "err", text: r.message });
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    } finally {
      setLoading(false);
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
        await openSource(active);
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
        await openSource(active);
      } else {
        setMsg({ kind: "err", text: r.message });
      }
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    }
  };

  return (
    <div>
      <PageHeader
        title="🗄️ 本地数据管理"
        desc="查看与维护本地持久化数据（SQLite：表模型 + Key-结构化 Value）。数据带「页面 tag」标记来源与使用场景。"
      />

      {msg && (
        <div style={{ ...card, borderColor: msg.kind === "ok" ? "#86efac" : "#fca5a5", background: msg.kind === "ok" ? "#f0fdf4" : "#fef2f2", color: msg.kind === "ok" ? "#15803d" : "#b91c1c" }}>
          {msg.text}
        </div>
      )}

      {/* 数据源列表 */}
      {!active && (
        <div>
          {sources === null ? (
            <div style={card}>加载中…</div>
          ) : (
            sources.map((s) => (
              <div key={`${s.kind}:${s.name}`} style={{ ...card, cursor: "pointer" }} onClick={() => void openSource(s)}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                  <span style={chip(s.kind === "kv" ? "#eff6ff" : "#f5f3ff", s.kind === "kv" ? "#1d4ed8" : "#6d28d9")}>
                    {s.kind === "kv" ? "KV" : "表"}
                  </span>
                  <b>{s.name}</b>
                  <span style={chip("#fef3c7", "#b45309")}>📄 {s.page}</span>
                  <span style={chip("#ecfdf5", "#047857")}>🏷 {s.tag}</span>
                  <span style={{ marginLeft: "auto", color: "#64748b", fontSize: "0.8rem" }}>{s.count} 条 →</span>
                </div>
                <div style={{ color: "#94a3b8", fontSize: "0.8rem", marginTop: "0.3rem" }}>{s.description}</div>
              </div>
            ))
          )}
        </div>
      )}

      {/* 数据源条目列表 */}
      {active && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
            <button style={{ ...btn, background: "#64748b" }} onClick={() => { setActive(null); setDetail(null); setEntries([]); void loadSources(); }} type="button">
              ← 返回
            </button>
            <span style={chip(active.kind === "kv" ? "#eff6ff" : "#f5f3ff", active.kind === "kv" ? "#1d4ed8" : "#6d28d9")}>{active.kind === "kv" ? "KV" : "表"}</span>
            <b>{active.name}</b>
            <span style={chip("#fef3c7", "#b45309")}>📄 {active.page}</span>
            <span style={chip("#ecfdf5", "#047857")}>🏷 {active.tag}</span>
            <span style={{ marginLeft: "auto", color: "#64748b", fontSize: "0.8rem" }}>{entries.length} 条</span>
          </div>

          {loading ? (
            <div style={card}>加载中…</div>
          ) : entries.length === 0 ? (
            <div style={card}>（空）</div>
          ) : (
            <div style={card} className="noPad">
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>key</th>
                    <th style={th}>更新时间</th>
                    <th style={th}>预览</th>
                    <th style={{ ...th, width: 120 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.key}>
                      <td style={thTd}><b>{e.key}</b></td>
                      <td style={thTd}>{e.updatedAt ? new Date(e.updatedAt).toLocaleString() : "—"}</td>
                      <td style={thTd}>
                        <code style={{ fontSize: "0.75rem", color: "#475569" }}>{e.preview}</code>
                      </td>
                      <td style={thTd}>
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
          </div>
          {active.kind === "kv" ? (
            <>
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                rows={10}
                style={{ width: "100%", marginTop: "0.6rem", fontFamily: "monospace", fontSize: "0.8rem", borderRadius: 8, border: "1px solid #cbd5e1", padding: "0.6rem" }}
              />
              <div style={{ marginTop: "0.6rem" }}>
                <button style={{ ...btn, background: "#16a34a" }} onClick={saveEdit} type="button">💾 保存修改</button>
              </div>
            </>
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
