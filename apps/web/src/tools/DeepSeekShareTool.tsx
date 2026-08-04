import { useState, type CSSProperties } from "react";
import { api } from "../api";
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
    } catch (e) {
      setErr(String(e));
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
      <h1 style={{ marginTop: 0 }}>🔗 DeepSeek Share 提取</h1>
      <p style={{ color: "#666", marginTop: "-0.4rem" }}>
        输入 DeepSeek 公开分享链接（或 share id），提取完整对话内容（含思考链、时间与 token 用量）。
      </p>

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
          <button style={btn} onClick={extract} disabled={loading} type="button">
            {loading ? "提取中…" : "📥 提取对话"}
          </button>
        </div>
      </div>

      {/* 错误 */}
      {err && (
        <div style={{ ...card, borderColor: "#fca5a5", background: "#fef2f2", color: "#b91c1c" }}>
          ❌ {err}
        </div>
      )}

      {/* 结果 */}
      {result && !result.ok && (
        <div style={{ ...card, borderColor: "#fca5a5", background: "#fef2f2", color: "#b91c1c" }}>
          ❌ {result.message}
        </div>
      )}

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
