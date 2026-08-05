import { useEffect, useState, type CSSProperties } from "react";
import { api, errMsg } from "../api";
import { PageHeader } from "../ui";
import type { LlmBalanceResult, LlmStatusResponse, LlmTestResult, LlmUsageSummary } from "@toolbox/shared";

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

export default function LlmSettings() {
  const [status, setStatus] = useState<LlmStatusResponse | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LlmTestResult | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // 对话验证
  const [prompt, setPrompt] = useState("");
  const [chatting, setChatting] = useState(false);
  const [chatReply, setChatReply] = useState<string | null>(null);
  const [chatUsage, setChatUsage] = useState<string | null>(null);
  // 用量监控 + 平台余额
  const [usage, setUsage] = useState<LlmUsageSummary | null>(null);
  const [balance, setBalance] = useState<LlmBalanceResult | null>(null);

  const refreshUsage = async () => {
    try {
      setUsage(await api.llmUsage());
    } catch {
      // 静默
    }
    try {
      setBalance(await api.llmBalance());
    } catch {
      setBalance({ ok: false, message: "余额查询失败" });
    }
  };

  const refreshStatus = async () => {
    try {
      setStatus(await api.llmStatus());
    } catch (e) {
      // 状态查询失败：显示错误（不静默吞掉）
      setMsg({ kind: "err", text: errMsg(e) });
      setStatus(null);
    }
  };

  useEffect(() => {
    void refreshStatus();
    void refreshUsage();
  }, []);

  const saveKey = async () => {
    const key = keyInput.trim();
    if (!key) {
      setMsg({ kind: "err", text: "请输入 DeepSeek API key" });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      await api.llmSettings({ apiKey: key });
      setKeyInput("");
      setMsg({ kind: "ok", text: "✅ API key 已保存到服务端本地设置库（SQLite，已 gitignore）" });
      await refreshStatus();
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api.llmSettings({ apiKey: "" });
      setMsg({ kind: "ok", text: "已清除 API key" });
      await refreshStatus();
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    setMsg(null);
    try {
      setTestResult(await api.llmTest());
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    } finally {
      setTesting(false);
    }
  };

  const sendChat = async () => {
    const text = prompt.trim();
    if (!text) {
      setMsg({ kind: "err", text: "请输入对话内容" });
      return;
    }
    setChatting(true);
    setChatReply(null);
    setChatUsage(null);
    setMsg(null);
    try {
      const r = await api.llmChat({ messages: [{ role: "user", content: text }] });
      if (r.ok) {
        setChatReply(r.content);
        if (r.usage) {
          setChatUsage(`tokens：prompt ${r.usage.promptTokens} / completion ${r.usage.completionTokens} / total ${r.usage.totalTokens}（模型 ${r.model}）`);
        } else {
          setChatUsage(`模型：${r.model}`);
        }
      } else {
        setMsg({ kind: "err", text: r.message });
      }
    } catch (e) {
      setMsg({ kind: "err", text: errMsg(e) });
    } finally {
      setChatting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="🤖 LLM 设置（DeepSeek）"
        desc="网站公共 LLM 能力模块：配置 DeepSeek API key，供各工具复用（对话 / 测试 / 后续扩展）。"
      />

      {/* 状态 */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.8rem" }}>
          <span style={{ fontWeight: 600 }}>当前状态：</span>
          {status === null ? (
            <span style={{ color: "#94a3b8" }}>查询中…</span>
          ) : status.configured ? (
            <span style={{ background: "#ecfdf5", color: "#047857", padding: "0.25rem 0.7rem", borderRadius: 999, fontWeight: 600 }}>
              ✅ 已配置（模型：{status.model ?? "deepseek-chat"}）
            </span>
          ) : (
            <span style={{ background: "#fef2f2", color: "#b91c1c", padding: "0.25rem 0.7rem", borderRadius: 999, fontWeight: 600 }}>
              ❌ 未配置 API key
            </span>
          )}
          <button style={{ ...btn, background: "#64748b", padding: "0.4rem 0.9rem" }} onClick={refreshStatus} type="button">
            刷新
          </button>
        </div>
      </div>

      {/* API key 配置 */}
      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: "0.6rem" }}>DeepSeek API 私钥</div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <input
            style={input}
            type={showKey ? "text" : "password"}
            placeholder="sk-…（https://platform.deepseek.com 获取）"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <button style={{ ...btn, background: "#64748b" }} onClick={() => setShowKey((v) => !v)} type="button">
            {showKey ? "🙈 隐藏" : "👁 显示"}
          </button>
          <button style={btn} onClick={saveKey} disabled={saving} type="button">
            {saving ? "保存中…" : "💾 保存"}
          </button>
          <button style={{ ...btn, background: "#dc2626" }} onClick={clearKey} disabled={saving} type="button">
            清除
          </button>
        </div>
        <div style={{ color: "#94a3b8", fontSize: "0.78rem", marginTop: "0.5rem" }}>
          🔒 key 仅保存在服务端本地设置库（SQLite .file/ 目录，已 gitignore），不存浏览器，不会出现在前端代码中。
        </div>
      </div>

      {/* 测试连接 */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", flexWrap: "wrap" }}>
          <button style={{ ...btn, background: "#0891b2" }} onClick={runTest} disabled={testing || !status?.configured} type="button">
            {testing ? "测试中…" : "🔌 测试连接"}
          </button>          {testResult && (
            testResult.ok ? (
              <span style={{ color: "#16a34a", fontSize: "0.9rem" }}>✅ {testResult.message}（{testResult.latencyMs}ms）</span>
            ) : (
              <span style={{ color: "#dc2626", fontSize: "0.9rem" }}>❌ {testResult.message}</span>
            )
          )}
        </div>
      </div>

      {/* 对话验证 */}
      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: "0.6rem" }}>💬 对话验证（公共 chat 能力）</div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <input
            style={input}
            placeholder="输入问题，如：用一句话介绍 DeepSeek"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }}
          />
          <button style={{ ...btn, background: "#16a34a" }} onClick={sendChat} disabled={chatting || !status?.configured} type="button">
            {chatting ? "思考中…" : "发送"}
          </button>
        </div>
        {chatReply !== null && (
          <div
            style={{
              marginTop: "0.8rem",
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              padding: "0.8rem 1rem",
              whiteSpace: "pre-wrap",
              fontSize: "0.9rem",
              lineHeight: 1.6,
            }}
          >
            {chatReply}
            {chatUsage && <div style={{ color: "#94a3b8", fontSize: "0.75rem", marginTop: "0.5rem" }}>{chatUsage}</div>}
          </div>
        )}
      </div>

      {/* 消息 */}
      {msg && (
        <div
          style={{
            ...card,
            borderColor: msg.kind === "ok" ? "#86efac" : "#fca5a5",
            background: msg.kind === "ok" ? "#f0fdf4" : "#fef2f2",
            color: msg.kind === "ok" ? "#15803d" : "#b91c1c",
          }}
        >
          {msg.text}
        </div>
      )}

      {/* 用量监控 + 平台余额 */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.6rem", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: "1rem" }}>📊 LLM 用量监控</span>
          <button style={{ ...btn, background: "#64748b", padding: "0.3rem 0.8rem", fontSize: "0.8rem" }} onClick={refreshUsage} type="button">
            ⟳ 刷新
          </button>
        </div>

        {/* 平台余额 */}
        <div style={{ marginBottom: "0.7rem", padding: "0.6rem 0.8rem", background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: "0.85rem" }}>
          <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>💰 DeepSeek 平台余额（platform.deepseek.com/usage）</div>
          {balance === null ? (
            <span style={{ color: "#94a3b8" }}>加载中…</span>
          ) : balance.ok ? (
            <div>
              {(balance.balance ?? []).map((b) => (
                <div key={b.currency} style={{ display: "flex", gap: "1.2rem", flexWrap: "wrap" }}>
                  <span><b>{b.currency}</b> 总余额 <b>{b.totalBalance}</b></span>
                  <span style={{ color: "#64748b" }}>充值 {b.toppedUpBalance} · 赠送 {b.grantedBalance}</span>
                  <span style={{ color: balance.isAvailable ? "#15803d" : "#b91c1c" }}>
                    {balance.isAvailable ? "✓ 可用" : "✗ 不可用"}
                  </span>
                </div>
              ))}
              {(balance.balance ?? []).length === 0 && <span style={{ color: "#94a3b8" }}>无余额信息</span>}
            </div>
          ) : (
            <span style={{ color: "#b91c1c" }}>{balance.message}</span>
          )}
        </div>

        {/* 本地用量汇总 */}
        <div style={{ fontSize: "0.85rem" }}>
          <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", marginBottom: "0.5rem", color: "#334155" }}>
            <span>总调用 <b>{usage?.total.calls ?? 0}</b> 次</span>
            <span>输入 <b>{((usage?.total.promptTokens ?? 0) / 1000).toFixed(1)}k</b> tokens</span>
            <span>输出 <b>{((usage?.total.completionTokens ?? 0) / 1000).toFixed(1)}k</b> tokens</span>
            <span>合计 <b>{((usage?.total.totalTokens ?? 0) / 1000).toFixed(1)}k</b> tokens</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.8rem" }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: "0.3rem", color: "#64748b", fontSize: "0.78rem" }}>按模块</div>
              {usage?.byModule.length ? (
                usage.byModule.map((m) => (
                  <div key={m.module} style={{ display: "flex", justifyContent: "space-between", padding: "0.18rem 0", borderBottom: "1px solid #f1f5f9" }}>
                    <span>{m.module}</span>
                    <span style={{ color: "#64748b" }}>{m.calls} 次 · {((m.totalTokens / 1000).toFixed(1))}k</span>
                  </div>
                ))
              ) : (
                <span style={{ color: "#94a3b8", fontSize: "0.8rem" }}>暂无记录（LLM 调用后自动累积）</span>
              )}
            </div>
            <div>
              <div style={{ fontWeight: 600, marginBottom: "0.3rem", color: "#64748b", fontSize: "0.78rem" }}>按天</div>
              {usage?.byDay.length ? (
                usage.byDay.map((d) => (
                  <div key={d.day} style={{ display: "flex", justifyContent: "space-between", padding: "0.18rem 0", borderBottom: "1px solid #f1f5f9" }}>
                    <span>{d.day}</span>
                    <span style={{ color: "#64748b" }}>{d.calls} 次 · {((d.totalTokens / 1000).toFixed(1))}k</span>
                  </div>
                ))
              ) : (
                <span style={{ color: "#94a3b8", fontSize: "0.8rem" }}>暂无记录</span>
              )}
            </div>
          </div>
          <div style={{ color: "#94a3b8", fontSize: "0.75rem", marginTop: "0.5rem" }}>
            ℹ️ 用量由服务端切面记录（每次 LLM 调用的 token 数，按模块归属），存于本地数据管理（llmUsage:log）。platform.deepseek.com/usage 网页明细需登录，本页展示本地统计 + 平台余额（API key 授权）。
          </div>
        </div>
      </div>
    </div>
  );
}
