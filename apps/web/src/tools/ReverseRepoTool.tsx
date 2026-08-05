import { useEffect, useState, type CSSProperties } from "react";
import { api, errMsg } from "../api";
import { useAsyncTask } from "../hooks/useAsyncTask";
import { CodeBlock, ErrorCard, PageHeader } from "../ui";
import BalanceChart from "../components/BalanceChart";
import type {
  ReverseRepoDailyResponse,
  ReverseRepoMonthlyResult,
  ReverseRepoMonthlyRow,
  ReverseRepoOperation,
} from "@toolbox/shared";

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

const table: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" };
const thTd: CSSProperties = { border: "1px solid #e2e8f0", padding: "0.45rem 0.5rem", textAlign: "center" };
const th: CSSProperties = { ...thTd, background: "#f1f5f9", fontWeight: 600 };

const fmtW = (n: number) => `${(n / 10000).toFixed(n >= 100000 ? 2 : 3)}万亿`;

export default function ReverseRepoTool() {
  // 存量数据（权威种子，直接读取）
  const [monthly, setMonthly] = useState<ReverseRepoMonthlyResult | null>(null);
  const [monthlyErr, setMonthlyErr] = useState<string | null>(null);
  // 增量每日变动
  const dailyTask = useAsyncTask<ReverseRepoDailyResponse>(
    "reverseRepoDailyTaskId",
    api.reverseRepoDailyTaskStatus,
    api.cancelTask,
  );
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);
  const [chatHint, setChatHint] = useState(false);
  const [promptText, setPromptText] = useState<string | null>(null);
  const [dailyErr, setDailyErr] = useState<string | null>(null);

  const daily = dailyTask.result;

  const probeDaily = async (force: boolean) => {
    setDailyErr(null);
    try {
      const t = await api.reverseRepoDaily(force);
      if (!t.ok) {
        setDailyErr(t.message);
        return;
      }
      dailyTask.watch(t.taskId, t);
    } catch (e) {
      setDailyErr(errMsg(e));
    }
  };

  const copyPrompt = async () => {
    if (!promptText) return;
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 静默
    }
  };

  const openChat = (text: string | null) => {
    if (!text) return;
    window.open("https://chat.deepseek.com/", "_blank", "noopener");
    void navigator.clipboard.writeText(text).catch(() => {});
    setChatHint(true);
    setTimeout(() => setChatHint(false), 8000);
  };

  // 挂载：读取存量数据 + 每日探查提示词
  useEffect(() => {
    void api
      .reverseRepoMonthly()
      .then((r) => setMonthly(r))
      .catch((e) => setMonthlyErr(errMsg(e)));
    void api
      .promptDetail("reverse-repo.daily")
      .then((r) => {
        if (r.ok) setPromptText(r.rendered);
      })
      .catch(() => {});
  }, []);

  return (
    <div>
      <PageHeader
        title="🏛️ 买断式逆回购余额"
        desc="央行买断式逆回购（2024 年 10 月推出的中期流动性工具，3M/6M）存量余额跟踪：逐笔操作流水 + 月度汇总 + 存量余额曲线（累计净投放口径，权威数据）；每日变动量探查 + 当月变动量说明（LLM 增量）。仅关注买断式逆回购。"
      />

      {/* 存量部分 */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: "1rem" }}>📊 存量余额（买断式逆回购）</span>
          <span style={{ color: "#94a3b8", fontSize: "0.82rem" }}>
            存量余额 = 累计净投放（2026-03 锚点 7.2 万亿元）；逐笔与月度数据经多轮修订整合
          </span>
        </div>
        {monthlyErr && <div style={{ color: "#b91c1c", marginTop: "0.5rem" }}>❌ {monthlyErr}</div>}
        {monthly && monthly.ok && (
          <div style={{ marginTop: "0.8rem" }}>
            <div style={{ fontSize: "0.8rem", color: "#94a3b8", marginBottom: "0.6rem" }}>{monthly.source}</div>

            {/* 余额曲线 + 逐笔投放（ECharts：x 轴精确到月/日期，缩放+十字准星+峰谷标注） */}
            <div style={{ fontWeight: 600, marginBottom: "0.3rem" }}>
              📈 买断式逆回购存量余额曲线（亿元，累计净投放；柱=逐笔投放，右轴）
            </div>
            <BalanceChart series={monthly.series} operations={monthly.operations} />

            {/* 月度汇总表 */}
            <div style={{ fontWeight: 600, margin: "0.8rem 0 0.3rem" }}>📋 月度汇总表（亿元；每日经济新闻口径，推算补充）</div>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>月份</th>
                  <th style={th}>操作日期</th>
                  <th style={th}>投放</th>
                  <th style={th}>3M</th>
                  <th style={th}>6M</th>
                  <th style={th}>净投放</th>
                  <th style={th}>累计净投放=存量</th>
                  <th style={th}>备注</th>
                </tr>
              </thead>
              <tbody>
                {monthly.rows.map((r: ReverseRepoMonthlyRow, i: number) => (
                  <tr key={i}>
                    <td style={thTd}><b>{r.month}</b></td>
                    <td style={thTd}>{r.opDate}</td>
                    <td style={thTd}>{r.operationTotal}</td>
                    <td style={thTd}>{r.m3}</td>
                    <td style={thTd}>{r.m6}</td>
                    <td style={{ ...thTd, color: (r.netChange ?? 0) >= 0 ? "#15803d" : "#dc2626", fontWeight: 600 }}>
                      {r.netChange !== null ? (r.netChange >= 0 ? `+${r.netChange}` : `${r.netChange}`) : "—"}
                    </td>
                    <td style={{ ...thTd, fontWeight: 700 }}>
                      {r.cumulativeNet !== null ? r.cumulativeNet : "—"}
                    </td>
                    <td style={{ ...thTd, textAlign: "left", fontSize: "0.78rem" }}>{r.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* 逐笔操作流水 */}
            <div style={{ fontWeight: 600, margin: "0.8rem 0 0.3rem" }}>
              🧾 逐笔操作流水表（精确到年月日，共 {monthly.operations.length} 笔）
            </div>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>操作日期</th>
                  <th style={th}>期限</th>
                  <th style={th}>金额(亿)</th>
                  <th style={th}>公告/来源</th>
                </tr>
              </thead>
              <tbody>
                {monthly.operations.map((op: ReverseRepoOperation, i: number) => (
                  <tr key={i}>
                    <td style={thTd}><b>{op.date}</b></td>
                    <td style={thTd}>{op.term}</td>
                    <td style={thTd}>{op.amount}</td>
                    <td style={{ ...thTd, textAlign: "left", fontSize: "0.78rem" }}>{op.source ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 增量部分：每日变动探查 */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: "1rem" }}>📈 每日变动量探查（LLM，仅买断式）</span>
          <button style={btn} onClick={() => void probeDaily(false)} disabled={dailyTask.running} type="button">
            {dailyTask.running ? "探查中…" : "🔎 探查今日变动"}
          </button>
          <button
            style={{ ...btn, background: "#dc2626" }}
            onClick={() => void probeDaily(true)}
            disabled={dailyTask.running}
            type="button"
          >
            ♻️ 强制刷新
          </button>
          <span style={{ color: "#94a3b8", fontSize: "0.82rem" }}>当日/最近变动 + 当月买断式逆回购变动量说明。</span>
        </div>
        {dailyErr && <div style={{ color: "#b91c1c", marginTop: "0.5rem" }}>❌ {dailyErr}</div>}
        {daily && (
          <div style={{ marginTop: "0.8rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", fontSize: "0.85rem", color: "#475569" }}>
              <span>数据截至：{daily.asOf}</span>
              {daily.currentBalance !== undefined && (
                <span style={{ background: "#dcfce7", color: "#15803d", padding: "0.15rem 0.5rem", borderRadius: 999, fontWeight: 600 }}>
                  存量余额 ≈ {fmtW(daily.currentBalance)}
                </span>
              )}
              {daily.fromCache && <span style={{ background: "#fef3c7", color: "#b45309", padding: "0.15rem 0.5rem", borderRadius: 999 }}>💾 缓存</span>}
            </div>
            <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, fontSize: "0.88rem", margin: "0.6rem 0" }}>
              <b>当月变动量说明：</b>
              {daily.monthSummary}
            </p>
            {daily.dailyChanges.length > 0 && (
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th}>日期</th>
                    <th style={th}>类型</th>
                    <th style={th}>方向</th>
                    <th style={th}>金额(亿)</th>
                    <th style={th}>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {daily.dailyChanges.map((c, i) => (
                    <tr key={i}>
                      <td style={thTd}><b>{c.date}</b></td>
                      <td style={thTd}>{c.type}{c.term ? ` (${c.term})` : ""}</td>
                      <td style={thTd}>{c.kind}</td>
                      <td style={thTd}>{c.amount}</td>
                      <td style={{ ...thTd, textAlign: "left", fontSize: "0.78rem" }}>{c.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* 提示词 */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
          <button style={{ ...btn, background: "#7c3aed" }} onClick={() => setShowPrompt((v) => !v)} type="button">
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
            增量部分由 LLM 提示词驱动（每日变动探查 reverse-repo.daily）；提示词统一存储于「本地设置数据」
          </span>
        </div>
        {showPrompt && <CodeBlock maxHeight="24rem">{promptText ?? "（提示词加载中…）"}</CodeBlock>}
        {chatHint && (
          <div style={{ color: "#0891b2", fontSize: "0.82rem", marginTop: "0.5rem" }}>
            💬 已打开 DeepSeek 网页版并复制提示词；请在输入框粘贴（Ctrl/Cmd+V）后发送。
          </div>
        )}
      </div>
    </div>
  );
}
