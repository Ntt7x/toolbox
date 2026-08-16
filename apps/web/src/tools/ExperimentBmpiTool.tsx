import { useEffect, useState } from "react";
import type { ExperimentBmpiResponse } from "@toolbox/shared";
import { useAsyncTask } from "../hooks/useAsyncTask";
import { api, errMsg } from "../api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const C = { text: "#0f172a", sub: "#475569", muted: "#94a3b8", accent: "#2563eb", amber: "#b45309", red: "#dc2626", bg: "#f8fafc", border: "#e2e8f0" };
const statusColor = (s: string) => (s?.includes("🔴") ? "#dc2626" : s?.includes("🟠") ? "#ea580c" : s?.includes("🟡") ? "#d97706" : "#16a34a");

function IndexCard({ label, score, sub, tone = "#334155" }: { label: string; score: number; sub?: string; tone?: string }) {
  return (
    <div style={{ background: C.bg, borderRadius: 8, padding: "0.6rem 0.8rem", border: `1px solid ${C.border}`, minWidth: 96 }}>
      <div style={{ fontSize: "0.72rem", color: C.muted }}>{label}</div>
      <div style={{ fontSize: "1.15rem", fontWeight: 700, color: tone }}>{score.toFixed(1)}</div>
      {sub && <div style={{ fontSize: "0.68rem", color: C.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/** 无 API 字段的用户补全表单（国债/逆回购/S 宏观）——保存 KV 后服务端采集时合并 */
const SUPP_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "y10", label: "中国 10Y 国债收益率 %", hint: "如 2.3" },
  { key: "y1", label: "中国 1Y 国债收益率 %", hint: "如 1.7" },
  { key: "netInjection", label: "央行周度净投放（亿元）", hint: "负=净回笼" },
  { key: "progressPct", label: "S₁ 发行进度 %（化债专项债）" },
  { key: "s1Pmi", label: "S₁ PMI（制造业）" },
  { key: "infraYoY", label: "S₁ 基建投资同比 %" },
  { key: "spreadBp", label: "S₂ 城投利差（bp）" },
  { key: "loanYoY", label: "S₂ 社融/贷款同比 %" },
  { key: "cpi", label: "S₂ CPI %" },
  { key: "receivableDays", label: "S₂ 应收账款天数" },
  { key: "housePriceYoY", label: "S₃ 房价同比 %" },
  { key: "soePb", label: "S₃ 国企平均 PB" },
  { key: "govDebtPct", label: "S₃ 政府债占 GDP %" },
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
    }).catch(() => setMsg("⚠️ 加载补全数据失败"));
  }, [open]);
  const save = async () => {
    setSaving(true); setMsg(null);
    const data: Record<string, unknown> = {};
    for (const f of SUPP_FIELDS) {
      const v = vals[f.key]?.trim();
      if (v !== undefined && v !== "") data[f.key] = Number(v);
    }
    try {
      await api.experimentBmpiSaveSupplement(data);
      setMsg("✅ 已保存（下次分析自动合并）");
      onSaved();
    } catch (e) { setMsg(`❌ ${errMsg(e)}`); }
    setSaving(false);
  };
  return (
    <Card><CardContent>
      <div style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none" }} onClick={() => setOpen(!open)}>
        <span style={{ fontSize: "0.82rem", color: open ? C.accent : C.muted }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontSize: "0.88rem", fontWeight: 600, color: C.text }}>📝 数据补全（无免费 API 字段）</span>
        <span style={{ fontSize: "0.72rem", color: C.muted, marginLeft: "auto" }}>国债收益率 / 逆回购 / S 宏观——缺失时 S 评分将按已有字段折算</span>
      </div>
      {open && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 8, marginTop: 10 }}>
          {SUPP_FIELDS.map((f) => (
            <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "0.75rem", color: C.sub }}>
              {f.label}
              <input
                inputMode="decimal"
                value={vals[f.key] ?? ""}
                placeholder={f.hint}
                onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
                style={{ padding: "0.4rem 0.5rem", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: "0.82rem", width: "100%", boxSizing: "border-box" }}
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

export default function ExperimentBmpiTool() {
  const [force, setForce] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [suppRev, setSuppRev] = useState(0);
  const task = useAsyncTask<ExperimentBmpiResponse>("expBmpiTaskId", api.experimentBmpiTask, (taskId) => api.cancelTask(taskId));

  const run = async () => {
    setLocalErr(null);
    try {
      const r = await api.experimentBmpi(force);
      if (!r.ok) { setLocalErr(r.message ?? "启动分析失败"); return; }
      task.watch(r.taskId, r);
    } catch (e) { setLocalErr(errMsg(e)); }
  };
  const r = task.result;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card><CardContent>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <span style={{ width: 4, height: 14, borderRadius: 999, background: C.accent }} />
          <span style={{ fontSize: "0.9rem", fontWeight: 700, color: C.text }}>🏛️ 化债牛市进度指数（BMPI v4.0）</span>
          <span style={{ fontSize: "0.72rem", color: C.muted, marginLeft: "auto" }}>化债完成度越高，牛市剩余空间越小</span>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Button onClick={() => void run()} disabled={task.running} className="h-9">
            {task.running ? "⏳ 分析中…" : "🚀 开始分析"}
          </Button>
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "0.8rem", color: C.sub }}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} style={{ accentColor: C.accent }} />
            强制刷新（绕过缓存）
          </label>
          {task.running && <Button variant="ghost" size="sm" onClick={() => task.cancel()} style={{ color: C.red }}>⏹ 停止</Button>}
          {r?.fromCache && <span style={{ fontSize: "0.72rem", color: C.amber, background: "#fffbeb", padding: "2px 8px", borderRadius: 999 }}>来自缓存 {r.cachedAt ? new Date(r.cachedAt).toLocaleString("zh-CN") : ""}</span>}
        </div>
        {localErr && <div style={{ color: C.red, fontSize: "0.82rem", marginTop: 6 }}>{localErr}</div>}
        {task.running && <div style={{ color: C.sub, fontSize: "0.8rem", marginTop: 6 }}>⏳ 采集成分股行情（quote 实时数据）→ 计算 S₁/S₂/S₃ 与 BMPI → LLM 研判…</div>}
      </CardContent></Card>

      <SupplementPanel onSaved={() => setSuppRev((n) => n + 1)} />

      {r && r.ok && (
        <>
          <Card><CardContent>
            <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: "0.72rem", color: C.muted }}>BMPI 读数</div>
                <div style={{ fontSize: "2.2rem", fontWeight: 800, color: statusColor(r.status) }}>{r.bmpi.toFixed(1)}</div>
                <div style={{ fontSize: "0.75rem", fontWeight: 600, color: statusColor(r.status) }}>{r.status}</div>
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

          <Card><CardContent>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <IndexCard label="S₁ 信用修复" score={r.indices.S1} sub={`权重 ${(r.indices.weights.w1 * 100).toFixed(0)}%`} tone="#2563eb" />
              <IndexCard label="S₂ 信用边际" score={r.indices.S2} sub={`权重 ${(r.indices.weights.w2 * 100).toFixed(0)}%`} tone="#7c3aed" />
              <IndexCard label="S₃ 信用扩张" score={r.indices.S3} sub={`权重 ${(r.indices.weights.w3 * 100).toFixed(0)}%`} tone="#0d9488" />
              <IndexCard label="R 利率环境" score={r.indices.R} sub="0-100" tone="#475569" />
              <IndexCard label="S_L 流动性" score={r.indices.SL} sub="0-100" tone="#475569" />
            </div>
            <div style={{ fontSize: "0.78rem", color: C.sub, marginTop: 10, lineHeight: 1.7 }}>
              <b>研判：</b>{r.summary}
            </div>
          </CardContent></Card>

          <Card><CardContent>
            <div style={{ fontSize: "0.85rem", fontWeight: 700, color: C.text, marginBottom: 8 }}>📊 分项依据</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {r.details.map((d, i) => (
                <div key={i} style={{ background: C.bg, borderRadius: 8, padding: "0.5rem 0.7rem", border: `1px solid ${C.border}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: "0.8rem", fontWeight: 700, color: C.text }}>{d.index}</span>
                    <span style={{ fontSize: "0.72rem", color: statusColor(`s${d.score}`), background: "#fff", border: `1px solid ${C.border}`, borderRadius: 999, padding: "0 8px" }}>{d.score.toFixed(1)}</span>
                    <span style={{ fontSize: "0.68rem", color: C.muted }}>置信：{d.confidence}</span>
                  </div>
                  <div style={{ fontSize: "0.76rem", color: C.sub, marginTop: 4 }}>{d.evidence}</div>
                </div>
              ))}
            </div>
          </CardContent></Card>

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
    </div>
  );
}
