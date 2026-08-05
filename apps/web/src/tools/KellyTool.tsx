// ============================================================
// 凯利仓位助手：凯利公式仓位计算（忠实实现「凯利仓位助手」提示词）
// - 输入：当前价格 / 上止盈 / 下止损 / 主观胜率 / 可用金额（可选股票代码自动填当前价）
// - 输出：核心参数 + 四方案（1/4、1/3、1/2、全额凯利）+ 风险警示
// - 程序性提示词：查看/复制/Chat 跳转（统一数据链路：本地设置数据 kelly.position）
// - 历史记录：自动保存、列表/详情/删除
// ============================================================

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { api, errMsg } from "../api";
import { ErrorCard, PageHeader, CodeBlock } from "../ui";
import type { KellyHistoryEntry, KellyRequest, KellyResult, QuoteSnapshot } from "@toolbox/shared";

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
  minWidth: 130,
  padding: "0.5rem 0.7rem",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  fontSize: "0.92rem",
};

const label: CSSProperties = {
  fontSize: "0.78rem",
  color: "#64748b",
  whiteSpace: "nowrap",
};

const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
const money = (v: number): string => v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const SCHEME_COLORS: Record<string, string> = { quarter: "#94a3b8", third: "#16a34a", half: "#f59e0b", kelly: "#dc2626" };
const SCHEME_ICONS: Record<string, string> = { quarter: "⚪", third: "🟢", half: "🟡", kelly: "🔴" };

export default function KellyTool() {
  // 输入
  const [priceInput, setPriceInput] = useState("");
  const [tpInput, setTpInput] = useState("");
  const [slInput, setSlInput] = useState("");
  const [wrInput, setWrInput] = useState("");
  const [amtInput, setAmtInput] = useState("");
  // 股票代码（可选：快照自动填当前价格 + 显示名称）
  const [codeInput, setCodeInput] = useState("");
  const [quoteInfo, setQuoteInfo] = useState<QuoteSnapshot | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  // 提示词
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);
  const [chatHint, setChatHint] = useState(false);
  const [promptText, setPromptText] = useState<string | null>(null);
  // 计算
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<KellyResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 历史
  const [historyList, setHistoryList] = useState<KellyHistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [viewingResult, setViewingResult] = useState<KellyResult | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const r = await api.kellyHistory();
      if (r.ok) setHistoryList(r.entries);
    } catch {
      // 静默
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // 挂载时从「本地设置数据」加载程序性提示词（展示/复制/Chat）
  useEffect(() => {
    void api
      .promptDetail("kelly.position")
      .then((r) => {
        if (r.ok) setPromptText(r.rendered);
      })
      .catch(() => {});
  }, []);

  /** 复制提示词到剪贴板 */
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

  /** 携带提示词跳转 DeepSeek 网页版 Chat（剪贴板中转） */
  const openChat = (text: string | null) => {
    if (!text) return;
    window.open("https://chat.deepseek.com/", "_blank", "noopener");
    void navigator.clipboard.writeText(text).catch(() => {});
    setChatHint(true);
    setTimeout(() => setChatHint(false), 8000);
  };

  /** 输入股票代码 → 快照自动填当前价格（可选，显示名称） */
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
      const q = await api.quoteSnapshot(code);
      if (q.ok) {
        setQuoteInfo(q);
        if (q.price !== undefined) setPriceInput(String(q.price));
      } else {
        setErr(q.message ?? "行情获取失败");
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setQuoteLoading(false);
    }
  };

  /** 执行凯利计算 */
  const runCalculate = async () => {
    setErr(null);
    const price = Number(priceInput);
    const tp = Number(tpInput);
    const sl = Number(slInput);
    const wr = Number(wrInput);
    const amt = Number(amtInput);
    if (![price, tp, sl, wr, amt].every((n) => Number.isFinite(n))) {
      setErr("请填写有效的数值（当前价格/上止盈/下止损/胜率%/可用金额）。");
      return;
    }
    const wrVal = wr > 1 ? wr / 100 : wr; // 支持百分数（80 → 0.8）
    setLoading(true);
    setResult(null);
    try {
      const req: KellyRequest = {
        price,
        takeProfit: tp,
        stopLoss: sl,
        winRate: wrVal,
        maxAmount: amt,
        ...(codeInput.trim() ? { code: codeInput.trim() } : {}),
        ...(quoteInfo?.name ? { name: quoteInfo.name } : {}),
      };
      const r = await api.kellyCalculate(req);
      setResult(r);
      await loadHistory();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  const viewHistory = async (id: string) => {
    setErr(null);
    try {
      const r = await api.kellyHistoryDetail(id);
      if (r.ok) {
        setViewingId(id);
        setViewingResult(r.entry.result);
      }
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  const deleteHistoryEntry = async (id: string) => {
    if (!window.confirm("删除这条凯利仓位历史？")) return;
    setErr(null);
    try {
      const r = await api.kellyHistoryDelete(id);
      if (r.ok) {
        if (viewingId === id) { setViewingId(null); setViewingResult(null); }
        await loadHistory();
      }
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  return (
    <div>
      <PageHeader
        title="📈 凯利仓位助手"
        desc="按凯利公式计算建议仓位：输入当前价/止盈/止损/主观胜率/可用金额，输出分数凯利四方案（1/4、1/3、1/2、全额）。"
      />

      {/* 输入表单 */}
      <div style={card}>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
            <span style={label}>股票代码（可选）</span>
            <input style={{ ...input, minWidth: 110 }} placeholder="600519" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void fetchQuote(); }} />
          </div>
          <button style={{ ...btn, background: "#0891b2" }} onClick={() => void fetchQuote()} disabled={quoteLoading} type="button">
            {quoteLoading ? "获取中…" : "⛁ 获取价格"}
          </button>
          {quoteInfo?.ok && (
            <span style={{ fontSize: "0.82rem", color: "#334155", whiteSpace: "nowrap" }}>
              🏷️ {quoteInfo.name ?? ""} {quoteInfo.code} 现价 {quoteInfo.price}
              {quoteInfo.pct !== undefined ? <span style={{ color: (quoteInfo.pct ?? 0) >= 0 ? "#dc2626" : "#16a34a" }}> {quoteInfo.pct >= 0 ? "+" : ""}{quoteInfo.pct}%</span> : null}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end", marginTop: "0.7rem" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
            <span style={label}>当前价格</span>
            <input style={{ ...input, minWidth: 110 }} placeholder="30" value={priceInput} onChange={(e) => setPriceInput(e.target.value)} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
            <span style={label}>上止盈价格</span>
            <input style={{ ...input, minWidth: 110 }} placeholder="39" value={tpInput} onChange={(e) => setTpInput(e.target.value)} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
            <span style={label}>下止损价格</span>
            <input style={{ ...input, minWidth: 110 }} placeholder="24" value={slInput} onChange={(e) => setSlInput(e.target.value)} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
            <span style={label}>主观胜率（%）</span>
            <input style={{ ...input, minWidth: 90 }} placeholder="75" value={wrInput} onChange={(e) => setWrInput(e.target.value)} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
            <span style={label}>仓位可用最大金额</span>
            <input style={{ ...input, minWidth: 130 }} placeholder="50000" value={amtInput} onChange={(e) => setAmtInput(e.target.value)} />
          </div>
          <button style={btn} onClick={() => void runCalculate()} disabled={loading} type="button">
            {loading ? "计算中…" : "🧮 计算"}
          </button>
        </div>
      </div>

      {err && <ErrorCard>{err}</ErrorCard>}

      {/* 结果 */}
      {result?.ok && (
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: "0.6rem" }}>📊 凯利仓位建议</div>
          {/* 核心参数 */}
          <div style={{ display: "flex", gap: "1.2rem", flexWrap: "wrap", fontSize: "0.88rem", marginBottom: "0.7rem", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.6rem 0.9rem" }}>
            <span>当前价格 <b>{result.price}</b></span>
            <span>上止盈 <b>{result.takeProfit}</b>，下止损 <b>{result.stopLoss}</b></span>
            <span>胜率 <b>{pct(result.winRate)}</b></span>
            <span>盈亏比 <b>{result.b.toFixed(2)}</b></span>
            <span>期望优势 <b>{pct(result.edge)}</b></span>
            <span>凯利原始比例 <b>{pct(Math.min(result.fRaw, 1))}</b></span>
          </div>

          {result.noPositiveEdge ? (
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "0.7rem 1rem", fontSize: "0.88rem", color: "#991b1b" }}>
              ⚠️ <b>无正期望，凯利公式建议不开仓。</b>
              <br />当前胜率与盈亏比组合下，交易的期望收益非正，任何正仓位都将损害长期资本增长。请重新评估胜率或调整止盈/止损价格。
            </div>
          ) : result.allZero ? (
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "0.7rem 1rem", fontSize: "0.88rem", color: "#991b1b" }}>
              ⚠️ <b>无有效仓位</b>：在当前仓位可用最大金额下，按凯利公式计算所得的理论仓位低于最小交易单位（100股），无法建仓。建议增加配额或选择单价更低的标的。
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ background: "#f1f5f9", color: "#475569" }}>
                  <th style={{ padding: "0.45rem 0.6rem", textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>方案</th>
                  <th style={{ padding: "0.45rem 0.6rem", textAlign: "right", borderBottom: "1px solid #e2e8f0" }}>占配额比例</th>
                  <th style={{ padding: "0.45rem 0.6rem", textAlign: "right", borderBottom: "1px solid #e2e8f0" }}>开仓资金</th>
                  <th style={{ padding: "0.45rem 0.6rem", textAlign: "right", borderBottom: "1px solid #e2e8f0" }}>份额数量</th>
                  <th style={{ padding: "0.45rem 0.6rem", textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>说明</th>
                </tr>
              </thead>
              <tbody>
                {result.schemes?.map((s) => (
                  <tr key={s.key} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "0.45rem 0.6rem", fontWeight: 600, color: SCHEME_COLORS[s.key] }}>
                      {SCHEME_ICONS[s.key]} {s.label}
                    </td>
                    <td style={{ padding: "0.45rem 0.6rem", textAlign: "right" }}>{s.pct.toFixed(2)}%</td>
                    <td style={{ padding: "0.45rem 0.6rem", textAlign: "right" }}>{money(s.cash)}</td>
                    <td style={{ padding: "0.45rem 0.6rem", textAlign: "right" }}>{s.shares}</td>
                    <td style={{ padding: "0.45rem 0.6rem", fontSize: "0.78rem", color: "#64748b" }}>{s.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* 风险警示 */}
          <div style={{ marginTop: "0.8rem", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, padding: "0.6rem 0.9rem", fontSize: "0.82rem", color: "#9a3412" }}>
            <b>🚨 风险警示</b>
            <br />⚠️ 主观胜率仅为估算，实际胜率可能严重偏离，历史表现不代表未来。
            <br />⚠️ 凯利仓位波动极大，最大回撤可能超出心理承受，请务必优先采用分数凯利。
            <br />⚠️ 严禁超过建议的仓位上限，盘中不得临时追加资金，突破配额将导致不可控亏损。
            {result.cutMessage && (
              <div style={{ marginTop: "0.4rem", color: "#b91c1c" }}>&gt; {result.cutMessage}</div>
            )}
          </div>
        </div>
      )}

      {/* 程序性提示词 */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>📜 程序性提示词</span>
          <button style={{ ...btn, background: "#64748b", padding: "0.4rem 0.9rem", fontSize: "0.82rem" }} onClick={() => setShowPrompt((v) => !v)} type="button">
            {showPrompt ? "🙈 收起提示词" : "📜 查看提示词"}
          </button>
          {showPrompt && (
            <>
              <button style={{ ...btn, background: "#16a34a", padding: "0.4rem 0.9rem", fontSize: "0.82rem" }} onClick={copyPrompt} type="button">
                {copied ? "✅ 已复制" : "📋 复制"}
              </button>
              <button style={{ ...btn, background: "#0891b2", padding: "0.4rem 0.9rem", fontSize: "0.82rem" }} onClick={() => openChat(promptText)} type="button">
                💬 Chat
              </button>
            </>
          )}
        </div>
        {showPrompt && (
          <div style={{ marginTop: "0.7rem" }}>
            <CodeBlock maxHeight="24rem">{promptText ?? "（提示词加载中…）"}</CodeBlock>
          </div>
        )}
        {chatHint && (
          <div style={{ color: "#0891b2", fontSize: "0.82rem", marginTop: "0.5rem" }}>
            💬 已打开 DeepSeek 网页版并将提示词复制到剪贴板；请在对话输入框粘贴后发送。
          </div>
        )}
      </div>

      {/* 历史记录 */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <button style={{ background: "none", border: "none", cursor: "pointer", fontWeight: 700, fontSize: "0.95rem", color: "#334155", padding: 0 }} onClick={() => setShowHistory((v) => !v)} type="button">
            🕘 历史凯利仓位（{historyList.length}）{showHistory ? " ▾" : " ▸"}
          </button>
          {historyList.length > 0 && (
            <span style={{ fontSize: "0.75rem", color: "#94a3b8" }}>计算成功自动保存，上限 50 条</span>
          )}
        </div>
        {showHistory && (
          <div style={{ marginTop: "0.6rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {historyList.length === 0 ? (
              <span style={{ color: "#94a3b8", fontSize: "0.85rem" }}>暂无历史记录</span>
            ) : (
              historyList.map((e) => (
                <div key={e.id} style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", padding: "0.45rem 0.7rem", border: "1px solid #e2e8f0", borderRadius: 8, background: "#f8fafc", fontSize: "0.82rem" }}>
                  <span style={{ fontWeight: 600 }}>
                    {e.summary.name ? `${e.summary.name} ` : ""}
                    价{e.summary.price}·盈{e.summary.takeProfit}·损{e.summary.stopLoss}·胜率{pct(e.summary.winRate)}
                  </span>
                  <span style={{ color: "#64748b" }}>
                    盈亏比 {e.summary.b.toFixed(2)} · 凯利 {e.summary.kellyPct.toFixed(2)}%（{money(e.summary.kellyCash)}）
                  </span>
                  <span style={{ color: "#94a3b8", fontSize: "0.75rem" }}>
                    {e.summary.code ? `${e.summary.code} · ` : ""}{new Date(e.createdAt).toLocaleString()}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button style={{ ...btn, background: "#0891b2", padding: "0.25rem 0.7rem", fontSize: "0.78rem" }} onClick={() => void viewHistory(e.id)} type="button">
                    查看
                  </button>
                  <button style={{ ...btn, background: "#dc2626", padding: "0.25rem 0.7rem", fontSize: "0.78rem" }} onClick={() => void deleteHistoryEntry(e.id)} type="button">
                    删除
                  </button>
                </div>
              ))
            )}
          </div>
        )}
        {viewingResult && (
          <div style={{ marginTop: "0.8rem", padding: "0.7rem 0.9rem", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8 }}>
            <div style={{ fontWeight: 700, fontSize: "0.9rem", marginBottom: "0.4rem" }}>📄 历史详情（{viewingId?.slice(0, 8)}）</div>
            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", fontSize: "0.84rem", marginBottom: "0.4rem" }}>
              <span>胜率 {pct(viewingResult.winRate)}</span>
              <span>盈亏比 {viewingResult.b.toFixed(2)}</span>
              <span>期望优势 {pct(viewingResult.edge)}</span>
              <span>凯利原始 {pct(Math.min(viewingResult.fRaw, 1))}</span>
            </div>
            {viewingResult.noPositiveEdge ? (
              <div style={{ fontSize: "0.85rem", color: "#b91c1c" }}>无正期望，凯利公式建议不开仓。</div>
            ) : viewingResult.allZero ? (
              <div style={{ fontSize: "0.85rem", color: "#b91c1c" }}>无有效仓位（低于最小交易单位 100 股）。</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
                <tbody>
                  {viewingResult.schemes?.map((s) => (
                    <tr key={s.key} style={{ borderBottom: "1px solid #fef3c7" }}>
                      <td style={{ padding: "0.3rem 0.4rem", fontWeight: 600, color: SCHEME_COLORS[s.key] }}>{SCHEME_ICONS[s.key]} {s.label}</td>
                      <td style={{ padding: "0.3rem 0.4rem", textAlign: "right" }}>{s.pct.toFixed(2)}%</td>
                      <td style={{ padding: "0.3rem 0.4rem", textAlign: "right" }}>{money(s.cash)}</td>
                      <td style={{ padding: "0.3rem 0.4rem", textAlign: "right" }}>{s.shares} 股</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
