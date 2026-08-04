import { useState, type CSSProperties } from "react";
import { api } from "../api";
import type { CbAction, CbRatePeriod, CbRateResult, CbRateBank } from "@toolbox/shared";

// ---------- 九大央行选项 ----------

const BANK_OPTIONS: { id: string; name: string }[] = [
  { id: "fed", name: "美联储" },
  { id: "ecb", name: "欧洲央行" },
  { id: "boj", name: "日本央行" },
  { id: "boe", name: "英国央行" },
  { id: "boc", name: "加拿大央行" },
  { id: "rba", name: "澳大利亚央行" },
  { id: "rbnz", name: "新西兰央行" },
  { id: "snb", name: "瑞士央行" },
  { id: "norges", name: "挪威央行" },
];

const ACTION_LABEL: Record<CbAction, string> = {
  hike: "📈 加息",
  cut: "📉 降息",
  hold: "⏸ 按兵不动",
  mixed: "🔄 方向混合",
};

const ACTION_COLOR: Record<CbAction, string> = {
  hike: "#dc2626",
  cut: "#16a34a",
  hold: "#64748b",
  mixed: "#d97706",
};

/** 过去 24 个月（含本月），从近到远 */
function buildMonthOptions(): { value: string; label: string }[] {
  const now = new Date();
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    out.push({
      value: `${y}-${String(m).padStart(2, "0")}`,
      label: `${y}年${m}月`,
    });
  }
  return out;
}

const MONTH_OPTIONS = buildMonthOptions();

// ---------- 样式 ----------

const card: CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.25rem 1.5rem",
  marginBottom: "1rem",
};

const btn: CSSProperties = {
  padding: "0.55rem 1.3rem",
  borderRadius: 8,
  border: "none",
  background: "#3b82f6",
  color: "#fff",
  fontSize: "0.92rem",
  fontWeight: 600,
  cursor: "pointer",
};

const chipStyle = (selected: boolean): CSSProperties => ({
  padding: "0.4rem 0.8rem",
  borderRadius: 999,
  border: `1.5px solid ${selected ? "#3b82f6" : "#e2e8f0"}`,
  background: selected ? "#eff6ff" : "#fff",
  color: selected ? "#1d4ed8" : "#475569",
  cursor: "pointer",
  fontSize: "0.85rem",
  fontWeight: selected ? 600 : 400,
});

const thTd: CSSProperties = {
  border: "1px solid #e2e8f0",
  padding: "0.45rem 0.6rem",
  textAlign: "left",
  fontSize: "0.85rem",
};

const th: CSSProperties = { ...thTd, background: "#f1f5f9", fontWeight: 600 };

export default function CbRateTool() {
  const [period, setPeriod] = useState<CbRatePeriod>("month");
  const [monthSel, setMonthSel] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [withCalendar, setWithCalendar] = useState(true);
  const [withSearch, setWithSearch] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CbRateResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const toggleBank = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const run = async () => {
    setErr(null);
    setLoading(true);
    setResult(null);
    setShowRaw(false);
    try {
      const req = {
        period,
        ...(monthSel ? { month: monthSel } : {}),
        ...(selected.size > 0 ? { banks: [...selected] } : {}),
        withCalendar,
        search: withSearch,
      };
      setResult(await api.cbRate(req));
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>🏦 央行利率分析</h1>
      <p style={{ color: "#666", marginTop: "-0.4rem" }}>
        九大央行利率政策时间线分析（LLM 驱动）。数据基于模型知识，请留意「数据截至日期」。需要先在「🤖 LLM 设置」中配置 DeepSeek API key。
      </p>

      {/* 参数区 */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600 }}>时间范围：</span>
          <button style={chipStyle(period === "month" && !monthSel)} onClick={() => { setPeriod("month"); setMonthSel(""); }} type="button">
            📅 本月以来
          </button>
          <button style={chipStyle(period === "year" && !monthSel)} onClick={() => { setPeriod("year"); setMonthSel(""); }} type="button">
            📆 今年以来
          </button>
          <select
            value={monthSel}
            onChange={(e) => { setMonthSel(e.target.value); if (e.target.value) setPeriod("month"); }}
            style={{
              padding: "0.4rem 0.6rem",
              borderRadius: 8,
              border: "1.5px solid #cbd5e1",
              fontSize: "0.85rem",
              background: "#fff",
            }}
          >
            <option value="">🗓 整月（过去 24 个月）</option>
            {MONTH_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <span style={{ marginLeft: "0.8rem", fontWeight: 600 }}>央行：</span>
          <button style={chipStyle(selected.size === 0)} onClick={() => setSelected(new Set())} type="button">
            全部九大
          </button>
          {BANK_OPTIONS.map((b) => (
            <button key={b.id} style={chipStyle(selected.has(b.id))} onClick={() => toggleBank(b.id)} type="button">
              {b.name}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", flexWrap: "wrap", marginTop: "0.8rem" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.88rem", cursor: "pointer" }}>
            <input type="checkbox" checked={withCalendar} onChange={(e) => setWithCalendar(e.target.checked)} />
            附会议日历
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.88rem", cursor: "pointer" }}>
            <input type="checkbox" checked={withSearch} onChange={(e) => setWithSearch(e.target.checked)} />
            📡 联网搜索（实时数据，较慢）
          </label>
          <button style={btn} onClick={run} disabled={loading} type="button">
            {loading ? "分析中…（LLM 可能需要 10~60 秒）" : "⚡ 开始分析"}
          </button>
        </div>
      </div>

      {/* 错误 */}
      {err && (
        <div style={{ ...card, borderColor: "#fca5a5", background: "#fef2f2", color: "#b91c1c" }}>
          ❌ {err}
        </div>
      )}
      {result && !result.ok && (
        <div style={{ ...card, borderColor: "#fca5a5", background: "#fef2f2", color: "#b91c1c" }}>
          ❌ {result.message}
        </div>
      )}

      {/* 结果 */}
      {result && result.ok && (
        <div>
          {/* 小结 */}
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, fontSize: "1.02rem" }}>📊 政策取向小结</span>
              <span style={{ background: "#f1f5f9", color: "#475569", padding: "0.2rem 0.6rem", borderRadius: 999, fontSize: "0.8rem" }}>
                数据截至：{result.asOf || "未知"}
              </span>
              <span style={{ color: "#94a3b8", fontSize: "0.78rem" }}>模型：{result.model}</span>
            </div>
            <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.7, marginTop: "0.6rem", fontSize: "0.92rem" }}>
              {result.summary}
            </p>
            {result.searchQueries && result.searchQueries.length > 0 && (
              <div style={{ color: "#94a3b8", fontSize: "0.78rem", marginTop: "0.4rem" }}>
                🔍 联网搜索：{result.searchQueries.join(" · ")}
              </div>
            )}
          </div>

          {/* 央行卡片 */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "0.8rem", marginBottom: "1rem" }}>
            {result.banks.map((b) => (
              <BankCard key={b.id} bank={b} />
            ))}
          </div>

          {/* 会议日历 */}
          {result.calendar && result.calendar.length > 0 && (
            <div style={card}>
              <div style={{ fontWeight: 700, marginBottom: "0.6rem" }}>🗓 近期会议日历</div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>日期</th>
                    <th style={th}>央行</th>
                    <th style={th}>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {result.calendar.map((c, i) => (
                    <tr key={i}>
                      <td style={thTd}>{c.date}</td>
                      <td style={thTd}><b>{c.bank}</b></td>
                      <td style={thTd}>{c.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 原始输出 */}
          {result.raw && (
            <div style={card}>
              <button
                style={{ ...btn, background: "#64748b", padding: "0.4rem 0.9rem" }}
                onClick={() => setShowRaw((v) => !v)}
                type="button"
              >
                {showRaw ? "收起 LLM 原始输出" : "查看 LLM 原始输出"}
              </button>
              {showRaw && (
                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: "0.7rem", background: "#0f172a", color: "#e2e8f0", padding: "0.9rem 1.1rem", borderRadius: 10, fontSize: "0.78rem", maxHeight: "20rem", overflowY: "auto" }}>
                  {result.raw}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- 央行卡片 ----------

function BankCard({ bank }: { bank: CbRateBank }) {
  const color = ACTION_COLOR[bank.action];
  return (
    <div style={{ ...card, marginBottom: 0, padding: "1rem 1.1rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
        <span style={{ fontWeight: 700, fontSize: "0.98rem" }}>🏛 {bank.name}</span>
        <span style={{ background: `${color}1a`, color, border: `1px solid ${color}55`, padding: "0.15rem 0.55rem", borderRadius: 999, fontSize: "0.78rem", fontWeight: 700 }}>
          {ACTION_LABEL[bank.action]}
        </span>
      </div>
      <div style={{ marginTop: "0.5rem", fontSize: "0.9rem" }}>
        <span style={{ color: "#94a3b8" }}>最新利率：</span>
        <b>{bank.latestRate}</b>
      </div>
      <div style={{ marginTop: "0.3rem", fontSize: "0.85rem", lineHeight: 1.6 }}>
        <div>{bank.actionDesc}</div>
        {bank.details && <div style={{ color: "#475569", marginTop: "0.25rem" }}>📋 {bank.details}</div>}
        {bank.nextMeeting && <div style={{ marginTop: "0.25rem" }}>🗓 下次会议：{bank.nextMeeting}</div>}
        {bank.outlook && <div style={{ color: "#475569", marginTop: "0.25rem" }}>🔮 {bank.outlook}</div>}
        {bank.updatedAt && (
          <div style={{ color: "#94a3b8", marginTop: "0.25rem", fontSize: "0.75rem" }}>最近变动：{bank.updatedAt}</div>
        )}
      </div>
    </div>
  );
}
