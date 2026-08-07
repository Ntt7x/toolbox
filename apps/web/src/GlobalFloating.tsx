// ============================================================
// 全局浮窗：右下角一列竖着的方块
// ① 回到顶部  ② 快速新增改进备忘录（随地记录，弹小窗输入）
// ============================================================
import { useEffect, useRef, useState } from "react";
import { api, errMsg } from "./api";
import type { ToolMeta } from "@toolbox/shared";

/** 非工具页路径 → 中文名（工具页走 api.tools() 动态映射） */
const STATIC_PATHS: Record<string, string> = {
  "/": "工作台",
  "/settings/llm": "LLM 设置",
  "/settings/local-data": "本地数据管理",
  "/settings/memo": "改进备忘录",
  "/settings/agent-sessions": "Agent 会话",
  "/admin/deps": "架构图",
};

export default function GlobalFloating() {
  const [showTop, setShowTop] = useState(false);
  const [openMemo, setOpenMemo] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [tip, setTip] = useState<{ ok: boolean; msg: string } | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toolsRef = useRef<ToolMeta[]>([]);
  const [pageName, setPageName] = useState<string | null>(null);

  // 加载工具 meta（id/path → 中文名）用于页面前缀
  useEffect(() => {
    api
      .tools()
      .then((r) => {
        toolsRef.current = r.tools ?? [];
        setPageName(pageNameOf(window.location.pathname));
      })
      .catch(() => {});
  }, []);

  /** 路径 → 页面中文名（未知返回 null） */
  const pageNameOf = (path: string): string | null => {
    if (STATIC_PATHS[path]) return STATIC_PATHS[path];
    for (const t of toolsRef.current) {
      if (t.path && (path === t.path || path.startsWith(t.path + "/"))) return t.name;
    }
    return null;
  };

  // 打开弹层时刷新当前页面前缀（浮窗常驻，页面可能在 SPA 内切换）
  useEffect(() => {
    if (openMemo) setPageName(pageNameOf(window.location.pathname));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMemo]);

  // 滚动超过一屏才显示「回到顶部」
  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 300);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const flash = (ok: boolean, msg: string) => {
    setTip({ ok, msg });
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => setTip(null), 2200);
  };

  const submitMemo = async () => {
    const t = text.trim();
    if (!t) return;
    // 自动添加所在页面前缀
    const prefixed = pageName ? `[${pageName}] ${t}` : t;
    setBusy(true);
    try {
      const r = await api.memoCreate(prefixed, "fix");
      if (r.ok) {
        setText("");
        setOpenMemo(false);
        flash(true, `✓ 已记入改进备忘录${pageName ? `（${pageName}）` : ""}`);
      } else {
        flash(false, errMsg(r as unknown as Error) ?? "保存失败");
      }
    } catch (e) {
      flash(false, errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const box: React.CSSProperties = {
    width: 42,
    height: 42,
    borderRadius: 12,
    background: "#fff",
    border: "1px solid #e2e8f0",
    boxShadow: "0 4px 14px rgba(15, 23, 42, 0.12)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "1.05rem",
    cursor: "pointer",
    transition: "transform .15s, box-shadow .15s",
    color: "#334155",
  };

  return (
    <div style={{ position: "fixed", right: 18, bottom: 18, zIndex: 2000, display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
      {/* 快速新增改进备忘录 */}
      <button
        type="button"
        title="快速记一条改进备忘录"
        style={{ ...box, background: "#0f172a", borderColor: "#0f172a", color: "#fff" }}
        onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.08)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
        onClick={() => setOpenMemo((v) => !v)}
      >
        📝
      </button>
      {/* 回到顶部 */}
      {showTop && (
        <button
          type="button"
          title="回到顶部"
          style={box}
          onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.08)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          ⬆️
        </button>
      )}

      {/* 快速输入弹层 */}
      {openMemo && (
        <div
          style={{
            position: "fixed",
            right: 18,
            bottom: 74,
            width: 300,
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: 12,
            boxShadow: "0 12px 32px rgba(15, 23, 42, 0.18)",
            padding: "0.9rem",
            zIndex: 2001,
            display: "flex",
            flexDirection: "column",
            gap: "0.55rem",
          }}
        >
          <div style={{ fontSize: "0.82rem", fontWeight: 700, color: "#0f172a" }}>
            📝 快速记一条改进
            <span style={{ fontWeight: 400, color: "#94a3b8", marginLeft: 8, fontSize: "0.72rem" }}>（自动记为 🔧 修复型）</span>
          </div>
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="记录使用过程中发现的小问题…（回车提交）"
            rows={3}
            style={{ width: "100%", resize: "vertical", padding: "0.45rem 0.55rem", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: "0.82rem", fontFamily: "inherit", lineHeight: 1.55, boxSizing: "border-box" }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitMemo(); } }}
          />
          {tip && (
            <div style={{ fontSize: "0.75rem", color: tip.ok ? "#059669" : "#dc2626" }}>{tip.msg}</div>
          )}
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
            <button
              type="button"
              style={{ padding: "0.3rem 0.8rem", borderRadius: 8, border: "1px solid #cbd5e1", background: "#fff", color: "#475569", fontSize: "0.78rem", cursor: "pointer" }}
              onClick={() => { setOpenMemo(false); setText(""); }}
            >
              取消
            </button>
            <button
              type="button"
              disabled={busy || !text.trim()}
              style={{ padding: "0.3rem 0.8rem", borderRadius: 8, border: "none", background: busy ? "#94a3b8" : "#3b82f6", color: "#fff", fontSize: "0.78rem", fontWeight: 600, cursor: busy ? "default" : "pointer" }}
              onClick={() => void submitMemo()}
            >
              {busy ? "保存中…" : "提交"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
