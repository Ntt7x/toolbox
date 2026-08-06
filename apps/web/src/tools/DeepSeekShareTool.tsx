import { useEffect, useState, type CSSProperties } from "react";
import { api, errMsg } from "../api";
import { ErrorCard, PageHeader } from "../ui";
import type { ShareExtractResult, ShareMessage } from "@toolbox/shared";

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
  minWidth: 260,
  padding: "0.5rem 0.7rem",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  fontSize: "0.92rem",
};

const EXAMPLE = "https://chat.deepseek.com/share/u5myqtvktzo5gal4qi";

/** 判断剪贴板文本是否符合 DeepSeek 分享链接 / share id 格式 */
function isShareInput(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // 完整链接：https://chat.deepseek.com/share/<id>
  if (/^https?:\/\/chat\.deepseek\.com\/share\/[A-Za-z0-9_-]{8,64}$/.test(t)) return true;
  // 裸 share id
  return /^[A-Za-z0-9_-]{8,64}$/.test(t);
}

function fmtTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function DeepSeekShareTool() {
  const [urlInput, setUrlInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ShareExtractResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);
  const [clipHint, setClipHint] = useState(false);
  // 提取历史
  const [history, setHistory] = useState<{ url: string; shareId: string; ts: string; messageCount: number }[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const loadHistory = async () => {
    try {
      const r = await api.shareHistory();
      if (r.ok) setHistory(r.items ?? []);
    } catch {
      // 静默
    }
  };

  /** 清空提取历史 */
  const clearHistory = async () => {
    if (history.length === 0) return;
    if (!window.confirm("确定清空全部提取历史？")) return;
    try {
      await api.shareHistoryClear();
      void loadHistory();
    } catch {
      // 静默
    }
  };

  /** 从历史重新提取 */
  const extractUrl = async (url: string) => {
    setUrlInput(url);
    setErr(null);
    setLoading(true);
    setResult(null);
    setExpanded(new Set());
    try {
      setResult(await api.shareExtract(url));
      void loadHistory();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  /** 从剪贴板读取并自动填入（仅当符合链接格式且输入框为空） */
  const readClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (isShareInput(text) && !urlInput.trim()) {
        setUrlInput(text.trim());
        setClipHint(true);
        setTimeout(() => setClipHint(false), 6000);
      }
    } catch {
      // 剪贴板无权限/不可用（非 https 或未授权）：静默，可手动粘贴
    }
  };

  // 挂载时自动读取剪贴板：符合链接则自动填入
  useEffect(() => {
    void readClipboard();
    void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const extract = async () => {
    const url = urlInput.trim();
    if (!url) {
      setErr("请粘贴 DeepSeek 分享链接或 share id。");
      return;
    }
    setErr(null);
    setLoading(true);
    setResult(null);
    setExpanded(new Set());
    try {
      setResult(await api.shareExtract(url));
      void loadHistory();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  const toggleThinking = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyAll = async () => {
    if (!result || !result.ok) return;
    const text = result.messages
      .map((m) => `${m.role === "user" ? "🧑 用户" : "🤖 DeepSeek"}\n${m.content}`)
      .join("\n\n---\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("复制失败，请手动选择文本复制");
    }
  };

  return (
    <div>
      <PageHeader
        title="🔗 DeepSeek 分析提取"
        desc="输入 DeepSeek 公开分享链接（或 share id），提取完整对话内容（含思考链、时间与 token 用量）。"
      />

      {/* 输入区 */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <input
            style={input}
            placeholder="https://chat.deepseek.com/share/{id}  或直接粘贴 share id"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") extract(); }}
          />
          <button style={{ ...btn, background: "#64748b" }} onClick={() => setUrlInput(EXAMPLE)} type="button">
            填入示例
          </button>
          <button style={{ ...btn, background: "#0891b2" }} onClick={() => void readClipboard()} type="button">
            📋 从剪贴板读取
          </button>
          <button style={btn} onClick={extract} disabled={loading} type="button">
            {loading ? "提取中…" : "📥 提取对话"}
          </button>
        </div>
        {clipHint && (
          <div style={{ color: "#0891b2", fontSize: "0.82rem", marginTop: "0.5rem" }}>
            📋 已检测到剪贴板中的 DeepSeek 分享链接并自动填入，点击「提取对话」即可。
          </div>
        )}

        {/* 提取历史 */}
        {history.length > 0 && (
          <div style={{ marginTop: "0.7rem", borderTop: "1px dashed #e2e8f0", paddingTop: "0.6rem" }}>
            <div
              style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", fontSize: "0.85rem", fontWeight: 600, color: "#334155" }}
              onClick={() => setShowHistory((v) => !v)}
            >
              🕘 提取历史（{history.length}）{showHistory ? " ▾" : " ▸"}
              <span style={{ flex: 1 }} />
              <span
                style={{ fontSize: "0.72rem", color: "#94a3b8", fontWeight: 400, cursor: "pointer", textDecoration: "underline" }}
                onClick={(e) => { e.stopPropagation(); void clearHistory(); }}
              >
                清空
              </span>
            </div>
            {showHistory && (
              <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                {history.map((h) => (
                  <div
                    key={h.url}
                    style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", padding: "0.4rem 0.6rem", border: "1px solid #e2e8f0", borderRadius: 8, background: "#f8fafc", fontSize: "0.8rem", cursor: "pointer" }}
                    onClick={() => void extractUrl(h.url)}
                    title="点击重新提取"
                  >
                    <span style={{ fontFamily: "monospace", color: "#4338ca" }}>{h.shareId}</span>
                    <span style={{ color: "#64748b" }}>{h.messageCount} 条消息</span>
                    <span style={{ color: "#94a3b8", fontSize: "0.72rem" }}>{fmtTime(h.ts)}</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: "0.72rem", color: "#94a3b8" }}>↻ 重提</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 错误 */}
      {err && <ErrorCard>❌ {err}</ErrorCard>}

      {/* 结果 */}
      {result && !result.ok && <ErrorCard>❌ {result.message}</ErrorCard>}

      {result && result.ok && (
        <div>
          {/* 元信息 */}
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, fontSize: "1.05rem" }}>💬 {result.title}</span>
              <button style={{ ...btn, background: "#16a34a", padding: "0.4rem 0.9rem" }} onClick={copyAll} type="button">
                {copied ? "✅ 已复制" : "📋 复制全文"}
              </button>
            </div>
            <div style={{ color: "#94a3b8", fontSize: "0.82rem", marginTop: "0.4rem" }}>
              消息 {result.count} 条 · 总 token {result.totalTokens} · share id：{result.shareId}
            </div>
            <a href={result.url} target="_blank" rel="noreferrer" style={{ fontSize: "0.82rem", color: "#3b82f6" }}>
              {result.url}
            </a>
          </div>

          {/* 消息时间线 */}
          <div style={card}>
            <div style={{ fontWeight: 600, marginBottom: "0.8rem" }}>对话时间线</div>
            {result.messages.map((m) => (
              <MessageBubble
                key={m.id}
                msg={m}
                expanded={expanded.has(m.id)}
                onToggleThinking={() => toggleThinking(m.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg, expanded, onToggleThinking }: {
  msg: ShareMessage;
  expanded: boolean;
  onToggleThinking: () => void;
}) {
  const isUser = msg.role === "user";
  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: "0.7rem" }}>
      <div
        style={{
          maxWidth: "88%",
          background: isUser ? "#3b82f6" : "#f1f5f9",
          color: isUser ? "#fff" : "#0f172a",
          borderRadius: 12,
          padding: "0.6rem 0.9rem",
          fontSize: "0.88rem",
          lineHeight: 1.6,
        }}
      >
        {/* 思考链折叠 */}
        {msg.thinking && (
          <div
            style={{
              marginBottom: "0.4rem",
              border: `1px dashed ${isUser ? "rgba(255,255,255,0.5)" : "#cbd5e1"}`,
              borderRadius: 8,
              padding: "0.35rem 0.6rem",
              fontSize: "0.78rem",
              cursor: "pointer",
            }}
            onClick={onToggleThinking}
            title="点击展开/收起思考链"
          >
            {expanded ? "🧠 思考链（点击收起）" : "🧠 思考链（点击展开）"}
            {expanded && (
              <div
                style={{
                  marginTop: "0.3rem",
                  whiteSpace: "pre-wrap",
                  color: isUser ? "rgba(255,255,255,0.85)" : "#64748b",
                }}
              >
                {msg.thinking}
              </div>
            )}
          </div>
        )}
        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{msg.content}</div>
        <div
          style={{
            marginTop: "0.35rem",
            fontSize: "0.7rem",
            color: isUser ? "rgba(255,255,255,0.7)" : "#94a3b8",
            textAlign: "right",
          }}
        >
          {fmtTime(msg.time)}
          {typeof msg.tokenUsage === "number" ? ` · ${msg.tokenUsage} tokens` : ""}
        </div>
      </div>
    </div>
  );
}
