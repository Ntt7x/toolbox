// ============================================================
// 工具页：新闻中心（NewsCenterTool）
// tab 展示区（默认）：按启用源合并拉取新闻（时间降序）
// tab 配置区：配置新闻源（东财等，可拓展；配置存本地设置数据）
// ============================================================
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { api, errMsg } from "../api";
import { ErrorCard, PageHeader } from "../ui";

const card: CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.25rem 1.5rem",
  marginBottom: "1rem",
};

const tabBtn = (active: boolean): CSSProperties => ({
  padding: "0.5rem 1.4rem",
  borderRadius: 999,
  border: `1.5px solid ${active ? "#3b82f6" : "#e2e8f0"}`,
  background: active ? "#eff6ff" : "#fff",
  color: active ? "#1d4ed8" : "#475569",
  fontWeight: active ? 700 : 500,
  fontSize: "0.9rem",
  cursor: "pointer",
});

interface NewsItem {
  title: string;
  digest: string;
  time: string;
  url: string;
  source: string;
  sourceName: string;
}

interface SourceDef {
  id: string;
  name: string;
  desc: string;
  enabled: boolean;
}

// 重要新闻关键词（利率/重大政策/通胀/流动性等；命中 title 或 digest 即高亮）
const IMPORTANT_KEYWORDS = [
  "利率", "央行", "降息", "加息", "CPI", "PPI", "逆回购", "MLF", "LPR",
  "货币政策", "美联储", "议息", "降准", "存款准备金", "国债", "汇率", "通胀", "财政政策",
];
const isImportant = (n: NewsItem): boolean =>
  IMPORTANT_KEYWORDS.some((k) => (n.title || "").includes(k) || (n.digest || "").includes(k));

export default function NewsCenterTool() {
  const [tab, setTab] = useState<"show" | "config">("show");
  // 展示区
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [at, setAt] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  // 配置区
  const [sources, setSources] = useState<SourceDef[]>([]);
  const [configMsg, setConfigMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadSources = useCallback(async () => {
    try {
      const r = await api.newsSources();
      if (r.ok) setSources(r.sources);
    } catch {
      // 静默
    }
  }, []);

  const loadItems = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await api.newsItems();
      if (r.ok) {
        setItems(r.items ?? []);
        setErrors(r.errors ?? []);
        setFromCache(r.fromCache?.every((x) => x) ?? false);
        setAt(new Date().toISOString());
      } else {
        setErrors([r.message ?? "新闻加载失败"]);
      }
    } catch (e) {
      setErrors([errMsg(e)]);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSources();
    void loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveConfig = async () => {
    setSaving(true);
    setConfigMsg(null);
    try {
      const r = await api.newsConfig(sources.filter((s) => s.enabled).map((s) => s.id));
      if (r.ok) {
        setSources(r.sources);
        setConfigMsg("✓ 已保存新闻源配置");
        void loadItems(true); // 保存后刷新展示
      } else {
        setConfigMsg(r.message ?? "保存失败");
      }
    } catch (e) {
      setConfigMsg(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="📰 新闻中心"
        desc="多新闻源聚合：展示区查看实时快讯（时间降序），配置区管理新闻源（可拓展：东财 → 后续更多）。"
      />

      {/* Tab 切换：展示区（默认）/ 配置区 */}
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button style={tabBtn(tab === "show")} onClick={() => setTab("show")} type="button">
          📺 展示区
        </button>
        <button style={tabBtn(tab === "config")} onClick={() => setTab("config")} type="button">
          ⚙️ 配置区
        </button>
      </div>

      {/* ============ 展示区 ============ */}
      {tab === "show" && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: "1rem" }}>🔥 实时快讯</span>
            <span style={{ color: "#94a3b8", fontSize: "0.8rem" }}>
              来源：{sources.filter((s) => s.enabled).map((s) => s.name).join("、") || "未启用任何源"}
            </span>
            <span style={{ flex: 1 }} />
            {fromCache && <span style={{ background: "#fef3c7", color: "#b45309", padding: "0.15rem 0.5rem", borderRadius: 999, fontSize: "0.72rem" }}>💾 缓存</span>}
            {at && <span style={{ color: "#94a3b8", fontSize: "0.75rem" }}>更新于 {new Date(at).toLocaleTimeString()}</span>}
            <button
              style={{ padding: "0.35rem 0.9rem", borderRadius: 8, border: "1px solid #cbd5e1", background: "#fff", color: "#475569", fontSize: "0.8rem", cursor: "pointer" }}
              onClick={() => void loadItems()}
              disabled={loading}
              type="button"
            >
              {loading ? "加载中…" : "🔄 刷新"}
            </button>
          </div>

          {errors.length > 0 && (
            <div style={{ color: "#b91c1c", fontSize: "0.82rem", marginTop: "0.5rem" }}>
              {errors.map((e, i) => (
                <div key={i}>❌ {e}</div>
              ))}
            </div>
          )}

          {items.length > 0 && (
            <div style={{ marginTop: "0.6rem", display: "flex", flexDirection: "column" }}>
              {items.map((n, i) => {
                const imp = isImportant(n);
                return (
                  <a
                    key={`${n.source}-${i}`}
                    href={n.url}
                    target="_blank"
                    rel="noreferrer"
                    title={n.digest}
                    style={{
                      display: "flex",
                      gap: "0.7rem",
                      alignItems: "baseline",
                      textDecoration: "none",
                      color: "#334155",
                      fontSize: "0.85rem",
                      lineHeight: 1.55,
                      padding: "0.28rem 0.4rem",
                      borderRadius: 8,
                      borderBottom: "1px solid #f1f5f9",
                      ...(imp
                        ? { background: "#fff7ed", borderLeft: "3px solid #f97316", fontWeight: 600, color: "#7c2d12" }
                        : {}),
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = imp ? "#ffedd5" : "#f8fafc"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = imp ? "#fff7ed" : "transparent"; }}
                  >
                    <span style={{ color: "#94a3b8", fontSize: "0.72rem", flexShrink: 0, width: 104 }}>{n.time.slice(5, 16)}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>{n.title}</span>
                    {imp && (
                      <span style={{ flexShrink: 0, background: "#f97316", color: "#fff", fontSize: "0.68rem", fontWeight: 700, padding: "0.1rem 0.45rem", borderRadius: 999 }}>
                        ⭐ 重要
                      </span>
                    )}
                    <span style={{ color: "#64748b", fontSize: "0.72rem", flexShrink: 0, background: "#f1f5f9", padding: "0.1rem 0.5rem", borderRadius: 999 }}>
                      {n.sourceName}
                    </span>
                  </a>
                );
              })}
            </div>
          )}
          {!loading && items.length === 0 && errors.length === 0 && (
            <div style={{ color: "#94a3b8", fontSize: "0.85rem", marginTop: "0.5rem" }}>暂无新闻（点击「刷新」重试，或到配置区检查新闻源）</div>
          )}
        </div>
      )}

      {/* ============ 配置区 ============ */}
      {tab === "config" && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
            <span style={{ fontWeight: 700, fontSize: "1rem" }}>⚙️ 新闻源配置</span>
            <span style={{ color: "#94a3b8", fontSize: "0.8rem" }}>勾选启用（保存后展示区按启用源拉取）；新增源由服务端注册表接入</span>
            <span style={{ flex: 1 }} />
            <button
              style={{ padding: "0.35rem 1rem", borderRadius: 8, border: "none", background: "#3b82f6", color: "#fff", fontSize: "0.82rem", fontWeight: 600, cursor: "pointer" }}
              onClick={() => void saveConfig()}
              disabled={saving}
              type="button"
            >
              {saving ? "保存中…" : "💾 保存配置"}
            </button>
          </div>
          {configMsg && (
            <div style={{ color: configMsg.startsWith("✓") ? "#059669" : "#dc2626", fontSize: "0.82rem", marginBottom: "0.5rem" }}>{configMsg}</div>
          )}
          {sources.length === 0 && <div style={{ color: "#94a3b8", fontSize: "0.85rem" }}>暂无新闻源</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {sources.map((s) => (
              <label
                key={s.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "0.6rem",
                  padding: "0.6rem 0.8rem",
                  borderRadius: 10,
                  border: `1.5px solid ${s.enabled ? "#3b82f6" : "#e2e8f0"}`,
                  background: s.enabled ? "#eff6ff" : "#fff",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={() => setSources((prev) => prev.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)))}
                  style={{ marginTop: "0.2rem" }}
                />
                <span>
                  <span style={{ fontWeight: 600 }}>{s.name}</span>
                  <br />
                  <span style={{ color: "#64748b", fontSize: "0.78rem" }}>{s.desc}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
