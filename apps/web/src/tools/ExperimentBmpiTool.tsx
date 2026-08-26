// 实验·页面2：化债牛市进度指数（BMPI v4.0）——TUI 面板版（数据工程：窗口/每日结果/回测/提示词）
import { useCallback, useEffect, useState } from "react";
import type { ExperimentBmpiResponse } from "@toolbox/shared";
import { useDataInfraTask } from "../hooks/useDataInfraTask";
import { api, errMsg } from "../api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const C = {
  text: "#0f172a", sub: "#475569", muted: "#94a3b8", accent: "#2563eb",
  amber: "#b45309", red: "#dc2626", green: "#16a34a", orange: "#ea580c",
  bg: "#f8fafc", border: "#e2e8f0", dark: "#0f172a", darkText: "#e2e8f0",
};
const statusColor = (s: string) => (s?.includes("🔴") ? C.red : s?.includes("🟠") ? C.orange : s?.includes("🟡") ? "#d97706" : C.green);

const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);

// ---------- 回测折线（SVG，40/60/80 阈值带） ----------
function BacktestChart({ series }: { series: { date: string; bmpi: number | null }[] }) {
  const pts = series.filter((p) => p.bmpi !== null) as { date: string; bmpi: number }[];
  if (pts.length < 2) return <div style={{ color: C.muted, fontSize: "0.75rem" }}>回测数据不足（至少 2 个交易日）</div>;
  const W = 620, H = 140;
  const min = Math.min(...pts.map((p) => p.bmpi), 0);
  const max = Math.max(...pts.map((p) => p.bmpi), 100);
  const px = (i: number) => 10 + (i / (pts.length - 1)) * (W - 26);
  const py = (v: number) => H - 16 - ((v - min) / (max - min)) * (H - 28);
  const line = pts.map((p, i) => `${px(i).toFixed(1)},${py(p.bmpi).toFixed(1)}`).join(" ");
  const step = Math.max(1, Math.floor(pts.length / 8));
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", background: C.dark, borderRadius: 8, display: "block" }}>
        {[40, 60, 80].map((t) => (
          <g key={t}>
            <line x1={10} y1={py(t)} x2={W - 14} y2={py(t)} stroke={t === 40 ? "#fde68a" : t === 60 ? "#fdba74" : "#fca5a5"} strokeDasharray="4 4" opacity={0.45} />
            <text x={W - 14} y={py(t) + 3} fill="#94a3b8" fontSize={9} textAnchor="end">{t}</text>
          </g>
        ))}
        <polyline points={line} fill="none" stroke="#60a5fa" strokeWidth={1.5} />
        {pts.map((p, i) => (i % step === 0) && (
          <text key={i} x={px(i)} y={H - 3} fill="#94a3b8" fontSize={8} textAnchor="middle">{p.date.slice(5)}</text>
        ))}
      </svg>
      <div style={{ fontSize: "0.68rem", color: C.muted, marginTop: 4 }}>BMPI 日序列：{pts[0].date} → {pts[pts.length - 1].date}（{pts.length} 个交易日，成分股日 K 回算）</div>
    </div>
  );
}

// ---------- 提示词预览 Dialog ----------
function PromptDialog() {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const openPrompt = async () => {
    setOpen(true);
    if (prompt) return;
    setLoading(true);
    try { const r = await api.experimentBmpiPrompt(); setPrompt(r.prompt); }
    catch (e) { setPrompt(`❌ 获取失败：${errMsg(e)}`); }
    setLoading(false);
  };
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => void openPrompt()} className="h-8">📋 查看提示词</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent style={{ maxWidth: 760 }}>
          <DialogHeader>
            <DialogTitle style={{ fontSize: "0.9rem" }}>📋 BMPI 研判提示词（模板 + 实时注入数据）</DialogTitle>
            <DialogDescription>与利率分析页面一致：展示服务端实际发送给 LLM 的完整提示词</DialogDescription>
          </DialogHeader>
          <pre style={{ maxHeight: "52vh", overflow: "auto", fontSize: "0.7rem", background: C.dark, color: C.darkText, padding: 12, borderRadius: 8, whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.5 }}>
            {loading ? "⏳ 加载中…" : prompt}
          </pre>
          <DialogFooter>
            <Button size="sm" onClick={() => { if (prompt) { void navigator.clipboard.writeText(prompt).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); } }}>
              {copied ? "✅ 已复制" : "📄 复制提示词"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------- 补全表单（不变，压缩） ----------
const SUPP_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "y10", label: "10Y 国债收益率 %", hint: "如 2.3" },
  { key: "y1", label: "1Y 国债收益率 %", hint: "如 1.7" },
  { key: "netInjection", label: "央行周度净投放（亿）", hint: "负=净回笼" },
  { key: "progressPct", label: "S₁ 发行进度 %" },
  { key: "s1Pmi", label: "S₁ PMI" },
  { key: "infraYoY", label: "S₁ 基建同比 %" },
  { key: "spreadBp", label: "S₂ 城投利差 bp" },
  { key: "loanYoY", label: "S₂ 贷款同比 %" },
  { key: "cpi", label: "S₂ CPI %" },
  { key: "receivableDays", label: "S₂ 应收天数" },
  { key: "housePriceYoY", label: "S₃ 房价同比 %" },
  { key: "soePb", label: "S₃ 国企 PB" },
  { key: "govDebtPct", label: "S₃ 政府债/GDP %" },
];

function SupplementPanel({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    api.experimentBmpiSupplement().then((r) => {
      const s: Record<string, unknown> = r.supplement ?? {};
      const next: Record<string, string> = {};
      for (const f of SUPP_FIELDS) if (typeof s[f.key] === "number") next[f.key] = String(s[f.key]);
      setVals(next);
    }).catch(() => setMsg("⚠️ 加载失败"));
  }, [open]);
  const save = async () => {
    setSaving(true); setMsg(null);
    const data: Record<string, unknown> = {};
    for (const f of SUPP_FIELDS) { const v = vals[f.key]?.trim(); if (v) data[f.key] = Number(v); }
    try { await api.experimentBmpiSaveSupplement(data); setMsg("✅ 已保存"); onSaved(); }
    catch (e) { setMsg(`❌ ${errMsg(e)}`); }
    setSaving(false);
  };
  return (
    <Card><CardContent>
      <div style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none" }} onClick={() => setOpen(!open)}>
        <span style={{ fontSize: "0.82rem", color: open ? C.accent : C.muted }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontSize: "0.88rem", fontWeight: 600, color: C.text }}>📝 数据补全（无免费 API 字段）</span>
        <span style={{ fontSize: "0.72rem", color: C.muted, marginLeft: "auto" }}>保存后窗口数据自动合并，缺失字段按已有折算</span>
      </div>
      {open && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 8, marginTop: 10 }}>
          {SUPP_FIELDS.map((f) => (
            <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "0.75rem", color: C.sub }}>
              {f.label}
              <input inputMode="decimal" value={vals[f.key] ?? ""} placeholder={f.hint}
                onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
                style={{ padding: "0.4rem 0.5rem", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: "0.82rem", width: "100%", boxSizing: "border-box" }} />
            </label>
          ))}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
            <Button size="sm" onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "💾 保存补全"}</Button>
            {msg && <span style={{ fontSize: "0.75rem", color: C.sub }}>{msg}</span>}
          </div>
        </div>
      )}
    </CardContent></Card>
  );
}

// ---------- TUI 分组监测行 ----------
function TuiRow({ label, value, delta, status, action, update }: { label: string; value: string; delta?: string; status: string; action: string; update: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 70px 90px 110px 1fr 46px", gap: 8, alignItems: "center", padding: "0.3rem 0.5rem", borderBottom: "1px solid #1e293b", fontFamily: "Consolas, monospace", fontSize: "0.75rem" }}>
      <span style={{ color: "#7dd3fc" }}>{label}</span>
      <span style={{ color: "#e2e8f0", fontWeight: 700 }}>{value}</span>
      <span style={{ color: "#94a3b8" }}>{delta ?? "—"}</span>
      <span style={{ color: status.includes("🟢") ? "#4ade80" : status.includes("🟡") ? "#facc15" : status.includes("🟠") ? "#fb923c" : "#f87171" }}>{status}</span>
      <span style={{ color: "#94a3b8" }}>{action}</span>
      <span style={{ color: "#64748b", textAlign: "right" }}>{update}</span>
    </div>
  );
}

export default function ExperimentBmpiTool() {
  const [force, setForce] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [history, setHistory] = useState<{ asOf: string; bmpi?: number; status: string; summary: string }[]>([]);
  const [backtest, setBacktest] = useState<{ date: string; bmpi: number | null }[] | null>(null);
  const [btLoading, setBtLoading] = useState(false);
  const [btMsg, setBtMsg] = useState<string | null>(null);
  const task = useDataInfraTask<ExperimentBmpiResponse>({
    storageKey: "expBmpiTaskId",
    create: async () => {
      const t = await api.experimentBmpi(force);
      if (!t.ok) throw new Error(t.message);
      return { taskId: t.taskId };
    },
    fetchResult: (taskId) => api.dataInfraResult<ExperimentBmpiResponse>(taskId),
    cancel: (taskId) => api.cancelTask(taskId),
  });
  const running = task.state.status === "running";

  // 挂载恢复：跨页/刷新后继续等待 data-infra 任务
  useEffect(() => { task.resumeIfPending(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const loadHistory = useCallback(async () => {
    try {
      const r = await api.experimentBmpiHistory();
      setHistory(r.history.map((h) => ({ asOf: h.asOf, bmpi: h.bmpi, status: h.status, summary: h.summary })));
    } catch { /* 静默 */ }
  }, []);
  const runBacktest = useCallback(async (forceRun = false) => {
    setBtLoading(true); setBtMsg(null);
    try {
      const r = await api.experimentBmpiBacktest(forceRun);
      setBacktest(r.backtest?.series ?? null);
      setBtMsg(r.fromCache ? "✅ 已载入缓存回测" : "✅ 回测完成（今年起日序列）");
    } catch (e) { setBtMsg(`❌ ${errMsg(e)}`); }
    setBtLoading(false);
  }, []);
  useEffect(() => { void loadHistory(); void runBacktest(false); }, [loadHistory, runBacktest]);

  const run = async () => {
    setLocalErr(null);
    try { await task.run(); } catch (e) { setLocalErr(errMsg(e)); }
  };
  const r = task.state.result;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 任务卡 */}
      <Card><CardContent>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <span style={{ width: 4, height: 14, borderRadius: 999, background: C.accent }} />
          <span style={{ fontSize: "0.9rem", fontWeight: 700, color: C.text }}>🏛️ 化债牛市进度指数（BMPI v4.0）</span>
          <span style={{ fontSize: "0.72rem", color: C.muted, marginLeft: "auto" }}>窗口数据自动刷新 · 每日结果存档 · 今年起回测</span>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Button onClick={() => void run()} disabled={running} className="h-9">{running ? "⏳ 分析中…" : "🚀 开始分析"}</Button>
          {running && <Button variant="ghost" size="sm" onClick={() => task.cancel()} style={{ color: C.red }}>⏹ 停止</Button>}
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "0.8rem", color: C.sub }}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} style={{ accentColor: C.accent }} />强制刷新
          </label>
          <PromptDialog />
          {r?.fromCache && <span style={{ fontSize: "0.72rem", color: C.amber, background: "#fffbeb", padding: "2px 8px", borderRadius: 999 }}>📦 缓存 {r.cachedAt ? new Date(r.cachedAt).toLocaleString("zh-CN") : ""}</span>}
        </div>
        {localErr && <div style={{ color: C.red, fontSize: "0.82rem", marginTop: 6 }}>{localErr}</div>}
        {running && <div style={{ color: C.sub, fontSize: "0.8rem", marginTop: 6 }}>⏳ 刷新窗口行情 → 计算 S₁/S₂/S₃ → 合成 BMPI → LLM 研判…</div>}
      </CardContent></Card>

      <SupplementPanel onSaved={() => void loadHistory()} />

      {r && r.ok && (
        <>
          {/* 快速阅读区（TUI 风格） */}
          <div style={{ background: C.dark, borderRadius: 8, padding: "0.6rem 0.9rem", fontFamily: "Consolas, monospace" }}>
            <div style={{ color: "#4ade80", fontSize: "0.72rem", marginBottom: 4 }}>$ bmpi --report {r.asOf}</div>
            <div style={{ color: "#e2e8f0", fontSize: "0.82rem", lineHeight: 1.6 }}>{r.summary || "—"}</div>
          </div>

          {/* 读数 + 进度条 */}
          <Card><CardContent>
            <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: "0.72rem", color: C.muted }}>BMPI 读数</div>
                <div style={{ fontSize: "2.4rem", fontWeight: 800, color: statusColor(r.status) }}>{(r.bmpi ?? 0).toFixed(1)}</div>
                <div style={{ fontSize: "0.78rem", fontWeight: 600, color: statusColor(r.status) }}>{r.status}</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ height: 10, borderRadius: 999, background: "#f1f5f9", overflow: "hidden", position: "relative" }}>
                  <div style={{ position: "absolute", left: "40%", top: 0, bottom: 0, width: 2, background: "#fde68a" }} />
                  <div style={{ position: "absolute", left: "60%", top: 0, bottom: 0, width: 2, background: "#fdba74" }} />
                  <div style={{ position: "absolute", left: "80%", top: 0, bottom: 0, width: 2, background: "#fca5a5" }} />
                  <div style={{ width: `${Math.min(r.bmpi, 100)}%`, height: "100%", background: statusColor(r.status), transition: "width 0.6s" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.68rem", color: C.muted, marginTop: 4 }}>
                  <span>🟢 正常 &lt;40</span><span>🟡 关注 40-60</span><span>🟠 预警 60-80</span><span>🔴 危险 &gt;80</span>
                </div>
              </div>
            </div>
          </CardContent></Card>

          {/* 分组监测（TUI 表） */}
          <div style={{ background: C.dark, borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "110px 70px 90px 110px 1fr 46px", gap: 8, padding: "0.45rem 0.5rem", color: "#7dd3fc", fontFamily: "Consolas, monospace", fontSize: "0.7rem", fontWeight: 700, borderBottom: "1px solid #334155" }}>
              <span>指标</span><span>当前</span><span>Δ(日)</span><span>状态</span><span>行动指向</span><span style={{ textAlign: "right" }}>更新</span>
            </div>
            <TuiRow label="S₁ 信用修复" value={(r.indices.S1 ?? 0).toFixed(1)} delta={`w=${(r.indices.weights.w1 * 100).toFixed(0)}%`} status={r.indices.S1 >= 60 ? "🟠 偏高" : r.indices.S1 >= 40 ? "🟡 中位" : "🟢 早期"} action="化债发行进度驱动" update="日" />
            <TuiRow label="S₂ 信用边际" value={(r.indices.S2 ?? 0).toFixed(1)} delta={`w=${(r.indices.weights.w2 * 100).toFixed(0)}%`} status={r.indices.S2 >= 60 ? "🟠 偏高" : r.indices.S2 >= 40 ? "🟡 中位" : "🟢 早期"} action="城投利差/贷款传导" update="日" />
            <TuiRow label="S₃ 信用扩张" value={(r.indices.S3 ?? 0).toFixed(1)} delta={`w=${(r.indices.weights.w3 * 100).toFixed(0)}%`} status={r.indices.S3 >= 60 ? "🟠 反向偏高" : r.indices.S3 >= 40 ? "🟡 中位" : "🟢 未过热"} action="核心资产 PB 重估（反向）" update="日" />
            <TuiRow label="R 利率环境" value={(r.indices.R ?? 0).toFixed(1)} delta="前置" status={r.indices.R >= 60 ? "🟢 支持化债" : r.indices.R >= 40 ? "🟡 中性" : "🔴 压制"} action="1Y/10Y 国债收益率" update="补全" />
            <TuiRow label="S_L 流动性" value={(r.indices.SL ?? 0).toFixed(1)} delta="周度" status={r.indices.SL >= 60 ? "🟢 净投放" : r.indices.SL >= 40 ? "🟡 中性" : "🔴 净回笼"} action="央行净投放方向规模" update="补全" />
          </div>

          {/* 分项依据 */}
          {r.details.length > 0 && (
            <Card><CardContent>
              <div style={{ fontSize: "0.85rem", fontWeight: 700, color: C.text, marginBottom: 8 }}>📊 分项依据</div>
              {r.details.map((d, i) => (
                <div key={i} style={{ background: C.bg, borderRadius: 8, padding: "0.5rem 0.7rem", border: `1px solid ${C.border}`, marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: "0.8rem", fontWeight: 700, color: C.text }}>{d.index}</span>
                    <span style={{ fontSize: "0.72rem", background: "#eef2ff", color: "#4338ca", borderRadius: 999, padding: "0 8px" }}>{d.score.toFixed(1)}</span>
                    <span style={{ fontSize: "0.68rem", color: C.muted }}>置信：{d.confidence}</span>
                  </div>
                  <div style={{ fontSize: "0.76rem", color: C.sub, marginTop: 4 }}>{d.evidence}</div>
                </div>
              ))}
            </CardContent></Card>
          )}

          {(r.watchDates?.length > 0 || r.caveats?.length > 0) && (
            <Card><CardContent>
              {r.watchDates?.length > 0 && (
                <>
                  <div style={{ fontSize: "0.85rem", fontWeight: 700, color: C.text, marginBottom: 6 }}>🗓️ 观察节点</div>
                  {r.watchDates.map((w, i) => (
                    <div key={i} style={{ fontSize: "0.78rem", color: C.sub, lineHeight: 1.6 }}>
                      <b style={{ color: C.text }}>{w.date}</b> · {w.event}（{w.focus}）
                    </div>
                  ))}
                </>
              )}
              {r.caveats?.length > 0 && (
                <>
                  <div style={{ fontSize: "0.85rem", fontWeight: 700, color: C.amber, marginTop: 8, marginBottom: 4 }}>⚠️ 风险提示</div>
                  {r.caveats.map((v, i) => <div key={i} style={{ fontSize: "0.76rem", color: C.sub, lineHeight: 1.6 }}>· {v}</div>)}
                </>
              )}
            </CardContent></Card>
          )}
        </>
      )}

      {/* 历史结果 */}
      {history.length > 0 && (
        <Card><CardContent>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: "0.85rem", fontWeight: 700, color: C.text }}>🗂️ 每日结果（历史快照）</span>
            <span style={{ fontSize: "0.7rem", color: C.muted }}>最近 {history.length} 条，随每次分析自动存档</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {history.slice(0, 14).map((h) => (
              <div key={h.asOf} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "0.3rem 0.6rem", textAlign: "center", minWidth: 92 }}>
                <div style={{ fontSize: "0.65rem", color: C.muted }}>{h.asOf}</div>
                <div style={{ fontSize: "1rem", fontWeight: 700, color: statusColor(h.status) }}>{h.bmpi !== undefined ? h.bmpi.toFixed(1) : "—"}</div>
                <div style={{ fontSize: "0.62rem", color: statusColor(h.status) }}>{h.status}</div>
              </div>
            ))}
          </div>
        </CardContent></Card>
      )}

      {/* 回测（今年起） */}
      <Card><CardContent>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 700, color: C.text }}>📈 回测序列（2026 年起 BMPI 日线）</span>
          <Button variant="outline" size="sm" className="h-7" disabled={btLoading} onClick={() => void runBacktest(true)} style={{ fontSize: "0.72rem" }}>
            {btLoading ? "⏳ 回测中…" : "🔄 重新回测"}
          </Button>
          {btMsg && <span style={{ fontSize: "0.7rem", color: C.sub }}>{btMsg}</span>}
        </div>
        {backtest ? <BacktestChart series={backtest} /> : <div style={{ color: C.muted, fontSize: "0.75rem" }}>点击「重新回测」生成今年起日序列（成分股日 K 回算 S 指数）</div>}
      </CardContent></Card>
    </div>
  );
}
