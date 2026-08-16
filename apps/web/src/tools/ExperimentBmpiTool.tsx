// 实验·页面2：化债牛市进度指数（BMPI v4.0）——R/L/S1/S2/S3 五指数 + BMPI 合成预警
import { useState } from "react";
import type { ExperimentBmpiResponse } from "@toolbox/shared";
import { useAsyncTask } from "../hooks/useAsyncTask";
import { api, errMsg } from "../api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const C = { accent: "#2563eb", muted: "#94a3b8", text: "#1e293b", sub: "#64748b", red: "#dc2626", green: "#059669", amber: "#d97706" };

const statusColor = (s: string) => (s.includes("🔴") ? C.red : s.includes("🟡") ? C.amber : C.green);

function IndexCard({ label, score, sub, tone = "#334155" }: { label: string; score: number; sub?: string; tone?: string }) {
  return (
    <div style={{ background: "#f8fafc", borderRadius: 8, padding: "0.6rem 0.8rem", border: "1px solid #eef2f7" }}>
      <div style={{ fontSize: "0.72rem", color: C.muted }}>{label}</div>
      <div style={{ fontSize: "1.15rem", fontWeight: 700, color: tone }}>{score.toFixed(1)}</div>
      {sub && <div style={{ fontSize: "0.68rem", color: C.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function ExperimentBmpiTool() {
  const [force, setForce] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const task = useAsyncTask<ExperimentBmpiResponse>("expBmpiTaskId", api.experimentBmpiTask);

  const run = async () => {
    setLocalErr(null);
    try {
      const t = await api.experimentBmpi(force);
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
          <span style={{ fontSize: "0.9rem", fontWeight: 700, color: C.text }}>🏛️ 化债牛市进度指数（BMPI v4.0）</span>
          <span style={{ fontSize: "0.72rem", color: C.muted, marginLeft: "auto" }}>化债完成度越高，牛市剩余空间越小（信用修复 → 边际传导 → 资产重估）</span>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Button onClick={() => void run()} disabled={task.running} className="h-9">
            {task.running ? "分析中…" : r ? "🔄 重新测算" : "🚀 开始测算"}
          </Button>
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: "0.8rem", color: C.sub, cursor: "pointer" }}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} style={{ accentColor: C.accent }} />
            强制刷新（绕过缓存）
          </label>
          {r?.fromCache && <span style={{ fontSize: "0.72rem", color: C.amber, background: "#fffbeb", padding: "0.15rem 0.5rem", borderRadius: 6 }}>📦 来自缓存</span>}
        </div>
        {localErr && <div style={{ color: C.red, fontSize: "0.82rem", marginTop: 6 }}>{localErr}</div>}
        {task.running && <div style={{ color: C.sub, fontSize: "0.8rem", marginTop: 6 }}>⏳ 正在采集国债/逆回购/成分股/宏观数据并测算（约 1-3 分钟）…</div>}
      </CardContent></Card>

      {r && (
        <>
          {/* BMPI 读数 + 状态 */}
          <Card><CardContent>
            <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: "0.72rem", color: C.muted }}>BMPI 读数</div>
                <div style={{ fontSize: "2.2rem", fontWeight: 800, color: statusColor(r.status) }}>{r.bmpi.toFixed(1)}</div>
                <div style={{ fontSize: "0.75rem", fontWeight: 600, color: statusColor(r.status) }}>{r.status}</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ height: 10, borderRadius: 999, background: "#f1f5f9", overflow: "hidden", position: "relative" }}>
                  <div style={{ position: "absolute", left: "40%", top: 0, bottom: 0, width: 2, background: "#fbbf24" }} />
                  <div style={{ position: "absolute", left: "60%", top: 0, bottom: 0, width: 2, background: "#f87171" }} />
                  <div style={{ width: `${Math.min(r.bmpi, 100)}%`, height: "100%", background: statusColor(r.status), borderRadius: 999 }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.68rem", color: C.muted, marginTop: 4 }}>
                  <span>🟢 正常（早期）&lt;40</span><span>🟡 关注（中期）40-60</span><span>🔴 高危（末期）&gt;60</span>
                </div>
              </div>
              <div style={{ fontSize: "0.75rem", color: C.muted, textAlign: "right" }}>数据日期<br />{r.asOf}</div>
            </div>
            {r.summary && <div style={{ fontSize: "0.85rem", color: C.sub, lineHeight: 1.6, marginTop: 10, whiteSpace: "pre-wrap" }}>{r.summary}</div>}
          </CardContent></Card>

          {/* 五指数 */}
          <Card><CardContent>
            <div style={{ fontSize: "0.82rem", fontWeight: 700, color: C.text, marginBottom: 8 }}>📊 五指数（0-10）</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
              <IndexCard label="R 利率环境" score={r.indices.R} sub="前置约束" />
              <IndexCard label="S_L 流动性" score={r.indices.SL} sub="央行净投放" />
              <IndexCard label="S₁ 信用修复" score={r.indices.S1} sub={`权重 ${(r.indices.weights.w1 * 100).toFixed(0)}%`} tone={C.accent} />
              <IndexCard label="S₂ 信用边际" score={r.indices.S2} sub={`权重 ${(r.indices.weights.w2 * 100).toFixed(0)}%`} />
              <IndexCard label="S₃ 信用扩张" score={r.indices.S3} sub={`权重 ${(r.indices.weights.w3 * 100).toFixed(0)}%（反向）`} />
            </div>
          </CardContent></Card>

          {/* 细节依据 */}
          {r.details.length > 0 && (
            <Card><CardContent>
              <div style={{ fontSize: "0.82rem", fontWeight: 700, color: C.text, marginBottom: 8 }}>📋 指数依据</div>
              {r.details.map((d, i) => (
                <div key={i} style={{ padding: "0.4rem 0", borderBottom: "1px solid #f1f5f9", fontSize: "0.8rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 700, color: C.text, width: 56 }}>{d.index}</span>
                    <span style={{ fontSize: "0.85rem", fontWeight: 700, color: C.accent }}>{d.score.toFixed(1)}</span>
                    <span style={{ fontSize: "0.68rem", padding: "0.05rem 0.4rem", borderRadius: 6, background: d.confidence === "高" ? "#f0fdf4" : d.confidence === "中" ? "#fffbeb" : "#fef2f2", color: d.confidence === "高" ? C.green : d.confidence === "中" ? C.amber : C.red }}>{d.confidence}</span>
                  </div>
                  <div style={{ color: C.sub, marginTop: 3 }}>{d.evidence}</div>
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
