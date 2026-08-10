import { useEffect, useState, type CSSProperties } from "react";
import { api, errMsg } from "../api";
import { PageHeader } from "../ui";
import { DailyTokensBar, DayModulePie } from "../components/UsageCharts";
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
  // 用量监控 + 平台余额
  const [usage, setUsage] = useState<LlmUsageSummary | null>(null);
  const [balance, setBalance] = useState<LlmBalanceResult | null>(null);
  // 单日扇形图：选中日期（默认最新一天）
  const [pieDay, setPieDay] = useState<string>("");
  // 单日扇形图：按用量 / 按费用切换
  const [pieMode, setPieMode] = useState<"tokens" | "cost">("tokens");

  const refreshUsage = async () => {
    try {
      const u = await api.llmUsage();
      setUsage(u);
      // 默认选中最新一天（byDay 倒序）
      setPieDay((prev) => prev || (u.byDay[0]?.day ?? ""));
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
    setTestResult(null);
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
    setTestResult(null);
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

  return (
    <div>
      <PageHeader
        title="🤖 LLM 用量（DeepSeek）"
        desc="网站公共 LLM 能力模块：私钥配置 + 用量管理。配置 DeepSeek API key 后，各工具（央行利率分析 / 国债汇率分析 / 专题自选股等）自动复用。"
      />

      {/* ============ 模块一：私钥配置 ============ */}
      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: "0.6rem", fontSize: "1rem" }}>🔑 私钥配置</div>

        {/* 状态 */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", marginBottom: "0.8rem", flexWrap: "wrap" }}>
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

        {/* API key 输入行：输入框 + 显示/隐藏 + 保存 + 清除 + 测试连接（并列） */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <input
            style={input}
            type={showKey ? "text" : "password"}
            placeholder="sk-…（https://platform.deepseek.com 获取）"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <button style={{ ...btn, background: "#64748b", padding: "0.5rem 0.9rem" }} onClick={() => setShowKey((v) => !v)} type="button">
            {showKey ? "🙈 隐藏" : "👁 显示"}
          </button>
          <button style={btn} onClick={saveKey} disabled={saving} type="button">
            {saving ? "保存中…" : "💾 保存"}
          </button>
          <button style={{ ...btn, background: "#dc2626" }} onClick={clearKey} disabled={saving} type="button">
            清除
          </button>
          <button
            style={{ ...btn, background: "#0891b2" }}
            onClick={runTest}
            disabled={testing || !status?.configured}
            title={status?.configured ? "用已保存的 key 测试 DeepSeek 连接" : "请先保存 API key"}
            type="button"
          >
            {testing ? "测试中…" : "🔌 测试连接"}
          </button>
        </div>

        {/* 测试结果内联 */}
        {testResult && (
          <div style={{ marginTop: "0.6rem", fontSize: "0.9rem" }}>
            {testResult.ok ? (
              <span style={{ color: "#16a34a" }}>✅ {testResult.message}（{testResult.latencyMs}ms）</span>
            ) : (
              <span style={{ color: "#dc2626" }}>❌ {testResult.message}</span>
            )}
          </div>
        )}

        <div style={{ color: "#94a3b8", fontSize: "0.78rem", marginTop: "0.6rem" }}>
          🔒 key 仅保存在服务端本地设置库（SQLite .file/ 目录，已 gitignore），不存浏览器，不会出现在前端代码中。测试连接使用已保存的 key。
        </div>
      </div>

      {/* ============ 模块二：用量管理 ============ */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.6rem", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: "1rem" }}>📊 用量管理</span>
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
              <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: "1.2rem", flexWrap: "wrap" }}>
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
                <a
                  href="https://platform.deepseek.com/top_up"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ ...btn, background: "#f59e0b", textDecoration: "none", display: "inline-block" }}
                >
                  💳 去充值
                </a>
              </div>
            </div>
          ) : (
            <span style={{ color: "#b91c1c" }}>{balance.message}</span>
          )}
        </div>

        {/* 关键指标卡（放在图表前，避免被扇形图遮挡） */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "0.7rem", marginBottom: "0.9rem" }}>
          {[
            { label: "总调用", value: `${usage?.total.calls ?? 0}`, unit: "次" },
            { label: "输入", value: ((usage?.total.promptTokens ?? 0) / 1000).toFixed(1), unit: "k tokens" },
            { label: "输出", value: ((usage?.total.completionTokens ?? 0) / 1000).toFixed(1), unit: "k tokens" },
            { label: "合计", value: ((usage?.total.totalTokens ?? 0) / 1000).toFixed(1), unit: "k tokens" },
            { label: "缓存命中", value: ((usage?.total.cacheRate ?? 0) * 100).toFixed(1), unit: "%", sub: `${((usage?.total.cacheHitTokens ?? 0) / 1000).toFixed(1)}k / ${((usage?.total.cacheMissTokens ?? 0) / 1000).toFixed(1)}k 输入` },
            { label: "估算费用", value: `¥${(usage?.total.costCny ?? 0).toFixed(2)}`, unit: "≈", sub: `$${(usage?.total.costUsd ?? 0).toFixed(2)} · 按公开价近似` },
          ].map((s) => (
            <div key={s.label} style={{ background: "#f8fafc", border: "1px solid #eef2f7", borderRadius: 10, padding: "0.6rem 0.85rem" }}>
              <div style={{ fontSize: "0.72rem", color: "#64748b", fontWeight: 500 }}>{s.label}</div>
              <div style={{ fontSize: "1.25rem", fontWeight: 800, color: "#1e293b", lineHeight: 1.3 }}>
                {s.value}
                <span style={{ fontSize: "0.75rem", fontWeight: 500, color: "#94a3b8", marginLeft: "0.25rem" }}>{s.unit}</span>
              </div>
              {"sub" in s && s.sub && <div style={{ fontSize: "0.68rem", color: "#94a3b8" }}>{s.sub}</div>}
            </div>
          ))}
        </div>

        {/* 图表：逐日条形图 + 单日扇形图 */}
        {(usage?.byDay.length ?? 0) > 0 && (
          <div style={{ marginBottom: "0.7rem", padding: "0.6rem 0.8rem", background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }}>
            <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "#64748b", marginBottom: "0.4rem" }}>📈 逐日用量（tokens）</div>
            <DailyTokensBar byDay={usage?.byDay ?? []} />
            <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "#64748b", margin: "0.8rem 0 0.4rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              🥧 单日构成
              <select
                style={{ padding: "0.25rem 0.5rem", borderRadius: 6, border: "1px solid #cbd5e1", fontSize: "0.8rem", background: "#fff" }}
                value={pieDay}
                onChange={(e) => setPieDay(e.target.value)}
              >
                {(usage?.byDay ?? []).map((d) => (
                  <option key={d.day} value={d.day}>
                    {d.day}（{d.calls} 次 · {((d.totalTokens / 1000).toFixed(1))}k tokens）
                  </option>
                ))}
              </select>
              <span style={{ display: "inline-flex", gap: "0.3rem", marginLeft: "0.4rem" }}>
                {([["tokens", "按用量"], ["cost", "按费用"]] as const).map(([v, l]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setPieMode(v)}
                    style={{
                      padding: "0.2rem 0.6rem",
                      borderRadius: 6,
                      border: `1px solid ${pieMode === v ? "#2563eb" : "#cbd5e1"}`,
                      background: pieMode === v ? "#eff6ff" : "#fff",
                      color: pieMode === v ? "#2563eb" : "#64748b",
                      fontSize: "0.75rem",
                      fontWeight: pieMode === v ? 600 : 400,
                      cursor: "pointer",
                    }}
                  >
                    {l}
                  </button>
                ))}
              </span>
            </div>
            <DayModulePie
              mode={pieMode}
              byModule={usage?.byDay.find((d) => d.day === pieDay)?.byModule ?? []}
            />
          </div>
        )}

        {/* 本地用量汇总 */}
        <div style={{ fontSize: "0.85rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.8rem" }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: "0.3rem", color: "#64748b", fontSize: "0.78rem" }}>按调用模式</div>
              {usage?.total.byMode.length ? (
                usage.total.byMode.map((m) => (
                  <div key={m.mode} style={{ display: "flex", justifyContent: "space-between", padding: "0.18rem 0", borderBottom: "1px solid #f1f5f9" }}>
                    <span>{m.label}</span>
                    <span style={{ color: "#64748b" }}>
                      {m.calls} 次 · {((m.totalTokens / 1000).toFixed(1))}k · 缓存 {(m.cacheRate * 100).toFixed(0)}%
                    </span>
                  </div>
                ))
              ) : (
                <span style={{ color: "#94a3b8", fontSize: "0.8rem" }}>暂无记录</span>
              )}
            </div>
            <div>
              <div style={{ fontWeight: 600, marginBottom: "0.3rem", color: "#64748b", fontSize: "0.78rem" }}>按模块（按场景分组）</div>
              {usage?.byModule.length ? (
                (["business", "system", "test"] as const)
                  .map((sc) => ({
                    sc,
                    label: usage.total.byScene.find((x) => x.scene === sc)?.label ?? (sc === "business" ? "业务场景" : sc === "system" ? "系统工具" : "测试"),
                    items: usage.byModule.filter((m) => m.scene === sc),
                  }))
                  .filter((g) => g.items.length > 0)
                  .map((g) => (
                    <details key={g.sc} open={g.sc === "business"} style={{ marginBottom: "0.35rem" }}>
                      <summary style={{ cursor: "pointer", color: g.sc === "business" ? "#1d4ed8" : "#64748b", fontSize: "0.8rem", fontWeight: 600 }}>
                        {g.sc === "test" ? "🧪" : g.sc === "system" ? "⚙️" : "📊"} {g.label}（{g.items.reduce((a, x) => a + x.calls, 0)} 次）
                      </summary>
                      <div style={{ marginTop: "0.2rem" }}>
                        {g.items.map((m) => (
                          <div key={m.module} style={{ display: "flex", justifyContent: "space-between", padding: "0.18rem 0", borderBottom: "1px solid #f1f5f9" }}>
                            <span>{m.label}</span>
                            <span style={{ color: "#64748b" }}>
                              {m.calls} 次 · {((m.totalTokens / 1000).toFixed(1))}k · 缓存 {(m.cacheRate * 100).toFixed(0)}%
                            </span>
                          </div>
                        ))}
                      </div>
                    </details>
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
            <br />⚡ 缓存命中：DeepSeek 前缀缓存自动生效（相同前缀完整匹配即命中），命中输入 token 价格约为未命中的 1/50（v4-flash）。服务端已做「前缀稳定化」——固定指令/系统提示词保持逐字稳定，动态内容（日期/标的/月份）追加到用户消息，以提升命中率降低成本。
          </div>
        </div>
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
    </div>
  );
}
