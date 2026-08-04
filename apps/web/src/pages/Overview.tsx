import { Link } from "react-router-dom";
import type { HealthResponse, ToolMeta } from "@toolbox/shared";

interface OverviewProps {
  health: HealthResponse | null;
  tools: ToolMeta[];
  error: string | null;
}

export default function Overview({ health, tools, error }: OverviewProps) {
  return (
    <section>
      <h1 style={{ marginTop: 0 }}>📊 工作台</h1>
      <p style={{ color: "#666" }}>
        后端状态：
        {health ? (
          <span style={{ color: "#16a34a", fontWeight: 600 }}>
            已连接 ({health.service} v{health.version})
          </span>
        ) : error ? (
          <span style={{ color: "#dc2626" }}>连接失败：{error}</span>
        ) : (
          <span>连接中…</span>
        )}
      </p>

      <h2>工具列表</h2>
      {tools.length === 0 ? (
        <p>暂无工具，等待 vibe coding 添加…</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "1rem" }}>
          {tools.map((t) => (
            <Link
              key={t.id}
              to={t.path}
              style={{
                display: "block",
                padding: "1rem 1.25rem",
                background: "#fff",
                border: "1px solid #e2e8f0",
                borderRadius: 10,
                textDecoration: "none",
                color: "inherit",
                boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
              }}
            >
              <strong style={{ fontSize: "1rem" }}>🧰 {t.name}</strong>
              <p style={{ margin: "0.4rem 0 0", color: "#666", fontSize: "0.875rem" }}>{t.description}</p>
              <code style={{ fontSize: "0.75rem", color: "#94a3b8" }}>{t.path}</code>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
