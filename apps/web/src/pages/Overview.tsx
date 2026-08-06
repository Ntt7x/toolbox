import { Link } from "react-router-dom";
import type { HealthResponse, ToolMeta } from "@toolbox/shared";

interface OverviewProps {
  health: HealthResponse | null;
  tools: ToolMeta[];
  error: string | null;
}

const GROUP_ICON: Record<string, string> = {
  后台管理: "⚙️",
  交易: "📈",
  小工具: "🧰",
  康复: "💪",
  其他: "🗂️",
};

export default function Overview({ health, tools, error }: OverviewProps) {
  // 按分组归类工具
  const grouped = new Map<string, ToolMeta[]>();
  const groupOf = (t: ToolMeta) => {
    if (t.path.startsWith("/settings/")) return "后台管理";
    if (["grid-plan", "kelly", "cb-rate", "treasury-fx", "reverse-repo", "watchlist"].includes(t.id)) return "交易";
    if (["deepseek-share", "books"].includes(t.id)) return "小工具";
    if (t.id.startsWith("rehab")) return "康复";
    return "其他";
  };
  for (const t of tools) {
    const g = groupOf(t);
    const arr = grouped.get(g) ?? [];
    arr.push(t);
    grouped.set(g, arr);
  }
  const order = ["交易", "小工具", "康复", "后台管理", "其他"];

  return (
    <section>
      <div style={{ display: "flex", alignItems: "center", gap: "0.9rem", flexWrap: "wrap", marginBottom: "1.4rem" }}>
        <h1 className="page-title" style={{ margin: 0 }}>
          📊 工作台
        </h1>
        <span className="chip" style={{ background: health ? "#dcfce7" : error ? "#fee2e2" : "#f1f5f9", color: health ? "#15803d" : error ? "#b91c1c" : "#64748b" }}>
          {health ? `● 已连接 ${health.service} v${health.version}` : error ? `✕ ${error}` : "… 连接中"}
        </span>
      </div>

      {tools.length === 0 ? (
        <div className="card">暂无工具，等待 vibe coding 添加…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.6rem" }}>
          {order
            .filter((g) => grouped.has(g))
            .map((g) => (
              <div key={g}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", marginBottom: "0.6rem" }}>
                  <span style={{ fontSize: "1.05rem" }}>{GROUP_ICON[g]}</span>
                  <h2 style={{ margin: 0, fontSize: "0.95rem", color: "#334155", fontWeight: 700 }}>{g}</h2>
                  <span className="muted" style={{ fontSize: "0.78rem" }}>
                    {grouped.get(g)!.length} 个
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "0.9rem" }}>
                  {grouped.get(g)!.map((t) => (
                    <Link
                      key={t.id}
                      to={t.path}
                      className="card"
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        textDecoration: "none",
                        color: "inherit",
                        padding: "1.1rem 1.25rem",
                        margin: 0,
                        transition: "box-shadow 150ms ease, transform 150ms ease, border-color 150ms ease",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.boxShadow = "var(--shadow-md)";
                        e.currentTarget.style.borderColor = "var(--primary)";
                        e.currentTarget.style.transform = "translateY(-2px)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.boxShadow = "var(--shadow)";
                        e.currentTarget.style.borderColor = "var(--border)";
                        e.currentTarget.style.transform = "translateY(0)";
                      }}
                    >
                      <strong style={{ fontSize: "0.95rem", color: "#1e293b", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                        <span style={{ fontSize: "1.05rem" }}>🧰</span> {t.name}
                      </strong>
                      <p style={{ margin: "0.45rem 0 0", color: "#64748b", fontSize: "0.8rem", lineHeight: 1.55, flex: 1 }}>{t.description}</p>
                      <code className="muted mono" style={{ fontSize: "0.7rem", marginTop: "0.5rem" }}>{t.path}</code>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
