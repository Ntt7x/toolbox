// ============================================================
// 书籍下载：zlib 搜索 + 浏览器打开下载
// - 服务端经本机代理搜索 zlib（匿名限额）；结果卡片展示
// - 「⬇ 下载」= window.open 下载链接（浏览器登录态下载）
// - 「🚀 浏览器打开」= 在浏览器打开 zlib 搜索页（登录态直接搜/下）
// ============================================================

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { api, errMsg } from "../api";
import { ErrorCard, PageHeader } from "../ui";
import type { BookConfig, BookItem } from "@toolbox/shared";
const card: CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.25rem 1.5rem",
  marginBottom: "1rem",
};

const btn: CSSProperties = {
  padding: "0.55rem 1.2rem",
  borderRadius: 8,
  border: "none",
  background: "#3b82f6",
  color: "#fff",
  fontSize: "0.92rem",
  fontWeight: 600,
  cursor: "pointer",
};

const input: CSSProperties = {
  flex: 1,
  minWidth: 200,
  padding: "0.5rem 0.7rem",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  fontSize: "0.92rem",
};

const btnSmall: CSSProperties = {
  padding: "0.3rem 0.7rem",
  borderRadius: 6,
  border: "none",
  background: "#e2e8f0",
  color: "#334155",
  fontSize: "0.78rem",
  fontWeight: 600,
  cursor: "pointer",
};

function openZlib(url: string): void {
  // 经浏览器打开（浏览器走系统代理 + zlib 登录态）
  window.open(url, "_blank", "noopener");
}

export default function BookSearchTool() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<BookItem[]>([]);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [base, setBase] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [config, setConfig] = useState<BookConfig | null>(null);
  const [imgFailed, setImgFailed] = useState<Set<number>>(new Set());
  // 历史搜索记录
  const [history, setHistory] = useState<{ q: string; ts: string; hits?: number }[]>([]);
  // 收藏
  const [favorites, setFavorites] = useState<BookItem[]>([]);
  const [showFav, setShowFav] = useState(false);

  const loadFavorites = useCallback(async () => {
    try {
      const r = await api.booksFavorites();
      if (r.ok) setFavorites(r.items ?? []);
    } catch {
      // 静默
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const r = await api.booksHistory();
      if (r.ok) setHistory(r.items ?? []);
    } catch {
      // 静默
    }
  }, []);

  /** 收藏/取消收藏 */
  const toggleFavorite = async (item: BookItem) => {
    const fav = favorites.some((f) => f.id === item.id);
    try {
      if (fav) {
        await api.booksFavoriteDelete(item.id);
      } else {
        await api.booksFavoriteAdd(item);
      }
      void loadFavorites();
    } catch {
      // 静默
    }
  };

  /** 清空收藏 */
  const clearFavorites = async () => {
    if (favorites.length === 0) return;
    if (!window.confirm("确定清空全部收藏？")) return;
    try {
      await api.booksFavoriteDelete();
      void loadFavorites();
    } catch {
      // 静默
    }
  };

  const refreshConfig = useCallback(async () => {
    try {
      setConfig(await api.booksConfig());
    } catch {
      // 静默
    }
  }, []);

  useEffect(() => {
    void refreshConfig();
    void loadHistory();
    void loadFavorites();
  }, [refreshConfig, loadHistory, loadFavorites]);

  const runSearch = async (page = 1) => {
    const query = q.trim();
    if (!query) {
      setErr("请输入书名（模糊搜索）");
      return;
    }
    setLoading(true);
    setErr(null);
    setImgFailed(new Set());
    try {
      const r = await api.booksSearch(query, page);
      if (r.ok) {
        setItems(r.items ?? []);
        setTotal(r.total);
        setBase(r.base ?? "");
        void loadHistory(); // 刷新历史（已记录本次搜索）
      } else {
        setItems([]);
        setTotal(undefined);
        setErr(r.message || "搜索失败");
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  const browserSearch = () => {
    const query = q.trim();
    openZlib(`${config?.zlibBase ?? "https://z-library.bz"}/s/?q=${encodeURIComponent(query || "book")}`);
  };

  /** 点击历史：填入并重搜 */
  const historySearch = (hq: string) => {
    setQ(hq);
    setItems([]);
    setTotal(undefined);
    setErr(null);
    void (async () => {
      setLoading(true);
      try {
        const r = await api.booksSearch(hq, 1);
        if (r.ok) {
          setItems(r.items ?? []);
          setTotal(r.total);
          setBase(r.base ?? "");
          void loadHistory();
        } else {
          setErr(r.message || "搜索失败");
        }
      } catch (e) {
        setErr(errMsg(e));
      } finally {
        setLoading(false);
      }
    })();
  };

  /** 删除单条历史 */
  const removeHistory = async (hq: string) => {
    try {
      await api.booksHistoryDelete(hq);
      void loadHistory();
    } catch {
      // 静默
    }
  };

  /** 清空历史 */
  const clearHistory = async () => {
    if (history.length === 0) return;
    if (!window.confirm("确定清空全部历史搜索记录？")) return;
    try {
      await api.booksHistoryDelete();
      void loadHistory();
    } catch {
      // 静默
    }
  };

  return (
    <div>
      <PageHeader title="📚 书籍下载（zlib）" desc="输入书名模糊搜索 zlib，服务端经本机代理查询；下载/详情在浏览器打开（需浏览器已登录 zlib，经系统代理访问）。" />

      {/* 使用说明 */}
      <div style={{ ...card, background: "#fffbeb", borderColor: "#fde68a" }}>
        <div style={{ fontSize: "0.85rem", color: "#92400e", lineHeight: 1.7 }}>
          <b>使用须知：</b>
          <br />① zlib 站点需科学上网：服务端经本机代理 <code style={{ background: "#fef3c7", padding: "0 4px", borderRadius: 4 }}>{config?.proxy ?? "http://127.0.0.1:10808"}</code> 访问（可在「本地数据管理」改 books.proxy / books.zlibBase）。
          <br />② 搜索自动携带 <b>访客会话</b>（zlib singlelogin 免密，服务端自动获取），一般不受匿名每日限额影响；极端限流（429）时稍后再试或点「🚀 浏览器打开」。
          <br />③ <b>下载需登录 zlib 账号</b>：用顶部「🚀 浏览器打开」在浏览器搜索该书，登录后点书进入详情页下载（免费账号每日限量）。
          <br />④ 请遵守版权法规，仅下载你有权获取的内容。
        </div>
      </div>

      {/* 搜索框 */}
      <div style={card}>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <input
            style={{ ...input, minWidth: 280 }}
            placeholder="书名 / 作者 / ISBN（模糊搜索）"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
          />
          <button style={btn} onClick={() => void runSearch()} disabled={loading} type="button">
            {loading ? "搜索中…" : "🔍 搜索"}
          </button>
          <button style={{ ...btn, background: "#7c3aed" }} onClick={browserSearch} type="button" title="在浏览器打开 zlib 搜索页（登录态直接搜索/下载）">
            🚀 浏览器打开
          </button>
        </div>
        {items.length > 0 && (
          <div style={{ color: "#64748b", fontSize: "0.82rem", marginTop: "0.5rem" }}>
            {total !== undefined ? <>共命中 <b>{total}</b> 条，显示前 {items.length} 条（zlib 匿名限额展示）。</> : <>返回 <b>{items.length}</b> 条结果。</>}
          </div>
        )}

        {/* 收藏列表 */}
        {favorites.length > 0 && (
          <div style={{ marginTop: "0.7rem", borderTop: "1px dashed #e2e8f0", paddingTop: "0.6rem" }}>
            <div
              style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", fontSize: "0.85rem", fontWeight: 600, color: "#334155" }}
              onClick={() => setShowFav((v) => !v)}
            >
              📌 收藏的书（{favorites.length}）{showFav ? " ▾" : " ▸"}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: "0.72rem", color: "#94a3b8", fontWeight: 400, cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); void clearFavorites(); }}>
                清空
              </span>
            </div>
            {showFav && (
              <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                {favorites.map((f) => (
                  <div key={f.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", padding: "0.4rem 0.6rem", border: "1px solid #e2e8f0", borderRadius: 8, background: "#fffbeb", fontSize: "0.82rem" }}>
                    <span style={{ fontWeight: 600, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.title}>
                      {f.title}
                    </span>
                    <span style={{ background: "#fef3c7", color: "#92400e", borderRadius: 4, padding: "0.05rem 0.4rem", fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase" }}>
                      {(f.extension ?? "?").toUpperCase()}
                    </span>
                    <span style={{ color: "#64748b", fontSize: "0.75rem" }}>{f.filesizeString ?? ""}</span>
                    <span style={{ flex: 1 }} />
                    {f.detailUrl && (
                      <button style={btnSmall} onClick={() => openZlib(f.detailUrl as string)} type="button">
                        📖 详情页
                      </button>
                    )}
                    <button style={{ ...btnSmall, background: "#dc2626", color: "#fff" }} onClick={() => void toggleFavorite(f)} type="button">
                      取消收藏
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 历史搜索记录 */}
        {history.length > 0 && (
          <div style={{ marginTop: "0.7rem", display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.78rem", color: "#64748b", whiteSpace: "nowrap" }}>🕘 历史：</span>
            {history.map((h) => (
              <span
                key={h.q}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.25rem",
                  padding: "0.15rem 0.6rem",
                  borderRadius: 999,
                  background: "#f1f5f9",
                  border: "1px solid #e2e8f0",
                  fontSize: "0.78rem",
                  color: "#334155",
                  cursor: "pointer",
                }}
                title={`${h.hits !== undefined ? `命中 ${h.hits} 条 · ` : ""}${new Date(h.ts).toLocaleString()}`}
                onClick={() => historySearch(h.q)}
              >
                {h.q}
                <span
                  style={{ color: "#94a3b8", fontSize: "0.85rem", lineHeight: 1, cursor: "pointer" }}
                  onClick={(e) => { e.stopPropagation(); void removeHistory(h.q); }}
                  title="删除该条历史"
                >
                  ×
                </span>
              </span>
            ))}
            <span
              style={{ fontSize: "0.75rem", color: "#94a3b8", cursor: "pointer", textDecoration: "underline" }}
              onClick={() => void clearHistory()}
            >
              清空
            </span>
          </div>
        )}
      </div>

      {err && <ErrorCard>{err}</ErrorCard>}

      {/* 结果列表 */}
      {items.length > 0 && (
        <div style={card}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
            {items.map((item, idx) => (
              <div
                key={item.id}
                style={{
                  display: "flex",
                  gap: "0.9rem",
                  padding: "0.8rem",
                  border: "1px solid #e2e8f0",
                  borderRadius: 10,
                  background: "#f8fafc",
                }}
              >
                {/* 封面 */}
                <div style={{ width: 64, height: 88, flexShrink: 0, borderRadius: 6, overflow: "hidden", background: "#e2e8f0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.6rem" }}>
                  {item.cover && !imgFailed.has(item.id) ? (
                    <img
                      src={item.cover}
                      alt=""
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      onError={() => setImgFailed((prev) => new Set(prev).add(item.id))}
                      loading="lazy"
                    />
                  ) : (
                    <span>📖</span>
                  )}
                </div>
                {/* 信息 */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: "0.95rem", lineHeight: 1.4 }}>
                    {idx + 1}. {item.title}
                  </div>
                  <div style={{ color: "#64748b", fontSize: "0.8rem", marginTop: "0.2rem" }}>
                    {[item.author, item.publisher, item.year ? `${item.year}年` : "", item.language, item.pages ? `${item.pages}页` : ""]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </div>
                  <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.45rem", flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ background: "#e0e7ff", color: "#4338ca", borderRadius: 4, padding: "0.1rem 0.45rem", fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase" }}>
                      {(item.extension ?? "?").toUpperCase()}
                    </span>
                    <span style={{ color: "#475569", fontSize: "0.78rem" }}>{item.filesizeString ?? (item.filesize ? `${(item.filesize / 1024 / 1024).toFixed(1)} MB` : "")}</span>
                    <span style={{ flex: 1 }} />
                    <button
                      style={{ ...btnSmall, background: favorites.some((f) => f.id === item.id) ? "#f59e0b" : "#e2e8f0", color: favorites.some((f) => f.id === item.id) ? "#fff" : "#475569" }}
                      onClick={() => void toggleFavorite(item)}
                      type="button"
                      title={favorites.some((f) => f.id === item.id) ? "取消收藏" : "收藏这本书（标记要下载）"}
                    >
                      {favorites.some((f) => f.id === item.id) ? "★ 已收藏" : "☆ 收藏"}
                    </button>
                    {item.detailUrl && (
                      <button style={btnSmall} onClick={() => item.detailUrl && openZlib(item.detailUrl)} type="button" title="打开 zlib 书籍详情页">
                        📖 详情页
                      </button>
                    )}
                    {item.readOnlineUrl && (
                      <button style={{ ...btnSmall, background: "#16a34a", color: "#fff" }} onClick={() => item.readOnlineUrl && openZlib(item.readOnlineUrl)} type="button">
                        👁 在线读
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && items.length === 0 && !err && (
        <div style={{ ...card, color: "#94a3b8", textAlign: "center", padding: "2.5rem" }}>
          输入书名开始搜索（如「深度学习」「Python」）。搜索由服务端经代理完成，下载在浏览器中打开。
        </div>
      )}
    </div>
  );
}
