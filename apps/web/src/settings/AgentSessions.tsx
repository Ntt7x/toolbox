// ============================================================
// 设置 → Agent 会话管理
// 管理两类有状态 LLM 会话：
//   - 自研 Cache 会话（chatSession，模式 2）：看历史 / 续问 / 恢复归档 / 删除
//   - Reasonix 会话（模式 3）：续问 / 关闭
// ============================================================
import { useEffect, useState, type ReactNode, type CSSProperties } from "react";
import { api } from "../api";
import type { AgentSessionsResult, AgentSessionAskResult, AgentSessionListItem, ChatSessionDetail } from "@toolbox/shared";

const STATUS_BADGE: Record<string, { text: string; bg: string; color: string }> = {
  active: { text: "活跃", bg: "#dcfce7", color: "#15803d" },
  archived: { text: "已归档", bg: "#f1f5f9", color: "#64748b" },
};

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN");
}

function usageLine(u?: AgentSessionAskResult["usage"]): string {
  if (!u) return "";
  const hit = u.cacheHitTokens ?? 0;
  const miss = u.cacheMissTokens ?? 0;
  const rate = hit + miss > 0 ? Math.round((hit / (hit + miss)) * 1000) / 10 : 0;
  return `⛽ ${u.promptTokens ?? "?"}t · 缓存命中 ${rate}%${u.estimatedCost !== undefined ? ` · ¥${(u.estimatedCost * 7.3).toFixed(4)}` : ""}`;
}

function SessionCard(props: {
  kind: "chat" | "reasonix";
  s: AgentSessionListItem;
  onChanged: () => void;
}) {
  const { kind, s, onChanged } = props;
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ChatSessionDetail | null>(null);
  const [askText, setAskText] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<AgentSessionAskResult | null>(null);
  const [error, setError] = useState("");

  const loadDetail = async () => {
    if (kind !== "chat") return;
    try {
      const d = await api.agentSessionDetail(s.id);
      if (d.ok) setDetail(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggle = () => {
    setOpen(!open);
    if (!open) void loadDetail();
  };

  const doAsk = async () => {
    const text = askText.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    setLastResult(null);
    try {
      const task = await api.agentSessionAsk(kind, s.id, text);
      if (!task.ok) {
        setError(task.message ?? "任务创建失败");
        return;
      }
      const r = await waitTask(task.taskId);
      if (r.ok && r.result) {
        setLastResult(r.result);
        if (kind === "chat") {
          await loadDetail();
          onChanged();
        }
      } else {
        setError(r.message ?? "任务失败");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setAskText("");
    }
  };

  const doDelete = async () => {
    if (!confirm(`删除会话 ${s.id}？`)) return;
    await api.agentSessionDelete(kind, s.id);
    onChanged();
  };

  const doRestore = async () => {
    await api.agentSessionRestore(s.id);
    await loadDetail();
    onChanged();
  };

  const badge = STATUS_BADGE[s.status] ?? STATUS_BADGE.active;

  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, marginBottom: "0.5rem", background: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.5rem 0.8rem" }}>
        <span style={{ fontSize: "0.72rem", padding: "0.1rem 0.45rem", borderRadius: 6, background: badge.bg, color: badge.color, fontWeight: 600 }}>{badge.text}</span>
        <b style={{ fontSize: "0.82rem", color: "#1e293b" }}>{s.module}</b>
        <span style={{ fontSize: "0.72rem", color: "#94a3b8", fontFamily: "monospace" }}>{s.id}</span>
        {kind === "chat" && s.turns > 0 && <span style={{ fontSize: "0.72rem", color: "#64748b" }}>{s.turns} 轮</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: "0.72rem", color: "#94a3b8" }}>创建 {fmtTime(s.createdAt)}</span>
        <button style={btn} onClick={toggle} type="button">{open ? "收起 ▲" : "展开 ▼"}</button>
        <button style={{ ...btn, color: "#b91c1c" }} onClick={() => void doDelete()} type="button">删除</button>
      </div>
      {open && (
        <div style={{ padding: "0.6rem 0.8rem 0.8rem", borderTop: "1px solid #e2e8f0", fontSize: "0.8rem" }}>
          {kind === "chat" ? (
            detail ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                <details style={{ background: "#f8fafc", borderRadius: 8, padding: "0.4rem" }}>
                  <summary style={{ cursor: "pointer", color: "#475569" }}>🧠 System 提示词（{detail.system?.length ?? 0} 字）</summary>
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.72rem", color: "#475569", margin: "0.4rem 0 0" }}>{detail.system}</pre>
                </details>
                {detail.archived && (
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", background: "#fef9c3", borderRadius: 8, padding: "0.4rem 0.6rem" }}>
                    <span style={{ color: "#a16207" }}>已归档（{detail.summary ? `摘要：${detail.summary.slice(0, 60)}…` : "无摘要"}）</span>
                    <button style={btn} onClick={() => void doRestore()} type="button">恢复续用</button>
                  </div>
                )}
                {detail.history && detail.history.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", maxHeight: 280, overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.5rem" }}>
                    {detail.history.map((m, i) => (
                      <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%", background: m.role === "user" ? "#dbeafe" : "#f1f5f9", borderRadius: 10, padding: "0.35rem 0.6rem", fontSize: "0.75rem", whiteSpace: "pre-wrap", color: "#1e293b" }}>
                        <span style={{ fontSize: "0.65rem", color: "#64748b" }}>{m.role === "user" ? "👤 我" : "🤖 助手"}</span>
                        <div>{String(m.content).slice(0, 600)}{String(m.content).length > 600 ? "…" : ""}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ color: "#94a3b8" }}>暂无对话轮次</div>
                )}
              </div>
            ) : (
              <div style={{ color: "#94a3b8" }}>加载中…</div>
            )
          ) : (
            <div style={{ color: "#64748b" }}>Reasonix 会话历史保存在 Agent 侧（ACP 持久化），此处可续问/关闭；最后活动 {fmtTime(s.lastAt)}</div>
          )}
          {error && <div style={{ color: "#b91c1c", marginTop: "0.4rem" }}>❌ {error}</div>}
          {lastResult && lastResult.ok && (
            <div style={{ marginTop: "0.4rem", background: "#f0fdf4", borderRadius: 8, padding: "0.5rem" }}>
              <div style={{ fontSize: "0.7rem", color: "#15803d" }}>✓ {usageLine(lastResult.usage)}</div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: "0.78rem", color: "#1e293b" }}>{lastResult.content}</div>
            </div>
          )}
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
            <input
              value={askText}
              onChange={(e) => setAskText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void doAsk()}
              placeholder={kind === "chat" ? "向该会话追加一条消息…" : "向该 Reasonix 会话提问…"}
              style={{ flex: 1, padding: "0.4rem 0.6rem", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: "0.8rem" }}
            />
            <button style={{ ...btn, background: "#2563eb", color: "#fff", borderColor: "#2563eb" }} disabled={busy} onClick={() => void doAsk()} type="button">
              {busy ? "发送中…" : "发送"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 轮询等待后台任务完成（页面简单场景够用） */
async function waitTask(taskId: string): Promise<{ ok: boolean; result?: AgentSessionAskResult; message?: string }> {
  for (let i = 0; i < 200; i++) {
    const t = await api.taskStatus<AgentSessionAskResult>(taskId);
    if (t.ok && t.status === "done" && t.result) return { ok: true, result: t.result };
    if (!t.ok || t.status === "error" || t.status === "cancelled") return { ok: false, message: t.message ?? "任务失败" };
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false, message: "等待超时" };
}

const btn: CSSProperties = {
  fontSize: "0.72rem",
  padding: "0.2rem 0.6rem",
  background: "#f1f5f9",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  cursor: "pointer",
  color: "#334155",
};

export default function AgentSessions() {
  const [data, setData] = useState<AgentSessionsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState<"chat" | "reasonix" | null>(null);
  const [module, setModule] = useState("");
  const [system, setSystem] = useState("");
  const [search, setSearch] = useState(false);
  const [json, setJson] = useState(false);
  const [err, setErr] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      setData(await api.agentSessions());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const doCreate = async () => {
    const m = module.trim();
    if (!m) return;
    setErr("");
    try {
      const r = await api.agentSessionCreate(showCreate!, {
        module: m,
        ...(showCreate === "chat" ? { system: system.trim() } : {}),
        ...(showCreate === "chat" && search ? { search: true } : {}),
        ...(showCreate === "chat" && json ? { json: true } : {}),
      });
      if (!r.ok) setErr(r.message ?? "创建失败");
      setShowCreate(null);
      setModule("");
      setSystem("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const renderList = (kind: "chat" | "reasonix", title: string, items: AgentSessionListItem[]): ReactNode => (
    <div style={{ marginBottom: "1.2rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.4rem" }}>
        <b style={{ fontSize: "0.9rem", color: "#334155" }}>{title}</b>
        <span style={{ fontSize: "0.75rem", color: "#94a3b8" }}>{items.length} 个会话</span>
        <span style={{ flex: 1 }} />
        <button style={btn} onClick={() => setShowCreate(kind)} type="button">＋ 新建</button>
      </div>
      {items.length === 0 ? (
        <div style={{ color: "#94a3b8", fontSize: "0.8rem" }}>暂无会话</div>
      ) : (
        items.map((s) => <SessionCard key={s.id} kind={kind} s={s} onChanged={() => void load()} />)
      )}
    </div>
  );

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "1.2rem" }}>
      <h2 style={{ fontSize: "1.1rem", margin: "0 0 0.2rem" }}>🤖 Agent 会话管理</h2>
      <p style={{ color: "#64748b", fontSize: "0.8rem", margin: "0 0 1rem" }}>
        管理两类有状态 LLM 会话。会话共享前缀缓存（DeepSeek 缓存价 1/50），同主题多次调用建议复用同一会话以降本。
      </p>
      {err && <div style={{ color: "#b91c1c", marginBottom: "0.6rem", fontSize: "0.8rem" }}>❌ {err}</div>}
      {loading ? (
        <div style={{ color: "#94a3b8" }}>加载中…</div>
      ) : (
        data && (
          <>
            {renderList("chat", "自研 Cache 会话（模式 2）", data.chat)}
            {renderList("reasonix", "Reasonix 会话（模式 3）", data.reasonix)}
          </>
        )
      )}
      {showCreate && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }} onClick={() => setShowCreate(null)}>
          <div style={{ background: "#fff", borderRadius: 12, padding: "1.2rem", width: 520, boxShadow: "0 10px 40px rgba(0,0,0,0.2)" }} onClick={(e) => e.stopPropagation()}>
            <b style={{ fontSize: "0.95rem" }}>新建 {showCreate === "chat" ? "Cache 会话" : "Reasonix 会话"}</b>
            <div style={{ marginTop: "0.8rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <label style={{ fontSize: "0.78rem", color: "#475569" }}>
                模块名（用量统计，如 my.module）
                <input value={module} onChange={(e) => setModule(e.target.value)} placeholder="如 medical.qa" style={{ width: "100%", padding: "0.4rem 0.6rem", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: "0.8rem", marginTop: "0.2rem" }} />
              </label>
              {showCreate === "chat" && (
                <>
                  <label style={{ fontSize: "0.78rem", color: "#475569" }}>
                    System 提示词（前缀锚点，会话内不可变）
                    <textarea value={system} onChange={(e) => setSystem(e.target.value)} rows={5} placeholder="你是…" style={{ width: "100%", padding: "0.4rem 0.6rem", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: "0.8rem", marginTop: "0.2rem", fontFamily: "monospace" }} />
                  </label>
                  <div style={{ display: "flex", gap: "1rem" }}>
                    <label style={{ fontSize: "0.78rem", display: "flex", gap: "0.3rem", alignItems: "center" }}>
                      <input type="checkbox" checked={search} onChange={(e) => setSearch(e.target.checked)} /> 联网搜索
                    </label>
                    <label style={{ fontSize: "0.78rem", display: "flex", gap: "0.3rem", alignItems: "center" }}>
                      <input type="checkbox" checked={json} onChange={(e) => setJson(e.target.checked)} /> JSON 输出
                    </label>
                  </div>
                </>
              )}
              {showCreate === "reasonix" && <div style={{ fontSize: "0.72rem", color: "#94a3b8" }}>Reasonix 会话将挂载到 .file 工作区（git 隔离）</div>}
            </div>
            <div style={{ display: "flex", gap: "0.6rem", justifyContent: "flex-end", marginTop: "1rem" }}>
              <button style={btn} onClick={() => setShowCreate(null)} type="button">取消</button>
              <button style={{ ...btn, background: "#2563eb", color: "#fff", borderColor: "#2563eb" }} disabled={!module.trim() || (showCreate === "chat" && !system.trim())} onClick={() => void doCreate()} type="button">创建</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
