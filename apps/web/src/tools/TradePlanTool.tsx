// ============================================================
// 交易规划（tools/trade-plan）
// 多策略：每策略独立配置（总仓位/交易标的/单日加仓上限/起始持仓）+ 日度交易计划校验。
// 标的输入支持名称搜索补全（复用专题自选股 search-stock）。
// ============================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  TradePlanAlert,
  TradePlanCheckResult,
  TradePlanItem,
  TradePlanStrategy,
  TradePlanStrategySummary,
  TradePlanDay,
} from "@toolbox/shared";
import { api, errMsg } from "../api";

const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1rem 1.1rem",
  marginBottom: "0.8rem",
  boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
};
const input: React.CSSProperties = {
  padding: "0.5rem 0.65rem",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  fontSize: "0.88rem",
  outline: "none",
  background: "#fff",
  transition: "border-color 0.15s",
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
const btnGhost: React.CSSProperties = {
  ...btn,
  background: "#f1f5f9",
  color: "#475569",
  fontWeight: 500,
};
const alertColor: Record<TradePlanAlert["level"], string> = { error: "#dc2626", warn: "#d97706", info: "#2563eb" };
const alertBg: Record<TradePlanAlert["level"], string> = { error: "#fef2f2", warn: "#fffbeb", info: "#eff6ff" };
const cny = (v: number) => `¥${Math.round(v).toLocaleString("zh-CN")}`;

export default function TradePlanTool() {
  const [strategies, setStrategies] = useState<TradePlanStrategySummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [strategy, setStrategy] = useState<TradePlanStrategy | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const [date, setDate] = useState(() => {
    // 默认下一个交易日：周六/周日 → 下周一
    const n = new Date();
    const d = n.getDay();
    if (d === 0) n.setDate(n.getDate() + 1);
    else if (d === 6) n.setDate(n.getDate() + 2);
    return n.toISOString().slice(0, 10);
  });
  const [items, setItems] = useState<TradePlanItem[]>([]);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<TradePlanCheckResult | null>(null);
  const [dayMsg, setDayMsg] = useState<string | null>(null);
  const [days, setDays] = useState<TradePlanDay[]>([]);
  const [viewDay, setViewDay] = useState<TradePlanDay | null>(null);
  const [calView, setCalView] = useState(false);
  const [allCalOpen, setAllCalOpen] = useState(false);

  const loadStrategies = useCallback(async () => {
    setListLoading(true);
    try {
      const r = await api.tradePlanStrategies();
      setStrategies(r.strategies);
      setSelectedId((prev) => (prev && r.strategies.some((s) => s.id === prev) ? prev : r.strategies[0]?.id ?? ""));
    } catch (e) {
      setMsg("❌ 策略列表加载失败：" + errMsg(e));
    } finally {
      setListLoading(false);
    }
  }, []);

  // 挂载：加载策略列表（缺失此 effect 会导致列表卡"加载中"——历史教训）
  useEffect(() => {
    void loadStrategies();
  }, [loadStrategies]);

  // 选中策略变化 → 加载完整详情
  useEffect(() => {
    if (!selectedId) return;
    void api.tradePlanStrategy(selectedId).then((r) => {
      if (r.ok && r.strategy) setStrategy(r.strategy);
      setResult(null);
      setViewDay(null);
      setItems([]);
      void loadDays(selectedId);
    }).catch(() => {});
  }, [selectedId]);

  const loadDays = useCallback(async (sid: string) => {
    try {
      const r = await api.tradePlanDays(sid);
      setDays(r.days);
    } catch { /* 静默 */ }
  }, []);

  const saveCfg = async () => {
    if (!strategy) return;
    // 上限% 校验：0-100
    const bad = strategy.stocks.find((s) => s.maxWeightPct !== undefined && (s.maxWeightPct < 0 || s.maxWeightPct > 100));
    if (bad) {
      setMsg(`❌ 标的 ${bad.code || "（未填代码）"} 的仓位上限需在 0-100% 之间`);
      return;
    }
    // 起始数量以 100 为最小单位（A股一手）
    const badShares = strategy.stocks.find((s) => s.initShares && s.initShares > 0 && s.initShares % 100 !== 0);
    if (badShares) {
      setMsg(`❌ 标的 ${badShares.code || "（未填代码）"} 的起始数量需为 100 的整数倍（A股一手 100 股）`);
      return;
    }
    setMsg(null);
    try {
      const r = await api.tradePlanSaveStrategy(strategy.id, strategy);
      if (r.ok && r.strategy) setStrategy(r.strategy);
      setMsg("✅ 策略配置已保存");
      await loadStrategies();
    } catch (e) {
      setMsg("❌ " + errMsg(e));
    }
  };

  const createSt = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const r = await api.tradePlanCreateStrategy(name);
      setNewName("");
      if (r.ok && r.strategy) setSelectedId(r.strategy.id);
      await loadStrategies();
    } catch (e) {
      setMsg("❌ " + errMsg(e));
    } finally {
      setCreating(false);
    }
  };

  const deleteSt = async (id: string, name: string) => {
    if (!confirm(`确定删除策略「${name}」？该策略的全部日度计划将一并删除。`)) return;
    try {
      await api.tradePlanDeleteStrategy(id);
      setSelectedId("");
      await loadStrategies();
    } catch (e) {
      setMsg("❌ " + errMsg(e));
    }
  };

  const setStockAt = (i: number, patch: Partial<{ code: string; name: string; maxWeightPct: number; initShares: number; initCost: number }>) => {
    if (!strategy) return;
    const stocks = strategy.stocks.slice();
    stocks[i] = { ...stocks[i], ...patch };
    setStrategy({ ...strategy, stocks });
  };
  const setItemAt = (i: number, patch: Partial<TradePlanItem>) => {
    const next = items.slice();
    next[i] = { ...next[i], ...patch };
    setItems(next);
    setResult(null);
    scheduleAutoCheck(next);
  };

  // #1 自动校验：条目变化后防抖 600ms 自动分析（无需手动触发）
  const autoCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAutoCheck = (list: TradePlanItem[]) => {
    if (autoCheckTimer.current) clearTimeout(autoCheckTimer.current);
    if (list.length === 0 || list.some((it) => !it.code || !it.amount)) return; // 条目不完整不自动
    autoCheckTimer.current = setTimeout(() => {
      void runCheck(false);
    }, 600);
  };

  const runCheck = async (save: boolean) => {
    if (!strategy) return;
    setChecking(true);
    setDayMsg(null);
    setResult(null);
    try {
      if (save) {
        const r = await api.tradePlanCreateDay(strategy.id, date, items);
        setResult(r.result);
        setDayMsg(r.day ? `✅ 已保存 ${r.day.date} 的日度计划` : r.message ?? "已保存");
        await loadDays(strategy.id);
      } else {
        const r = await api.tradePlanCheck(strategy.id, items);
        setResult(r.result);
        if (r.result.ok) setDayMsg("校验通过，可保存为日度计划");
      }
    } catch (e) {
      setDayMsg("❌ " + errMsg(e));
    } finally {
      setChecking(false);
    }
  };

  const deleteOne = async (dayId: string) => {
    if (!strategy) return;
    try {
      await api.tradePlanDeleteDay(strategy.id, dayId);
      if (viewDay?.id === dayId) setViewDay(null);
      await loadDays(strategy.id);
    } catch (e) {
      setDayMsg("❌ " + errMsg(e));
    }
  };

  const stockOptions = useMemo(() => strategy?.stocks ?? [], [strategy]);
  const displayResult = viewDay?.result ?? result;
  const isDirty = (strategy?.stocks ?? []).some((s) => s.code) || strategy?.totalCapital !== undefined;

  return (
    <div style={{ maxWidth: 1240, margin: "0 auto", fontSize: "0.88rem" }}>
      <div style={{ marginBottom: "0.8rem" }}>
        <h2 style={{ margin: "0 0 0.2rem" }}>📋 策略仓位管理</h2>
        <div style={{ color: "#64748b", fontSize: "0.82rem" }}>
          多策略管理：配置策略保护仓位不失控；每日输入交易计划，自动校验是否符合策略与仓位控制
        </div>
      </div>
      {msg && (
        <div style={{ marginBottom: "0.6rem", padding: "0.5rem 0.8rem", borderRadius: 8, background: msg.startsWith("❌") ? "#fef2f2" : "#ecfdf5", border: `1px solid ${msg.startsWith("❌") ? "#fca5a5" : "#6ee7b7"}`, color: msg.startsWith("❌") ? "#b91c1c" : "#047857", fontSize: "0.84rem" }}>
          {msg}
        </div>
      )}

      {/* #1 全部策略总计划日历（跨策略） */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ fontWeight: 700 }}>📅 全部策略总计划</span>
          <button
            style={{ ...btnGhost, padding: "0.3rem 0.8rem", fontSize: "0.8rem" }}
            onClick={() => setAllCalOpen((v) => !v)}
            type="button"
          >
            {allCalOpen ? "收起" : "展开"}
          </button>
          <span style={{ fontSize: "0.78rem", color: "#94a3b8" }}>跨策略查看每天的交易计划</span>
        </div>
        {allCalOpen && <AllCalendar />}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: "1rem", alignItems: "start" }}>
        {/* 左：策略列表 */}
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: "0.6rem" }}>📁 策略仓位列表</div>
          <div style={{ display: "flex", gap: "0.35rem", marginBottom: "0.6rem" }}>
            <input
              style={{ ...input, flex: 1, minWidth: 0 }}
              placeholder="新策略名称"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void createSt(); }}
            />
            <button style={{ ...btn, padding: "0.5rem 0.8rem" }} onClick={() => void createSt()} disabled={creating || !newName.trim()} type="button">
              ＋
            </button>
          </div>
          {listLoading && <div style={{ color: "#94a3b8", fontSize: "0.82rem" }}>加载中…</div>}
          {!listLoading && strategies.length === 0 && <div style={{ color: "#94a3b8", fontSize: "0.82rem" }}>暂无策略，先新建一个</div>}
          {strategies.map((s) => (
            <div
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              style={{
                padding: "0.55rem 0.7rem",
                borderRadius: 10,
                border: `1.5px solid ${selectedId === s.id ? "var(--primary)" : "#e2e8f0"}`,
                background: selectedId === s.id ? "var(--primary-soft)" : "#fff",
                cursor: "pointer",
                marginBottom: "0.4rem",
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: "0.9rem", color: selectedId === s.id ? "var(--primary)" : "#1e293b" }}>{s.name}</div>
                <div style={{ fontSize: "0.74rem", color: "#64748b" }}>
                  仓位 {cny(s.totalCapital)} · {s.stockCount} 标的 · {s.dayCount} 计划
                </div>
              </div>
              <button
                style={{ ...btn, background: "transparent", color: "#94a3b8", padding: "0.2rem 0.4rem", fontSize: "0.85rem" }}
                onClick={(e) => { e.stopPropagation(); void deleteSt(s.id, s.name); }}
                title="删除策略"
                type="button"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        {/* 右：选中策略 */}
        <div>
          {!strategy ? (
            <div style={card}>
              <div style={{ color: "#94a3b8", textAlign: "center", padding: "2rem 0" }}>请选择或新建一个策略</div>
            </div>
          ) : (
            <>
              {/* 策略配置 */}
              <div style={card}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.8rem", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>⚙️ 策略仓位配置</span>
                  <input
                    style={{ ...input, width: 160, fontWeight: 700 }}
                    value={strategy.name}
                    onChange={(e) => setStrategy({ ...strategy, name: e.target.value })}
                    placeholder="策略名称"
                  />
                  <span style={{ flex: 1 }} />
                  <button style={btn} onClick={() => void saveCfg()} type="button">💾 保存配置</button>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem", marginBottom: "0.7rem" }}>
                  <label>
                    <span style={{ color: "#475569", fontSize: "0.8rem" }}>总仓位（元）</span>
                    <input style={{ ...input, width: "100%", marginTop: "0.2rem" }} type="text" inputMode="numeric" value={strategy.totalCapital ? strategy.totalCapital.toLocaleString("zh-CN") : ""} onChange={(e) => setStrategy({ ...strategy, totalCapital: Number(e.target.value.replace(/[,，\s]/g, "")) || 0 })} placeholder="如 100,000" />
                  </label>
                  <label>
                    <span style={{ color: "#475569", fontSize: "0.8rem" }}>单日加仓上限（元）</span>
                    <input style={{ ...input, width: "100%", marginTop: "0.2rem" }} type="text" inputMode="numeric" value={strategy.dailyAddLimit ? strategy.dailyAddLimit.toLocaleString("zh-CN") : ""} onChange={(e) => setStrategy({ ...strategy, dailyAddLimit: Number(e.target.value.replace(/[,，\s]/g, "")) || 0 })} placeholder="如 20,000" />
                  </label>
                </div>

                <div style={{ fontWeight: 600, color: "#475569", marginBottom: "0.35rem", fontSize: "0.82rem" }}>交易标的（搜索补全；上限% 可选；起始数量与成本价选填）</div>
                {strategy.stocks.length === 0 && <div style={{ color: "#94a3b8", fontSize: "0.8rem", marginBottom: "0.35rem" }}>暂无标的，添加后限定可交易范围</div>}
                {strategy.stocks.map((s, i) => (
                  <div key={i} style={{ border: "1px solid #eef2f7", borderRadius: 10, padding: "0.5rem 0.6rem", marginBottom: "0.45rem", background: "#fcfcfd" }}>
                    {/* 第一行：股票代码 / 名称（搜索补全） */}
                    <div style={{ display: "flex", gap: "0.35rem", alignItems: "center", marginBottom: "0.4rem" }}>
                      <StockCodeInput
                        code={s.code}
                        name={s.name}
                        onPick={(code, name) => setStockAt(i, { code, name: name ?? s.name })}
                        onChange={(code) => setStockAt(i, { code, name: undefined })}
                      />
                      {s.name && (
                        <span style={{ flexShrink: 0, background: "var(--primary-soft)", color: "var(--primary)", fontSize: "0.74rem", fontWeight: 600, padding: "0.2rem 0.45rem", borderRadius: 6 }}>
                          {s.name}
                        </span>
                      )}
                      <span style={{ flex: 1 }} />
                      <button style={{ ...btn, background: "#ef4444", padding: "0.3rem 0.6rem" }} onClick={() => setStrategy((st) => (st ? { ...st, stocks: st.stocks.filter((_, jj) => jj !== i) } : st))} type="button">✕</button>
                    </div>
                    {/* 第二行：上限% 滑块 / 起始数量 / 成本价 */}
                    <div style={{ display: "flex", gap: "0.8rem", alignItems: "center", flexWrap: "wrap" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.76rem", color: "#64748b" }}>
                        上限
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={1}
                          value={s.maxWeightPct ?? 0}
                          onChange={(e) => setStockAt(i, { maxWeightPct: Number(e.target.value) || 0 })}
                          style={{ width: 70, accentColor: "#2563eb" }}
                          title="单标的上限（占总仓位百分比）"
                        />
                        <input style={{ ...input, width: 54, padding: "0.3rem 0.45rem", borderColor: s.maxWeightPct !== undefined && (s.maxWeightPct < 0 || s.maxWeightPct > 100) ? "#ef4444" : "#cbd5e1" }} type="number" min={0} max={100} value={s.maxWeightPct ?? ""} onChange={(e) => setStockAt(i, { maxWeightPct: Number(e.target.value) || 0 })} />
                        %
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.76rem", color: "#64748b" }}>
                        起始数量
                        <input style={{ ...input, width: 90, padding: "0.3rem 0.45rem" }} type="number" min={0} step={100} value={s.initShares ?? ""} onChange={(e) => setStockAt(i, { initShares: Number(e.target.value) || 0 })} title="A股一手 100 股" />
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.76rem", color: "#64748b" }}>
                        成本价
                        <input style={{ ...input, width: 90, padding: "0.3rem 0.45rem" }} type="number" min={0} value={s.initCost ?? ""} onChange={(e) => setStockAt(i, { initCost: Number(e.target.value) || 0 })} />
                      </label>
                    </div>
                  </div>
                ))}
                <button style={{ ...btnGhost, padding: "0.4rem 0.9rem", fontSize: "0.82rem" }} onClick={() => setStrategy((st) => (st ? { ...st, stocks: [...st.stocks, { code: "" }] } : st))} type="button">＋ 添加标的</button>

                {!isDirty && <div style={{ color: "#94a3b8", fontSize: "0.76rem", marginTop: "0.4rem" }}>保存配置后日度计划才能按此策略校验</div>}
              </div>

              {/* 日度交易计划 */}
              <div style={card}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
                  <span style={{ fontWeight: 700 }}>📅 日度交易计划</span>
                  <input style={{ ...input, width: 145, padding: "0.4rem 0.6rem" }} type="date" value={date} onChange={(e) => setDate(e.target.value)} title="默认：当日交易日；周末取下一交易日" />
                  <span style={{ fontSize: "0.78rem", color: "#94a3b8" }}>策略：{strategy.name}</span>
                </div>

                {items.length === 0 && <div style={{ color: "#94a3b8", fontSize: "0.82rem", marginBottom: "0.5rem" }}>添加今日的交易操作（加仓 / 减仓）</div>}
                {items.map((it, i) => (
                  <div key={i} style={{ display: "flex", gap: "0.35rem", marginBottom: "0.4rem", alignItems: "center" }}>
                    <select style={{ ...input, width: 150, padding: "0.4rem 0.55rem" }} value={it.code} onChange={(e) => setItemAt(i, { code: e.target.value })}>
                      <option value="">选择标的</option>
                      {stockOptions.map((s) => {
                        const used = items.some((it2, j) => j !== i && it2.code === s.code);
                        return (
                          <option key={s.code} value={s.code} disabled={used}>
                            {used ? `✓ 已添加 ${s.name ? s.name + " " + s.code : s.code}` : s.name ? `${s.name} ${s.code}` : s.code}
                          </option>
                        );
                      })}
                    </select>
                    <select style={{ ...input, width: 80, padding: "0.4rem 0.55rem" }} value={it.action} onChange={(e) => setItemAt(i, { action: e.target.value as "add" | "reduce" })}>
                      <option value="add">加仓</option>
                      <option value="reduce">减仓</option>
                    </select>
                    <input style={{ ...input, width: 100, padding: "0.4rem 0.55rem" }} type="text" inputMode="numeric" placeholder="金额（元）" value={it.amount ? it.amount.toLocaleString("zh-CN") : ""} onChange={(e) => setItemAt(i, { amount: Number(e.target.value.replace(/[,，\s]/g, "")) || 0 })} />
                    {/* #3 金额百分比滑块：占总仓位百分比 → 自动算金额 */}
                    {strategy.totalCapital > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={1}
                          value={it.amount > 0 ? Math.min(100, Math.round((it.amount / strategy.totalCapital) * 100)) : 0}
                          onChange={(e) => setItemAt(i, { amount: Math.round((strategy.totalCapital * Number(e.target.value)) / 100) })}
                          style={{ width: 72, accentColor: "#2563eb" }}
                          title="拖动设置占策略总仓位的百分比，自动计算金额"
                        />
                        <span style={{ fontSize: "0.72rem", color: "#64748b", width: 38 }}>{it.amount > 0 ? Math.round((it.amount / strategy.totalCapital) * 100) : 0}%</span>
                      </div>
                    )}
                    <input style={{ ...input, flex: 1, minWidth: 70, padding: "0.4rem 0.55rem" }} placeholder="备注（可选）" value={it.note ?? ""} onChange={(e) => setItemAt(i, { note: e.target.value })} />
                    <button style={{ ...btn, background: "#ef4444", padding: "0.4rem 0.6rem" }} onClick={() => setItems((arr) => arr.filter((_, j) => j !== i))} type="button">✕</button>
                  </div>
                ))}
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.4rem", alignItems: "center" }}>
                  <button style={{ ...btnGhost, padding: "0.4rem 0.9rem", fontSize: "0.84rem" }} onClick={() => setItems((arr) => [...arr, { code: "", action: "add", amount: 0 }])} type="button">＋ 添加操作</button>
                  <button
                    style={{ ...btn, background: result && !result.ok ? "#94a3b8" : "var(--primary)" }}
                    onClick={() => void runCheck(true)}
                    disabled={checking || items.length === 0 || stockOptions.length === 0 || (result !== null && !result.ok)}
                    title={result && !result.ok ? "违反策略仓位管理，无法保存" : "保存为日度计划"}
                    type="button"
                  >
                    💾 保存为日度计划
                  </button>
                  <span style={{ fontSize: "0.78rem", color: "#94a3b8" }}>计划调整后自动校验，保存前请先通过校验</span>
                  {dayMsg && <span style={{ color: dayMsg.startsWith("❌") ? "#dc2626" : "#16a34a", fontSize: "0.82rem" }}>{dayMsg}</span>}
                </div>

                {displayResult && <ResultView result={displayResult} />}
              </div>

              {/* 历史 */}
              <div style={card}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <span style={{ fontWeight: 700 }}>🗂️ 历史日度计划</span>
                  <span style={{ flex: 1 }} />
                  <div style={{ display: "inline-flex", background: "#f1f5f9", borderRadius: 8, padding: 2 }}>
                    {([["list", "📋 列表"], ["cal", "🗓️ 日历"]] as const).map(([v, l]) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setCalView(v === "cal")}
                        style={{
                          padding: "0.2rem 0.6rem", borderRadius: 6, border: "none", fontSize: "0.78rem", cursor: "pointer",
                          background: (v === "cal") === calView ? "#fff" : "transparent", color: (v === "cal") === calView ? "#2563eb" : "#64748b", fontWeight: (v === "cal") === calView ? 600 : 400,
                          boxShadow: (v === "cal") === calView ? "0 1px 2px rgba(15,23,42,0.08)" : "none",
                        }}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                </div>

                {calView ? (
                  <MonthCalendar days={days} selected={date} onSelect={setDate} />
                ) : (
                  <>
                    {days.length === 0 && <div style={{ color: "#94a3b8", fontSize: "0.82rem" }}>暂无记录，保存后自动累积</div>}
                    {days.map((d) => (
                      <div key={d.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.4rem 0", borderBottom: "1px solid #f1f5f9", flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 600 }}>{d.date}</span>
                        <span style={{ color: d.result.ok ? "#16a34a" : "#dc2626", fontSize: "0.8rem" }}>
                          {d.result.ok ? "✅ 通过" : `⚠️ ${d.result.alerts.filter((a) => a.level === "error").length} 项告警`}
                        </span>
                        <span style={{ color: "#64748b", fontSize: "0.78rem" }}>
                          {d.items.map((it) => {
                            const st = strategy?.stocks.find((x) => x.code === it.code);
                            return `${st?.name ? st.name + " " : ""}${it.code} ${it.action === "add" ? "加" : "减"}${cny(it.amount)}`;
                          }).join("；")}
                        </span>
                        <span style={{ flex: 1 }} />
                        <button style={{ ...btn, background: "#0891b2", padding: "0.25rem 0.6rem", fontSize: "0.76rem" }} onClick={() => setViewDay(viewDay?.id === d.id ? null : d)} type="button">
                          {viewDay?.id === d.id ? "收起" : "查看"}
                        </button>
                        <button style={{ ...btn, background: "#ef4444", padding: "0.25rem 0.6rem", fontSize: "0.76rem" }} onClick={() => void deleteOne(d.id)} type="button">删除</button>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 股票代码/名称搜索补全输入（名称 → 代码候选，复用专题自选股 search-stock） */
/** 交易日历视图：当月网格 + 有计划的日期标记（绿=通过/红=告警），点击日期查看当日操作汇总 */
function MonthCalendar({ days, selected, onSelect }: { days: TradePlanDay[]; selected: string; onSelect: (d: string) => void }) {
  const [month, setMonth] = useState(selected.slice(0, 7) || new Date().toISOString().slice(0, 7));
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);

  const [y, m] = month.split("-").map(Number);
  const firstDay = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const pad = (v: number) => String(v).padStart(2, "0");
  const dateStr = (d: number) => `${y}-${pad(m)}-${pad(d)}`;

  const prev = () => setMonth(m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`);
  const next = () => setMonth(m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`);
  const selectedDay = byDate.get(selected);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.5rem" }}>
        <button style={{ ...btn, background: "#f1f5f9", color: "#475569", padding: "0.25rem 0.6rem", fontSize: "0.8rem" }} onClick={prev} type="button">‹</button>
        <span style={{ fontWeight: 700, flex: 1, textAlign: "center" }}>{month}</span>
        <button style={{ ...btn, background: "#f1f5f9", color: "#475569", padding: "0.25rem 0.6rem", fontSize: "0.8rem" }} onClick={next} type="button">›</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3, textAlign: "center", marginBottom: "0.4rem" }}>
        {["日", "一", "二", "三", "四", "五", "六"].map((w) => (
          <div key={w} style={{ fontSize: "0.72rem", color: "#94a3b8", padding: "0.15rem 0" }}>{w}</div>
        ))}
        {Array.from({ length: firstDay }).map((_, i) => <div key={"e" + i} />)}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const d = i + 1;
          const ds = dateStr(d);
          const day = byDate.get(ds);
          const isSel = ds === selected;
          return (
            <button
              key={d}
              type="button"
              onClick={() => onSelect(ds)}
              style={{
                position: "relative",
                padding: "0.35rem 0",
                borderRadius: 8,
                border: `1.5px solid ${isSel ? "var(--primary)" : "transparent"}`,
                background: isSel ? "var(--primary-soft)" : day ? (day.result.ok ? "#f0fdf4" : "#fef2f2") : "#fff",
                color: isSel ? "var(--primary)" : "#1e293b",
                fontWeight: isSel ? 700 : 500,
                fontSize: "0.84rem",
                cursor: "pointer",
              }}
              title={day ? `${ds}：${day.items.map((it) => `${it.code} ${it.action === "add" ? "加" : "减"}${it.amount}`).join("；")}` : ds}
            >
              {d}
              {day && (
                <span
                  style={{
                    position: "absolute", bottom: 3, left: "50%", transform: "translateX(-50%)",
                    width: 6, height: 6, borderRadius: "50%", background: day.result.ok ? "#16a34a" : "#dc2626",
                  }}
                />
              )}
            </button>
          );
        })}
      </div>
      {/* 选中日期操作汇总 */}
      {selectedDay ? (
        <div style={{ background: "#f8fafc", border: "1px solid #eef2f7", borderRadius: 8, padding: "0.5rem 0.7rem", fontSize: "0.8rem" }}>
          <div style={{ fontWeight: 700, marginBottom: "0.3rem" }}>
            {selected} {selectedDay.result.ok ? "✅ 通过" : "⚠️ 有告警"}
          </div>
          {selectedDay.items.map((it, i) => (
            <div key={i} style={{ padding: "0.15rem 0", color: "#475569" }}>
              {it.code} {it.action === "add" ? "加仓" : "减仓"} {cny(it.amount)}
              {it.note ? `（${it.note}）` : ""}
            </div>
          ))}
          <div style={{ color: "#64748b", marginTop: "0.2rem", fontSize: "0.76rem" }}>
            当日加仓 {cny(selectedDay.result.totals.addTotal)} · 执行后仓位 {selectedDay.result.totals.positionPct.toFixed(1)}%
          </div>
        </div>
      ) : (
        <div style={{ color: "#94a3b8", fontSize: "0.78rem", textAlign: "center", padding: "0.4rem 0" }}>{selected} 无交易计划</div>
      )}
    </div>
  );
}

/** 全部策略总计划日历：跨策略聚合，某天显示所有策略的操作 */
function AllCalendar() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<{ date: string; strategies: { id: string; name: string; items: TradePlanItem[]; result: TradePlanCheckResult }[] }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setData(null);
    setErr(null);
    void api.tradePlanCalendar(month).then((r) => {
      setData(r.days);
      if (r.days.length > 0) setSelected(r.days[0].date);
    }).catch((e) => setErr(errMsg(e)));
  }, [month, refreshKey]);

  const byDate = useMemo(() => new Map((data ?? []).map((d) => [d.date, d])), [data]);
  const [y, m] = month.split("-").map(Number);
  const firstDay = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const pad = (v: number) => String(v).padStart(2, "0");
  const dateStr = (d: number) => `${y}-${pad(m)}-${pad(d)}`;
  const selectedDay = byDate.get(selected);

  return (
    <div style={{ marginTop: "0.7rem", borderTop: "1px dashed #e2e8f0", paddingTop: "0.7rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.5rem" }}>
        <button style={{ ...btn, background: "#f1f5f9", color: "#475569", padding: "0.25rem 0.6rem", fontSize: "0.8rem" }} onClick={() => setMonth(m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`)} type="button">‹</button>
        <span style={{ fontWeight: 700, flex: 1, textAlign: "center" }}>{month}</span>
        <button style={{ ...btn, background: "#f1f5f9", color: "#475569", padding: "0.25rem 0.6rem", fontSize: "0.8rem" }} onClick={() => setMonth(m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`)} type="button">›</button>
        <button style={{ ...btn, background: "#2563eb", color: "#fff", padding: "0.25rem 0.6rem", fontSize: "0.8rem" }} onClick={() => setRefreshKey((k) => k + 1)} type="button" title="刷新当月计划">🔄</button>
      </div>
      {err && <div style={{ color: "#dc2626", fontSize: "0.82rem", marginBottom: "0.4rem" }}>❌ {err}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3, textAlign: "center", marginBottom: "0.4rem" }}>
        {["日", "一", "二", "三", "四", "五", "六"].map((w) => (
          <div key={w} style={{ fontSize: "0.72rem", color: "#94a3b8", padding: "0.15rem 0" }}>{w}</div>
        ))}
        {Array.from({ length: firstDay }).map((_, i) => <div key={"e" + i} />)}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const d = i + 1;
          const ds = dateStr(d);
          const day = byDate.get(ds);
          const hasErr = day?.strategies.some((s) => !s.result.ok);
          const isSel = ds === selected;
          return (
            <button
              key={d}
              type="button"
              onClick={() => setSelected(ds)}
              style={{
                position: "relative",
                padding: "0.35rem 0",
                borderRadius: 8,
                border: `1.5px solid ${isSel ? "var(--primary)" : "transparent"}`,
                background: isSel ? "var(--primary-soft)" : day ? (hasErr ? "#fef2f2" : "#f0fdf4") : "#fff",
                color: isSel ? "var(--primary)" : "#1e293b",
                fontWeight: isSel ? 700 : 500,
                fontSize: "0.84rem",
                cursor: "pointer",
              }}
              title={day ? `${ds}：${day.strategies.map((s) => `${s.name} ${s.items.length}项`).join("；")}` : ds}
            >
              {d}
              {day && (
                <span style={{ position: "absolute", bottom: 3, left: "50%", transform: "translateX(-50%)", width: 6, height: 6, borderRadius: "50%", background: hasErr ? "#dc2626" : "#16a34a" }} />
              )}
            </button>
          );
        })}
      </div>
      {/* 选中日：各策略操作汇总 */}
      {selectedDay ? (
        <div style={{ background: "#f8fafc", border: "1px solid #eef2f7", borderRadius: 8, padding: "0.5rem 0.7rem", fontSize: "0.8rem" }}>
          <div style={{ fontWeight: 700, marginBottom: "0.3rem" }}>{selected} 全部策略计划</div>
          {selectedDay.strategies.map((s) => (
            <div key={s.id} style={{ padding: "0.25rem 0", borderBottom: "1px solid #f1f5f9" }}>
              <div style={{ fontWeight: 600, color: s.result.ok ? "#16a34a" : "#dc2626" }}>
                {s.name} {s.result.ok ? "✅" : "⚠️"}
              </div>
              <div style={{ color: "#475569" }}>
                {s.items.map((it, i) => `${it.code} ${it.action === "add" ? "加仓" : "减仓"} ${cny(it.amount)}${it.note ? `（${it.note}）` : ""}`).join("；")}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ color: "#94a3b8", fontSize: "0.78rem", textAlign: "center", padding: "0.4rem 0" }}>{selected || month} 无任何策略计划</div>
      )}
    </div>
  );
}

function StockCodeInput({ code, name, onChange, onPick }: { code: string; name?: string; onChange: (v: string) => void; onPick: (code: string, name?: string) => void }) {
  const [cands, setCands] = useState<{ code: string; name: string }[]>([]);
  const [focus, setFocus] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 显示文本：有名称时显示「名称 代码」（可读性优先），否则仅代码
  const [disp, setDisp] = useState(code ? (name ? name + " " + code : code) : "");
  useEffect(() => {
    const target = code ? (name ? name + " " + code : code) : "";
    setDisp((d) => (d === target ? d : target));
  }, [code, name]);

  const onInput = (v: string) => {
    setDisp(v);
    onChange(v); // 外部同步清空 name（手动输入 = 更换标的）
    if (timer.current) clearTimeout(timer.current);
    const t = v.trim();
    if (!t || /^\d{5,6}$/.test(t)) { setCands([]); return; } // 纯代码不搜索
    timer.current = setTimeout(async () => {
      try {
        const r = await api.watchlistSearchStock(t, 6);
        if (r.ok) setCands(r.items.map((x) => ({ code: x.code, name: x.name })));
        else setCands([]);
      } catch {
        setCands([]);
      }
    }, 300);
  };

  return (
    <div style={{ position: "relative", flex: 0.85, minWidth: 100 }}>
      <input
        style={{ ...input, width: "100%" }}
        placeholder="代码 / 名称（搜索补全）"
        value={disp}
        onChange={(e) => onInput(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setTimeout(() => setFocus(false), 200)}
      />
      {focus && cands.length > 0 && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, boxShadow: "0 4px 12px rgba(15,23,42,0.08)", marginTop: 2, maxHeight: 220, overflow: "auto" }}>
          {cands.map((c) => (
            <div
              key={c.code}
              onMouseDown={() => { setDisp(c.name + " " + c.code); onChange(c.code); onPick(c.code, c.name); setCands([]); }}
              style={{ padding: "0.4rem 0.6rem", cursor: "pointer", display: "flex", justifyContent: "space-between", fontSize: "0.84rem" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#f1f5f9")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#fff")}
            >
              <span>{c.name}</span>
              <span style={{ color: "#94a3b8", fontSize: "0.78rem" }}>{c.code}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ResultView({ result }: { result: TradePlanCheckResult }) {
  return (
    <div style={{ marginTop: "0.9rem", borderTop: "1px dashed #e2e8f0", paddingTop: "0.8rem" }}>
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
