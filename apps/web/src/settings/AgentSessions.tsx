// ============================================================
// 设置 → Agent 会话管理
// 管理两类有状态 LLM 会话：
//   - 自研 Cache 会话（chatSession，模式 2）：看历史 / 续问 / 恢复归档 / 删除
//   - Reasonix 会话（模式 3）：续问 / 关闭
// ============================================================
import { useEffect, useState, type ReactNode, type CSSProperties } from "react";
import { api } from "../api";
import type { AgentSessionsResult, AgentSessionAskResult, AgentSessionListItem, ChatSessionDetail, ReasonixSessionDetail, ReasonixProcessStatus, McpServerConfigItem, PromptMeta } from "@toolbox/shared";

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
  const [detail, setDetail] = useState<ChatSessionDetail | ReasonixSessionDetail | null>(null);
  const [askText, setAskText] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<AgentSessionAskResult | null>(null);
  const [error, setError] = useState("");

  const loadDetail = async () => {
    try {
      const d = kind === "chat" ? await api.agentSessionDetail(s.id) : await api.agentSessionReasonixDetail(s.id);
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
        await loadDetail(); // chat/reasonix 均刷新详情（reasonix 历史也随续问追加）
        onChanged(); // 刷新列表（lastAt 等）
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
            detail && "system" in detail ? (
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
            // Reasonix：展示服务端托管对话数据
            detail ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                <div style={{ fontSize: "0.72rem", color: "#94a3b8" }}>对话数据由服务端托管（reasonixHistory:）· 最后活动 {fmtTime(s.lastAt)}</div>
                {detail.history && detail.history.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", maxHeight: 320, overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.5rem" }}>
                    {detail.history.map((m, i) => (
                      <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%", background: m.role === "user" ? "#dbeafe" : "#f1f5f9", borderRadius: 10, padding: "0.35rem 0.6rem", fontSize: "0.75rem", whiteSpace: "pre-wrap", color: "#1e293b" }}>
                        <span style={{ fontSize: "0.65rem", color: "#64748b" }}>{m.role === "user" ? "👤 我" : "🤖 Reasonix"}</span>
                        <div>{String(m.content).slice(0, 600)}{String(m.content).length > 600 ? "…" : ""}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ color: "#94a3b8" }}>暂无对话记录（每次续问成功后自动归档到服务端）</div>
                )}
              </div>
            ) : (
              <div style={{ color: "#94a3b8" }}>加载中…</div>
            )
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
  const [proc, setProc] = useState<ReasonixProcessStatus | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerConfigItem[]>([]);
  const [procBusy, setProcBusy] = useState(false);
  const [tab, setTab] = useState<"self" | "reasonix" | "prompts">("self");
  const [prompts, setPrompts] = useState<PromptMeta[]>([]);
  const [showCreate, setShowCreate] = useState<"chat" | "reasonix" | null>(null);
  const [module, setModule] = useState("");
  const [system, setSystem] = useState("");
  const [search, setSearch] = useState(false);
  const [json, setJson] = useState(false);
  const [err, setErr] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const [s, p, m, pr] = await Promise.all([api.agentSessions(), api.reasonixProcess(), api.mcpServers(), api.prompts()]);
      setData(s);
      setProc(p);
      setMcpServers(m.servers);
      if (pr.ok && "prompts" in pr) setPrompts(pr.prompts);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const doProcStart = async () => {
    setProcBusy(true);
    try {
      setProc(await api.reasonixProcessStart());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setProcBusy(false);
    }
  };

  const doProcStop = async () => {
    if (!confirm("停止 Reasonix ACP 进程？（会话注册表保留，续问时自动重启+resume）")) return;
    setProcBusy(true);
    try {
      setProc(await api.reasonixProcessStop());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setProcBusy(false);
    }
  };

  const toggleMcp = async (idx: number) => {
    const next = mcpServers.map((s, i) => (i === idx ? { ...s, enabled: !s.enabled } : s));
    setMcpServers(next);
    try {
      const r = await api.mcpServersSave(next);
      setMcpServers(r.servers);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteMcp = async (idx: number) => {
    if (!confirm(`删除 MCP server ${mcpServers[idx].name}？`)) return;
    const next = mcpServers.filter((_, i) => i !== idx);
    setMcpServers(next);
    try {
      const r = await api.mcpServersSave(next);
      setMcpServers(r.servers);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const addMcp = async () => {
    const name = prompt("MCP server 名称（如 kb）：");
    if (!name?.trim()) return;
    const command = prompt("启动命令（stdio，如 node）：") ?? "";
    const argsRaw = prompt("参数（空格分隔，如 --import tsx 脚本路径）：") ?? "";
    const next = [...mcpServers, { name: name.trim(), command: command.trim() || undefined, args: argsRaw.trim() ? argsRaw.trim().split(/\s+/) : undefined, enabled: true } as McpServerConfigItem];
    setMcpServers(next);
    try {
      const r = await api.mcpServersSave(next);
      setMcpServers(r.servers);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

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
      <h2 style={{ fontSize: "1.1rem", margin: "0 0 0.2rem" }}>💬 LLM 会话</h2>
      <p style={{ color: "#64748b", fontSize: "0.8rem", margin: "0 0 1rem" }}>
        管理两类有状态 LLM 会话。会话共享前缀缓存（DeepSeek 缓存价 1/50），同主题多次调用建议复用同一会话以降本。
      </p>
      {err && <div style={{ color: "#b91c1c", marginBottom: "0.6rem", fontSize: "0.8rem" }}>❌ {err}</div>}
      {/* 两大模块 Tab */}
      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1rem", borderBottom: "1px solid #e2e8f0", paddingBottom: "0.6rem" }}>
        {(
          [
            { key: "self", label: "💾 自研会话管理", desc: "Cache 会话（模式 2）" },
            { key: "reasonix", label: "🤖 Reasonix 管理", desc: "进程 / MCP / 会话（模式 3）" },
            { key: "prompts", label: "📝 提示词管理", desc: "统一数据化 · 场景化" },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: 10,
              border: tab === t.key ? "2px solid #2563eb" : "1px solid #e2e8f0",
              background: tab === t.key ? "#eff6ff" : "#fff",
              color: tab === t.key ? "#1d4ed8" : "#475569",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "0.85rem",
            }}
          >
            {t.label}
            <div style={{ fontSize: "0.68rem", fontWeight: 400, color: "#94a3b8", marginTop: "0.1rem" }}>{t.desc}</div>
          </button>
        ))}
      </div>
      {loading ? (
        <div style={{ color: "#94a3b8" }}>加载中…</div>
      ) : (
        data && (
          tab === "self" ? (
            renderList("chat", "自研 Cache 会话（模式 2）", data.chat)
          ) : tab === "prompts" ? (
            <PromptsTab prompts={prompts} onChanged={() => void load()} />
          ) : (
            <>
              {/* Reasonix 管理说明 */}
              <details style={{ border: "1px solid #e2e8f0", borderRadius: 10, marginBottom: "0.8rem", background: "#f8fafc", padding: "0.5rem 0.8rem" }}>
                <summary style={{ cursor: "pointer", fontSize: "0.8rem", color: "#475569", fontWeight: 600 }}>
                  💡 什么是 Reasonix 管理？（进程 / MCP / 会话）
                </summary>
                <div style={{ fontSize: "0.76rem", color: "#64748b", lineHeight: 1.7, marginTop: "0.4rem" }}>
                  <b>🛠 进程</b>：Reasonix 是一个 Agent（Go 二进制，DeepSeek 驱动），通过 ACP 协议与本服务通信。
                  进程为惰性单例——首次问答自动启动；此处可手动「停止进程」（会话记录保留，续问自动重启并恢复上下文）。
                  <br />
                  <b>🔌 MCP</b>：为 Agent 挂载的工具服务（如内置「kb」知识库：Agent 用 kb_set/kb_get 等直接读写知识库 KV）。
                  配置存于本地设置数据（settings:mcp.servers），新会话挂载所有启用项；可停用/删除/新增。
                  <br />
                  <b>💬 会话</b>：每个会话是 Agent 的一段持久上下文（30 天活跃 / 360 天归档）。对话数据由服务端托管
                  （reasonixHistory:），可展开查看；续问自动追加并共享前缀缓存降本。
                </div>
              </details>
              {/* Reasonix 进程状态（显式进程管理） */}
              <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: "0.6rem 0.8rem", marginBottom: "1rem", background: "#fff", display: "flex", alignItems: "center", gap: "0.8rem", flexWrap: "wrap" }}>
                <b style={{ fontSize: "0.82rem", color: "#334155" }}>🛠 Reasonix 进程</b>
                <span style={{ fontSize: "0.75rem", padding: "0.1rem 0.5rem", borderRadius: 6, background: proc?.running ? "#dcfce7" : "#fee2e2", color: proc?.running ? "#15803d" : "#b91c1c", fontWeight: 600 }}>
                  {proc?.running ? `运行中 · PID ${proc.pid}` : "未运行"}
                </span>
                {proc?.running && proc.startedAt && (
                  <span style={{ fontSize: "0.72rem", color: "#64748b" }}>启动于 {new Date(proc.startedAt).toLocaleString("zh-CN")} · 未决请求 {proc.pendingRequests}</span>
                )}
                <span style={{ fontSize: "0.72rem", color: "#94a3b8" }}>会话数 {proc?.sessionCount ?? 0}</span>
                <span style={{ flex: 1 }} />
                {proc?.running ? (
                  <button style={{ ...btn, color: "#b91c1c" }} disabled={procBusy} onClick={() => void doProcStop()} type="button">{procBusy ? "处理中…" : "■ 停止进程"}</button>
                ) : (
                  <button style={{ ...btn, background: "#2563eb", color: "#fff", borderColor: "#2563eb" }} disabled={procBusy} onClick={() => void doProcStart()} type="button">{procBusy ? "处理中…" : "▶ 启动进程"}</button>
                )}
              </div>
              {/* MCP 配置（Reasonix 会话挂载的 MCP server） */}
              <details style={{ border: "1px solid #e2e8f0", borderRadius: 10, marginBottom: "1rem", background: "#fff", padding: "0.5rem 0.8rem" }}>
                <summary style={{ cursor: "pointer", fontSize: "0.82rem", color: "#334155", fontWeight: 600 }}>
                  🔌 MCP Server 配置 <span style={{ fontWeight: 400, color: "#94a3b8", fontSize: "0.72rem" }}>（Reasonix 新会话挂载启用项；知识库 kb 为内置默认）</span>
                </summary>
                <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                  {mcpServers.length === 0 ? (
                    <div style={{ color: "#94a3b8", fontSize: "0.78rem" }}>无 MCP server（默认将内置知识库 kb）</div>
                  ) : (
                    mcpServers.map((s, i) => (
                      <div key={s.name + i} style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.75rem", border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.3rem 0.5rem" }}>
                        <span style={{ fontWeight: 600, color: "#1e293b", minWidth: 60 }}>{s.name}</span>
                        <span style={{ color: "#64748b", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {s.url ? `HTTP ${s.url}` : `${s.command ?? "?"} ${(s.args ?? []).join(" ")}`.slice(0, 80)}
                        </span>
                        <button style={btn} onClick={() => void toggleMcp(i)} type="button">{s.enabled ? "✓ 启用" : "停用"}</button>
                        <button style={{ ...btn, color: "#b91c1c" }} onClick={() => void deleteMcp(i)} type="button">删除</button>
                      </div>
                    ))
                  )}
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.3rem" }}>
                    <button style={btn} onClick={() => void addMcp()} type="button">＋ 新增 MCP server</button>
                    <span style={{ fontSize: "0.7rem", color: "#94a3b8" }}>stdio：命令 + 参数；HTTP：url（reasonix 支持 stdio / Streamable HTTP）</span>
                  </div>
                </div>
              </details>
              {renderList("reasonix", "Reasonix 会话（模式 3）", data.reasonix)}
            </>
          )
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

/** 提示词管理 Tab：按场景分组展示所有提示词模板，支持编辑/重置/预览 */
function PromptsTab(props: { prompts: PromptMeta[]; onChanged: () => void }) {
  const { prompts, onChanged } = props;
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // 按场景分组（保持注册表顺序）
  const groups: { group: string; items: PromptMeta[] }[] = [];
  const seen = new Set<string>();
  for (const p of prompts) {
    const g = p.group ?? "通用";
    if (!seen.has(g)) {
      seen.add(g);
      groups.push({ group: g, items: [] });
    }
    groups.find((x) => x.group === g)!.items.push(p);
  }

  const openEdit = async (p: PromptMeta) => {
    setEditId(p.id);
    setDraft(p.template);
    setPreview(null);
    setMsg(null);
  };

  const showPreview = async (p: PromptMeta) => {
    try {
      const d = await api.promptDetail(p.id);
      if (d.ok && "rendered" in d) setPreview(d.rendered);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    }
  };

  const save = async () => {
    if (!editId) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.promptUpdate(editId, draft);
      if (!r.ok) setMsg({ kind: "err", text: "保存失败" });
      else setMsg({ kind: "ok", text: "已保存（存于本地设置数据 settings:prompt.*）" });
      setEditId(null);
      onChanged();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const reset = async (id: string) => {
    if (!confirm(`恢复提示词 ${id} 为默认值？`)) return;
    try {
      const r = await api.promptReset(id);
      if (!r.ok) setMsg({ kind: "err", text: "重置失败" });
      else {
        setMsg({ kind: "ok", text: `已恢复默认 ${id}` });
        setEditId(null);
        onChanged();
      }
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div>
      <div style={{ fontSize: "0.76rem", color: "#64748b", marginBottom: "0.8rem", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "0.5rem 0.8rem" }}>
        所有 LLM / 程序性提示词统一存储在「本地设置数据」（settings:prompt.*），服务端实际使用与页面展示走同一条链路。
        可编辑模板（保存即时生效于后续调用）或一键恢复默认；「预览」为默认参数渲染后的完整文本。
      </div>
      {msg && (
        <div style={{ fontSize: "0.78rem", marginBottom: "0.6rem", color: msg.kind === "ok" ? "#15803d" : "#b91c1c" }}>
          {msg.kind === "ok" ? "✓" : "❌"} {msg.text}
        </div>
      )}
      {groups.map((g) => (
        <details key={g.group} open style={{ marginBottom: "0.8rem", border: "1px solid #e2e8f0", borderRadius: 10, background: "#fff", padding: "0.4rem 0.8rem" }}>
          <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: "0.85rem", color: "#334155" }}>
            🏷 {g.group}
            <span style={{ fontWeight: 400, color: "#94a3b8", fontSize: "0.72rem", marginLeft: "0.4rem" }}>{g.items.length} 个提示词</span>
          </summary>
          <div style={{ marginTop: "0.4rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {g.items.map((p) => (
              <div key={p.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.4rem 0.6rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                  <b style={{ fontSize: "0.78rem", fontFamily: "monospace", color: "#1d4ed8" }}>{p.id}</b>
                  <span style={{ fontSize: "0.7rem", color: "#94a3b8" }}>{p.page}</span>
                  <span style={{ flex: 1 }} />
                  {editId === p.id ? (
                    <button style={{ ...btn, background: "#16a34a", color: "#fff", borderColor: "#16a34a" }} disabled={busy} onClick={() => void save()} type="button">保存</button>
                  ) : (
                    <button style={btn} onClick={() => void openEdit(p)} type="button">✏️ 编辑</button>
                  )}
                  <button style={btn} onClick={() => void showPreview(p)} type="button">👁 预览</button>
                  <button style={{ ...btn, color: "#b91c1c" }} onClick={() => void reset(p.id)} type="button">↺ 重置</button>
                </div>
                <div style={{ color: "#64748b", fontSize: "0.74rem", marginTop: "0.2rem" }}>{p.description}</div>
                {editId === p.id ? (
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={Math.min(16, Math.max(4, draft.split("\n").length))}
                    style={{ width: "100%", marginTop: "0.4rem", padding: "0.4rem", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: "0.75rem", fontFamily: "monospace", boxSizing: "border-box" }}
                  />
                ) : (
                  <details style={{ marginTop: "0.3rem" }}>
                    <summary style={{ cursor: "pointer", fontSize: "0.72rem", color: "#94a3b8" }}>查看模板（{p.template.length} 字）</summary>
                    <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.72rem", color: "#475569", background: "#f8fafc", borderRadius: 8, padding: "0.5rem", maxHeight: 240, overflowY: "auto" }}>{p.template}</pre>
                  </details>
                )}
                {preview && (
                  <details open style={{ marginTop: "0.3rem" }}>
                    <summary style={{ cursor: "pointer", fontSize: "0.72rem", color: "#94a3b8" }}>渲染预览（默认参数）</summary>
                    <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.72rem", color: "#475569", background: "#f0fdf4", borderRadius: 8, padding: "0.5rem", maxHeight: 240, overflowY: "auto" }}>{preview}</pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
