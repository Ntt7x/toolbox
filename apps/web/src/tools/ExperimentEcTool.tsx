// 实验·页面3：欧元/日元泡沫预警（ec）——TUI 面板版（数据工程：窗口/每日结果/提示词）
import { useCallback, useEffect, useState } from "react";
import type { ExperimentEcResponse } from "@toolbox/shared";
import { useAsyncTask } from "../hooks/useAsyncTask";
import { api, errMsg } from "../api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const C = { accent: "#2563eb", muted: "#94a3b8", text: "#1e293b", sub: "#64748b", red: "#dc2626", green: "#059669", amber: "#d97706", dark: "#0f172a", darkText: "#e2e8f0" };
const fmt = (v: number | undefined | null, digits = 2) => (typeof v === "number" && isFinite(v) ? v.toFixed(digits) : "—");

function StatCard({ label, value, tone = "#334155", sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div style={{ background: "#f8fafc", borderRadius: 8, padding: "0.6rem 0.8rem", border: "1px solid #eef2f7" }}>
      <div style={{ fontSize: "0.72rem", color: C.muted }}>{label}</div>
      <div style={{ fontSize: "1.1rem", fontWeight: 700, color: tone }}>{value}</div>
      {sub && <div style={{ fontSize: "0.68rem", color: C.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ---------- 提示词预览 Dialog ----------
function EcPromptDialog() {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const openPrompt = async () => {
    setOpen(true);
    if (prompt) return;
    setLoading(true);
    try { const r = await api.experimentEcPrompt(); setPrompt(r.prompt); }
    catch (e) { setPrompt(`❌ 获取失败：${errMsg(e)}`); }
    setLoading(false);
  };
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => void openPrompt()} className="h-8">📋 查看提示词</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent style={{ maxWidth: 760 }}>
          <DialogHeader>
            <DialogTitle style={{ fontSize: "0.9rem" }}>📋 ec 研判提示词（模板 + 实时注入数据）</DialogTitle>
            <DialogDescription>展示服务端实际发送给 LLM 的完整提示词</DialogDescription>
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

// ---------- 补全表单 ----------
const EC_SUPP_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "vix", label: "VIX 指数", hint: "如 14.2" },
  { key: "vixPrev", label: "上一交易日 VIX" },
  { key: "lowVolWeeks", label: "VIX<20 连续周数" },
  { key: "de10y", label: "德国 10Y %", hint: "如 2.6" },
  { key: "jp10y", label: "日本 10Y %", hint: "如 1.2" },
  { key: "spreadDiff", label: "德日利差（百分点）" },
  { key: "cftcNetShortK", label: "CFTC 净空头（千手）" },
  { key: "cftcZ", label: "空头 z 分数" },
  { key: "buffettIndicator", label: "巴菲特指标" },
  { key: "zFx", label: "汇率 z 分数" },
  { key: "zSpread", label: "利差 z 分数" },
  { key: "zValuation", label: "估值 z 分数" },
  { key: "fxChangePct", label: "EUR/JPY 周度变动 %" },
  { key: "spreadChangePct", label: "利差周度变动（百分点）" },
];

function EcSupplementPanel({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    api.experimentEcSupplement().then((r) => {
      const s: Record<string, unknown> = r.supplement ?? {};
      const next: Record<string, string> = {};
      for (const f of EC_SUPP_FIELDS) if (typeof s[f.key] === "number") next[f.key] = String(s[f.key]);
      setVals(next);
    }).catch(() => setMsg("⚠️ 加载失败"));
  }, [open]);
  const save = async () => {
    setSaving(true); setMsg(null);
    const data: Record<string, unknown> = {};
    for (const f of EC_SUPP_FIELDS) { const v = vals[f.key]?.trim(); if (v) data[f.key] = Number(v); }
    try { await api.experimentEcSaveSupplement(data); setMsg("✅ 已保存"); onSaved(); }
    catch (e) { setMsg(`❌ ${errMsg(e)}`); }
    setSaving(false);
  };
  return (
    <Card><CardContent>
      <div style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none" }} onClick={() => setOpen(!open)}>
        <span style={{ fontSize: "0.82rem", color: open ? C.accent : C.muted }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontSize: "0.88rem", fontWeight: 600, color: C.text }}>📝 数据补全（无免费 API 字段）</span>
        <span style={{ fontSize: "0.72rem", color: C.muted, marginLeft: "auto" }}>VIX / 利差 / CFTC / z 分数</span>
      </div>
      {open && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8, marginTop: 10 }}>
          {EC_SUPP_FIELDS.map((f) => (
            <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "0.75rem", color: C.sub }}>
              {f.label}
              <input inputMode="decimal" value={vals[f.key] ?? ""} placeholder={f.hint}
                onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
                style={{ padding: "0.4rem 0.5rem", borderRadius: 6, border: "1px solid #e2e8f0", fontSize: "0.82rem", width: "100%", boxSizing: "border-box" }} />
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
function EcTuiRow({ label, value, delta, status, action, update }: { label: string; value: string; delta?: string; status: string; action: string; update: string }) {
  const sc = status.includes("🔴") ? "#f87171" : status.includes("🟡") ? "#facc15" : status.includes("🟢") ? "#4ade80" : "#94a3b8";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 80px 80px 90px 1fr 40px", gap: 8, alignItems: "center", padding: "0.3rem 0.5rem", borderBottom: "1px solid #1e293b", fontFamily: "Consolas, monospace", fontSize: "0.75rem" }}>
      <span style={{ color: "#7dd3fc" }}>{label}</span>
      <span style={{ color: "#e2e8f0", fontWeight: 700 }}>{value}</span>
      <span style={{ color: "#94a3b8" }}>{delta ?? "—"}</span>
      <span style={{ color: sc }}>{status}</span>
      <span style={{ color: "#94a3b8" }}>{action}</span>
      <span style={{ color: "#64748b", textAlign: "right" }}>{update}</span>
    </div>
  );
}

export default function ExperimentEcTool() {
  const [force, setForce] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [history, setHistory] = useState<{ asOf: string; b?: number; status: string }[]>([]);
  const task = useAsyncTask<ExperimentEcResponse>("expEcTaskId", api.experimentEcTask, (taskId) => api.cancelTask(taskId));
  const loadHistory = useCallback(async () => {
    try {
      const r = await api.experimentEcHistory();
      setHistory(r.history.map((h) => ({ asOf: h.asOf, b: typeof h.indices.b === "number" ? h.indices.b : undefined, status: h.status })));
    } catch { /* 静默 */ }
  }, []);
  useEffect(() => { void loadHistory(); }, [loadHistory]);

  const run = async () => {
    setLocalErr(null);
    try {
      const t = await api.experimentEc(force);
      if (!t.ok) { setLocalErr(t.message); return; }
      task.watch(t.taskId, t);
    } catch (e) { setLocalErr(errMsg(e)); }
  };
  const r = task.result;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card><CardContent>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <span style={{ width: 4, height: 14, borderRadius: 999, background: C.accent }} />
          <span style={{ fontSize: "0.9rem", fontWeight: 700, color: C.text }}>🌊 欧元/日元泡沫预警（ec）</span>
          <span style={{ fontSize: "0.72rem", color: C.muted, marginLeft: "auto" }}>全球套利拥挤度 · 窗口数据自动刷新 · 每日结果存档</span>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Button onClick={() => void run()} disabled={task.running} className="h-9">{task.running ? "分析中…" : r ? "🔄 重新预警" : "🚀 开始预警"}</Button>
          {task.running && <Button variant="ghost" size="sm" onClick={() => task.cancel()} style={{ color: C.red }}>⏹ 停止</Button>}
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "0.8rem", color: C.sub, cursor: "pointer" }}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} style={{ accentColor: C.accent }} />强制刷新
          </label>
          <EcPromptDialog />
          {r?.fromCache && <span style={{ fontSize: "0.72rem", color: C.amber, background: "#fffbeb", padding: "0.15rem 0.5rem", borderRadius: 6 }}>📦 来自缓存</span>}
        </div>
        {localErr && <div style={{ color: C.red, fontSize: "0.82rem", marginTop: 6 }}>{localErr}</div>}
        {task.running && <div style={{ color: C.sub, fontSize: "0.8rem", marginTop: 6 }}>⏳ 刷新外汇窗口 → 计算 B/Ω/CVAS/CCV → LLM 研判…</div>}
      </CardContent></Card>

      <EcSupplementPanel onSaved={() => void loadHistory()} />

      {r && (
        <>
          {/* 快速阅读区 */}
          <div style={{ background: C.dark, borderRadius: 8, padding: "0.6rem 0.9rem", fontFamily: "Consolas, monospace" }}>
            <div style={{ color: "#4ade80", fontSize: "0.72rem", marginBottom: 4 }}>$ ec-update --report {r.asOf}</div>
            <div style={{ color: "#e2e8f0", fontSize: "0.82rem", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{r.summary || "—"}</div>
          </div>

          {/* 预警状态 + 指标 */}
          <Card><CardContent>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: "1.4rem" }}>{r.status.split(" ")[0]}</span>
              <span style={{ fontSize: "1rem", fontWeight: 700, color: C.text }}>预警状态：{r.status}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
              <StatCard label="B(t) 加速度计" value={fmt(r.indicators.b)} tone={typeof r.indicators.b === "number" && r.indicators.b < 0 ? C.red : C.green} sub={`趋势 ${r.indicators.bTrend}`} />
              <StatCard label="Ω 泡沫指数" value={fmt(r.indicators.omega)} tone={typeof r.indicators.omega === "number" && r.indicators.omega > 1.6 ? C.red : C.text} sub=">1.6 高危" />
              <StatCard label="CVAS 反身性" value={fmt(r.indicators.cvas)} tone={C.text} sub="低波累积" />
              <StatCard label="CCV 异动" value={fmt(r.indicators.ccv)} tone={typeof r.indicators.ccv === "number" && r.indicators.ccv > 0.2 ? C.red : C.text} sub="单日 VIX 变动" />
            </div>
            {r.indicators.signals.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                {r.indicators.signals.map((sg, i) => <span key={i} style={{ fontSize: "0.72rem", background: "#fef2f2", color: C.red, padding: "0.15rem 0.5rem", borderRadius: 6 }}>🚨 {sg}</span>)}
              </div>
            )}
          </CardContent></Card>

          {/* 分组监测（TUI 表，参考原框架面板） */}
          <div style={{ background: C.dark, borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "110px 80px 80px 90px 1fr 40px", gap: 8, padding: "0.45rem 0.5rem", color: "#7dd3fc", fontFamily: "Consolas, monospace", fontSize: "0.7rem", fontWeight: 700, borderBottom: "1px solid #334155" }}>
              <span>指标</span><span>当前</span><span>Δ(日)</span><span>状态</span><span>行动指向</span><span style={{ textAlign: "right" }}>更新</span>
            </div>
            <EcTuiRow label="Ω 综合风险" value={fmt(r.indicators.omega)} delta="—" status={typeof r.indicators.omega === "number" && r.indicators.omega > 1.6 ? "🔴 高危" : typeof r.indicators.omega === "number" && r.indicators.omega > 1.2 ? "🟡 关注" : "🟢 正常"} action="敞口 ≤ 50%" update="日" />
            <EcTuiRow label="B(t) 资金转向" value={fmt(r.indicators.b)} delta="周度" status={typeof r.indicators.b === "number" && r.indicators.b < 0 ? "🔴 负值" : "🟢 正值"} action="连续为负→防御" update="周" />
            <EcTuiRow label="CVAS 反身性" value={fmt(r.indicators.cvas)} delta="日" status={typeof r.indicators.cvas === "number" && r.indicators.cvas > 1 ? "🟡 高累积" : "🟢 低位"} action=">1.0 共振警惕" update="日" />
            <EcTuiRow label="CCV 危机波动" value={fmt(r.indicators.ccv)} delta="日" status={typeof r.indicators.ccv === "number" && r.indicators.ccv >= 0.2 ? "🔴 骤降" : "🟢 正常"} action="单日降≥0.10 警惕" update="日" />
            <EcTuiRow label="VIX 波动输入" value={fmt(r.data.vix)} delta="日" status={typeof r.data.vix === "number" && r.data.vix > 25 ? "🟡 偏高" : "🟢 低位"} action="单日涨>20% 重评" update="日" />
            <EcTuiRow label="CFTC 净空头" value={r.data.cftc?.netShortK !== undefined ? `${fmt(r.data.cftc.netShortK)}K` : "—"} delta="周" status={typeof r.data.cftc?.zScore === "number" && r.data.cftc.zScore >= 2.5 ? "🟡 拥挤" : "—"} action="连减10%→加速平仓" update="周" />
          </div>

          {/* 监测数据快照 */}
          <Card><CardContent>
            <div style={{ fontSize: "0.82rem", fontWeight: 700, color: C.text, marginBottom: 8 }}>📡 原始数据快照</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
              <StatCard label="EUR/JPY" value={fmt(r.data.fx.eurjpy)} sub="腾讯实时" />
              <StatCard label="USD/JPY" value={fmt(r.data.fx.usdjpy)} sub="腾讯实时" />
              <StatCard label="德日 10Y 利差" value={fmt(r.data.spreads?.diff)} sub={`德 ${fmt(r.data.spreads?.de10y)} · 日 ${fmt(r.data.spreads?.jp10y)}`} />
              <StatCard label="巴菲特指标" value={fmt(r.data.buffettIndicator)} />
            </div>
          </CardContent></Card>

          {/* 操作锚点 + 观察节点 */}
          {r.anchors.length > 0 && (
            <Card><CardContent>
              <div style={{ fontSize: "0.82rem", fontWeight: 700, color: C.text, marginBottom: 8 }}>🎯 操作锚点</div>
              {r.anchors.map((a, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "0.35rem 0", borderBottom: "1px solid #f1f5f9", fontSize: "0.8rem" }}>
                  <span style={{ flex: 1, color: C.sub }}>{a.condition}</span>
                  <span style={{ fontSize: "0.72rem", padding: "0.1rem 0.5rem", borderRadius: 6, background: a.status === "已触发" ? "#fef2f2" : a.status === "逼近" ? "#fffbeb" : "#f0fdf4", color: a.status === "已触发" ? C.red : a.status === "逼近" ? C.amber : C.green }}>{a.status}</span>
                  <span style={{ flex: 1.2, color: C.text }}>{a.action}</span>
                </div>
              ))}
            </CardContent></Card>
          )}
          {r.watchDates.length > 0 && (
            <Card><CardContent>
              <div style={{ fontSize: "0.82rem", fontWeight: 700, color: C.text, marginBottom: 8 }}>📅 观察节点</div>
              {r.watchDates.map((w, i) => (
                <div key={i} style={{ display: "flex", gap: 8, fontSize: "0.8rem", padding: "0.3rem 0", borderBottom: "1px solid #f1f5f9" }}>
                  <span style={{ fontWeight: 600, color: C.text, width: 90, flexShrink: 0 }}>{w.date}</span>
                  <span style={{ color: C.sub, flex: 1 }}>{w.event}</span>
                  <span style={{ color: C.muted, flex: 1 }}>{w.focus}</span>
                </div>
              ))}
            </CardContent></Card>
          )}
          {r.caveats.length > 0 && (
            <div style={{ fontSize: "0.75rem", color: C.amber, background: "#fffbeb", padding: "0.5rem 0.8rem", borderRadius: 8 }}>
              ⚠️ {r.caveats.join("；")}
            </div>
          )}
        </>
      )}

      {/* 历史结果 */}
      {history.length > 0 && (
        <Card><CardContent>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: "0.85rem", fontWeight: 700, color: C.text }}>🗂️ 每日结果（历史快照）</span>
            <span style={{ fontSize: "0.7rem", color: C.muted }}>最近 {history.length} 条</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {history.slice(0, 14).map((h) => (
              <div key={h.asOf} style={{ background: "#f8fafc", border: "1px solid #eef2f7", borderRadius: 6, padding: "0.3rem 0.6rem", textAlign: "center", minWidth: 92 }}>
                <div style={{ fontSize: "0.65rem", color: C.muted }}>{h.asOf}</div>
                <div style={{ fontSize: "1rem", fontWeight: 700, color: h.status?.includes("🔴") ? C.red : h.status?.includes("🟡") ? C.amber : C.green }}>{h.b !== undefined ? h.b.toFixed(2) : "—"}</div>
                <div style={{ fontSize: "0.62rem", color: C.muted }}>{h.status}</div>
              </div>
            ))}
          </div>
        </CardContent></Card>
      )}
    </div>
  );
}
