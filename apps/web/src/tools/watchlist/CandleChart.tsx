// ============================================================
// 行情图表（@getcandlekit/charts）
// ------------------------------------------------------------
// 依赖：@getcandlekit/charts@0.1.0（轻量封装 lightweight-charts v5）
// 取代原手写 KlineChart.tsx：原实现只有「日 K + 固定 MA5/10/20」，周期、指标、
// 绘图、测量全部要自己写；这些正是 candlekit 已经做好的部分，改为复用成熟件。
// 本文件只做「接入 + 本页口径适配」三件事：
//   1) 券商配色主题（A 股红涨绿跌）+ CSS 变量覆写（测量浮层也是红涨绿跌）
//   2) 指标注册表扩展：内置 9 个指标 + 本页默认均线组 MA5/10/20 + 分时昨收线
//   3) 顶部图例（随十字光标联动）——candlekit 未提供，保留原有券商式图例
//
// 时间口径（重要，改动前先读）：
//   candlekit 的 Bar.ts 是**毫秒时间戳**，lightweight-charts 只渲染 UTC 分量。
//   沪深/港交所固定 UTC+8 且无夏令时 → 直接把「交易所本地时钟」当作 UTC 写入
//   （即 Date.UTC(y,m,d,H,M)），图表显示的时间就是北京时间，无需再做偏移换算。
// ============================================================

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import "@getcandlekit/charts/styles.css";
import {
  ChartView,
  DrawingController,
  DrawingToolbar,
  IndicatorController,
  IndicatorPicker,
  MeasurementOverlay,
  createBuiltinRegistry,
  type Bar,
  type ChartTheme,
  type ChartViewApi,
  type DrawingControllerOptions,
  type DrawingToolId,
  type IndicatorDef,
  type IndicatorRegistry,
  type SeriesType,
} from "@getcandlekit/charts/react";
import { C, fmtPct, fmtPrice, pctColor } from "./shared";

/** 券商浅色主题（A 股：红涨绿跌） */
const LIGHT: ChartTheme = {
  mode: "light",
  background: "#ffffff",
  text: "#64748b",
  grid: "#f1f5f9",
  axis: "#e2e8f0",
  crosshair: "#94a3b8",
  crosshairLabelBg: "#e2e8f0",
  up: C.gain, // 涨 红
  down: C.loss, // 跌 绿
  line: C.accent,
  volumeUp: "rgba(220, 38, 38, 0.45)",
  volumeDown: "rgba(22, 163, 74, 0.45)",
  fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'PingFang SC', sans-serif",
  fontSize: 11,
};

/** 覆写 candlekit 组件 CSS 变量：测量浮层等也按红涨绿跌着色（默认西式绿涨红跌） */
const CK_VARS = { ["--ck-up" as never]: C.gain, ["--ck-down" as never]: C.loss } as CSSProperties;

/** 本页默认均线组（券商日 K 默认 5/10/20，配色沿用原实现） */
const MA_DEFS = [
  { name: "MA5", title: "5 日均线", period: 5, color: "#f59e0b" },
  { name: "MA10", title: "10 日均线", period: 10, color: "#3b82f6" },
  { name: "MA20", title: "20 日均线", period: 20, color: "#a855f7" },
] as const;

/** 分时昨收基准线（分时图的水平参考线） */
const PREV_CLOSE_NAME = "昨收";

/**
 * 均线指标定义。
 * candlekit 内置 SMA 只能按名字挂一个实例（add(name) 以 name 为键），
 * 而券商默认要同时显示 5/10/20 三条 → 注册成三个独立定义，各自带配色。
 * `calculate` 输入的时间是**秒**（lightweight-charts 单位），输出沿用即可。
 */
function maDef(name: string, title: string, period: number, color: string): IndicatorDef {
  return {
    name,
    title,
    shortTitle: name,
    category: "overlay",
    defaultInputs: { length: period },
    inputConfig: [{ name: "length", type: "int", defval: period, title: "周期" }],
    plotConfig: [{ id: "ma", title: name, color, lineWidth: 1 }],
    hlineConfig: [],
    calculate: (bars, inputs) => {
      const len = Number(inputs?.length ?? period) || period;
      const out: { time: number; value: number }[] = [];
      let sum = 0;
      for (let i = 0; i < bars.length; i++) {
        sum += bars[i].close;
        if (i >= len) sum -= bars[i - len].close;
        // 窗口不足不出点（不填充伪值，避免画出「假的均线起点」）
        if (i >= len - 1) out.push({ time: bars[i].time, value: sum / len });
      }
      return { plots: { ma: out } };
    },
  };
}

/** 昨收基准线定义（常量线；用于分时，随昨收价动态注册） */
function prevCloseDef(prevClose: number): IndicatorDef {
  return {
    name: PREV_CLOSE_NAME,
    title: "昨收基准",
    shortTitle: PREV_CLOSE_NAME,
    category: "overlay",
    defaultInputs: {},
    inputConfig: [],
    plotConfig: [{ id: "prevClose", title: PREV_CLOSE_NAME, color: "#94a3b8", lineWidth: 1 }],
    hlineConfig: [],
    calculate: (bars) => ({ plots: { prevClose: bars.map((b) => ({ time: b.time, value: prevClose })) } }),
  };
}

/** 指标注册表：内置 9 个（SMA/EMA/WMA/VWAP/BOLL/RSI/MACD/ATR/KDJ）+ 本页均线组 + 昨收线 */
function buildRegistry(prevClose?: number): IndicatorRegistry {
  const reg = createBuiltinRegistry();
  for (const d of MA_DEFS) reg.register(maDef(d.name, d.title, d.period, d.color));
  if (typeof prevClose === "number" && Number.isFinite(prevClose)) reg.register(prevCloseDef(prevClose));
  return reg;
}

/**
 * 精简绘图工具条。
 * candlekit 默认 16 个工具竖排（约 570px）会撑破图表高度 → 只留最常用的 5 个，
 * 加 3 个操作按钮共 8 个（约 240px），在 460px 图表内不会溢出。
 */
const DRAW_TOOLS: { id: DrawingToolId; label: string; title: string }[] = [
  { id: "TrendLine", label: "╱", title: "趋势线" },
  { id: "HorizontalLine", label: "─", title: "水平线" },
  { id: "VerticalLine", label: "│", title: "垂直线" },
  { id: "Rectangle", label: "▭", title: "矩形" },
  { id: "FibRetracement", label: "Fib", title: "斐波那契回撤" },
];

/** 图例数据（随十字光标联动；券商 App 顶部那一行） */
interface Legend {
  /** 日期（+ 时刻，分钟 K / 分时） */
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 相对基准的涨跌幅 %（分时基准=昨收，K 线基准=前一根收盘） */
  pct: number;
  /** 均线值（K 线）；分时此处放均价 */
  ma: { name: string; color: string; value?: number }[];
  /** 分时均价（仅分时） */
  avg?: number;
  volume?: number;
}

/**
 * 时间戳 → 显示文本。
 * 写入时已把交易所本地时钟当作 UTC（见文件头「时间口径」），故 toISOString 即为本地时钟。
 */
function tsLabel(ts: number, withTime: boolean): string {
  const iso = new Date(ts).toISOString();
  return withTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

/** 成交量（手）→ 人读文本（≥1 亿手用「亿」，≥1 万手用「万」） */
function fmtVol(v?: number): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(2)}万`;
  return String(Math.round(v));
}

/** 简单移动平均（图例用；与指标定义里的算法同口径） */
function smaAt(bars: Bar[], idx: number, period: number): number | undefined {
  if (idx < period - 1) return undefined;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) sum += bars[i].close;
  return sum / period;
}

/** 累计均价（分时黄线）：Σ(价×量) / Σ量；量全为 0 时回退价格本身 */
function avgAt(bars: Bar[], idx: number): number | undefined {
  let pv = 0;
  let vol = 0;
  for (let i = 0; i <= idx; i++) {
    const v = bars[i].volume ?? 0;
    pv += bars[i].close * v;
    vol += v;
  }
  return vol > 0 ? pv / vol : bars[idx].close;
}

function LegendBar({ legend, isLine }: { legend: Legend | null; isLine: boolean }) {
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
      <span style={{ fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>{legend.label}</span>
      {isLine ? (
        cell("价", fmtPrice(legend.close), color)
      ) : (
        <>
          {cell("开", fmtPrice(legend.open))}
          {cell("高", fmtPrice(legend.high))}
          {cell("低", fmtPrice(legend.low))}
          {cell("收", fmtPrice(legend.close), color)}
        </>
      )}
      {cell("涨跌", fmtPct(legend.pct), color)}
      {typeof legend.avg === "number" ? cell("均价", fmtPrice(legend.avg)) : null}
      {legend.ma.map((m) => (
        <span key={m.name} style={{ whiteSpace: "nowrap" }}>
          <span style={{ color: m.color }}>{m.name} </span>
          <span style={{ fontWeight: 600 }}>{typeof m.value === "number" ? m.value.toFixed(2) : "—"}</span>
        </span>
      ))}
      {cell("量", fmtVol(legend.volume))}
    </div>
  );
}

/** 在 bars 中找最接近 ts 的一根（升序数组 → 二分） */
function indexAt(bars: Bar[], ts: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  // lo 是第一个 ts >= 目标；比较相邻两根取更近的
  if (lo > 0 && Math.abs(bars[lo - 1].ts - ts) <= Math.abs(bars[lo].ts - ts)) return lo - 1;
  return lo;
}

export interface CandleChartProps {
  /** K 线 / 分时点（升序；ts 为毫秒，见文件头时间口径） */
  bars: Bar[];
  /** 主图类型：分时走 area，K 线走 candlestick */
  seriesType?: SeriesType;
  /** 图例是否带时刻（分钟 K / 分时为 true） */
  withTime?: boolean;
  /** 昨收（分时涨跌幅基准 + 昨收基准线）；K 线缺省时用前一根收盘 */
  prevClose?: number;
  /** 绘图持久化 key（建议 `ckdraw:<code>:<period>`，按标的+周期隔离） */
  storageKey?: string;
  /** 图表高度（px） */
  height?: number;
}

/**
 * 行情图表（candlekit 封装）。
 * 启用能力：多指标（下拉面板，含内置 9 个 + 均线组）、绘图工具、Shift 拖拽测量、成交量副图。
 * 多周期由外层切换 `bars`/`storageKey` 驱动（key 变化 → 图表重建 → 时间轴精度随之切换）。
 */
export function CandleChart({
  bars,
  seriesType = "candlestick",
  withTime = false,
  prevClose,
  storageKey = "ckdraw:default",
  height = 460,
}: CandleChartProps) {
  const [api, setApi] = useState<ChartViewApi | null>(null);
  const [legend, setLegend] = useState<Legend | null>(null);
  /** 闭包陷阱防护：光标回调只读 ref，不捕获渲染期的 bars */
  const barsRef = useRef<Bar[]>(bars);
  const withTimeRef = useRef(withTime);
  const prevCloseRef = useRef(prevClose);

  const isLine = seriesType === "area" || seriesType === "line";

  // 数据/配置变化：同步 ref，并把图例重置到最新一根（未悬停时也有内容）
  useEffect(() => {
    barsRef.current = bars;
    withTimeRef.current = withTime;
    prevCloseRef.current = prevClose;
    setLegend(bars.length > 0 ? legendAt(bars, bars.length - 1, withTime, prevClose, isLine) : null);
  }, [bars, withTime, prevClose, isLine]);

  // 十字光标 → 图例联动（bus.on 返回退订函数）
  useEffect(() => {
    if (!api) return;
    return api.controller.bus.on("crosshairMove", (p) => {
      // 光标移出图表：保留最后显示的图例（与券商 App 一致）
      if (!p) return;
      const cur = barsRef.current;
      if (cur.length === 0) return;
      const idx = indexAt(cur, p.ts);
      setLegend(legendAt(cur, idx, withTimeRef.current, prevCloseRef.current, isLine));
    });
  }, [api, isLine]);

  // 指标控制器：分时默认「均价 + 昨收」，K 线默认「均线组(MA5/10/20) + BOLL + MACD」
  // 默认开 MACD/BOLL 是券商行情页的常见默认（副图已就绪，用户无需逐一点开）。
  // 依赖刻意只含 isLine / prevClose —— 数据变化走 controller.onData 重算，不重建控制器
  const indicators = useMemo(() => {
    const ctl = new IndicatorController(buildRegistry(prevClose));
    if (isLine) {
      ctl.add("VWAP"); // 分时均价线（= 累计成交额 / 累计成交量）
      if (typeof prevClose === "number" && Number.isFinite(prevClose)) ctl.add(PREV_CLOSE_NAME);
    } else {
      for (const d of MA_DEFS) ctl.add(d.name, { length: d.period }); // 均线组
      ctl.add("Bollinger"); // BOLL 布林带（叠加在主图）
      ctl.add("MACD"); // MACD（独立副图）
    }
    return ctl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLine, prevClose]);

  // 绘图选项必须 memo：ChartView 以引用为依赖，字面量会每次渲染重建控制器（图形丢失）
  // 默认 Lock drawing（锁定绘图层）：用户不主动点「解锁」就不会误触画线/改图，
  // 符合行情页「看图为主、偶尔标注」的使用习惯（解锁入口在绘图工具条上的锁按钮）。
  const drawing = useMemo(() => {
    const opts: DrawingControllerOptions = { storageKey };
    const ctl = new DrawingController(opts);
    ctl.engine.setLocked(true);
    return ctl;
  }, [storageKey]);

  const chartOptions = useMemo(
    () => ({
      localization: { locale: "zh-CN", dateFormat: withTime ? "yyyy-MM-dd HH:mm" : "yyyy-MM-dd" },
      timeScale: { rightOffset: 4, timeVisible: withTime, secondsVisible: false, borderColor: C.border },
      rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.08, bottom: 0.08 } },
    }),
    [withTime],
  );

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden", background: "#fff", ...CK_VARS }}>
      <LegendBar legend={legend} isLine={isLine} />
      {/* ChartView 根节点是 height:100% → 必须外套一个定高容器 */}
      <div style={{ height, position: "relative" }}>
        <ChartView
          // 周期切换需要重建图表：时间轴精度（timeVisible）只在创建时生效
          key={storageKey}
          data={bars}
          seriesType={seriesType}
          theme={LIGHT}
          showVolume
          chartOptions={chartOptions}
          drawing={drawing}
          indicators={indicators}
          measurement
          onReady={setApi}
        >
          <DrawingToolbar tools={DRAW_TOOLS} />
          <IndicatorPicker label="指标" />
          <MeasurementOverlay />
        </ChartView>
      </div>
    </div>
  );
}

/** 构造某根数据的图例 */
function legendAt(bars: Bar[], idx: number, withTime: boolean, prevClose: number | undefined, isLine: boolean): Legend | null {
  const b = bars[idx];
  if (!b) return null;
  // 基准：分时优先昨收（券商口径）；K 线用前一根收盘（首根用自身开盘，涨跌幅为 0）
  const base = isLine && typeof prevClose === "number" && Number.isFinite(prevClose) && prevClose > 0
    ? prevClose
    : idx > 0
      ? bars[idx - 1].close
      : b.open;
  return {
    label: tsLabel(b.ts, withTime),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    pct: base > 0 ? ((b.close - base) / base) * 100 : 0,
    ma: isLine
      ? []
      : MA_DEFS.map((d) => ({ name: d.name, color: d.color, value: smaAt(bars, idx, d.period) })),
    ...(isLine ? { avg: avgAt(bars, idx) } : {}),
    volume: b.volume,
  };
}
