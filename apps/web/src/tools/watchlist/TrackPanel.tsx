// ============================================================
// 自选股 · 行情跟踪 —— 服务对象：单一标的
// 数据：GET /tools/watchlist/items/:code/kline?period=<周期>（K 线）
//      GET /tools/watchlist/items/:code/intraday（分时）
// 展示：candlekit 图表（多周期 + 多指标 + 绘图 + 测量 + 成交量副图）
// 周期口径（数据源能力决定，服务端 supportedPeriods 下发，前端不猜）：
//   沪深 sh/sz：分时 · 5/15/30/60 分 · 日/周/月
//   北交所/港股：分时 · 日/周/月（行情源无分钟 K）
//   场外基金  ：净值型，无 K 线 / 无分时（supported 为空数组）
// ============================================================

import { useEffect, useMemo, useState } from "react";
import { api, errMsg } from "../../api";
import {
  WATCH_KLINE_PERIODS,
  WATCH_KLINE_PERIOD_LABEL,
  type WatchIntradayResult,
  type WatchKlinePeriod,
  type WatchKlineResult,
} from "@toolbox/shared";
import { C, Caveats, Empty, Loading, MetaBar, SegTabs, btnSmall } from "./shared";
import { CandleChart } from "./CandleChart";
import type { Bar as ChartBar } from "@getcandlekit/charts/react";

/**
 * 'YYYY-MM-DD'（+ 'HH:mm'）→ 毫秒时间戳。
 * 沪深/港交所固定 UTC+8 无夏令时 → 把交易所本地时钟直接当 UTC 写入，
 * 图表渲染的就是北京时间（详见 CandleChart.tsx 文件头「时间口径」）。
 */
function toTs(date: string, time?: string): number {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!d) return Number.NaN;
  const t = time ? /^(\d{2}):(\d{2})$/.exec(time) : null;
  return Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), t ? Number(t[1]) : 0, t ? Number(t[2]) : 0);
}

/** K 线 → 图表数据（OHLC 齐全才成 K；缺失即不画，不用快照伪造 K 线） */
function klineToBars(result: WatchKlineResult): ChartBar[] {
  const out: ChartBar[] = [];
  for (const b of result.bars) {
    const ts = toTs(b.date, b.time);
    if (!Number.isFinite(ts)) continue;
    out.push({
      ts,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      ...(typeof b.volume === "number" ? { volume: b.volume } : {}),
    });
  }
  return out;
}

/** 分时点 → 图表数据（分时是价格线：OHLC 四值同价，成交量用每分钟量） */
function intradayToBars(result: WatchIntradayResult): ChartBar[] {
  const out: ChartBar[] = [];
  for (const p of result.points) {
    const ts = toTs(result.date, p.time);
    if (!Number.isFinite(ts)) continue;
    out.push({ ts, open: p.price, high: p.price, low: p.price, close: p.price, volume: p.volume });
  }
  return out;
}

export function TrackPanel({ code, name, kind }: { code: string; name?: string; kind?: "stock" | "fund" }) {
  const [period, setPeriod] = useState<WatchKlinePeriod>("day");
  const [kline, setKline] = useState<WatchKlineResult | null>(null);
  const [intraday, setIntraday] = useState<WatchIntradayResult | null>(null);
  /** 该标的支持的周期；null = 尚未加载（未加载时不禁用任何 Tab，避免首屏全灰） */
  const [supported, setSupported] = useState<WatchKlinePeriod[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (force = false) => {
    setLoading(true);
    setErr(null);
    try {
      if (period === "min") {
        const d = await api.watchlistIntraday(code, force);
        setIntraday(d);
        setKline(null);
        setSupported(d.supported);
      } else {
        const d = await api.watchlistKline(code, period, force);
        setKline(d);
        setIntraday(null);
        setSupported(d.supported);
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setKline(null);
    setIntraday(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, period]);

  const data = period === "min" ? intraday : kline;
  const bars = useMemo(
    () => (period === "min" ? (intraday ? intradayToBars(intraday) : []) : kline ? klineToBars(kline) : []),
    [period, kline, intraday],
  );

  if (err) return <div style={{ color: "#b91c1c", fontSize: "0.85rem" }}>{err}</div>;

  const isMin = period === "min";
  const tabs = WATCH_KLINE_PERIODS.map((p) => ({
    value: p,
    label: WATCH_KLINE_PERIOD_LABEL[p],
    // 未加载完（supported=null）不禁用；已加载则按行情源能力禁用不可得周期
    ...(supported ? { disabled: !supported.includes(p) } : {}),
    title: supported && !supported.includes(p) ? "该标的无此周期数据" : WATCH_KLINE_PERIOD_LABEL[p],
  }));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <span style={{ width: 4, height: 14, borderRadius: 999, background: C.accent, flexShrink: 0 }} />
          <span style={{ fontWeight: 700, fontSize: "0.88rem", color: C.text }}>
            {isMin ? "⏱ 分时" : `📈 ${WATCH_KLINE_PERIOD_LABEL[period]}`}
          </span>
        </div>
        <span style={{ fontSize: "0.72rem", color: C.faintest }}>
          {name ? `${name}（${code}）· ` : `${code} · `}
          {data?.note ?? "加载中…"}
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

      <div style={{ marginTop: "0.3rem" }}>
        <SegTabs value={period} options={tabs} onChange={setPeriod} size="sm" />
      </div>

      {!data ? (
        <Loading text={isMin ? "加载分时行情…" : "加载 K 线行情…"} />
      ) : bars.length === 0 ? (
        <Empty>
          {kind === "fund"
            ? "场外基金为净值型，无 K 线 / 分时数据"
            : isMin
              ? "暂无分时数据（非交易日或数据源不可达）"
              : "暂无 K 线数据（数据源不可达或该代码无行情）"}
        </Empty>
      ) : (
        <div style={{ marginTop: "0.3rem" }}>
          <CandleChart
            // 周期切换重建图表（时间轴精度 timeVisible 只在创建时生效）
            key={`${code}:${period}`}
            bars={bars}
            seriesType={isMin ? "area" : "candlestick"}
            withTime={isMin || period === "m5" || period === "m15" || period === "m30" || period === "m60"}
            {...(isMin && intraday && Number.isFinite(intraday.prevClose) ? { prevClose: intraday.prevClose } : {})}
            storageKey={`ckdraw:${code}:${period}`}
          />
        </div>
      )}

      <MetaBar meta={data?.meta} />
      <Caveats meta={data?.meta} />
    </div>
  );
}
