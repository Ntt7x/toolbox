import { useEffect, useState, type CSSProperties } from "react";
import { api, errMsg } from "../api";
import { CodeBlock, ErrorCard, PageHeader } from "../ui";
import type {
  GridPlanRequest,
  GridPlanResponse,
  GridPlanResult,
  GridStyleKey,
  GridStyleResult,
  GridTrendType,
  QuoteResponse,
} from "@toolbox/shared";

// ---------- 趋势类型选项 ----------

const TREND_OPTIONS: { type: GridTrendType; name: string; desc: string }[] = [
  { type: 1, name: "单边强牛市", desc: "陡峭上升，几乎无回调，回调即买点" },
  { type: 2, name: "单边强熊市", desc: "陡峭下跌，几乎无反弹，反弹即卖点" },
  { type: 3, name: "慢牛震荡市", desc: "重心缓升，常见急跌慢涨，回调浅" },
  { type: 4, name: "慢熊震荡市", desc: "重心缓降，常见反弹弱、下跌深" },
  { type: 5, name: "宽幅震荡市", desc: "区间内大幅来回波动，无方向" },
  { type: 6, name: "窄幅盘整市", desc: "波动率极低或持续收窄，等待突破" },
  { type: 7, name: "喇叭口震荡", desc: "波动从低渐高或从高渐低，即将变盘" },
];

const STYLE_ORDER: GridStyleKey[] = ["rad", "bal", "con"];
const STYLE_LABEL: Record<GridStyleKey, string> = { rad: "🔴 激进", bal: "🟡 均衡", con: "🟢 保守" };
const EXAMPLE = "1.073 1.290 0.856";

// ---------- 样式 ----------

const card: CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.25rem 1.5rem",
  marginBottom: "1rem",
};

const btn: CSSProperties = {
  padding: "0.6rem 1.4rem",
  borderRadius: 8,
  border: "none",
  background: "#3b82f6",
  color: "#fff",
  fontSize: "0.95rem",
  fontWeight: 600,
  cursor: "pointer",
};

const input: CSSProperties = {
  width: 110,
  padding: "0.5rem 0.6rem",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  fontSize: "0.95rem",
  textAlign: "center",
};

const table: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
  background: "#fff",
};

const thTd: CSSProperties = {
  border: "1px solid #e2e8f0",
  padding: "0.5rem 0.6rem",
  textAlign: "center",
};

const th: CSSProperties = { ...thTd, background: "#f1f5f9", fontWeight: 600 };

// ---------- 格式化 ----------

function fmt(x: number, digits = 2): string {
  return String(parseFloat(x.toFixed(digits)));
}

// ---------- 组件 ----------

export default function GridPlanTool() {
  const [type, setType] = useState<GridTrendType>(3);
  const [inputs, setInputs] = useState<string[]>(["", "", ""]);
  const [maxAmountInput, setMaxAmountInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [quoteInfo, setQuoteInfo] = useState<QuoteResponse | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);
  const [chatHint, setChatHint] = useState(false);
  // 程序性提示词（统一数据链路：API → 本地设置数据）
  const [promptText, setPromptText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GridPlanResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /** 复制原始提示词到剪贴板 */
  const copyPrompt = async () => {
    if (!promptText) return;
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("复制失败，请手动选择文本复制");
    }
  };

  // 挂载时从「本地设置数据」加载程序性提示词（展示/复制）
  useEffect(() => {
    void api
      .promptDetail("grid-plan.system")
      .then((r) => {
        if (r.ok) setPromptText(r.rendered);
      })
      .catch(() => {
        // 加载失败静默：提示词区块显示占位文案
      });
  }, []);

  /** 携带提示词跳转 DeepSeek 网页版 Chat（剪贴板中转：网页版不支持 URL 预填输入） */
  const openChat = (text: string | null) => {
    if (!text) return;
    // 同步打开新标签（必须在用户手势内，异步调用会被浏览器弹窗拦截）
    window.open("https://chat.deepseek.com/", "_blank", "noopener");
    // 提示词经剪贴板中转（DeepSeek 网页版无预填参数，经代码验证仅支持 ?model=/OAuth 参数）
    void navigator.clipboard.writeText(text).catch(() => {});
    setChatHint(true);
    setTimeout(() => setChatHint(false), 8000);
  };

  /** 输入股票代码 → 自动获取月线 BOLL → 填充输入框并自动生成计划 */
  const fetchQuote = async () => {
    const code = codeInput.trim();
    if (!code) {
      setErr("请先输入股票代码，如 600519 / hk00700。");
      return;
    }
    setErr(null);
    setQuoteLoading(true);
    setQuoteInfo(null);
    try {
      const q = await api.quote(code);
      if (q.ok) {
        const bolls = [q.U, q.M, q.L];
        setInputs(bolls.map(String));
        setQuoteInfo(q);
        await runPlan(bolls); // 自动生成计划
      } else {
        setErr(q.message);
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setQuoteLoading(false);
    }
  };

  /** 用给定 BOLL 生成计划（含可选最大仓位金额） */
  const runPlan = async (bolls: number[]) => {
    setErr(null);
    if (bolls.some((n) => !Number.isFinite(n) || n <= 0)) {
      setErr("请填写三个正数的布林带数值（上轨/中轨/下轨，顺序任意）。");
      return;
    }
    const amt = maxAmountInput.trim();
    if (amt !== "" && (!Number.isFinite(Number(amt)) || Number(amt) <= 0)) {
      setErr("最大仓位金额必须是正数，或留空使用默认 K=1000 份基准。");
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const req: GridPlanRequest = {
        type,
        boll: [bolls[0], bolls[1], bolls[2]],
        ...(amt !== "" ? { maxAmount: Number(amt) } : {}),
      };
      setResult(await api.gridPlan(req));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  const submit = () => runPlan(inputs.map((s) => Number(s.trim())));

  return (
    <div>
      <PageHeader
        title="📈 交易网格计划"
        desc="仓位中性趋势优势网格计划生成：输入趋势类型 + 月线布林带数值，输出三档风格（激进/均衡/保守）完整网格参数。"
      />

      {/* 表单 */}
      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: "0.6rem" }}>① 行情趋势类型</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: "0.5rem" }}>
          {TREND_OPTIONS.map((o) => (
            <label
              key={o.type}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "0.5rem",
                padding: "0.55rem 0.7rem",
                borderRadius: 8,
                border: `1.5px solid ${type === o.type ? "#3b82f6" : "#e2e8f0"}`,
                background: type === o.type ? "#eff6ff" : "#fff",
                cursor: "pointer",
              }}
            >
              <input
                type="radio"
                name="trend"
                checked={type === o.type}
                onChange={() => setType(o.type)}
                style={{ marginTop: "0.2rem" }}
              />
              <span>
                <span style={{ fontWeight: 600 }}>{o.type}. {o.name}</span>
                <br />
                <span style={{ color: "#94a3b8", fontSize: "0.78rem" }}>{o.desc}</span>
              </span>
            </label>
          ))}
        </div>

        <div style={{ fontWeight: 600, margin: "1rem 0 0.6rem" }}>② 股票代码自动补全（可选）</div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <input
            style={{ ...input, width: 180 }}
            placeholder="如 600519 / hk00700 / 00700"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") fetchQuote(); }}
          />
          {quoteInfo && quoteInfo.name && (
            <span
              style={{
                background: "#ecfdf5",
                color: "#047857",
                borderRadius: 6,
                padding: "0.32rem 0.6rem",
                fontWeight: 600,
                fontSize: "0.9rem",
                border: "1px solid #a7f3d0",
              }}
            >
              🏷️ {quoteInfo.name}
            </span>
          )}
          <button
            style={{ ...btn, background: "#0891b2" }}
            onClick={fetchQuote}
            disabled={quoteLoading}
            type="button"
          >
            {quoteLoading ? "获取中…" : "📡 获取月 BOLL 并生成"}
          </button>
          {quoteInfo && (
            <span style={{ color: "#16a34a", fontSize: "0.85rem" }}>
              {quoteInfo.name || quoteInfo.code}：BOLL 已填入（{quoteInfo.bars} 根完整月K，截至 {quoteInfo.lastDate}
              {quoteInfo.warning ? `；⚠️ ${quoteInfo.warning}` : ""}）
            </span>
          )}
        </div>

        <div style={{ fontWeight: 600, margin: "1rem 0 0.6rem" }}>③ 月线布林带数值（可手动填写/修改，顺序任意，可附带文字备注）</div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          {inputs.map((v, i) => (
            <input
              key={i}
              style={input}
              placeholder={["上轨", "中轨", "下轨"][i]}
              value={v}
              onChange={(e) => setInputs(inputs.map((x, j) => (j === i ? e.target.value : x)))}
            />
          ))}
          <button
            style={{ ...btn, background: "#64748b" }}
            onClick={() => setInputs(EXAMPLE.split(" "))}
            type="button"
          >
            填入示例
          </button>
          <button style={btn} onClick={submit} disabled={loading} type="button">
            {loading ? "计算中…" : "⚡ 生成计划"}
          </button>
        </div>
        <div style={{ color: "#94a3b8", fontSize: "0.78rem", marginTop: "0.5rem" }}>
          示例数值：1.073（上轨）1.290（中轨）0.856（下轨）——请直接填写三个数字，顺序任意。
        </div>

        <div style={{ fontWeight: 600, margin: "1rem 0 0.6rem" }}>④ 最大仓位金额（可选，控制仓位数量）</div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <input
            style={input}
            placeholder="如 10000"
            value={maxAmountInput}
            onChange={(e) => setMaxAmountInput(e.target.value)}
          />
          <span style={{ color: "#94a3b8", fontSize: "0.85rem" }}>
            留空 = 默认 K=1000 份基准；填写后按各档总成本（Q_max × C_avg）缩放，份数与金额同时展示
          </span>
        </div>
      </div>

      {/* 原始提示词展示/复制 */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
          <button
            style={{ ...btn, background: "#7c3aed" }}
            onClick={() => setShowPrompt((v) => !v)}
            type="button"
          >
            {showPrompt ? "🙈 收起提示词" : "📜 查看提示词"}
          </button>
          {showPrompt && (
            <>
              <button style={{ ...btn, background: "#16a34a" }} onClick={copyPrompt} type="button">
                {copied ? "✅ 已复制" : "📋 复制"}
              </button>
              <button style={{ ...btn, background: "#0891b2" }} onClick={() => openChat(promptText)} type="button">
                💬 Chat
              </button>
            </>
          )}
          <span style={{ color: "#94a3b8", fontSize: "0.82rem" }}>
            本工具即由该 LLM 提示词固化而来，提示词统一存储于「本地设置数据」，可编辑与重置
          </span>
        </div>
        {showPrompt && (
          <CodeBlock maxHeight="24rem">{promptText ?? "（提示词加载中…）"}</CodeBlock>
        )}
        {chatHint && <div style={{ color: "#0891b2", fontSize: "0.82rem", marginTop: "0.5rem" }}>💬 已打开 DeepSeek 网页版并复制提示词；网页版不支持 URL 预填，请在输入框粘贴（Ctrl/Cmd+V）后发送。</div>}
      </div>

      {/* 错误提示 */}
      {err && <ErrorCard>❌ {err}</ErrorCard>}

      {/* 后端错误 */}
      {result && !result.ok && <ErrorCard>❌ {result.message}</ErrorCard>}

      {/* 结果 */}
      {result && result.ok && <ResultView r={result} />}
    </div>
  );
}

// ---------- 结果视图 ----------

function ResultView({ r }: { r: GridPlanResponse }) {
  const styles = r.styles;
  const amountMode = typeof r.maxAmount === "number" && r.maxAmount > 0;

  return (
    <div>
      {/* 概要 */}
      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: "0.6rem" }}>📊 网格计划概要</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "0.5rem", fontSize: "0.9rem" }}>
          <Info label="产出日期" value={r.date} />
          <Info label="布林带 U/M/L" value={`${fmt(r.U, 4)} / ${fmt(r.M, 4)} / ${fmt(r.L, 4)}`} />
          <Info label="月波动率 σ_m" value={`${fmt(r.sigma_m)}%`} />
          <Info label="日波动率 σ_d" value={`${fmt(r.sigma_d)}%`} />
          <Info label="趋势类型" value={r.typeName} />
          <Info label="不对称比 r" value={`${fmt(r.r)} (${r.r_desc})${r.asymmetric ? " ⚠️不对称" : ""}`} />
          {amountMode && <Info label="最大仓位金额" value={String(r.maxAmount)} />}
        </div>
      </div>

      {/* 三档对比表 */}
      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: "0.6rem" }}>
          🔬 三档风格对比{amountMode && `（金额模式：按最大仓位金额 ${fmt(r.maxAmount!)} 缩放，份/金额同显）`}
        </div>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>风格</th>
              <th style={th}>止损 L</th>
              <th style={th}>锁盈 P</th>
              <th style={th}>买入 b%</th>
              <th style={th}>买入{amountMode ? "份/金额" : "份数"}</th>
              <th style={th}>上涨卖 a%</th>
              <th style={th}>卖出{amountMode ? "份/金额" : "份数"}</th>
              <th style={th}>加仓 n</th>
              <th style={th}>最大仓位</th>
              <th style={th}>最小仓位</th>
              <th style={th}>极端浮盈</th>
              <th style={th}>极端浮亏</th>
              <th style={th}>标记</th>
            </tr>
          </thead>
          <tbody>
            {STYLE_ORDER.map((key) => {
              const s: GridStyleResult = styles[key];
              const amt = s.amount;
              return (
                <tr key={key}>
                  <td style={thTd}><b>{STYLE_LABEL[key]}</b></td>
                  {s.unavailable ? (
                    <td style={thTd} colSpan={12}><span style={{ color: "#dc2626" }}>方案不可用（极端安全超限）</span></td>
                  ) : (
                    <>
                      <td style={thTd}>{s.L_stop}%</td>
                      <td style={thTd}>{s.P_lock}%</td>
                      <td style={thTd}>{fmt(s.b_final)}%</td>
                      <td style={thTd}>
                        {s.B_int}
                        {amountMode && amt ? <span style={{ color: "#64748b" }}> / {fmt(amt.buyAmount)}</span> : null}
                      </td>
                      <td style={thTd}>{fmt(s.a_final)}%</td>
                      <td style={thTd}>
                        {s.S_int}
                        {amountMode && amt ? <span style={{ color: "#64748b" }}> / {fmt(amt.sellAmount)}</span> : null}
                      </td>
                      <td style={thTd}>{s.n}</td>
                      <td style={thTd}>
                        {s.Q_max}
                        {amountMode && amt ? <span style={{ color: "#64748b" }}> / {fmt(amt.maxAmount)}</span> : null}
                      </td>
                      <td style={thTd}>
                        {s.Q_min}
                        {amountMode && amt ? <span style={{ color: "#64748b" }}> / {fmt(amt.minAmount)}</span> : null}
                      </td>
                      <td style={thTd}>{fmt(s.profit_ratio)}%</td>
                      <td style={thTd}>{fmt(s.loss_ratio)}%</td>
                      <td style={{ ...thTd, fontSize: "0.75rem", color: s.flags.length ? "#d97706" : "#94a3b8" }}>
                        {s.flags.length ? s.flags.join("；") : "—"}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 完整计划文本 */}
      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: "0.6rem" }}>📄 完整计划文本（可复制）</div>
        <CodeBlock>{r.markdown}</CodeBlock>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#f8fafc", borderRadius: 8, padding: "0.5rem 0.7rem" }}>
      <div style={{ color: "#94a3b8", fontSize: "0.75rem" }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>{value}</div>
    </div>
  );
}
