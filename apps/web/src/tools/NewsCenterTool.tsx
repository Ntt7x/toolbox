// ============================================================
// 工具页：新闻中心（NewsCenterTool）
// tab 展示区（默认）：按启用源合并拉取新闻（时间降序）+ 服务端文本加工结果
//   · tags 打标（规则命中）· hits 高亮词组命中区间 · blocked 黑名单命中
// tab 配置区：新闻源配置 + 文本加工配置（打标规则 / 高亮词组 / 黑名单词组）
// 匹配能力全部在服务端 core/newsText（非 LLM、纯函数），前端只做渲染
// ============================================================
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import type {
  NewsMatchMode,
  NewsTagRule,
  NewsTextConfig,
  NewsTextHit,
  ProcessedNewsItem,
} from "@toolbox/shared"
import { openDeepSeekChat } from "../deepseekChat";
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

const smallBtn: CSSProperties = {
  padding: "0.3rem 0.75rem",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#475569",
  fontSize: "0.78rem",
  cursor: "pointer",
};

const labelStyle: CSSProperties = { fontSize: "0.76rem", fontWeight: 600, color: "#475569" };
const hintStyle: CSSProperties = { fontSize: "0.72rem", color: "#94a3b8" };
const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.7rem",
  minHeight: 36,
  fontSize: "0.85rem",
  lineHeight: 1.6,
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  background: "#fff",
  boxSizing: "border-box",
};

/** 标签徽章配色（规则未指定颜色时按序取用） */
const TAG_COLORS = ["#f97316", "#2563eb", "#059669", "#7c3aed", "#db2777", "#0891b2", "#b45309", "#4b5563"];

interface SourceDef {
  id: string;
  name: string;
  desc: string;
  enabled: boolean;
}

/** 词组文本 ↔ 数组：支持逗号 / 顿号 / 分号 / 换行分隔（保留英文短语内部空格） */
const splitWords = (s: string): string[] =>
  s.split(/[,，、;；\n\r]+/).map((x) => x.trim()).filter(Boolean);
const joinWords = (arr: string[]): string => arr.join("、");

const emptyConfig: NewsTextConfig = {
  rules: [],
  highlight: { enabled: true, mode: "exact", words: [] },
  blacklist: { enabled: false, mode: "fuzzy", words: [], action: "hide" },
};

/** 按命中区间渲染高亮文本（区间由服务端给出，基于原始字符串下标） */
function Highlighted({ text, hits }: { text: string; hits: NewsTextHit[] }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  hits.forEach((h, i) => {
    const start = Math.max(0, Math.min(h.start, text.length));
    const end = Math.max(start, Math.min(h.end, text.length));
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark
        key={`${h.word}-${i}`}
        title={`命中高亮词组：${h.word}`}
        style={{ background: "#fde68a", color: "#7c2d12", padding: "0 1px", borderRadius: 3 }}
      >
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export default function NewsCenterTool() {
  const [tab, setTab] = useState<"show" | "config">("show");
  // 展示区
  const [items, setItems] = useState<ProcessedNewsItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [at, setAt] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [blockedCount, setBlockedCount] = useState(0);
  // 分页（memo msq32kgv：滚动加载更多）
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // 标签筛选（展示区顶部 chips，按打标结果过滤）
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  // 配置区：新闻源
  const [sources, setSources] = useState<SourceDef[]>([]);
  const [configMsg, setConfigMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 配置区：文本加工（cfg 为权威配置；draft 为词组编辑态，blur/保存时才解析，避免输入中被吞字符）
  const [cfg, setCfg] = useState<NewsTextConfig>(emptyConfig);
  const [draft, setDraft] = useState<{ rules: Record<string, string>; highlight: string; blacklist: string }>({
    rules: {},
    highlight: "",
    blacklist: "",
  });
  const [textMsg, setTextMsg] = useState<string | null>(null);
  const [savingText, setSavingText] = useState(false);
  // 试跑
  const [previewText, setPreviewText] = useState("");
  const [previewItems, setPreviewItems] = useState<ProcessedNewsItem[] | null>(null);
  const [previewBlocked, setPreviewBlocked] = useState(0);
  const [previewing, setPreviewing] = useState(false);

  const loadSources = useCallback(async () => {
    try {
      const r = await api.newsSources();
      if (r.ok) setSources(r.sources);
    } catch {
      // 静默
    }
  }, []);

  const loadRules = useCallback(async () => {
    try {
      const r = await api.newsRules();
      if (r.ok && r.config) {
        setCfg(r.config);
        setDraft({
          rules: Object.fromEntries(r.config.rules.map((rule) => [rule.id, joinWords(rule.keywords)])),
          highlight: joinWords(r.config.highlight.words),
          blacklist: joinWords(r.config.blacklist.words),
        });
      }
    } catch {
      // 静默
    }
  }, []);

  const loadItems = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await api.newsItems(undefined, 1);
      if (r.ok) {
        setItems(r.items ?? []);
        setErrors(r.errors ?? []);
        setFromCache(r.fromCache?.every((x) => x) ?? false);
        setBlockedCount(r.blockedCount ?? 0);
        setAt(new Date().toISOString());
        setPage(1);
        setHasMore((r.items ?? []).length >= 40); // 单页满 40 认为可能还有更多
      } else {
        setErrors([r.message ?? "新闻加载失败"]);
      }
    } catch (e) {
      setErrors([errMsg(e)]);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  /** 加载更多（分页追加，按 url 去重；memo msq32kgv） */
  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const next = page + 1;
      const r = await api.newsItems(undefined, next);
      if (r.ok) {
        setItems((prev) => {
          const seen = new Set(prev.map((x) => x.url));
          const fresh = (r.items ?? []).filter((x) => !seen.has(x.url));
          return [...prev, ...fresh];
        });
        setBlockedCount((prev) => prev + (r.blockedCount ?? 0));
        setPage(next);
        setHasMore((r.items ?? []).length >= 40);
      } else {
        setErrors([r.message ?? "加载更多失败"]);
      }
    } catch (e) {
      setErrors([errMsg(e)]);
    } finally {
      setLoadingMore(false);
    }
  }, [page]);

  useEffect(() => {
    void loadSources();
    void loadRules();
    void loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 无限滚动（memo mt94j7yw）：sentinel 进入视口自动加载下一页
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loadingMore && !loading) void loadMore();
      },
      { rootMargin: "160px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loadingMore, loading, loadMore]);

  // ---------- 展示区派生 ----------
  const tagStats = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of items) for (const t of n.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);

  const visibleItems = useMemo(
    () => (tagFilter.length === 0 ? items : items.filter((n) => (n.tags ?? []).some((t) => tagFilter.includes(t)))),
    [items, tagFilter],
  );

  const colorOf = useCallback(
    (tag: string): string => {
      const rule = cfg.rules.find((r) => r.name === tag);
      if (rule?.color) return rule.color;
      const idx = cfg.rules.findIndex((r) => r.name === tag);
      return TAG_COLORS[(idx < 0 ? tag.length : idx) % TAG_COLORS.length];
    },
    [cfg.rules],
  );

  // ---------- 配置区操作 ----------
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

  /** 把草稿词组解析进配置（保存/试跑前调用） */
  const buildConfig = useCallback((): NewsTextConfig => {
    const rules: NewsTagRule[] = cfg.rules.map((r) => ({
      ...r,
      name: r.name.trim(),
      keywords: splitWords(draft.rules[r.id] ?? joinWords(r.keywords)),
    }));
    return {
      rules,
      highlight: { ...cfg.highlight, words: splitWords(draft.highlight) },
      blacklist: { ...cfg.blacklist, words: splitWords(draft.blacklist) },
    };
  }, [cfg, draft]);

  const saveTextConfig = async () => {
    setSavingText(true);
    setTextMsg(null);
    try {
      const payload = buildConfig();
      const r = await api.newsSaveRules(payload);
      if (r.ok && r.config) {
        setCfg(r.config);
        setDraft({
          rules: Object.fromEntries(r.config.rules.map((rule) => [rule.id, joinWords(rule.keywords)])),
          highlight: joinWords(r.config.highlight.words),
          blacklist: joinWords(r.config.blacklist.words),
        });
        setTextMsg("✓ 已保存文本加工配置");
        void loadItems(true);
      } else {
        setTextMsg(r.message ?? "保存失败");
      }
    } catch (e) {
      setTextMsg(errMsg(e));
    } finally {
      setSavingText(false);
    }
  };

  const runPreview = async () => {
    setPreviewing(true);
    try {
      const r = await api.newsPreview(buildConfig(), previewText.trim() || undefined, 20);
      if (r.ok) {
        setPreviewItems(r.items ?? []);
        setPreviewBlocked(r.blockedCount ?? 0);
      } else {
        setTextMsg(r.message ?? "试跑失败");
      }
    } catch (e) {
      setTextMsg(errMsg(e));
    } finally {
      setPreviewing(false);
    }
  };

  const addRule = () => {
    const id = `rule-${Date.now().toString(36)}`;
    setCfg((c) => ({ ...c, rules: [...c.rules, { id, name: "", mode: "exact", keywords: [], enabled: true }] }));
    setDraft((d) => ({ ...d, rules: { ...d.rules, [id]: "" } }));
  };

  const patchRule = (id: string, patch: Partial<NewsTagRule>) =>
    setCfg((c) => ({ ...c, rules: c.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));

  const removeRule = (id: string) => {
    setCfg((c) => ({ ...c, rules: c.rules.filter((r) => r.id !== id) }));
    setDraft((d) => {
      const next = { ...d.rules };
      delete next[id];
      return { ...d, rules: next };
    });
  };

  const modeSelect = (value: NewsMatchMode, onChange: (m: NewsMatchMode) => void) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as NewsMatchMode)}
      style={{ ...inputStyle, width: "auto", minWidth: 96, padding: "0.3rem 0.5rem" }}
    >
      <option value="exact">精准</option>
      <option value="fuzzy">模糊</option>
    </select>
  );

  return (
    <div>
      <PageHeader
        title="📰 新闻中心"
        desc="多新闻源聚合 + 文本加工：展示区看加工后的实时快讯（打标/高亮/黑名单），配置区管理新闻源与加工规则。"
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

          {/* 标签筛选 chips（打标结果即筛选维度） */}
          {tagStats.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.6rem" }}>
              <span style={hintStyle}>标签筛选</span>
              <button
                type="button"
                onClick={() => setTagFilter([])}
                style={{
                  padding: "0.15rem 0.55rem",
                  borderRadius: 999,
                  fontSize: "0.74rem",
                  cursor: "pointer",
                  border: `1px solid ${tagFilter.length === 0 ? "#3b82f6" : "#e2e8f0"}`,
                  background: tagFilter.length === 0 ? "#eff6ff" : "#fff",
                  color: tagFilter.length === 0 ? "#1d4ed8" : "#64748b",
                }}
              >
                全部
              </button>
              {tagStats.map(([tag, count]) => {
                const on = tagFilter.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setTagFilter((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))}
                    style={{
                      padding: "0.15rem 0.55rem",
                      borderRadius: 999,
                      fontSize: "0.74rem",
                      cursor: "pointer",
                      border: `1px solid ${on ? colorOf(tag) : "#e2e8f0"}`,
                      background: on ? colorOf(tag) : "#fff",
                      color: on ? "#fff" : "#475569",
                    }}
                  >
                    {tag} {count}
                  </button>
                );
              })}
            </div>
          )}

          {errors.length > 0 && (
            <div style={{ color: "#b91c1c", fontSize: "0.82rem", marginTop: "0.5rem" }}>
              {errors.map((e, i) => (
                <div key={i}>❌ {e}</div>
              ))}
            </div>
          )}

          {blockedCount > 0 && (
            <div style={{ marginTop: "0.5rem" }}>
              <ErrorCard>🚫 已按黑名单词组过滤 {blockedCount} 条（配置区可切换为「仅标记」）</ErrorCard>
            </div>
          )}

          {visibleItems.length > 0 && (
            <>
            <div style={{ marginTop: "0.6rem", display: "flex", flexDirection: "column" }}>
              {visibleItems.map((n, i) => {
                const tagged = (n.tags ?? []).length > 0;
                const hits = (n.hits ?? []).filter((h) => h.field === "title");
                const blocked = n.blocked; // 黑名单 action=mark 时保留展示
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
                      color: blocked ? "#94a3b8" : "#334155",
                      fontSize: "1rem",
                      lineHeight: 1.55,
                      padding: "0.28rem 0.4rem",
                      borderRadius: 8,
                      borderBottom: "1px solid #f1f5f9",
                      ...(blocked
                        ? { background: "#f8fafc", opacity: 0.75 }
                        : tagged
                          ? { background: "#fff7ed", borderLeft: "3px solid #f97316", fontWeight: 600, color: "#7c2d12" }
                          : {}),
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = blocked ? "#f1f5f9" : tagged ? "#ffedd5" : "#f8fafc"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = blocked ? "#f8fafc" : tagged ? "#fff7ed" : "transparent"; }}
                  >
                    <span style={{ color: "#94a3b8", fontSize: "0.82rem", flexShrink: 0, width: 104 }}>{n.time.slice(5, 16)}</span>
                    <button
                      type="button"
                      title="用 DeepSeek Chat 分析这条新闻"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); void openDeepSeekChat(`【新闻】${n.title}\n\n${n.digest}\n\n来源：${n.sourceName}（${n.time}）`); }}
                      style={{ flexShrink: 0, border: "none", background: "transparent", cursor: "pointer", fontSize: "0.85rem", color: "#2563eb", padding: "0 0.2rem", lineHeight: 1 }}
                    >💬</button>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <Highlighted text={n.title} hits={hits} />
                    </span>
                    {blocked && (
                      <span style={{ flexShrink: 0, background: "#e2e8f0", color: "#475569", fontSize: "0.72rem", fontWeight: 700, padding: "0.1rem 0.45rem", borderRadius: 999 }}>
                        🚫 黑名单
                      </span>
                    )}
                    {(n.tags ?? []).map((t) => (
                      <span
                        key={t}
                        style={{ flexShrink: 0, background: colorOf(t), color: "#fff", fontSize: "0.74rem", fontWeight: 700, padding: "0.1rem 0.45rem", borderRadius: 999 }}
                      >
                        {t}
                      </span>
                    ))}
                    <span style={{ color: "#64748b", fontSize: "0.82rem", flexShrink: 0, background: "#f1f5f9", padding: "0.1rem 0.5rem", borderRadius: 999 }}>
                      {n.sourceName}
                    </span>
                  </a>
                );
              })}
            </div>
            {hasMore && (
              <div
                ref={sentinelRef}
                style={{ marginTop: "0.7rem", alignSelf: "center", padding: "0.5rem 1.2rem", color: "#2563eb", fontSize: "0.82rem", textAlign: "center" }}
              >
                {loadingMore ? "加载中…" : "继续滚动加载更多…"}
              </div>
            )}
            </>
          )}
          {!loading && visibleItems.length === 0 && errors.length === 0 && (
            <div style={{ color: "#94a3b8", fontSize: "0.85rem", marginTop: "0.5rem" }}>
              {items.length === 0 ? "暂无新闻（点击「刷新」重试，或到配置区检查新闻源）" : "当前标签筛选下没有新闻（点「全部」取消筛选）"}
            </div>
          )}
        </div>
      )}

      {/* ============ 配置区 ============ */}
      {tab === "config" && (
        <>
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
                {saving ? "保存中…" : "💾 保存新闻源"}
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

          {/* ---- 文本加工配置：打标规则 / 高亮 / 黑名单 ---- */}
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
              <span style={{ fontWeight: 700, fontSize: "1rem" }}>🏷️ 文本加工配置</span>
              <span style={hintStyle}>非 LLM 匹配：精准（归一化子串）/ 模糊（编辑距离，容错错字·缺字）</span>
              <span style={{ flex: 1 }} />
              <button style={smallBtn} onClick={() => void runPreview()} disabled={previewing} type="button">
                {previewing ? "试跑中…" : "🧪 试跑当前配置"}
              </button>
              <button
                style={{ padding: "0.35rem 1rem", borderRadius: 8, border: "none", background: "#3b82f6", color: "#fff", fontSize: "0.82rem", fontWeight: 600, cursor: "pointer" }}
                onClick={() => void saveTextConfig()}
                disabled={savingText}
                type="button"
              >
                {savingText ? "保存中…" : "💾 保存加工配置"}
              </button>
            </div>
            {textMsg && (
              <div style={{ color: textMsg.startsWith("✓") ? "#059669" : "#dc2626", fontSize: "0.82rem", marginBottom: "0.5rem" }}>{textMsg}</div>
            )}

            {/* 打标规则 */}
            <div style={{ marginBottom: "1rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.4rem" }}>
                <span style={labelStyle}>打标规则（命中关键词 → 给新闻打标签）</span>
                <span style={{ flex: 1 }} />
                <button style={smallBtn} onClick={addRule} type="button">＋ 新增规则</button>
              </div>
              {cfg.rules.length === 0 && <div style={hintStyle}>暂无规则（默认仅展示原始新闻）</div>}
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {cfg.rules.map((r) => (
                  <div
                    key={r.id}
                    style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", padding: "0.5rem 0.6rem", borderRadius: 10, border: "1px solid #e2e8f0", background: r.enabled ? "#fff" : "#f8fafc" }}
                  >
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={() => patchRule(r.id, { enabled: !r.enabled })}
                      title="启用该规则"
                      style={{ marginTop: "0.45rem" }}
                    />
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
                        <input
                          value={r.name}
                          onChange={(e) => patchRule(r.id, { name: e.target.value })}
                          placeholder="标签名（如 美联储 / 地产）"
                          style={{ ...inputStyle, width: 180, flex: "0 0 auto" }}
                        />
                        {modeSelect(r.mode, (m) => patchRule(r.id, { mode: m }))}
                        <span style={hintStyle}>关键词（逗号/顿号/换行分隔）</span>
                      </div>
                      <textarea
                        value={draft.rules[r.id] ?? ""}
                        onChange={(e) => setDraft((d) => ({ ...d, rules: { ...d.rules, [r.id]: e.target.value } }))}
                        onBlur={(e) => setDraft((d) => ({ ...d, rules: { ...d.rules, [r.id]: joinWords(splitWords(e.target.value)) } }))}
                        placeholder="降息、议息、FOMC"
                        style={{ ...inputStyle, minHeight: 56, resize: "vertical" }}
                      />
                    </div>
                    <button style={{ ...smallBtn, color: "#dc2626", borderColor: "#fecaca" }} onClick={() => removeRule(r.id)} type="button">
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* 高亮词组 */}
            <div style={{ marginBottom: "1rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.4rem" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                  <input
                    type="checkbox"
                    checked={cfg.highlight.enabled}
                    onChange={() => setCfg((c) => ({ ...c, highlight: { ...c.highlight, enabled: !c.highlight.enabled } }))}
                  />
                  <span style={labelStyle}>高亮词组（命中处标黄）</span>
                </label>
                {modeSelect(cfg.highlight.mode, (m) => setCfg((c) => ({ ...c, highlight: { ...c.highlight, mode: m } })))}
              </div>
              <textarea
                value={draft.highlight}
                onChange={(e) => setDraft((d) => ({ ...d, highlight: e.target.value }))}
                onBlur={(e) => setDraft((d) => ({ ...d, highlight: joinWords(splitWords(e.target.value)) }))}
                placeholder="降准、CPI、美联储"
                style={{ ...inputStyle, minHeight: 56, resize: "vertical" }}
              />
            </div>

            {/* 黑名单词组 */}
            <div style={{ marginBottom: "0.8rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.4rem", flexWrap: "wrap" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                  <input
                    type="checkbox"
                    checked={cfg.blacklist.enabled}
                    onChange={() => setCfg((c) => ({ ...c, blacklist: { ...c.blacklist, enabled: !c.blacklist.enabled } }))}
                  />
                  <span style={labelStyle}>黑名单词组</span>
                </label>
                {modeSelect(cfg.blacklist.mode, (m) => setCfg((c) => ({ ...c, blacklist: { ...c.blacklist, mode: m } })))}
                <select
                  value={cfg.blacklist.action}
                  onChange={(e) => setCfg((c) => ({ ...c, blacklist: { ...c.blacklist, action: e.target.value === "mark" ? "mark" : "hide" } }))}
                  style={{ ...inputStyle, width: "auto", minWidth: 120, padding: "0.3rem 0.5rem" }}
                >
                  <option value="hide">过滤（不展示）</option>
                  <option value="mark">仅标记（保留）</option>
                </select>
                <span style={hintStyle}>标题或摘要命中即生效</span>
              </div>
              <textarea
                value={draft.blacklist}
                onChange={(e) => setDraft((d) => ({ ...d, blacklist: e.target.value }))}
                onBlur={(e) => setDraft((d) => ({ ...d, blacklist: joinWords(splitWords(e.target.value)) }))}
                placeholder="广告、直播预告"
                style={{ ...inputStyle, minHeight: 56, resize: "vertical" }}
              />
            </div>

            {/* 试跑 */}
            <div style={{ borderTop: "1px dashed #e2e8f0", paddingTop: "0.7rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.4rem" }}>
                <span style={labelStyle}>试跑（不保存）</span>
                <span style={hintStyle}>留空 = 对当前新闻流前 20 条加工；填文本 = 只加工这一条（首行为标题，其余为摘要）</span>
              </div>
              <textarea
                value={previewText}
                onChange={(e) => setPreviewText(e.target.value)}
                placeholder="央行宣布降准 0.5 个百分点&#10;市场预期流动性进一步宽松"
                style={{ ...inputStyle, minHeight: 56, resize: "vertical" }}
              />
              {previewItems && (
                <div style={{ marginTop: "0.6rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                  {previewBlocked > 0 && <div style={hintStyle}>🚫 黑名单过滤 {previewBlocked} 条</div>}
                  {previewItems.length === 0 && <div style={hintStyle}>无命中（试跑结果为空）</div>}
                  {previewItems.slice(0, 10).map((n, i) => {
                    const hits = (n.hits ?? []).filter((h) => h.field === "title");
                    return (
                      <div key={i} style={{ display: "flex", gap: "0.45rem", alignItems: "baseline", fontSize: "0.85rem", padding: "0.25rem 0.4rem", borderRadius: 8, background: n.blocked ? "#f8fafc" : "#f8fafc", borderBottom: "1px solid #f1f5f9" }}>
                        <span style={{ flex: 1, minWidth: 0, color: n.blocked ? "#94a3b8" : "#334155" }}>
                          <Highlighted text={n.title} hits={hits} />
                        </span>
                        {n.blocked && <span style={{ fontSize: "0.72rem", color: "#64748b" }}>🚫 {n.blockHits.join("、")}</span>}
                        {(n.tags ?? []).map((t) => (
                          <span key={t} style={{ background: colorOf(t), color: "#fff", fontSize: "0.72rem", fontWeight: 700, padding: "0.05rem 0.4rem", borderRadius: 999 }}>{t}</span>
                        ))}
                      </div>
                    );
                  })}
                  {previewItems.length > 10 && <div style={hintStyle}>…共 {previewItems.length} 条，仅展示前 10 条</div>}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
