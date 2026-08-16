// 实验·页面3：欧元/日元泡沫预警（ec）——B/Ω/CVAS/CCV 指标仪表盘 + 研判（数据源直采版）
import { useEffect, useState } from "react";
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

/** 无 API 字段的用户补全表单（VIX/利差/CFTC/估值/z 分数）——保存 KV 后服务端采集时合并 */
const EC_SUPP_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "vix", label: "VIX 指数", hint: "如 14.2" },
  { key: "vixPrev", label: "上一交易日 VIX", hint: "如 13.8" },
  { key: "lowVolWeeks", label: "VIX<20 连续周数", hint: "如 12" },
  { key: "de10y", label: "德国 10Y 收益率 %", hint: "如 2.6" },
  { key: "jp10y", label: "日本 10Y 收益率 %", hint: "如 1.2" },
  { key: "spreadDiff", label: "德日 10Y 利差（百分点）", hint: "如 1.4" },
  { key: "cftcNetShortK", label: "CFTC 日元净空头（千手）" },
  { key: "cftcZ", label: "空头 z 分数", hint: "如 2.3" },
  { key: "buffettIndicator", label: "巴菲特指标（美股总市值/GDP）", hint: "如 1.85" },
  { key: "zFx", label: "欧元/日元汇率 z 分数" },
  { key: "zSpread", label: "利差 z 分数" },
  { key: "zValuation", label: "估值 z 分数" },
  { key: "fxChangePct", label: "EUR/JPY 周度变动 %", hint: "如 1.2" },
  { key: "spreadChangePct", label: "利差周度变动（百分点）", hint: "如 0.3" },
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
    }).catch(() => setMsg("⚠️ 加载补全数据失败"));
  }, [open]);
  const save = async () => {
    setSaving(true); setMsg(null);
    const data: Record<string, unknown> = {};
    for (const f of EC_SUPP_FIELDS) {
      const v = vals[f.key]?.trim();
      if (v !== undefined && v !== "") data[f.key] = Number(v);
    }
    try {
      await api.experimentEcSaveSupplement(data);
      setMsg("✅ 已保存（下次预警自动合并）");
      onSaved();
    } catch (e) { setMsg(`❌ ${errMsg(e)}`); }
    setSaving(false);
  };
  return (
    <Card><CardContent>
      <div style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none" }} onClick={() => setOpen(!open)}>
        <span style={{ fontSize: "0.82rem", color: open ? C.accent : C.muted }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontSize: "0.88rem", fontWeight: 600, color: C.text }}>📝 数据补全（无免费 API 字段）</span>
        <span style={{ fontSize: "0.72rem", color: C.muted, marginLeft: "auto" }}>VIX / 利差 / CFTC / z 分数——缺失指标按已有字段折算</span>
      </div>
      {open && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8, marginTop: 10 }}>
          {EC_SUPP_FIELDS.map((f) => (
            <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "0.75rem", color: C.sub }}>
              {f.label}
              <input
                inputMode="decimal"
                value={vals[f.key] ?? ""}
                placeholder={f.hint}
                onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
                style={{ padding: "0.4rem 0.5rem", borderRadius: 6, border: "1px solid #e2e8f0", fontSize: "0.82rem", width: "100%", boxSizing: "border-box" }}
              />
            </label>
          ))}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
            <Button size="sm" onClick={() => void save()} disabled={saving} style={{ whiteSpace: "nowrap" }}>{saving ? "保存中…" : "💾 保存补全"}</Button>
            {msg && <span style={{ fontSize: "0.75rem", color: C.sub }}>{msg}</span>}
          </div>
        </div>
      )}
    </CardContent></Card>
  );
}

export default function ExperimentEcTool() {
  const [force, setForce] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [suppRev, setSuppRev] = useState(0);
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

      <EcSupplementPanel onSaved={() => setSuppRev((n) => n + 1)} />

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
