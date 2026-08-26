// ============================================================
// 通用组件：任务历史（异步分析任务回看）
// - 统一模式：读 data-infra 任务记录（GET /api/data-infra/tasks，按 type 过滤）
// - 展示：状态徽章 / 名称 / 时间 / 结果；点击条目展开
// - renderResult 由页面传入（复用页面自身的结果渲染）
// ============================================================
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";

interface TaskRecord {
  id: string;
  type: string;
  name: string;
  status: string;
  lastResult?: string;
  result?: unknown;
  lastRunAt?: number;
  createdAt: number;
}

const STATUS_BADGE: Record<string, { text: string; bg: string; color: string }> = {
  done: { text: "✓ 成功", bg: "#dcfce7", color: "#15803d" },
  failed: { text: "✗ 失败", bg: "#fee2e2", color: "#b91c1c" },
  error: { text: "✗ 失败", bg: "#fee2e2", color: "#b91c1c" },
  cancelled: { text: "✕ 已取消", bg: "#f1f5f9", color: "#64748b" },
  running: { text: "… 运行中", bg: "#fef9c3", color: "#a16207" },
  queued: { text: "… 排队中", bg: "#f1f5f9", color: "#64748b" },
  pending: { text: "… 排队中", bg: "#f1f5f9", color: "#64748b" },
};

export function TaskHistory(props: {
  module: string;
  /** 渲染历史任务结果（点击展开时） */
  renderResult: (result: unknown) => ReactNode;
  /** 变化时自动刷新（如当前任务完成后传当前时间） */
  refreshKey?: unknown;
  /** 折叠标题（默认「📚 历史任务」） */
  title?: string;
}) {
  const { module, renderResult, refreshKey, title = "📚 历史任务" } = props;
  const [entries, setEntries] = useState<TaskRecord[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.dataInfraTasks();
      if (r.ok) setEntries((r.tasks ?? []).filter((t) => t.type === module));
    } catch {
      // 静默（历史不可用不影响主流程）
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [module, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ marginTop: "1rem", borderTop: "1px dashed #e2e8f0", paddingTop: "0.8rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.4rem" }}>
        <b style={{ fontSize: "0.85rem", color: "#334155" }}>{title}</b>
        <span style={{ color: "#94a3b8", fontSize: "0.75rem" }}>{entries.length > 0 ? `${entries.length} 条` : ""}</span>
        <span style={{ flex: 1 }} />
        <button
          style={{ fontSize: "0.72rem", padding: "0.15rem 0.6rem", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 6, cursor: "pointer" }}
          onClick={() => void load()}
          type="button"
        >
          ⟳ 刷新
        </button>
      </div>
      {loading && entries.length === 0 ? (
        <div style={{ color: "#94a3b8", fontSize: "0.8rem" }}>加载中…</div>
      ) : entries.length === 0 ? (
        <div style={{ color: "#94a3b8", fontSize: "0.8rem" }}>暂无历史任务（每次分析完成后自动归档）</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
          {entries.map((e) => {
            const badge = STATUS_BADGE[e.status] ?? STATUS_BADGE.pending;
            const open = openId === e.id;
            const failed = e.status === "failed" || e.status === "cancelled";
            return (
              <div key={e.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, background: open ? "#f8fafc" : "#fff" }}>
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : e.id)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.6rem",
                    padding: "0.4rem 0.7rem",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    fontSize: "0.8rem",
                    color: "#334155",
                    textAlign: "left",
                  }}
                >
                  <span style={{ fontSize: "0.72rem", padding: "0.1rem 0.45rem", borderRadius: 6, background: badge.bg, color: badge.color, fontWeight: 600 }}>
                    {badge.text}
                  </span>
                  <span style={{ fontWeight: 600, fontSize: "0.82rem" }}>{e.name ?? `任务 ${e.id.slice(0, 8)}…`}</span>
                  <span style={{ color: "#94a3b8", fontSize: "0.75rem" }}>{new Date(e.createdAt).toLocaleString("zh-CN")}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ color: "#94a3b8" }}>{open ? "收起 ▴" : "查看 ▾"}</span>
                </button>
                {open && (
                  <div style={{ padding: "0.5rem 0.7rem 0.7rem", borderTop: "1px solid #e2e8f0" }}>
                    {failed ? (
                      <div style={{ color: "#b91c1c", fontSize: "0.8rem" }}>{e.lastResult ?? "任务失败"}</div>
                    ) : (
                      renderResult(e.result)
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
