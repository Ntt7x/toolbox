// ============================================================
// 自选股 · 行情跟踪 —— 服务对象：单一标的
// 数据：GET /tools/watchlist/items/:code/kline（日 K 序列）
// 展示：券商式 K 线图（蜡烛 + 均线 + 成交量 + 十字光标联动图例）
// 取舍：K 线本身已表达 OHLC / 涨跌 / 成交量，故不再提供「日/周/月周期切换 + 周期明细表」
//       ——那类视图与 K 线信息重叠，属于冗余（用户明确要求精简）。
// ============================================================

import { useEffect, useState } from "react";
import { api, errMsg } from "../../api";
import type { WatchKlineBar, WatchKlineResult } from "@toolbox/shared";
import { C, Caveats, Empty, Loading, MetaBar, btnSmall } from "./shared";
import { KlineChart, type ChartBar } from "./KlineChart";

/** 日 K → 图表数据（OHLC 齐全才成 K；缺失即不画，不用快照伪造 K 线） */
function toBars(bars: WatchKlineBar[]): ChartBar[] {
  return bars.map((b) => ({
    time: b.date,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    ...(typeof b.volume === "number" ? { volume: b.volume } : {}),
  }));
}

export function TrackPanel({ code, name, kind }: { code: string; name?: string; kind?: "stock" | "fund" }) {
  const [data, setData] = useState<WatchKlineResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (force = false) => {
    setLoading(true);
    setErr(null);
    try {
      setData(await api.watchlistKline(code, force));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setData(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  if (err) return <div style={{ color: "#b91c1c", fontSize: "0.85rem" }}>{err}</div>;
  if (!data) return <Loading text="加载日 K 行情…" />;

  const bars = toBars(data.bars);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <span style={{ width: 4, height: 14, borderRadius: 999, background: C.accent, flexShrink: 0 }} />
          <span style={{ fontWeight: 700, fontSize: "0.88rem", color: C.text }}>📈 日 K</span>
        </div>
        <span style={{ fontSize: "0.72rem", color: C.faintest }}>
          {name ? `${name}（${code}）· ` : `${code} · `}
          {data.note}
          {kind === "fund" ? " · 场外基金为净值型" : ""}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={{ ...btnSmall, background: "#fff", color: C.faint, border: `1px solid ${C.border}` }}
          onClick={() => void load(true)}
          disabled={loading}
        >
          {loading ? "刷新中…" : "🔄 刷新"}
        </button>
      </div>

      {bars.length === 0 ? (
        <Empty>
          {kind === "fund" ? "场外基金为净值型，无日 K 数据" : "暂无日 K 数据（数据源不可达或该代码无行情）"}
        </Empty>
      ) : (
        <div style={{ marginTop: "0.3rem" }}>
          <KlineChart bars={bars} height={360} />
        </div>
      )}

      <MetaBar meta={data.meta} />
      <Caveats meta={data.meta} />
    </div>
  );
}
