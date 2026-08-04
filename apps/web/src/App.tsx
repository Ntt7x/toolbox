import { createElement, useEffect, useState, type ComponentType, type CSSProperties } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { api } from "./api";
import type { HealthResponse, ToolMeta } from "@toolbox/shared";
import Overview from "./pages/Overview";
import ToolPlaceholder from "./pages/ToolPlaceholder";
import GridPlanTool from "./tools/GridPlanTool";

/** 已实现工具页的映射（未注册的工具回退到 ToolPlaceholder） */
const toolPages: Record<string, ComponentType> = {
  "grid-plan": GridPlanTool,
};

const createPage = (C: ComponentType) => createElement(C);

/** 侧边栏菜单项样式（active 高亮） */
const menuItemStyle = (isActive: boolean): CSSProperties => ({
  display: "block",
  padding: "0.55rem 0.9rem",
  margin: "0.15rem 0",
  borderRadius: 8,
  color: isActive ? "#fff" : "#c7cdd6",
  background: isActive ? "#3b82f6" : "transparent",
  textDecoration: "none",
  fontSize: "0.925rem",
  transition: "background 0.15s, color 0.15s",
});

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
    <BrowserRouter>
      <div style={{ display: "flex", minHeight: "100vh" }}>
        {/* 左侧菜单栏 */}
        <aside
          style={{
            width: 220,
            flexShrink: 0,
            background: "#1e293b",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ padding: "1.1rem 1.25rem", color: "#fff", fontWeight: 700, fontSize: "1.05rem" }}>
            🛠️ Toolbox
          </div>
          <nav style={{ padding: "0.25rem 0.5rem 1rem" }}>
            <NavLink to="/" end style={({ isActive }) => menuItemStyle(isActive)}>
              📊 工作台
            </NavLink>
            {tools.map((t) => (
              <NavLink key={t.id} to={t.path} style={({ isActive }) => menuItemStyle(isActive)}>
                🧰 {t.name}
              </NavLink>
            ))}
          </nav>
        </aside>

        {/* 右侧内容区 */}
        <main style={{ flex: 1, minWidth: 0, padding: "1.5rem 2rem", background: "#f5f6f8" }}>
          <Routes>
            <Route path="/" element={<Overview health={health} tools={tools} error={error} />} />
            {tools.map((t) => (
              <Route
                key={t.id}
                path={t.path}
                element={toolPages[t.id] ? createPage(toolPages[t.id]) : <ToolPlaceholder tool={t} />}
              />
            ))}
            <Route path="*" element={<ToolPlaceholder tool={null} />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
