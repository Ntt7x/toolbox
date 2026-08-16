// 实验·页面3：欧元/日元泡沫预警（ec）——B/Ω/CVAS/CCV 指标仪表盘 + 研判
import { useState } from "react";
import type { ExperimentEcResponse } from "@toolbox/shared";
import { useAsyncTask } from "../hooks/useAsyncTask";
import { api, errMsg } from "../api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const C = { accent: "#2563eb", muted: "#94a3b8", text: "#1e293b", sub: "#64748b", red: "#dc2626", green: "#059669", amber: "#d97706" };

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

export default function ExperimentEcTool() {
  const [force, setForce] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const task = useAsyncTask<ExperimentEcResponse>("expEcTaskId", api.experimentEcTask);

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
          <span style={{ fontSize: "0.72rem", color: C.muted, marginLeft: "auto" }}>全球套利拥挤度：B 加速度计 · Ω 泡沫指数 · CVAS/CCV 波动率双信号</span>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Button onClick={() => void run()} disabled={task.running} className="h-9">
            {task.running ? "分析中…" : r ? "🔄 重新预警" : "🚀 开始预警"}
          </Button>
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "0.8rem", color: C.sub, cursor: "pointer" }}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} style={{ accentColor: C.accent }} />
            强制刷新（绕过缓存）
          </label>
          {r?.fromCache && <span style={{ fontSize: "0.72rem", color: C.amber, background: "#fffbeb", padding: "0.15rem 0.5rem", borderRadius: 6 }}>📦 来自缓存</span>}
        </div>
        {localErr && <div style={{ color: C.red, fontSize: "0.82rem", marginTop: 6 }}>{localErr}</div>}
        {task.running && <div style={{ color: C.sub, fontSize: "0.8rem", marginTop: 6 }}>⏳ 正在采集汇率/利差/VIX/CFTC 数据并计算指标（约 1-3 分钟）…</div>}
      </CardContent></Card>

      {r && (
        <>
          {/* 预警状态 */}
          <Card><CardContent>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: "1.4rem" }}>{r.status.split(" ")[0]}</span>
              <span style={{ fontSize: "1rem", fontWeight: 700, color: C.text }}>预警状态：{r.status}</span>
              <span style={{ fontSize: "0.75rem", color: C.muted, marginLeft: "auto" }}>数据日期 {r.asOf}</span>
            </div>
            {r.summary && <div style={{ fontSize: "0.85rem", color: C.sub, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{r.summary}</div>}
          </CardContent></Card>

          {/* 指标仪表盘 */}
          <Card><CardContent>
            <div style={{ fontSize: "0.82rem", fontWeight: 700, color: C.text, marginBottom: 8 }}>📊 核心指标</div>
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

          {/* 监测数据 */}
          <Card><CardContent>
            <div style={{ fontSize: "0.82rem", fontWeight: 700, color: C.text, marginBottom: 8 }}>📡 监测数据</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
              <StatCard label="EUR/JPY" value={fmt(r.data.fx.eurjpy)} sub="欧元/日元" />
              <StatCard label="USD/JPY" value={fmt(r.data.fx.usdjpy)} />
              <StatCard label="德日 10Y 利差" value={fmt(r.data.spreads?.diff)} sub={`德 ${fmt(r.data.spreads?.de10y)} · 日 ${fmt(r.data.spreads?.jp10y)}`} />
              <StatCard label="VIX" value={fmt(r.data.vix)} tone={typeof r.data.vix === "number" && r.data.vix > 25 ? C.red : C.text} />
              <StatCard label="CFTC 净空头" value={r.data.cftc?.netShortK !== undefined ? `${fmt(r.data.cftc.netShortK)}K` : "—"} sub={`z=${fmt(r.data.cftc?.zScore)}`} />
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
    </div>
  );
}
