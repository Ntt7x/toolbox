// ============================================================
// 券商式 K 线图（TradingView Lightweight Charts 官方库）
// ------------------------------------------------------------
// 依赖：lightweight-charts v5（官方 https://github.com/tradingview/lightweight-charts）
// 组成（对标券商 App 的日 K 页）：
//   主图  蜡烛（涨红跌绿）+ MA5 / MA10 / MA20（标 A 股配色，涨红跌绿）
//   交互  十字光标 + 顶部图例（随光标联动显示 开/高/低/收/涨跌 + 三条均线）
//         滚轮缩放 · 拖拽平移 · 双击复位
// v5 API 要点（与 v4 不同，勿混用）：
//   · 统一 chart.addSeries(CandlestickSeries, opts)，无 addCandlestickSeries
//   · 系列常量需与 createChart 一起 import（ESM）
//   · createChart({ autoSize: true }) 自动跟随容器，无需手动 applyOptions({ width })
//   · 卸载必须 chart.remove()（否则 ResizeObserver / 订阅泄漏）
// 时间轴用 BusinessDay（'YYYY-MM-DD' → {year,month,day}），避免本地时区漂移。
// ============================================================

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  type BusinessDay,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import { C, fmtPct, fmtPrice, pctColor } from "./shared";

/**
 * 'YYYY-MM-DD' → BusinessDay。
 * v5 的 time 只接受 BusinessDay 对象或 UTCTimestamp（秒），**不接受字符串**；
 * 用 BusinessDay 而非时间戳，可规避本地时区导致的日期漂移（东八区常见于跨零点场景）。
 */
function toBusinessDay(date: string): BusinessDay {
  const [y, m, d] = date.split("-").map(Number);
  return { year: y, month: m, day: d };
}

/** 图表回调里的 Time → 'YYYY-MM-DD'（BusinessDay / UTCTimestamp 两种形态都兼容） */
function timeToKey(t: unknown): string {
  if (t && typeof t === "object") {
    const b = t as BusinessDay;
    if (typeof b.year === "number" && typeof b.month === "number" && typeof b.day === "number") {
      return `${b.year}-${String(b.month).padStart(2, "0")}-${String(b.day).padStart(2, "0")}`;
    }
  }
  if (typeof t === "number") {
    return new Date(t * 1000).toISOString().slice(0, 10);
  }
  return String(t);
}

/** 一根日 K（qfq 前复权） */
export interface ChartBar {
  /** YYYY-MM-DD */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

const UP = C.gain; // 涨：红
const DOWN = C.loss; // 跌：绿

/** 均线定义（券商默认 5/10/20） */
const MA_DEFS = [
  { period: 5, color: "#f59e0b" },
  { period: 10, color: "#3b82f6" },
  { period: 20, color: "#a855f7" },
] as const;

/**
 * 简单移动平均（纯函数；窗口不足 → null，图表自动断线）。
 * 不足窗口不填充伪值，避免画出「假的均线起点」。
 */
export function movingAverage(bars: ChartBar[], period: number): ({ time: string; value: number } | null)[] {
  const out: ({ time: string; value: number } | null)[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    out.push(i >= period - 1 ? { time: bars[i].time, value: sum / period } : null);
  }
  return out;
}

/** 图例数据（随十字光标联动；券商 App 顶部那一行） */
interface Legend {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 相对前一根收盘的涨跌幅 % */
  pct: number;
  ma: Record<number, number | undefined>;
}

/** 构造某根 K 的图例（prev 缺省时用当根开盘做基准，首根涨跌幅为 0） */
function legendAt(bars: ChartBar[], idx: number): Legend | null {
  const b = bars[idx];
  if (!b) return null;
  const prev = idx > 0 ? bars[idx - 1].close : b.open;
  const ma: Record<number, number | undefined> = {};
  for (const d of MA_DEFS) ma[d.period] = movingAverage(bars, d.period)[idx]?.value;
  return {
    date: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    pct: prev ? ((b.close - prev) / prev) * 100 : 0,
    ma,
  };
}

function LegendBar({ legend }: { legend: Legend | null }) {
  if (!legend) return null;
  const color = pctColor(legend.pct);
  const cell = (label: string, value: string, valueColor?: string) => (
    <span key={label} style={{ whiteSpace: "nowrap" }}>
      <span style={{ color: C.faintest }}>{label} </span>
      <span style={{ fontWeight: 600, color: valueColor ?? C.text }}>{value}</span>
    </span>
  );
  return (
    <div
      style={{
        display: "flex",
        gap: "0.6rem",
        flexWrap: "wrap",
        fontSize: "0.74rem",
        lineHeight: 1.5,
        padding: "0.25rem 0.35rem",
        borderBottom: `1px solid ${C.border}`,
        color: C.text,
      }}
    >
      <span style={{ fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>{legend.date}</span>
      {cell("开", fmtPrice(legend.open))}
      {cell("高", fmtPrice(legend.high))}
      {cell("低", fmtPrice(legend.low))}
      {cell("收", fmtPrice(legend.close), color)}
      {cell("涨跌", fmtPct(legend.pct), color)}
      {MA_DEFS.map((d) => (
        <span key={d.period} style={{ whiteSpace: "nowrap" }}>
          <span style={{ color: d.color }}>MA{d.period} </span>
          <span style={{ fontWeight: 600 }}>{typeof legend.ma[d.period] === "number" ? (legend.ma[d.period] as number).toFixed(2) : "—"}</span>
        </span>
      ))}
    </div>
  );
}

export function KlineChart({ bars, height = 360 }: { bars: ChartBar[]; /** 总高度（px） */ height?: number }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  /** 均线 series 引用（按 MA_DEFS 顺序） */
  const maRefs = useRef<(ISeriesApi<"Line"> | null)[]>([]);
  const [legend, setLegend] = useState<Legend | null>(null);

  // 建图：仅一次（数据变化走下面的 setData，避免重建导致闪烁与缩放状态丢失）
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    const chart = createChart(box, {
      autoSize: true, // 跟随容器尺寸：省去手动 ResizeObserver
      height,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: C.faint,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
      rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: C.border, rightOffset: 4, fixLeftEdge: true, minBarSpacing: 0.5 },
      crosshair: {
        mode: CrosshairMode.Normal, // 券商默认：十字线 + 轴标签
        vertLine: { color: "#94a3b8", width: 1, style: 3, labelBackgroundColor: "#e2e8f0" },
        horzLine: { color: "#94a3b8", width: 1, style: 3, labelBackgroundColor: "#e2e8f0" },
      },
      localization: { locale: "zh-CN", dateFormat: "yyyy-MM-dd" },
    });
    chartRef.current = chart;

    // 主图：蜡烛
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    candleRef.current = candle;

    // 主图叠加：均线（隐藏价格线/最后值/光标标记，避免遮挡 K 线）
    maRefs.current = MA_DEFS.map((d) =>
      chart.addSeries(LineSeries, {
        color: d.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      }),
    );

    // 十字光标 → 图例联动
    const onMove = (param: MouseEventParams<Time>) => {
      const t = param.time;
      if (t === undefined) return; // 光标移出图表：保留最后显示的图例
      const idx = bars.findIndex((b) => b.time === timeToKey(t));
      if (idx >= 0) setLegend(legendAt(bars, idx));
    };
    chart.subscribeCrosshairMove(onMove);

    chart.timeScale().applyOptions({ rightOffset: 4 });

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove(); // 必须显式销毁：内部有 ResizeObserver 与订阅
      chartRef.current = null;
      candleRef.current = null;
      maRefs.current = [];
    };
    // bars 故意不进依赖：数据更新走 setData，避免每次数据变化重建整图
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  // 灌数据：蜡烛 / 均线（增量更新，不重建图）
  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    if (!chart || !candle) return;

    candle.setData(
      bars.map((b) => ({
        time: toBusinessDay(b.time),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );

    MA_DEFS.forEach((d, i) => {
      const s = maRefs.current[i];
      if (!s) return;
      const ma = movingAverage(bars, d.period).filter((x): x is { time: string; value: number } => x !== null);
      s.setData(ma.map((p) => ({ time: toBusinessDay(p.time), value: p.value })));
    });

    chart.timeScale().fitContent();
  }, [bars]);

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden", background: "#fff" }}>
      <LegendBar legend={legend} />
      <div ref={boxRef} style={{ width: "100%" }} />
    </div>
  );
}
