import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api, errMsg } from "../api";
import { openDeepSeekChat } from "../deepseekChat";
import { useDataInfraTask } from "../hooks/useDataInfraTask";
import { CodeBlock, ErrorCard, PageHeader } from "../ui";
import { TaskHistory } from "../components/TaskHistory";
import type { CbAction, CbRatePeriod, CbRateBank, CbRateRequest, CbRateResponse } from "@toolbox/shared";

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
  const [withCache, setWithCache] = useState(true);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);
  const [chatHint, setChatHint] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  // 程序性提示词（统一数据链路：API → 本地设置数据）
  const [promptText, setPromptText] = useState<string | null>(null);
  // 后台异步任务（统一模式：data-infra 任务——SSE 状态/进度 + 轮询兜底 + sessionStorage 恢复 + 停止）
  const task = useDataInfraTask<CbRateResponse>({
    storageKey: "cbRateTaskId",
    create: async () => {
      const t = await api.cbRate(reqRef.current!);
      if (!t.ok) throw new Error(t.message);
      if (t.result) return { result: t.result as CbRateResponse };
      return { taskId: t.taskId };
    },
    fetchResult: (taskId) => api.dataInfraResult<CbRateResponse>(taskId),
    cancel: (taskId) => api.cancelTask(taskId),
  });
  const reqRef = useRef<CbRateRequest | null>(null); // run 里赋值，create 闭包读取最新请求
  const running = task.state.status === "running";
  const [localErr, setLocalErr] = useState<string | null>(null); // 本地一次性错误（非任务错误）
  // result 恒为 CbRateResponse（ok:true）——错误统一走 task.state.error/localErr，不再断言联合类型
  const result = task.state.result;
  const err = task.state.error ?? localErr;
  const taskRunning = running;
  const taskId = task.state.taskId;

  // 任务运行计时（任务信息：已运行时长）
  const [runSec, setRunSec] = useState(0);
  // 挂载恢复：跨页/刷新后继续等待 data-infra 任务
  useEffect(() => { task.resumeIfPending(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => {
    if (!taskRunning) {
      setRunSec(0);
      return;
    }
    const t = setInterval(() => setRunSec((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [taskRunning]);

  const toggleBank = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const run = async () => {
    setShowRaw(false);
    setLoading(true);
    try {
      reqRef.current = {
        period,
        ...(monthSel ? { month: monthSel } : {}),
        ...(selected.size > 0 ? { banks: [...selected] } : {}),
        withCalendar,
        search: withSearch,
        useCache: withCache,
      };
      await task.run(); // 统一模式：create 内部提交 + SSE 监听；缓存命中直接落地（result.fromCache 展示）
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
      // 剪贴板不可用（非 https/权限）：静默忽略
    }
  };

  // 挂载时从「本地设置数据」加载程序性提示词（展示/复制）
  useEffect(() => {
    void api
      .promptDetail("cb-rate.system")
      .then((r) => {
        if (r.ok) setPromptText(r.rendered);
      })
      .catch(() => {
        // 加载失败静默：提示词区块显示占位文案
      });
  }, []);

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

  return (
    <div>
      <PageHeader
        title="🏦 央行利率分析"
        desc="九大央行利率政策时间线分析（LLM 驱动）。数据基于模型知识，请留意「数据截至日期」。需要先在「🤖 LLM 设置」中配置 DeepSeek API key。"
      />

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
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.88rem", cursor: "pointer" }}>
            <input type="checkbox" checked={withCache} onChange={(e) => setWithCache(e.target.checked)} />
            💾 缓存（命中免调 LLM）
          </label>
          <span style={{ flex: 1 }} />
          <button style={btn} onClick={run} disabled={loading || taskRunning} type="button">
            {loading ? "提交中…" : taskRunning ? "⏳ 后台分析中…" : "⚡ 开始分析"}
          </button>
          {/* 查看提示词并入开始分析按钮组（与国债汇率分析一致） */}
          <button
            style={{ ...btn, background: "#7c3aed", fontWeight: 500, padding: "0.55rem 1rem" }}
            onClick={() => setShowPrompt((v) => !v)}
            type="button"
          >
            {showPrompt ? "🙈 收起提示词" : "📜 查看提示词"}
          </button>
        </div>
        {/* 提示词展开（紧跟按钮组下方，与国债汇率分析一致） */}
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
                本功能即由该 LLM 提示词固化而来（默认版：联网搜索 + 会议日历）；提示词统一存储于「本地设置数据」，可编辑与重置
              </span>
            </div>
            <CodeBlock maxHeight="22rem">{promptText ?? "（提示词加载中…）"}</CodeBlock>
            {chatHint && <div style={{ color: chatHint?.startsWith("❌") ? "#dc2626" : "#0891b2", fontSize: "0.82rem", marginTop: "0.5rem" }}>{chatHint}</div>}
          </div>
        )}
      </div>

      {/* 后台任务进行中提示（可切走页面，稍后回来查看） */}
      {taskRunning && (
        <div style={{ ...card, borderColor: "#fcd34d", background: "#fffbeb", color: "#b45309" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 600 }}>
              ⏳ 分析任务已在后台运行{taskId ? `（任务 ${taskId.slice(0, 8)}…）` : ""}，已耗时 <b>{runSec}s</b>，每 3 秒自动刷新。
            </div>
            <button
              style={{ ...btn, background: "#dc2626", marginLeft: "auto" }}
              onClick={() => void task.cancel()}
              type="button"
            >
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

      {/* 缓存命中提示（瞬时完成反馈，与国债汇率分析一致） */}
      {result?.fromCache && (
        <div style={{ ...card, borderColor: "#fde68a", background: "#fffbeb", color: "#b45309", padding: "0.7rem 1rem" }}>
          💾 已从缓存加载（{result.cachedAt ? new Date(result.cachedAt).toLocaleTimeString() : new Date().toLocaleTimeString()}）——参数未变化时命中缓存免调 LLM；如需最新数据请关闭「缓存」或修改参数。
        </div>
      )}

      {/* 结果（result 恒为 ok:true，错误已由上方 err 分支展示） */}
      {result && (
        <div>
          {/* 小结 */}
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, fontSize: "1.02rem" }}>📊 政策取向小结</span>
              <span style={{ background: "#f1f5f9", color: "#475569", padding: "0.2rem 0.6rem", borderRadius: 999, fontSize: "0.8rem" }}>
                数据截至：{result.asOf || "未知"}
              </span>
              {result.dataMode === "search" ? (
                <span style={{ background: "#dcfce7", color: "#15803d", padding: "0.2rem 0.6rem", borderRadius: 999, fontSize: "0.8rem", fontWeight: 600 }}>
                  📡 联网实时数据
                </span>
              ) : (
                <span style={{ background: "#fee2e2", color: "#b91c1c", padding: "0.2rem 0.6rem", borderRadius: 999, fontSize: "0.8rem", fontWeight: 600 }}>
                  ⚠️ 模型知识模式{result.knowledgeCutoff ? `（知识截至 ${result.knowledgeCutoff}）` : ""}
                </span>
              )}
              {result.fromCache && (
                <span style={{ background: "#fef3c7", color: "#b45309", padding: "0.2rem 0.6rem", borderRadius: 999, fontSize: "0.8rem", fontWeight: 600 }}>
                  💾 来自缓存{result.cachedAt ? `（${new Date(result.cachedAt).toLocaleString()}）` : ""}
                </span>
              )}
              <span style={{ color: "#94a3b8", fontSize: "0.78rem" }}>模型：{result.model}</span>
            </div>
            {result.dataMode === "knowledge" && (
              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", borderRadius: 8, padding: "0.5rem 0.8rem", fontSize: "0.82rem", marginTop: "0.6rem" }}>
                ⚠️ 当前为<b>知识模式</b>：数据来自模型训练知识（{result.knowledgeCutoff ? `截至 ${result.knowledgeCutoff}` : "可能过时"}），仅供参考，请勿用于实盘决策；建议开启「联网搜索」获取实时数据。
              </div>
            )}
            {result.missingBanks && result.missingBanks.length > 0 && (
              <div style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#b45309", borderRadius: 8, padding: "0.5rem 0.8rem", fontSize: "0.82rem", marginTop: "0.6rem" }}>
                ⚠️ 以下央行本次未返回数据：{result.missingBanks.join("、")}
              </div>
            )}
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
                <CodeBlock maxHeight="20rem">{result.raw}</CodeBlock>
              )}
            </div>
          )}
        </div>
      )}

      {/* 历史任务（KV 持久化，回看以往分析） */}
      <TaskHistory
        module="cb-rate"
        refreshKey={taskId}
        renderResult={(v) => <CbRateHistoryView result={v as CbRateResponse} />}
      />
    </div>
  );
}

// ---------- 历史任务结果视图（复用核心展示；不含原始输出/交互态） ----------

function CbRateHistoryView({ result }: { result: CbRateResponse }) {
  return (
    <div>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: "1rem" }}>📊 政策取向小结</span>
          <span style={{ background: "#f1f5f9", color: "#475569", padding: "0.2rem 0.6rem", borderRadius: 999, fontSize: "0.78rem" }}>
            数据截至：{result.asOf || "未知"}
          </span>
          {result.dataMode === "search" ? (
            <span style={{ background: "#dcfce7", color: "#15803d", padding: "0.2rem 0.6rem", borderRadius: 999, fontSize: "0.78rem", fontWeight: 600 }}>
              📡 联网实时数据
            </span>
          ) : (
            <span style={{ background: "#fee2e2", color: "#b91c1c", padding: "0.2rem 0.6rem", borderRadius: 999, fontSize: "0.78rem", fontWeight: 600 }}>
              ⚠️ 模型知识模式
            </span>
          )}
          {result.fromCache && (
            <span style={{ background: "#fef3c7", color: "#b45309", padding: "0.2rem 0.6rem", borderRadius: 999, fontSize: "0.78rem", fontWeight: 600 }}>
              💾 来自缓存
            </span>
          )}
        </div>
        <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.7, marginTop: "0.6rem", fontSize: "0.88rem" }}>{result.summary}</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "0.7rem", marginTop: "0.7rem" }}>
        {(result.banks ?? []).map((b) => (
          <BankCard key={b.id} bank={b} />
        ))}
      </div>
      {Array.isArray(result.calendar) && result.calendar.length > 0 && (
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: "0.5rem", fontSize: "0.9rem" }}>🗓 近期会议日历</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {result.calendar.map((c, i) => (
                <tr key={i}>
                  <td style={{ ...thTd, whiteSpace: "nowrap" }}>{c.date}</td>
                  <td style={thTd}><b>{c.bank}</b></td>
                  <td style={thTd}>{c.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
      {bank.flags && bank.flags.length > 0 && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", borderRadius: 6, padding: "0.35rem 0.6rem", fontSize: "0.75rem", marginTop: "0.5rem" }}>
          ⚠️ {bank.flags.join("；")}
        </div>
      )}
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
