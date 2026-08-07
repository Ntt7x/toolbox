import { useEffect, useState, type CSSProperties } from "react";
import { api, errMsg } from "../api";
import { openDeepSeekChat } from "../deepseekChat";
import { useAsyncTask } from "../hooks/useAsyncTask";
import { CodeBlock, ErrorCard, PageHeader } from "../ui";
import { TaskHistory } from "../components/TaskHistory";
import type { TreasuryFxResponse, TreasuryFxRow } from "@toolbox/shared";

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

const chip = (active: boolean): CSSProperties => ({
  padding: "0.45rem 1rem",
  borderRadius: 999,
  border: `1.5px solid ${active ? "#3b82f6" : "#e2e8f0"}`,
  background: active ? "#eff6ff" : "#fff",
  color: active ? "#1d4ed8" : "#475569",
  fontWeight: active ? 700 : 500,
  cursor: "pointer",
});

const table: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" };
const thTd: CSSProperties = { border: "1px solid #e2e8f0", padding: "0.45rem 0.5rem", textAlign: "center" };
const th: CSSProperties = { ...thTd, background: "#f1f5f9", fontWeight: 600 };

const DAY_OPTIONS = [1, 3, 5, 10];
const dayLabel = (d: number) => (d === 1 ? "今天" : `最近 ${d} 个交易日`);

export default function TreasuryFxTool() {
  const [days, setDays] = useState(1);
  const [withSearch, setWithSearch] = useState(true);
  const [withCache, setWithCache] = useState(true);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [cacheHint, setCacheHint] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);
  const [chatHint, setChatHint] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [promptText, setPromptText] = useState<string | null>(null);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const task = useAsyncTask<TreasuryFxResponse>("treasuryFxTaskId", api.treasuryFxTaskStatus, api.cancelTask);
  const result = task.result;
  const err = task.error ?? localErr;
  const taskRunning = task.running;
  const taskId = task.taskId;

  // 任务运行计时（任务信息：已运行时长）
  const [runSec, setRunSec] = useState(0);
  useEffect(() => {
    if (!taskRunning) {
      setRunSec(0);
      return;
    }
    const t = setInterval(() => setRunSec((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [taskRunning]);

  const run = async () => {
    setShowRaw(false);
    setLoading(true);
    setCacheHint(false);
    try {
      const t = await api.treasuryFx({ days, search: withSearch, useCache: withCache });
      if (!t.ok) {
        setLocalErr(t.message);
        return;
      }
      // 缓存命中（cache- 前缀 taskId）：瞬时完成，给出明确反馈避免「点了没反应」的错觉
      if (t.taskId && t.taskId.startsWith("cache-")) setCacheHint(true);
      task.watch(t.taskId, t);
    } catch (e) {
      setLocalErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  const copyPrompt = async () => {
    if (!promptText) return;
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用：静默
    }
  };

  /** 携带提示词跳转 DeepSeek 网页版 Chat（剪贴板中转：网页版不支持 URL 预填输入） */
  const openChat = async (text: string | null) => {
    if (!text || chatBusy) return;
    setChatBusy(true);
    try {
      // 一键去 Chat：服务端 playwright 自动打开浏览器、开深度思考/智能搜索、填入提示词并自动发送
      const msg = await openDeepSeekChat(text);
      setChatHint(msg);
    } catch (e) {
      setChatHint("❌ " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setChatBusy(false);
    }
  };

  // 挂载时从「本地设置数据」加载程序性提示词（展示/复制）
  useEffect(() => {
    void api
      .promptDetail("treasury-fx.system")
      .then((r) => {
        if (r.ok) setPromptText(r.rendered);
      })
      .catch(() => {});
  }, []);

  return (
    <div>
      <PageHeader
        title="🏦 国债汇率分析"
        desc="人民币短波段研判框架（汇率套利 + 债券信号）：USDJPY / USDCNY 日变动率排序决定资金流向，中日 10Y 国债利差作为主升浪「发令枪」。需要先在「🤖 LLM 设置」中配置 DeepSeek API key。"
      />

      {/* 参数区 */}
      <div style={card}>
        {/* 第一行：分析窗口 */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          <span style={{ fontWeight: 600, marginRight: "0.2rem" }}>分析窗口：</span>
          {DAY_OPTIONS.map((d) => (
            <button key={d} style={chip(days === d)} onClick={() => setDays(d)} type="button">
              {dayLabel(d)}
            </button>
          ))}
        </div>
        {/* 第二行：开关 + 操作按钮（开始分析 / 查看提示词） */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.9rem", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.88rem", cursor: "pointer" }}>
            <input type="checkbox" checked={withSearch} onChange={(e) => setWithSearch(e.target.checked)} />
            📡 联网搜索（实时数据，较慢）
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.88rem", cursor: "pointer" }}>
            <input type="checkbox" checked={withCache} onChange={(e) => setWithCache(e.target.checked)} />
            💾 缓存（命中免调 LLM）
          </label>
          <span style={{ flex: 1 }} />
          <button style={btn} onClick={run} disabled={loading || taskRunning} type="button">
            {loading ? "提交中…" : taskRunning ? "⏳ 后台分析中…" : "⚡ 开始分析"}
          </button>
          {/* 查看提示词并入按钮组（更紧凑；紫色小按钮） */}
          <button
            style={{ ...btn, background: "#7c3aed", fontWeight: 500, padding: "0.55rem 1rem" }}
            onClick={() => setShowPrompt((v) => !v)}
            type="button"
          >
            {showPrompt ? "🙈 收起提示词" : "📜 查看提示词"}
          </button>
        </div>
        {/* 提示词展开（紧跟按钮组下方，位置直观） */}
        {showPrompt && (
          <div style={{ marginTop: "0.9rem", borderTop: "1px dashed #e2e8f0", paddingTop: "0.8rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
              <button style={{ ...btn, background: "#16a34a", padding: "0.4rem 1rem", fontSize: "0.82rem" }} onClick={copyPrompt} type="button">
                {copied ? "✅ 已复制" : "📋 复制"}
              </button>
              <button style={{ ...btn, background: "#0891b2", padding: "0.4rem 1rem", fontSize: "0.82rem" }} onClick={() => openChat(promptText)} type="button">
                💬 去 Chat{chatBusy ? "…" : ""}
              </button>
              <span style={{ color: "#94a3b8", fontSize: "0.78rem" }}>
                本功能由 LLM 提示词固化而来；提示词统一存储于「本地设置数据」，可编辑与重置
              </span>
            </div>
            <CodeBlock maxHeight="22rem">{promptText ?? "（提示词加载中…）"}</CodeBlock>
            {chatHint && (
              <div style={{ color: chatHint?.startsWith("❌") ? "#dc2626" : "#0891b2", fontSize: "0.82rem", marginTop: "0.5rem" }}>
                {chatHint}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 后台任务进行中提示 */}
      {taskRunning && (
        <div style={{ ...card, borderColor: "#fcd34d", background: "#fffbeb", color: "#b45309" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 600 }}>
              ⏳ 分析任务已在后台运行{taskId ? `（任务 ${taskId.slice(0, 8)}…）` : ""}，已耗时 <b>{runSec}s</b>，每 3 秒自动刷新。
            </div>
            <button style={{ ...btn, background: "#dc2626", marginLeft: "auto" }} onClick={() => void task.cancel()} type="button">
              ⏹ 停止分析
            </button>
          </div>
          <div style={{ fontSize: "0.85rem", marginTop: "0.3rem" }}>
            你可以放心切换到其它页面（或刷新），分析不会被中断；完成后回到本页会自动展示结果。卡住时可点「停止分析」强行中断。
          </div>
        </div>
      )}

      {/* 错误 */}
      {err && <ErrorCard>❌ {err}</ErrorCard>}

      {/* 缓存命中提示（瞬时完成反馈） */}
      {cacheHint && (
        <div style={{ ...card, borderColor: "#fde68a", background: "#fffbeb", color: "#b45309", padding: "0.7rem 1rem" }}>
          💾 已从缓存加载（{new Date().toLocaleTimeString()}）——参数未变化时命中缓存免调 LLM；如需最新数据请关闭「缓存」或修改参数。
        </div>
      )}

      {/* 结果 */}
      {result && <ResultView r={result} showRaw={showRaw} setShowRaw={setShowRaw} />}

      {/* 历史任务（KV 持久化，回看以往分析） */}
      <TaskHistory
        module="treasury-fx"
        refreshKey={taskId}
        renderResult={(v) => <ResultView r={v as TreasuryFxResponse} showRaw={false} setShowRaw={() => undefined} />}
      />
    </div>
  );
}

// ---------- 结果视图 ----------

function ResultView({
  r,
  showRaw,
  setShowRaw,
}: {
  r: TreasuryFxResponse;
  showRaw: boolean;
  setShowRaw: (v: boolean) => void;
}) {
  return (
    <div>
      {/* 小结 */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: "1.02rem" }}>📊 框架判定</span>
          <span style={{ background: "#f1f5f9", color: "#475569", padding: "0.2rem 0.6rem", borderRadius: 999, fontSize: "0.8rem" }}>
            数据截至：{r.asOf || "未知"}
          </span>
          {r.dataMode === "search" ? (
            <span style={{ background: "#dcfce7", color: "#15803d", padding: "0.2rem 0.6rem", borderRadius: 999, fontSize: "0.8rem", fontWeight: 600 }}>
              📡 联网实时数据
            </span>
          ) : (
            <span style={{ background: "#fee2e2", color: "#b91c1c", padding: "0.2rem 0.6rem", borderRadius: 999, fontSize: "0.8rem", fontWeight: 600 }}>
              ⚠️ 模型知识模式{r.knowledgeCutoff ? `（知识截至 ${r.knowledgeCutoff}）` : ""}
            </span>
          )}
          {r.fromCache && (
            <span style={{ background: "#fef3c7", color: "#b45309", padding: "0.2rem 0.6rem", borderRadius: 999, fontSize: "0.8rem", fontWeight: 600 }}>
              💾 来自缓存{r.cachedAt ? `（${new Date(r.cachedAt).toLocaleString()}）` : ""}
            </span>
          )}
          <span style={{ color: "#94a3b8", fontSize: "0.78rem" }}>模型：{r.model}</span>
        </div>
        {r.dataMode === "knowledge" && (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", borderRadius: 8, padding: "0.5rem 0.8rem", fontSize: "0.82rem", marginTop: "0.6rem" }}>
            ⚠️ 当前为<b>知识模式</b>：汇率/国债数据来自模型训练知识，可能过时，请勿用于实盘决策；建议开启「联网搜索」。
          </div>
        )}
        <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.7, marginTop: "0.6rem", fontSize: "0.92rem" }}>{r.summary}</p>
      </div>

      {/* 数据速览表 */}
      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: "0.6rem" }}>📈 汇率/国债数据速览（近 {r.days} 个交易日）</div>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>日期</th>
              <th style={th}>USDJPY</th>
              <th style={th}>USDCNY</th>
              <th style={th}>UJ%</th>
              <th style={th}>UC%</th>
              <th style={th}>排序判定</th>
              <th style={th}>JP10Y</th>
              <th style={th}>CN10Y</th>
              <th style={th}>利差(BP)</th>
            </tr>
          </thead>
          <tbody>
            {r.rows.map((row: TreasuryFxRow, i: number) => (
              <tr key={i}>
                <td style={thTd}><b>{row.date}</b></td>
                <td style={thTd}>{row.usdjpy ?? "—"}</td>
                <td style={thTd}>{row.usdcny ?? "—"}</td>
                <td style={thTd}>{row.uj ?? "—"}</td>
                <td style={thTd}>{row.uc ?? "—"}</td>
                <td style={{ ...thTd, fontWeight: 700 }}>{row.rank ?? "—"}</td>
                <td style={thTd}>{row.jp10y ?? "—"}</td>
                <td style={thTd}>{row.cn10y ?? "—"}</td>
                <td style={thTd}>{row.spreadBp ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 操作结论 */}
      {r.conclusion && (
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: "0.5rem" }}>🎯 操作结论</div>
          <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.7, fontSize: "0.92rem", margin: 0 }}>{r.conclusion}</p>
        </div>
      )}

      {/* 搜索查询词 */}
      {r.searchQueries && r.searchQueries.length > 0 && (
        <div style={{ ...card, background: "#f8fafc" }}>
          <div style={{ fontWeight: 700, marginBottom: "0.4rem" }}>🔎 联网搜索查询词</div>
          <div style={{ fontSize: "0.82rem", color: "#475569", lineHeight: 1.7 }}>
            {r.searchQueries.map((q, i) => (
              <div key={i}>· {q}</div>
            ))}
          </div>
        </div>
      )}

      {/* 原始输出 */}
      {r.raw && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <span style={{ fontWeight: 700 }}>📄 LLM 原始输出</span>
            <button
              style={{ ...btn, background: "#64748b", padding: "0.3rem 0.8rem", fontSize: "0.8rem" }}
              onClick={() => setShowRaw(!showRaw)}
              type="button"
            >
              {showRaw ? "收起" : "展开"}
            </button>
          </div>
          {showRaw && <CodeBlock maxHeight="20rem">{r.raw}</CodeBlock>}
        </div>
      )}
    </div>
  );
}
