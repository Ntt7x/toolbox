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

  const refreshConfig = useCallback(async () => {
    try {
      setConfig(await api.booksConfig());
    } catch {
      // 静默
    }
  }, []);

  useEffect(() => {
    void refreshConfig();
  }, [refreshConfig]);

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

  const download = (item: BookItem) => {
    // zlib 下载强制登录会话：服务端匿名拿到的 /dl/ 短链无效（404）。
    // 在浏览器打开该书的搜索结果页，登录态下直接可见下载入口。
    openZlib(`${config?.zlibBase ?? base}/s/?q=${encodeURIComponent(item.title)}`);
  };

  return (
    <div>
      <PageHeader title="📚 书籍下载（zlib）" desc="输入书名模糊搜索 zlib，服务端经本机代理查询；下载/详情在浏览器打开（需浏览器已登录 zlib，经系统代理访问）。" />

      {/* 使用说明 */}
      <div style={{ ...card, background: "#fffbeb", borderColor: "#fde68a" }}>
        <div style={{ fontSize: "0.85rem", color: "#92400e", lineHeight: 1.7 }}>
          <b>使用须知：</b>
          <br />① zlib 站点需科学上网：服务端经本机代理 <code style={{ background: "#fef3c7", padding: "0 4px", borderRadius: 4 }}>{config?.proxy ?? "http://127.0.0.1:10808"}</code> 访问（可在「本地数据管理」改 books.proxy / books.zlibBase）。
          <br />② 搜索免费匿名可用，但每日有限额（429 时可稍后再试或点「🚀 浏览器打开」）。
          <br />③ <b>下载需登录 zlib 账号</b>：点「⬇ 打开下载」会在浏览器打开该书搜索页，登录后点书进入详情页下载（免费账号每日限量）。
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
                    <button style={{ ...btnSmall, background: "#3b82f6", color: "#fff" }} onClick={() => download(item)} type="button" title="浏览器打开该书 zlib 搜索结果页，登录后点击下载">
                      ⬇ 打开下载
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
