// ============================================================
// 交易规划（tools/trade-plan）
// 配置区：交易策略（总仓位/交易标的/单日加仓上限/起始持仓）——保护仓位不失控
// 每日变动：输入日度交易计划 → 校验是否符合策略配置与仓位控制 → 提醒与告警
// ============================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  TradePlanAlert,
  TradePlanCheckResult,
  TradePlanConfig,
  TradePlanDay,
  TradePlanItem,
} from "@toolbox/shared";
import { api, errMsg } from "../api";

const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1rem 1.1rem",
  marginBottom: "0.8rem",
};
const input: React.CSSProperties = {
  padding: "0.45rem 0.6rem",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  fontSize: "0.88rem",
  outline: "none",
};
const btn: React.CSSProperties = {
  padding: "0.5rem 1.1rem",
  borderRadius: 9,
  border: "none",
  background: "var(--primary)",
  color: "#fff",
  fontSize: "0.88rem",
  fontWeight: 600,
  cursor: "pointer",
};
const alertColor: Record<TradePlanAlert["level"], string> = {
  error: "#dc2626",
  warn: "#d97706",
  info: "#2563eb",
};
const alertBg: Record<TradePlanAlert["level"], string> = {
  error: "#fef2f2",
  warn: "#fffbeb",
  info: "#eff6ff",
};

export default function TradePlanTool() {
  const [config, setConfig] = useState<TradePlanConfig | null>(null);
  const [cfgMsg, setCfgMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 每日变动
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [items, setItems] = useState<TradePlanItem[]>([]);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<TradePlanCheckResult | null>(null);
  const [dayMsg, setDayMsg] = useState<string | null>(null);

  // 历史
  const [days, setDays] = useState<TradePlanDay[]>([]);
  const [viewDay, setViewDay] = useState<TradePlanDay | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const r = await api.tradePlanConfig();
      setConfig(r.config);
    } catch (e) {
      setCfgMsg("❌ " + errMsg(e));
    }
  }, []);
  const loadDays = useCallback(async () => {
    try {
      const r = await api.tradePlanDays();
      setDays(r.days);
    } catch {
      /* 静默 */
    }
  }, []);

  useEffect(() => {
    void loadConfig();
    void loadDays();
  }, [loadConfig, loadDays]);

  const saveCfg = async () => {
    if (!config) return;
    setSaving(true);
    setCfgMsg(null);
    try {
      const r = await api.tradePlanSaveConfig(config);
      setConfig(r.config);
      setCfgMsg("✅ 策略配置已保存");
    } catch (e) {
      setCfgMsg("❌ " + errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const setStockAt = (i: number, patch: Partial<{ code: string; name: string; maxWeightPct: number }>) => {
    if (!config) return;
    const stocks = config.stocks.slice();
    stocks[i] = { ...stocks[i], ...patch };
    setConfig({ ...config, stocks });
  };
  const setPosAt = (i: number, patch: Partial<{ code: string; shares: number; cost: number }>) => {
    if (!config) return;
    const initialPositions = config.initialPositions.slice();
    initialPositions[i] = { ...initialPositions[i], ...patch };
    setConfig({ ...config, initialPositions });
  };
  const setItemAt = (i: number, patch: Partial<TradePlanItem>) => {
    const next = items.slice();
    next[i] = { ...next[i], ...patch };
    setItems(next);
    setResult(null);
  };

  const runCheck = async (save: boolean) => {
    setChecking(true);
    setDayMsg(null);
    setResult(null);
    try {
      if (save) {
        const r = await api.tradePlanCreateDay(date, items);
        setResult(r.result);
        setDayMsg(r.day ? `✅ 已保存 ${r.day.date} 的日度计划` : r.message ?? "已保存");
        await loadDays();
      } else {
        const r = await api.tradePlanCheck(items);
        setResult(r.result);
        if (r.result.ok) setDayMsg("校验通过，可保存为日度计划");
      }
    } catch (e) {
      setDayMsg("❌ " + errMsg(e));
    } finally {
      setChecking(false);
    }
  };

  const deleteOne = async (id: string) => {
    try {
      await api.tradePlanDeleteDay(id);
      if (viewDay?.id === id) setViewDay(null);
      await loadDays();
    } catch (e) {
      setDayMsg("❌ " + errMsg(e));
    }
  };

  const stockOptions = useMemo(() => config?.stocks ?? [], [config]);
  const displayResult = viewDay?.result ?? result;

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", fontSize: "0.88rem" }}>
      <div style={{ marginBottom: "0.8rem" }}>
        <h2 style={{ margin: "0 0 0.2rem" }}>📋 交易规划</h2>
        <div style={{ color: "#64748b", fontSize: "0.82rem" }}>
          配置交易策略保护仓位不失控；每日输入交易计划，自动校验是否符合策略与仓位控制，给出提醒与告警
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(340px, 1fr) 2fr", gap: "1rem", alignItems: "start" }}>
        {/* 左：策略配置 */}
        <div>
          <div style={card}>
            <div style={{ fontWeight: 700, marginBottom: "0.7rem" }}>⚙️ 策略配置</div>

            <label style={{ display: "block", marginBottom: "0.6rem" }}>
              <span style={{ color: "#475569" }}>总仓位（元）</span>
              <input
                style={{ ...input, width: "100%", marginTop: "0.25rem" }}
                type="number"
                min={0}
                value={config?.totalCapital ?? ""}
                onChange={(e) => setConfig((c) => (c ? { ...c, totalCapital: Number(e.target.value) || 0 } : c))}
                placeholder="如 100000"
              />
            </label>
            <label style={{ display: "block", marginBottom: "0.7rem" }}>
              <span style={{ color: "#475569" }}>单日加仓上限（元）</span>
              <input
                style={{ ...input, width: "100%", marginTop: "0.25rem" }}
                type="number"
                min={0}
                value={config?.dailyAddLimit ?? ""}
                onChange={(e) => setConfig((c) => (c ? { ...c, dailyAddLimit: Number(e.target.value) || 0 } : c))}
                placeholder="如 20000"
              />
            </label>

            <div style={{ fontWeight: 600, color: "#475569", marginBottom: "0.3rem", fontSize: "0.82rem" }}>交易标的（含单标的上限 %，可选）</div>
            {(config?.stocks ?? []).map((s, i) => (
              <div key={i} style={{ display: "flex", gap: "0.35rem", marginBottom: "0.35rem" }}>
                <input style={{ ...input, width: 90 }} placeholder="代码" value={s.code} onChange={(e) => setStockAt(i, { code: e.target.value })} />
                <input style={{ ...input, flex: 1 }} placeholder="名称" value={s.name ?? ""} onChange={(e) => setStockAt(i, { name: e.target.value })} />
                <input
                  style={{ ...input, width: 70 }}
                  type="number"
                  min={0}
                  max={100}
                  placeholder="上限%"
                  value={s.maxWeightPct ?? ""}
                  onChange={(e) => setStockAt(i, { maxWeightPct: Number(e.target.value) || 0 })}
                />
                <button
                  style={{ ...btn, background: "#ef4444", padding: "0.3rem 0.6rem" }}
                  onClick={() => setConfig((c) => (c ? { ...c, stocks: c.stocks.filter((_, j) => j !== i) } : c))}
                  type="button"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              style={{ ...btn, background: "#475569", padding: "0.35rem 0.9rem", fontSize: "0.82rem" }}
              onClick={() => setConfig((c) => (c ? { ...c, stocks: [...c.stocks, { code: "" }] } : c))}
              type="button"
            >
              ＋ 添加标的
            </button>

            <div style={{ fontWeight: 600, color: "#475569", margin: "0.7rem 0 0.3rem", fontSize: "0.82rem" }}>起始持仓（数量 × 成本价）</div>
            {(config?.initialPositions ?? []).map((p, i) => (
              <div key={i} style={{ display: "flex", gap: "0.35rem", marginBottom: "0.35rem" }}>
                <input style={{ ...input, width: 90 }} placeholder="代码" value={p.code} onChange={(e) => setPosAt(i, { code: e.target.value })} />
                <input style={{ ...input, flex: 1 }} type="number" min={0} placeholder="数量" value={p.shares || ""} onChange={(e) => setPosAt(i, { shares: Number(e.target.value) || 0 })} />
                <input style={{ ...input, flex: 1 }} type="number" min={0} placeholder="成本价" value={p.cost || ""} onChange={(e) => setPosAt(i, { cost: Number(e.target.value) || 0 })} />
                <button
                  style={{ ...btn, background: "#ef4444", padding: "0.3rem 0.6rem" }}
                  onClick={() => setConfig((c) => (c ? { ...c, initialPositions: c.initialPositions.filter((_, j) => j !== i) } : c))}
                  type="button"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              style={{ ...btn, background: "#475569", padding: "0.35rem 0.9rem", fontSize: "0.82rem", marginTop: "0.35rem" }}
              onClick={() => setConfig((c) => (c ? { ...c, initialPositions: [...c.initialPositions, { code: "", shares: 0, cost: 0 }] } : c))}
              type="button"
            >
              ＋ 添加持仓
            </button>

            <div style={{ marginTop: "0.8rem", display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <button style={btn} onClick={() => void saveCfg()} disabled={saving} type="button">
                {saving ? "保存中…" : "💾 保存配置"}
              </button>
              {cfgMsg && <span style={{ color: cfgMsg.startsWith("❌") ? "#dc2626" : "#16a34a", fontSize: "0.82rem" }}>{cfgMsg}</span>}
            </div>
          </div>
        </div>

        {/* 右：每日变动 */}
        <div>
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
              <span style={{ fontWeight: 700 }}>📅 日度交易计划</span>
              <input style={{ ...input, width: 140 }} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>

            {(items.length === 0) && (
              <div style={{ color: "#94a3b8", fontSize: "0.82rem", marginBottom: "0.5rem" }}>添加今日的交易操作（加仓 / 减仓）</div>
            )}
            {items.map((it, i) => (
              <div key={i} style={{ display: "flex", gap: "0.35rem", marginBottom: "0.4rem", alignItems: "center" }}>
                <select
                  style={{ ...input, width: 130 }}
                  value={it.code}
                  onChange={(e) => setItemAt(i, { code: e.target.value })}
                >
                  <option value="">选择标的</option>
                  {stockOptions.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name ? `${s.name} ${s.code}` : s.code}
                    </option>
                  ))}
                </select>
                <select style={{ ...input, width: 84 }} value={it.action} onChange={(e) => setItemAt(i, { action: e.target.value as "add" | "reduce" })}>
                  <option value="add">加仓</option>
                  <option value="reduce">减仓</option>
                </select>
                <input
                  style={{ ...input, width: 120 }}
                  type="number"
                  min={0}
                  placeholder="金额（元）"
                  value={it.amount || ""}
                  onChange={(e) => setItemAt(i, { amount: Number(e.target.value) || 0 })}
                />
                <input
                  style={{ ...input, flex: 1, minWidth: 80 }}
                  placeholder="备注（可选）"
                  value={it.note ?? ""}
                  onChange={(e) => setItemAt(i, { note: e.target.value })}
                />
                <button style={{ ...btn, background: "#ef4444", padding: "0.3rem 0.6rem" }} onClick={() => setItems((arr) => arr.filter((_, j) => j !== i))} type="button">
                  ✕
                </button>
              </div>
            ))}
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.4rem" }}>
              <button
                style={{ ...btn, background: "#475569", padding: "0.4rem 0.9rem", fontSize: "0.84rem" }}
                onClick={() => setItems((arr) => [...arr, { code: "", action: "add", amount: 0 }])}
                type="button"
              >
                ＋ 添加操作
              </button>
              <button style={{ ...btn, background: "#0891b2" }} onClick={() => void runCheck(false)} disabled={checking || items.length === 0} type="button">
                {checking ? "分析中…" : "🔍 分析校验"}
              </button>
              <button style={btn} onClick={() => void runCheck(true)} disabled={checking || items.length === 0} type="button">
                💾 保存为日度计划
              </button>
              {dayMsg && <span style={{ color: dayMsg.startsWith("❌") ? "#dc2626" : "#16a34a", fontSize: "0.82rem" }}>{dayMsg}</span>}
            </div>

            {/* 校验结果 */}
            {displayResult && <ResultView result={displayResult} />}
          </div>

          {/* 历史计划 */}
          <div style={card}>
            <div style={{ fontWeight: 700, marginBottom: "0.5rem" }}>🗂️ 历史日度计划</div>
            {days.length === 0 && <div style={{ color: "#94a3b8", fontSize: "0.82rem" }}>暂无记录，保存后自动累积</div>}
            {days.map((d) => (
              <div key={d.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.4rem 0", borderBottom: "1px solid #f1f5f9", flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600 }}>{d.date}</span>
                <span style={{ color: d.result.ok ? "#16a34a" : "#dc2626", fontSize: "0.8rem" }}>
                  {d.result.ok ? "✅ 通过" : `⚠️ ${d.result.alerts.filter((a) => a.level === "error").length} 项告警`}
                </span>
                <span style={{ color: "#64748b", fontSize: "0.78rem" }}>
                  {d.items.map((it) => `${it.code} ${it.action === "add" ? "加" : "减"}${it.amount}`).join("；")}
                </span>
                <span style={{ flex: 1 }} />
                <button style={{ ...btn, background: "#0891b2", padding: "0.25rem 0.6rem", fontSize: "0.76rem" }} onClick={() => setViewDay(viewDay?.id === d.id ? null : d)} type="button">
                  {viewDay?.id === d.id ? "收起" : "查看"}
                </button>
                <button style={{ ...btn, background: "#ef4444", padding: "0.25rem 0.6rem", fontSize: "0.76rem" }} onClick={() => void deleteOne(d.id)} type="button">
                  删除
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultView({ result }: { result: TradePlanCheckResult }) {
  const cny = (v: number) => `¥${Math.round(v).toLocaleString("zh-CN")}`;
  return (
    <div style={{ marginTop: "0.9rem", borderTop: "1px dashed #e2e8f0", paddingTop: "0.8rem" }}>
      {/* 汇总卡 */}
      <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.7rem" }}>
        {[
          { label: "当日加仓", value: cny(result.totals.addTotal) },
          { label: "执行后总市值", value: cny(result.totals.totalMarketValue) },
          { label: "总仓位占比", value: `${result.totals.positionPct.toFixed(1)}%` },
          { label: "剩余可用", value: cny(Math.max(0, result.totals.remaining)) },
        ].map((s) => (
          <div key={s.label} style={{ background: "#f8fafc", border: "1px solid #eef2f7", borderRadius: 8, padding: "0.4rem 0.8rem" }}>
            <div style={{ fontSize: "0.7rem", color: "#64748b" }}>{s.label}</div>
            <div style={{ fontSize: "0.95rem", fontWeight: 700, color: "#1e293b" }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* 告警列表 */}
      {result.alerts.map((a, i) => (
        <div
          key={i}
          style={{
            background: alertBg[a.level],
            border: `1px solid ${alertColor[a.level]}33`,
            borderLeft: `3px solid ${alertColor[a.level]}`,
            borderRadius: 6,
            padding: "0.4rem 0.6rem",
            marginBottom: "0.35rem",
            fontSize: "0.83rem",
          }}
        >
          <span style={{ color: alertColor[a.level], fontWeight: 600 }}>
            {a.level === "error" ? "⛔" : a.level === "warn" ? "⚠️" : "ℹ️"} {a.message}
          </span>
          {a.detail && <div style={{ color: "#64748b", fontSize: "0.78rem", marginTop: "0.15rem" }}>{a.detail}</div>}
        </div>
      ))}

      {/* 执行后仓位表 */}
      {result.after.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.5rem", fontSize: "0.8rem" }}>
          <thead>
            <tr>
              {["标的", "持仓市值", "占比", "份额", "成本", "本次加仓"].map((h) => (
                <th key={h} style={{ textAlign: "left", color: "#64748b", borderBottom: "1px solid #e2e8f0", padding: "0.3rem 0.4rem" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.after.map((p) => (
              <tr key={p.code}>
                <td style={{ padding: "0.3rem 0.4rem", fontWeight: 600 }}>{p.name ? `${p.name} ${p.code}` : p.code}</td>
                <td style={{ padding: "0.3rem 0.4rem" }}>{cny(p.marketValue)}</td>
                <td style={{ padding: "0.3rem 0.4rem" }}>{p.weightPct.toFixed(1)}%</td>
                <td style={{ padding: "0.3rem 0.4rem" }}>{p.shares.toLocaleString("zh-CN")}</td>
                <td style={{ padding: "0.3rem 0.4rem" }}>{p.avgCost > 0 ? p.avgCost.toFixed(2) : "—"}</td>
                <td style={{ padding: "0.3rem 0.4rem" }}>{p.addAmount > 0 ? cny(p.addAmount) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
