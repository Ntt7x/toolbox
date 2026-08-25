// ============================================================
// 数据工程基础设施运管页（设置分组）
// 统一观察 数据/消息/任务/调度 四层生命周期：
//   - 任务层：注册任务清单（状态/cron/上次/下次/操作：触发/暂停/恢复/回溯/删除）
//   - 消息层：队列统计（积压/处理中/失败）
//   - 调度层：cron 计划展示；回溯（backfill）= 幂等重跑重建派生数据
// ============================================================
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { DataInfraQueueStats, DataInfraTaskHistoryEntry, DataInfraTaskSummary } from "@toolbox/shared";
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";

const C = {
  text: "#0f172a",
  sub: "#475569",
  muted: "#94a3b8",
  border: "#e2e8f0",
  gainBg: "#f0fdf4",
  gainBorder: "#bbf7d0",
};

const statusColor: Record<string, string> = {
  queued: "#2563eb",
  running: "#d97706",
  done: "#059669",
  failed: "#dc2626",
  paused: "#64748b",
};

const statusLabel: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  done: "已完成",
  failed: "失败",
  paused: "已暂停",
};

function fmt(t?: number): string {
  if (!t) return "—";
  return new Date(t).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtDur(ms?: number): string {
  if (ms === undefined) return "—";
  return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms";
}

/** 队列行：统计 + 查看消息（peek）/ 恢复超时（requeue-stale） */
function QueueRow({ q, onAction }: { q: DataInfraQueueStats; onAction: (fn: () => Promise<unknown>, okMsg: string) => void }) {
  const [msgs, setMsgs] = useState<any[] | null>(null);
  const [audit, setAudit] = useState<any[] | null>(null);
  const [showMsgs, setShowMsgs] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const toggle = async () => {
    if (showMsgs) { setShowMsgs(false); return; }
    setShowMsgs(true);
    if (!msgs) {
      try { const r = await api.dataInfraQueueMessages(q.name); setMsgs(r.messages ?? []); } catch { /* 忽略 */ }
    }
  };
  const toggleAudit = async () => {
    if (showAudit) { setShowAudit(false); return; }
    setShowAudit(true);
    if (!audit) {
      try { const r = await api.dataInfraQueueAudit(q.name); setAudit(r.entries ?? []); } catch { /* 忽略 */ }
    }
  };
  return (
    <div style={{ fontSize: "0.78rem", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ fontWeight: 600, color: C.text }}>{q.name}</span>
      <span>待处理 <b style={{ color: q.pending > 0 ? "#d97706" : C.text }}>{q.pending}</b></span>
      <span>处理中 <b>{q.processing}</b></span>
      <span>失败 <b style={{ color: q.failed > 0 ? "#dc2626" : C.text }}>{q.failed}</b></span>
      <span style={{ color: C.muted }}>共 {q.total}</span>
      <Button size="sm" variant="ghost" onClick={() => void toggle()}>🔍 消息{showMsgs ? " ▲" : ""}</Button>
      <Button size="sm" variant="ghost" onClick={() => void toggleAudit()}>🕘 消费记录{showAudit ? " ▲" : ""}</Button>
      <Button size="sm" variant="ghost" onClick={() => onAction(() => api.dataInfraQueueRequeueStale(q.name), "已恢复处理超时消息")}>♻ 恢复</Button>
      {showMsgs && (
        <div style={{ width: "100%", borderTop: "1px dashed " + C.border, marginTop: 4, paddingTop: 4, fontSize: "0.72rem", color: C.sub }}>
          {(msgs ?? []).length === 0 ? "（无消息——队列已清空）" : msgs!.map((m, i) => (
            <div key={i} style={{ padding: "0.15rem 0", display: "flex", gap: 8 }}>
              <span style={{ color: C.muted, whiteSpace: "nowrap" }}>{m.status}{m.attempts > 1 ? `×${m.attempts}` : ""}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "70%" }}>{JSON.stringify(m.payload ?? {}).slice(0, 120)}</span>
            </div>
          ))}
        </div>
      )}
      {showAudit && (
        <div style={{ width: "100%", borderTop: "1px dashed " + C.border, marginTop: 4, paddingTop: 4, fontSize: "0.72rem", color: C.sub }}>
          {(audit ?? []).length === 0 ? "（暂无消费记录）" : [...(audit ?? [])].reverse().map((e, i) => (
            <div key={i} style={{ padding: "0.15rem 0", display: "flex", gap: 8 }}>
              <span style={{ color: e.status === "done" ? "#059669" : "#dc2626", whiteSpace: "nowrap", fontWeight: 600 }}>{e.status === "done" ? "✓" : "✗"}</span>
              <span style={{ color: C.muted, whiteSpace: "nowrap" }}>{fmt(e.at)}</span>
              {e.type && <span style={{ color: C.text }}>{e.type}</span>}
              <span style={{ color: C.muted }}>{e.attempts > 1 ? `重试×${e.attempts}` : ""}</span>
              <span style={{ color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "50%" }}>{e.id}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DataInfraTool() {
  const [tasks, setTasks] = useState<DataInfraTaskSummary[]>([]);
  const [queues, setQueues] = useState<DataInfraQueueStats[]>([]);
  const [derivators, setDerivators] = useState<any[]>([]);
  const [consumers, setConsumers] = useState<any[]>([]);
  const [orphans, setOrphans] = useState<string[]>([]);
  const [health, setHealth] = useState<{ healthy: boolean; problems: string[]; summary: Record<string, number> } | null>(null);
  const [history, setHistory] = useState<Record<string, DataInfraTaskHistoryEntry[]>>({});
  const [openHist, setOpenHist] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const [t, q, d, cs, ov, h] = await Promise.all([
        api.dataInfraTasks(), api.dataInfraQueues(), api.dataInfraDerivators(), api.dataInfraConsumers(),
        api.dataInfraOverview ? api.dataInfraOverview() : Promise.resolve({ orphanQueues: [] }),
        api.dataInfraHealth(),
      ]);
      setTasks(t.tasks ?? []);
      setQueues(q.queues ?? []);
      setDerivators(d.derivators ?? []);
      setConsumers(cs.consumers ?? []);
      setOrphans((ov as any).orphanQueues ?? []);
      setHealth(h);
    } catch (e) {
      setMsg("加载失败：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const act = async (fn: () => Promise<unknown>, okMsg: string) => {
    try {
      await fn();
      setMsg(okMsg);
      void reload();
    } catch (e) {
      setMsg("操作失败：" + (e instanceof Error ? e.message : String(e)));
    }
  };

  const toggleHist = async (id: string) => {
    if (openHist === id) { setOpenHist(null); return; }
    setOpenHist(id);
    if (!history[id]) {
      try { const h = await api.dataInfraHistory(id); setHistory((m) => ({ ...m, [id]: h.entries ?? [] })); } catch { /* 忽略 */ }
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h1 style={{ fontSize: "1.125rem", fontWeight: 700, margin: 0, color: C.text }}>⚙️ 数据工程基础设施</h1>
      <div style={{ fontSize: "0.8rem", color: C.sub }}>统一观察 数据/消息/任务/调度 四层生命周期 · 幂等 · 可回溯（backfill 重跑重建派生数据）</div>
      {health && (
        <div style={{
          padding: "0.6rem 0.9rem", borderRadius: 8, fontSize: "0.84rem",
          border: "1px solid " + (health.healthy ? C.gainBorder : "#fde68a"),
          background: health.healthy ? C.gainBg : "#fffbeb",
          color: health.healthy ? "#047857" : "#b45309",
        }}>
          <b>{health.healthy ? "✅ 数据工程健康" : `⚠️ 发现 ${health.problems.length} 个问题`}</b>
          <span style={{ marginLeft: 10, color: C.sub, fontSize: "0.76rem" }}>
            任务 {health.summary.tasks ?? 0}{health.summary.failedTasks ? `（失败 ${health.summary.failedTasks}）` : ""} · 队列 {health.summary.queues ?? 0}
            {health.summary.backlog ? `（积压 ${health.summary.backlog}）` : ""} · 消费者 {health.summary.consumers ?? 0}
            {health.summary.notRunning ? `（未运行 ${health.summary.notRunning}）` : ""} · 派生器 {health.summary.derivators ?? 0}
            {health.summary.unmarkedKv ? ` · 未标记 KV ${health.summary.unmarkedKv}` : ""}
          </span>
          {!health.healthy && (
            <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem", fontSize: "0.78rem" }}>
              {health.problems.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          )}
        </div>
      )}
      {msg && <div style={{ padding: "0.5rem 0.8rem", borderRadius: 8, fontSize: "0.84rem", border: "1px solid " + C.gainBorder, background: C.gainBg, color: "#b91c1c" }}>{msg}</div>}
      {loading ? <div style={{ padding: "2rem", textAlign: "center", color: C.muted }}>加载中…</div> : (
        <>
          {/* 任务层：注册任务清单 */}
          <Card><CardContent>
            <div style={{ fontSize: "0.85rem", fontWeight: 700, color: C.text, marginBottom: 8 }}>📋 任务注册表（生命周期：排队→执行→完成/失败→历史）</div>
            {tasks.length === 0 ? (
              <div style={{ color: C.muted, fontSize: "0.82rem" }}>暂无注册任务（Phase 3 将注册净值快照任务）</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {tasks.map((t) => (
                  <div key={t.id} style={{ border: "1px solid " + C.border, borderRadius: 8, padding: "0.6rem 0.8rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 700, fontSize: "0.85rem", color: C.text }}>{t.name}</span>
                      <span style={{ fontSize: "0.72rem", color: C.muted, background: "#f1f5f9", padding: "0.1rem 0.4rem", borderRadius: 4 }}>{t.type}</span>
                      <span style={{ fontSize: "0.75rem", color: statusColor[t.status] ?? C.text, fontWeight: 700 }}>{statusLabel[t.status] ?? t.status}</span>
                      {t.cron && <span style={{ fontSize: "0.72rem", color: C.muted }}>cron: {t.cron}</span>}
                      <span style={{ flex: 1 }} />
                      <span style={{ fontSize: "0.72rem", color: C.muted }}>上次 {fmt(t.lastRunAt)}{t.lastResult ? " · " + t.lastResult : ""} | 下次 {fmt(t.nextRunAt)}</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                      <Button size="sm" variant="outline" onClick={() => act(() => api.dataInfraTrigger(t.id), "已触发执行")}>▶ 立即触发</Button>
                      {t.status === "paused"
                        ? <Button size="sm" variant="outline" onClick={() => act(() => api.dataInfraResume(t.id), "已恢复")}>▶ 恢复</Button>
                        : <Button size="sm" variant="outline" onClick={() => act(() => api.dataInfraPause(t.id), "已暂停")}>⏸ 暂停</Button>}
                      <Button size="sm" variant="outline" onClick={() => act(() => api.dataInfraBackfill(t.id, { force: true }), "回溯完成（幂等重跑）")}>♻ 回溯重建</Button>
                      <Button size="sm" variant="ghost" onClick={() => toggleHist(t.id)}>🕘 历史{openHist === t.id ? " ▲" : ""}</Button>
                      <Button size="sm" variant="ghost" onClick={() => act(() => api.dataInfraDelete(t.id), "已删除")}>🗑 删除</Button>
                    </div>
                    {openHist === t.id && (
                      <div style={{ marginTop: 8, borderTop: "1px dashed " + C.border, paddingTop: 6 }}>
                        {(history[t.id] ?? []).length === 0 ? (
                          <div style={{ color: C.muted, fontSize: "0.75rem" }}>暂无执行历史</div>
                        ) : (
                          [...(history[t.id] ?? [])].reverse().slice(0, 20).map((h, i) => (
                            <div key={i} style={{ fontSize: "0.74rem", color: C.sub, padding: "0.15rem 0", display: "flex", gap: 8 }}>
                              <span style={{ color: C.muted, whiteSpace: "nowrap" }}>{fmt(h.at)}</span>
                              <span style={{ color: statusColor[h.status] ?? C.text }}>{statusLabel[h.status] ?? h.status}</span>
                              <span style={{ color: C.muted }}>{h.trigger}{h.durationMs !== undefined ? ` · ${fmtDur(h.durationMs)}` : ""}</span>
                              {h.message && <span style={{ color: C.text }}>{h.message}</span>}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent></Card>

          {/* 消息层：队列统计 */}
          <Card><CardContent>
            <div style={{ fontSize: "0.85rem", fontWeight: 700, color: C.text, marginBottom: 8 }}>📨 消息队列（至少一次投递 + 幂等消费）</div>
            {orphans.length > 0 && (
              <div style={{ fontSize: "0.78rem", color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "0.4rem 0.6rem", marginBottom: 8 }}>
                ⚠️ 孤儿队列（有消息但无消费者订阅）：{orphans.join("、")}
              </div>
            )}
            {queues.length === 0 ? <div style={{ color: C.muted, fontSize: "0.82rem" }}>暂无队列消息</div> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {queues.map((q) => (
                  <QueueRow key={q.name} q={q} onAction={act} />
                ))}
              </div>
            )}
          </CardContent></Card>

          {/* 派生层：源事件 → 衍生消息 */}
          <Card><CardContent>
            <div style={{ fontSize: "0.85rem", fontWeight: 700, color: C.text, marginBottom: 8 }}>🔀 派生器（源事件 → 衍生消息；derive 可重放）</div>
            {derivators.length === 0 ? (
              <div style={{ color: C.muted, fontSize: "0.82rem" }}>暂无派生器（Phase 4 将注册快照完成→通知派生）</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {derivators.map((d) => (
                  <div key={d.id} style={{ border: "1px solid " + C.border, borderRadius: 8, padding: "0.5rem 0.8rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 700, fontSize: "0.84rem", color: C.text }}>{d.id}</span>
                      <span style={{ fontSize: "0.72rem", color: C.muted }}>→ 队列 {d.queue}</span>
                      {d.when?.cron && <span style={{ fontSize: "0.72rem", color: C.muted }}>cron {d.when.cron}</span>}
                      <span style={{ fontSize: "0.72rem", color: C.muted }}>
                        {(d.when?.taskDone ?? []).map((x: string) => "任务完成:" + x).concat((d.when?.taskFailed ?? []).map((x: string) => "任务失败:" + x)).join(" ") || "手动"}
                      </span>
                      <span style={{ flex: 1 }} />
                      <Button size="sm" variant="outline" onClick={() => act(() => api.dataInfraDerivatorTrigger(d.id), "派生器已触发")}>▶ 触发派生</Button>
                    </div>
                    {(d.runs ?? []).length > 0 && (
                      <div style={{ marginTop: 6, fontSize: "0.72rem", color: C.sub, display: "flex", gap: 12, flexWrap: "wrap" }}>
                        {[...(d.runs ?? [])].reverse().slice(0, 3).map((r: any, i: number) => (
                          <span key={i} style={{ background: "#f8fafc", padding: "0.1rem 0.4rem", borderRadius: 4 }}>
                            {fmt(r.at)} {r.trigger} 派生 {r.messages} 条{r.ok ? "" : " ✗ " + (r.error ?? "")}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent></Card>

          {/* 执行层：消费者（FaaS） */}
          <Card><CardContent>
            <div style={{ fontSize: "0.85rem", fontWeight: 700, color: C.text, marginBottom: 8 }}>⚡ 消费者（消息 → FaaS 执行；至少一次 + 幂等）</div>
            {consumers.length === 0 ? (
              <div style={{ color: C.muted, fontSize: "0.82rem" }}>暂无消费者（Phase 4 将注册快照完成消费者）</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {consumers.map((c) => (
                  <div key={c.queue} style={{ fontSize: "0.78rem", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600, color: C.text }}>{c.queue}</span>
                    <span style={{ color: C.sub }}>{c.name}</span>
                    <span style={{ color: C.muted }}>并发 {c.concurrency}</span>
                    <span style={{ color: c.running ? "#059669" : "#dc2626", fontWeight: 700 }}>{c.running ? "运行中" : "未运行"}</span>
                    <span style={{ color: C.muted }}>已处理 {c.processedCount ?? 0}{c.lastConsumedAt ? ` · 最近 ${fmt(c.lastConsumedAt)}` : ""}</span>
                    {c.lastError && <span style={{ color: "#dc2626", fontSize: "0.72rem" }}>最近错误: {c.lastError}</span>}
                  </div>
                ))}
              </div>
            )}
          </CardContent></Card>

          {/* 调度层说明 */}
          <Card><CardContent>
            <div style={{ fontSize: "0.82rem", color: C.sub, lineHeight: 1.7 }}>
              <b style={{ color: C.text }}>🗓 调度层</b>：cron 任务到点自动触发（missed 补跑）；「立即触发」手动执行；「回溯重建」幂等重跑派生数据（账本重放 → 快照）。
              <br />数据源 <code style={{ background: "#f1f5f9", padding: "0 0.3rem", borderRadius: 4 }}>dataInfra</code> 已注册（本地数据管理可见队列/任务/历史 KV）。
            </div>
          </CardContent></Card>
        </>
      )}
    </div>
  );
}
