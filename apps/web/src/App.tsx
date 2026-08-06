import { useEffect, useState, type ComponentType, type CSSProperties } from "react";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { api } from "./api";
import type { HealthResponse, ToolMeta } from "@toolbox/shared";
import Overview from "./pages/Overview";
import ToolPlaceholder from "./pages/ToolPlaceholder";
import { ErrorBoundary } from "./components/ErrorBoundary";
import GridPlanTool from "./tools/GridPlanTool";
import KellyTool from "./tools/KellyTool";
import DeepSeekShareTool from "./tools/DeepSeekShareTool";
import BookSearchTool from "./tools/BookSearchTool";
import CbRateTool from "./tools/CbRateTool";
import TreasuryFxTool from "./tools/TreasuryFxTool";
import ReverseRepoTool from "./tools/ReverseRepoTool";
import WatchlistTool from "./tools/WatchlistTool";
import RehabMedicalTool from "./tools/RehabMedicalTool";
import MemoTool from "./settings/MemoTool";
import LlmSettings from "./settings/LlmSettings";
import LocalData from "./settings/LocalData";
import AgentSessions from "./settings/AgentSessions";

/** 已实现工具页的映射（未注册的工具回退到 ToolPlaceholder） */
const toolPages: Record<string, ComponentType> = {
  "grid-plan": GridPlanTool,
  "kelly": KellyTool,
  "deepseek-share": DeepSeekShareTool,
  "books": BookSearchTool,
  "cb-rate": CbRateTool,
  "treasury-fx": TreasuryFxTool,
  "reverse-repo": ReverseRepoTool,
  "watchlist": WatchlistTool,
  "rehab-medical": RehabMedicalTool,
};

/** 已实现工具页渲染；未映射的工具回退到占位页（ErrorBoundary 捕获运行时崩溃，显示错误而非白屏） */
function ToolPage({ t }: { t: ToolMeta }) {
  const C = toolPages[t.id];
  return <ErrorBoundary>{C ? <C /> : <ToolPlaceholder tool={t} />}</ErrorBoundary>;
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
      { name: "LLM 管理", path: "/settings/llm", icon: "🤖" },
      { name: "Agent 会话管理", path: "/settings/agent-sessions", icon: "💬" },
      { name: "本地数据管理", path: "/settings/local-data", icon: "🗄️" },
      { name: "改进备忘录", path: "/settings/memo", icon: "📝" },
    ],
  },
  { label: "交易", toolIds: ["grid-plan", "kelly", "cb-rate", "treasury-fx", "reverse-repo", "watchlist"] },
  { label: "小工具", toolIds: ["deepseek-share", "books"] },
  { label: "康复", toolIds: ["rehab-medical", "rehab-muscle"] },
];

/** 菜单顺序服务端设置 key（本地设置数据：settings:menu.order） */
const MENU_ORDER_KEY = "settings:menu.order";
/** 折叠状态本地存储 key（UI 偏好，不进服务端） */
const COLLAPSE_STORAGE_KEY = "menu.collapsed";

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

const editBtn: CSSProperties = {
  width: "100%",
  padding: "0.4rem 0.6rem",
  borderRadius: 8,
  border: "1px dashed #475569",
  background: "transparent",
  color: "#94a3b8",
  fontSize: "0.78rem",
  cursor: "pointer",
};

/** 解析组内条目：用户顺序优先（未列出的按默认补末尾） */
function resolveGroupItems(g: MenuGroup, tools: ToolMeta[], order?: string[]): MenuEntry[] {
  const defaults: MenuEntry[] = [
    ...(g.staticItems ?? []).map((s) => ({ key: s.path, name: s.name, path: s.path, icon: s.icon })),
    ...tools
      .filter((t) => g.toolIds?.includes(t.id))
      .map((t) => ({ key: t.id, name: t.name, path: t.path, icon: "🧰" })),
  ];
  if (!order || order.length === 0) return defaults;
  const byKey = new Map(defaults.map((d) => [d.key, d]));
  const ordered = order.map((k) => byKey.get(k)).filter((x): x is MenuEntry => !!x);
  const rest = defaults.filter((d) => !order.includes(d.key));
  return [...ordered, ...rest];
}

/** 默认顺序（分组内按定义顺序） */
function defaultOrder(groups: MenuGroup[], tools: ToolMeta[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const g of groups) {
    const items = resolveGroupItems(g, tools);
    if (items.length > 0) out[g.label] = items.map((it) => it.key);
  }
  const grouped = new Set(groups.flatMap((g) => g.toolIds ?? []));
  const rest = tools.filter((t) => !grouped.has(t.id));
  if (rest.length > 0) out["其他"] = rest.map((t) => t.id);
  return out;
}

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [tools, setTools] = useState<ToolMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 菜单顺序（服务端设置：settings:menu.order）
  const [menuOrder, setMenuOrder] = useState<Record<string, string[]> | null>(null);
  // 编辑模式（本地草稿，保存后写服务端）
  const [editing, setEditing] = useState(false);
  const [draftOrder, setDraftOrder] = useState<Record<string, string[]> | null>(null);
  const [dragState, setDragState] = useState<{ group: string; from: number } | null>(null);
  // 分组折叠（UI 偏好，localStorage）
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY) ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch((e: unknown) => setError(String(e)));
    api
      .tools()
      .then((r) => setTools(r.tools))
      .catch((e: unknown) => setError(String(e)));
    // 加载服务端菜单顺序
    api
      .localEntry({ source: "settings:", key: MENU_ORDER_KEY })
      .then((r) => {
        if (r.ok && "value" in r && r.value && typeof r.value === "object") {
          setMenuOrder(r.value as Record<string, string[]>);
        }
      })
      .catch(() => {});
  }, []);

  /** 折叠/展开分组 */
  const toggleCollapse = (label: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [label]: !prev[label] };
      try {
        localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // 存储不可用：静默
      }
      return next;
    });
  };

  /** 进入编辑模式（以当前生效顺序为草稿） */
  const startEdit = () => {
    const base = menuOrder ?? defaultOrder(MENU_GROUPS, tools);
    setDraftOrder(JSON.parse(JSON.stringify(base)) as Record<string, string[]>);
    setEditing(true);
  };

  /** 保存顺序到服务端设置 */
  const saveOrder = async () => {
    if (!draftOrder) return;
    try {
      await api.localUpdate({ source: "settings:", key: MENU_ORDER_KEY, value: draftOrder });
      setMenuOrder(JSON.parse(JSON.stringify(draftOrder)) as Record<string, string[]>);
    } catch (e) {
      setError(`菜单顺序保存失败：${String(e)}`);
    }
    setEditing(false);
    setDraftOrder(null);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraftOrder(null);
    setDragState(null);
  };

  /** 组内拖拽落点：重排草稿顺序 */
  const onDrop = (groupLabel: string, to: number) => {
    if (!dragState || dragState.group !== groupLabel) return;
    const from = dragState.from;
    setDraftOrder((prev) => {
      if (!prev) return prev;
      const arr = [...(prev[groupLabel] ?? [])];
      if (from === to || from < 0 || from >= arr.length || to < 0 || to > arr.length) return prev;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return { ...prev, [groupLabel]: arr };
    });
    setDragState(null);
  };

  // 全部分组（含"其他"）
  const allGroups: { label: string; group: MenuGroup | null }[] = [
    ...MENU_GROUPS.map((g) => ({ label: g.label, group: g })),
    { label: "其他", group: null },
  ];

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

            {/* 编辑模式工具条 */}
            <div style={{ padding: "0.5rem 0.9rem 0.2rem" }}>
              {editing ? (
                <div style={{ display: "flex", gap: "0.4rem" }}>
                  <button style={{ ...editBtn, borderColor: "#16a34a", color: "#4ade80" }} onClick={() => void saveOrder()} type="button">
                    💾 保存顺序
                  </button>
                  <button style={editBtn} onClick={cancelEdit} type="button">
                    取消
                  </button>
                </div>
              ) : (
                <button style={editBtn} onClick={startEdit} type="button">
                  ✏️ 编辑菜单（拖动排序）
                </button>
              )}
            </div>
            {editing && (
              <div style={{ padding: "0.2rem 0.9rem", fontSize: "0.7rem", color: "#94a3b8" }}>
                拖动 ⠿ 调整菜单顺序，保存后同步到服务端设置（本地数据管理可见）。
              </div>
            )}

            {allGroups.map(({ label, group }) => {
              const items = group
                ? resolveGroupItems(group, tools, editing ? draftOrder?.[label] : menuOrder?.[label])
                : tools.filter((t) => {
                    const grouped = new Set(MENU_GROUPS.flatMap((g) => g.toolIds ?? []));
                    return !grouped.has(t.id);
                  }).map((t) => ({ key: t.id, name: t.name, path: t.path, icon: "🧰" }));
              if (items.length === 0) return null;
              const isCollapsed = !editing && !!collapsed[label];
              return (
                <div key={label}>
                  {/* 分组标题：点击折叠/展开（编辑模式下不折叠） */}
                  <div
                    style={{ ...groupLabelStyle, display: "flex", alignItems: "center", gap: "0.35rem", cursor: editing ? "default" : "pointer", userSelect: "none" }}
                    onClick={() => { if (!editing) toggleCollapse(label); }}
                    title={editing ? undefined : (isCollapsed ? "展开分组" : "折叠分组")}
                  >
                    <span style={{ fontSize: "0.58rem", color: "#94a3b8", width: 10, display: "inline-block" }}>
                      {isCollapsed ? "▸" : "▾"}
                    </span>
                    <span>{label}</span>
                    <span style={{ color: "#475569", fontWeight: 400 }}>({items.length})</span>
                  </div>
                  {!isCollapsed &&
                    items.map((it, idx) =>
                      editing ? (
                        <div
                          key={it.key}
                          draggable
                          onDragStart={() => setDragState({ group: label, from: idx })}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => onDrop(label, idx)}
                          onDragEnd={() => setDragState(null)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.45rem",
                            padding: "0.45rem 0.5rem",
                            margin: "0.15rem 0",
                            borderRadius: 8,
                            background: dragState?.group === label && dragState.from === idx ? "#3b82f6" : "#334155",
                            color: "#e2e8f0",
                            fontSize: "0.9rem",
                            cursor: "grab",
                          }}
                        >
                          <span style={{ color: "#94a3b8", fontSize: "0.85rem" }}>⠿</span>
                          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {it.icon} {it.name}
                          </span>
                          <span style={{ flex: 1 }} />
                          <span style={{ color: "#64748b", fontSize: "0.65rem" }}>{idx + 1}</span>
                        </div>
                      ) : (
                        <NavLink key={it.key} to={it.path} style={({ isActive }) => menuItemStyle(isActive)}>
                          {it.icon} {it.name}
                        </NavLink>
                      ),
                    )}
                </div>
              );
            })}
          </nav>
        </aside>

        {/* 右侧内容区 */}
        <main style={{ flex: 1, minWidth: 0, padding: "1.5rem 2rem", background: "#f5f6f8" }}>
          <Routes>
            <Route path="/" element={<Overview health={health} tools={tools} error={error} />} />
            <Route path="/settings/llm" element={<LlmSettings />} />
            <Route path="/settings/agent-sessions" element={<AgentSessions />} />
            <Route path="/settings/local-data" element={<LocalData />} />
            <Route path="/settings/memo" element={<MemoTool />} />
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
