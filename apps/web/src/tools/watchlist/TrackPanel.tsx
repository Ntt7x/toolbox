// ============================================================
// 自选股 · 行情跟踪（日 / 周 / 月）
// 数据：GET /tools/watchlist/:id/track?period=day|week|month
// 左侧：分组等权走势（纯 SVG，无第三方图表依赖）；右侧：周期统计表
// ============================================================

import { useEffect, useState } from "react";
import { api, errMsg } from "../../api";
import type { WatchPeriod, WatchTrackResult } from "@toolbox/shared";
import {
  C, Caveats, Empty, ItemPicker, Loading, MetaBar, SegTabs,
  btnSmall, fmtPct, fmtPrice, pctColor, stockDetailUrl, table, th, thTd,
} from "./shared";


const PERIOD_OPTS: { value: WatchPeriod; label: string; title: string }[] = [
  { value: "day", label: "日度", title: "每个交易日一根 K（前复权）" },
  { value: "week", label: "周度", title: "自然周内日 K 聚合" },
  { value: "month", label: "月度", title: "自然月内日 K 聚合" },
];

/** 分组等权走势（SVG 折线 + 零轴；无数据时不渲染） */
function GroupTrend({ points }: { points: { from: string; to: string; pct: number; count: number }[] }) {
  if (points.length === 0) return <Empty>暂无可绘制的周期数据（标的多为场外基金或日 K 缺失，或仅有一个周期可比）</Empty>;
  const W = 720;
  const H = 160;
  const pad = { l: 44, r: 12, t: 12, b: 22 };
  const vals = points.map((p) => p.pct);
  const max = Math.max(...vals, 0);
  const min = Math.min(...vals, 0);
  const span = max - min || 1;
  const x = (i: number) => pad.l + (i * (W - pad.l - pad.r)) / Math.max(1, points.length - 1);
  const y = (v: number) => pad.t + ((max - v) / span) * (H - pad.t - pad.b);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.pct).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const lastColor = pctColor(last.pct);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 170 }}>
      {/* 零轴 */}
      <line x1={pad.l} y1={y(0)} x2={W - pad.r} y2={y(0)} stroke="#cbd5e1" strokeWidth={1} strokeDasharray="4 3" />
      <text x={4} y={y(0) + 4} fontSize={10} fill={C.faintest}>0%</text>
      <text x={4} y={pad.t + 8} fontSize={10} fill={C.faintest}>{max.toFixed(1)}%</text>
      <text x={4} y={H - pad.b + 4} fontSize={10} fill={C.faintest}>{min.toFixed(1)}%</text>
      <path d={line} fill="none" stroke={lastColor} strokeWidth={2} />
      {points.map((p, i) => (
        <circle key={p.from} cx={x(i)} cy={y(p.pct)} r={2.5} fill={pctColor(p.pct)} />
      ))}
      {/* 首末周期标注 */}
      <text x={pad.l} y={H - 6} fontSize={10} fill={C.faintest}>{points[0].from}</text>
      <text x={W - pad.r} y={H - 6} fontSize={10} textAnchor="end" fill={C.faintest}>{last.to}</text>
    </svg>
  );
}

export default function TrackPanel({ groupId }: { groupId: string }) {
  const [period, setPeriod] = useState<WatchPeriod>("day");
  const [data, setData] = useState<WatchTrackResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState("");

  const load = async (p: WatchPeriod, force = false) => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.watchlistTrack(groupId, p, force);
      if (r.ok) {
        setData(r);
        setCode((prev) => (prev && r.stats.some((s) => s.code === prev) ? prev : r.stats[0]?.code ?? ""));
      } else setErr(r.message ?? "加载失败");
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setData(null);
    void load(period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, period]);

  if (err) return <div style={{ color: "#b91c1c", fontSize: "0.85rem" }}>{err}</div>;
  if (!data) return <Loading text="加载周期行情…" />;

  const stats = data.stats;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
        <SegTabs value={period} options={PERIOD_OPTS} onChange={(v) => setPeriod(v)} />
        <span style={{ flex: 1 }} />
        <button type="button" style={{ ...btnSmall, background: "#fff", color: C.faint, border: `1px solid ${C.border}` }} onClick={() => void load(period, true)} disabled={loading}>
          {loading ? "刷新中…" : "🔄 刷新"}
        </button>
      </div>

      <div style={{ fontSize: "0.75rem", color: C.faintest, marginTop: "0.3rem" }}>{data.note}</div>
      <Caveats meta={data.meta} />
      <MetaBar meta={data.meta} />

      <div style={{ fontWeight: 700, fontSize: "0.88rem", margin: "0.6rem 0 0.2rem" }}>📈 分组等权走势</div>
      <GroupTrend points={data.group} />

      <div style={{ fontWeight: 700, fontSize: "0.88rem", margin: "0.8rem 0 0.4rem" }}>📋 标的周期统计</div>
      {stats.length === 0 ? (
        <Empty>该分组暂无标的</Empty>
      ) : (
        <table style={table}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left" }}>名称 / 代码</th>
              <th style={th}>周期区间</th>
              <th style={th}>开</th>
              <th style={th}>高</th>
              <th style={th}>低</th>
              <th style={th}>收</th>
              <th style={th}>涨跌幅</th>
              <th style={th}>振幅</th>
              <th style={th}>交易日</th>
              <th style={th}>最新价</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.code} style={{ background: s.code === code ? C.accentBg : undefined }}>
                <td style={{ ...thTd, textAlign: "left", whiteSpace: "nowrap" }}>
                  <a href={stockDetailUrl(s.code, s.kind)} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "none" }}>
                    <div style={{ fontWeight: 700, lineHeight: 1.3 }}>{s.name ?? "—"}</div>
                    <div style={{ color: C.accent, fontSize: "0.72rem", textDecoration: "underline" }}>{s.code} ↗</div>
                  </a>
                  {s.caveat ? <div style={{ color: C.warn, fontSize: "0.7rem", marginTop: "0.15rem" }} title={s.caveat}>⚠️ 见备注</div> : null}
                </td>
                <td style={{ ...thTd, fontSize: "0.75rem", whiteSpace: "nowrap" }}>
                  {s.from ? `${s.from} → ${s.to}` : "—"}
                </td>
                <td style={thTd}>{fmtPrice(s.open)}</td>
                <td style={thTd}>{fmtPrice(s.high)}</td>
                <td style={thTd}>{fmtPrice(s.low)}</td>
                <td style={{ ...thTd, fontWeight: 600 }}>{fmtPrice(s.close)}</td>
                <td style={{ ...thTd, color: pctColor(s.pct), fontWeight: 700 }}>{fmtPct(s.pct)}</td>
                <td style={thTd}>{fmtPct(s.amplitude)}</td>
                <td style={thTd}>{s.sessions || "—"}</td>
                <td style={{ ...thTd, whiteSpace: "nowrap" }}>
                  {fmtPrice(s.last)}
                  {typeof s.lastPct === "number" ? (
                    <span style={{ color: pctColor(s.lastPct), marginLeft: "0.3rem", fontSize: "0.75rem" }}>{fmtPct(s.lastPct)}</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {stats.length > 0 && (
        <div style={{ marginTop: "0.6rem" }}>
          <div style={{ fontSize: "0.78rem", color: C.faint, marginBottom: "0.25rem" }}>选中标的（供其它 Tab 联动）：</div>
          <ItemPicker items={stats.map((s) => ({ code: s.code, name: s.name ?? s.code, badge: fmtPct(s.pct), badgeColor: pctColor(s.pct) }))} value={code} onChange={setCode} />
        </div>
      )}

      {/* 缺失明细（表格里只放 ⚠️ 角标，原因在此集中展示，避免撑爆列宽） */}
      {stats.some((s) => s.caveat) && (
        <div style={{ marginTop: "0.5rem", background: C.warnBg, border: "1px solid #fde68a", borderRadius: 8, padding: "0.5rem 0.7rem", fontSize: "0.76rem", color: "#92400e" }}>
          {stats.filter((s) => s.caveat).map((s) => (
            <div key={s.code}>⚠️ {s.name ?? s.code}（{s.code}）：{s.caveat}</div>
          ))}
        </div>
      )}
    </div>
  );
}
