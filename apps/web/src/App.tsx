import { useEffect, useState } from "react";
import { api } from "./api";
import type { HealthResponse, ToolMeta } from "@toolbox/shared";

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [tools, setTools] = useState<ToolMeta[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch((e: unknown) => setError(String(e)));
    api
      .tools()
      .then((r) => setTools(r.tools))
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1>🛠️ Toolbox · 个人小工具集</h1>
      <p style={{ color: "#666" }}>
        后端状态：
        {health ? `已连接 (${health.service} v${health.version})` : error ?? "连接中…"}
      </p>
      <h2>工具列表</h2>
      {tools.length === 0 ? (
        <p>暂无工具，等待 vibe coding 添加…</p>
      ) : (
        <ul>
          {tools.map((t) => (
            <li key={t.id}>
              <strong>{t.name}</strong> — {t.description} <code>{t.path}</code>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
