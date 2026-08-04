import { useEffect, useState, type ComponentType, type CSSProperties } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { api } from "./api";
import type { HealthResponse, ToolMeta } from "@toolbox/shared";
import Overview from "./pages/Overview";
import ToolPlaceholder from "./pages/ToolPlaceholder";
import GridPlanTool from "./tools/GridPlanTool";
import DeepSeekShareTool from "./tools/DeepSeekShareTool";
import CbRateTool from "./tools/CbRateTool";
import LlmSettings from "./settings/LlmSettings";
import LocalData from "./settings/LocalData";

/** 已实现工具页的映射（未注册的工具回退到 ToolPlaceholder） */
const toolPages: Record<string, ComponentType> = {
  "grid-plan": GridPlanTool,
  "deepseek-share": DeepSeekShareTool,
  "cb-rate": CbRateTool,
};

/** 已实现工具页渲染；未映射的工具回退到占位页 */
function ToolPage({ t }: { t: ToolMeta }) {
  const C = toolPages[t.id];
  return C ? <C /> : <ToolPlaceholder tool={t} />;
}
interface MenuGroup {
  label: string;
  staticItems?: { name: string; path: string; icon: string }[];
  toolIds?: string[];
}

const MENU_GROUPS: MenuGroup[] = [
  {
    label: "设置",
    staticItems: [
      { name: "LLM 设置", path: "/settings/llm", icon: "🤖" },
      { name: "本地数据管理", path: "/settings/local-data", icon: "🗄️" },
    ],
  },
  { label: "交易", toolIds: ["grid-plan", "cb-rate"] },
  { label: "小工具", toolIds: ["deepseek-share"] },
];

const groupLabelStyle: CSSProperties = {
  padding: "0.9rem 0.9rem 0.3rem",
  fontSize: "0.72rem",
  fontWeight: 700,
  letterSpacing: "0.08em",
  color: "#64748b",
  textTransform: "uppercase",
};

interface MenuEntry {
  key: string;
  name: string;
  path: string;
  icon: string;
}

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
            {MENU_GROUPS.map((g) => {
              const entries: MenuEntry[] = [
                ...(g.staticItems ?? []).map((s) => ({ key: s.path, name: s.name, path: s.path, icon: s.icon })),
                ...tools
                  .filter((t) => g.toolIds?.includes(t.id))
                  .map((t) => ({ key: t.id, name: t.name, path: t.path, icon: "🧰" })),
              ];
              if (entries.length === 0) return null;
              return (
                <div key={g.label}>
                  <div style={groupLabelStyle}>{g.label}</div>
                  {entries.map((it) => (
                    <NavLink key={it.key} to={it.path} style={({ isActive }) => menuItemStyle(isActive)}>
                      {it.icon} {it.name}
                    </NavLink>
                  ))}
                </div>
              );
            })}
            {(() => {
              const grouped = new Set(MENU_GROUPS.flatMap((g) => g.toolIds ?? []));
              const rest = tools.filter((t) => !grouped.has(t.id));
              if (rest.length === 0) return null;
              return (
                <div>
                  <div style={groupLabelStyle}>其他</div>
                  {rest.map((t) => (
                    <NavLink key={t.id} to={t.path} style={({ isActive }) => menuItemStyle(isActive)}>
                      🧰 {t.name}
                    </NavLink>
                  ))}
                </div>
              );
            })()}
          </nav>
        </aside>

        {/* 右侧内容区 */}
        <main style={{ flex: 1, minWidth: 0, padding: "1.5rem 2rem", background: "#f5f6f8" }}>
          <Routes>
            <Route path="/" element={<Overview health={health} tools={tools} error={error} />} />
            <Route path="/settings/llm" element={<LlmSettings />} />
            <Route path="/settings/local-data" element={<LocalData />} />
            {tools.map((t) => (
              <Route key={t.id} path={t.path} element={<ToolPage t={t} />} />
            ))}
            <Route path="*" element={<ToolPlaceholder tool={null} />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
