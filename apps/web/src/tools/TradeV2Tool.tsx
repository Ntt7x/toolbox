// ============================================================
// 仓位管理 v2（tools/trade-v2）—— 交易员视角体验版
// 布局：全横向 Tab（分组行 + 功能区行）；名称优先（代码辅助）；统计分组盒；友好配色
// 数据：逐笔交易账本（增量）→ 仓位明细（存量，自动归并派生）→ 分组约束 → 收益分析
// 每日工作流：💼 交易单 批量录入（Enter 流式跳转/复制上日/价格预填）→ 提交 → 仓位自动重算
// ============================================================
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as echarts from "echarts";
import { calcFee } from "./tradeV2Fee";
import type {
  TradeV2Alert,
  TradeV2CheckResult,
  TradeV2DailyPoint,
  TradeV2DayOrderSummary,
  TradeV2Deal,
  TradeV2Entry,
  TradeV2EntryDraft,
  TradeV2AggregateAnalysis,
  TradeV2Group,
  TradeV2GroupAnalysis,
  TradeV2GroupSummary,
  TradeV2Metrics,
  TradeV2MonthlyPoint,
  TradeV2PnlAttribution,
  TradeV2Position,
} from "@toolbox/shared";
import { api, errMsg } from "../api";
import { numInput, parseBatchText, type OrderRow } from "./tradeV2Parse";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { match } from "pinyin-pro";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";

// ---------- 配色（友好可读） ----------

// 调色板对齐 V1（策略仓位管理）审美：slate 灰系 + blue/indigo/emerald/red 柔和 tint 卡片
const C = {
  gain: "#dc2626",       // 盈利 · red-600（A股红涨）
  gainBg: "#fef2f2",     // red-50
  gainBorder: "#fee2e2", // red-100
  loss: "#059669",       // 亏损 · emerald-600（A股绿跌）
  lossBg: "#ecfdf5",     // emerald-50
  lossBorder: "#d1fae5", // emerald-100
  accent: "#2563eb",     // blue-600
  accentBg: "#eff6ff",   // blue-50
  accentBorder: "#dbeafe", // blue-100
  indigo: "#4f46e5",
  indigoBg: "#eef2ff",
  amber: "#d97706",
  amberBg: "#fffbeb",
  text: "#1e293b",       // slate-800（主文字）
  sub: "#64748b",        // slate-500
  muted: "#94a3b8",      // slate-400
  faint: "#cbd5e1",      // slate-300
  border: "#e2e8f0",     // slate-200
  panel: "#f8fafc",      // slate-50
};

/** V1 风格小节标题：彩色竖条 + 图标 + 加粗文字 */
function SectionTitle({ icon, children, color = C.accent }: { icon?: string; children: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
      <span style={{ width: 4, height: 14, borderRadius: 999, background: color, flexShrink: 0 }} />
      <span style={{ fontSize: "0.88rem", fontWeight: 700, color: C.text }}>{icon} {children}</span>
    </div>
  );
}

/** 盈亏着色 */
const pnlColor = (v: number | undefined | null): string => {
  if (typeof v !== "number" || !isFinite(v) || v === 0) return C.sub;
  return v > 0 ? C.gain : C.loss;
};

/** 信息分类徽章（memo mt4hl5g9 强化 UI：有信息📡/无信息📊） */
function InfoTypeBadge({ infoType }: { infoType?: "info" | "noinfo" }) {  if (!infoType) return null;
  return (
    <span
      title="信息分类：交易噪声是否携带信息（有信息=基于信息/逻辑判断，无信息=纯执行/统计规律）"
      style={{
        marginLeft: 6, fontSize: "0.72rem", padding: "0.08rem 0.45rem", borderRadius: 999,
        background: infoType === "info" ? C.indigoBg : C.amberBg,
        color: infoType === "info" ? C.indigo : C.amber,
        fontWeight: 700, whiteSpace: "nowrap", verticalAlign: "middle",
      }}
    >
      {infoType === "info" ? "💡 有信息" : "🗿 无信息"}
    </span>
  );
}

/** 虚盘徽章（memo mtbjkyro：不参与聚合组合/实盘金额计算） */
function PaperBadge({ isPaper }: { isPaper?: boolean }) {
  if (!isPaper) return null;
  return (
    <span
      title="虚盘：仅独立记账，金额与标的不参与「聚合组合 / 实盘实际金额」计算"
      style={{
        marginLeft: 6, fontSize: "0.72rem", padding: "0.08rem 0.45rem", borderRadius: 999,
        background: "#f0fdf4", color: "#15803d", fontWeight: 700, whiteSpace: "nowrap", verticalAlign: "middle",
      }}
    >
      📝 虚盘
    </span>
  );
}

/** 信息-风险提醒（标的市场波动口径——memo：无信息→低波运行/高波风险放大；有信息→控仓+信息-波动比） */
function InfoRiskAlert({ infoType, positions, currentStock }: {
  infoType?: "info" | "noinfo";
  /** 分组持仓（带 volatility/volLevel）——用于点名高波标的 */
  positions?: (TradeV2Position & { volatility?: number; volLevel?: "low" | "mid" | "high" | "extreme" })[];
  /** 提交标的（EntryEditor）——单标的波动提醒 */
  currentStock?: { name?: string; volatility?: number; volLevel?: "low" | "mid" | "high" | "extreme" };
}) {
  if (!infoType) return null;
  const box: React.CSSProperties = { display: "flex", alignItems: "flex-start", gap: 8, padding: "0.6rem 0.8rem", borderRadius: 10, fontSize: "0.82rem", lineHeight: 1.5, marginBottom: 10 };
  const fmtVol = (v?: number) => (v !== undefined ? v.toFixed(1) + "%" : "");
  // 分组维度：点名高波（volLevel === "high"）标的
  const highVols = (positions ?? []).filter((p) => p.volLevel === "high" && p.volatility !== undefined);
  const highText = highVols.length
    ? `：${highVols.map((p) => `${p.name ?? p.code}（${fmtVol(p.volatility)}）`).slice(0, 5).join("、")}${highVols.length > 5 ? " 等" : ""}`
    : "";
  // 单标的维度（EntryEditor 优先展示当前标的）
  const curLevel = currentStock?.volLevel;
  const curVol = fmtVol(currentStock?.volatility);

  if (infoType === "noinfo") {
    if (currentStock) {
      const style = curLevel === "extreme" ? { ...box, background: "#fef2f2", color: "#991b1b", border: "1px solid #fca5a5", fontWeight: 700 }
        : curLevel === "high" ? { ...box, background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca" }
        : curLevel === "mid" ? { ...box, background: C.amberBg, color: "#92400e", border: "1px solid #fde68a" }
        : { ...box, background: "#ecfdf5", color: "#059669", border: "1px solid #a7f3d0" };
      const text = curLevel === undefined ? `📊 无信息策略：噪声不携带信息，应在低波动环境执行（${currentStock.name ?? "该标的"}暂无波动数据）`
        : curLevel === "low" ? `✅ ${currentStock.name ?? "该标的"}低波（${curVol}）：适合无信息策略`
        : curLevel === "mid" ? `⚠️ ${currentStock.name ?? "该标的"}中波（${curVol}）：噪声增大，注意控制风险`
        : curLevel === "high" ? `🔴 ${currentStock.name ?? "该标的"}高波（${curVol}）：已偏离无信息策略适用域——建议暂停交易；如继续需大幅降仓`
        : `🔴🔴 ${currentStock.name ?? "该标的"}极波（${curVol}）：严重偏离无信息策略适用域——建议暂停交易，等待低波回归`;
      return <div style={style}>{text}</div>;
    }
    if (highVols.length > 0) {
      return <div style={{ ...box, background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca" }}>🔴 高波标的{highText}——已偏离无信息策略适用域（高波），建议暂停交易，等低波回归</div>;
    }
    return <div style={{ ...box, background: "#ecfdf5", color: "#059669", border: "1px solid #a7f3d0" }}>✅ 该组无高波标的——适配无信息策略的低波动运行要求</div>;
  }

  // 有信息
  const style = { ...box, background: C.indigoBg, color: C.indigo, border: "1px solid #c7d2fe" };
  if (currentStock) {
    const extra = curLevel === "high" || curLevel === "extreme" ? `；⚠️ 该标的高波（${curVol}）：信息-波动比偏低——建议降仓（信息优势仍在，无需清仓）` : "";
    return <div style={style}>📡 有信息也要控仓——信息优势有限，仓位过大即赌博{extra}</div>;
  }
  const highNote = highVols.length ? `；高波标的${highText}——信息-波动比偏低，建议降仓（信息优势仍在）` : "";
  return <div style={style}>📡 有信息也要控仓——信息优势有限，仓位过大即赌博{highNote}</div>;
}
/** 盈亏文本：▲/▼ + 金额（红涨绿跌；undefined/非数 → —；0 → ¥0.00 表示确为零） */
const pnlText = (v: number | undefined | null): string => {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  if (v === 0) return "¥0.00";
  const a = Math.abs(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v > 0 ? `▲ ¥${a}` : `▼ ¥${a}`;
};
const alertColor: Record<TradeV2Alert["level"], string> = { error: C.gain, warn: C.amber, info: C.accent };
const alertBg: Record<TradeV2Alert["level"], string> = { error: C.gainBg, warn: C.amberBg, info: C.accentBg };

// ---------- 格式化 ----------

const cny = (v: number | undefined | null) => (typeof v === "number" && isFinite(v) ? `¥${Math.round(v).toLocaleString("zh-CN")}` : "—");
const cny2 = (v: number | undefined | null) => {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}¥${Math.abs(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const pct = (v: number | undefined | null, digits = 1) => (typeof v === "number" && isFinite(v) ? `${v.toFixed(digits)}%` : "—");
const pctSigned = (v: number | undefined | null, digits = 1) => (typeof v === "number" && isFinite(v) ? (v > 0 ? "+" : "") + `${v.toFixed(digits)}%` : "—");
const qtyFmt = (v: number) => v.toLocaleString("zh-CN");
const costFmt = (v?: number) => (typeof v === "number" && !isNaN(v) ? String(+v.toFixed(3)) : "—");

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** 默认下一个交易日（周六/周日 → 下周一） */
function nextTradingDay(): string {
  const n = new Date();
  const d = n.getDay();
  if (d === 0) n.setDate(n.getDate() + 1);
  else if (d === 6) n.setDate(n.getDate() + 2);
  return localDateStr(n);
}
/** 导出 CSV（UTF-8 BOM，Excel 中文兼容） */
function downloadCSV(filename: string, headers: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    // 含逗号/引号/换行时加引号包裹（CSV 规范）
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = "\uFEFF" + [headers.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 名称优先展示（名称加粗 + 代码辅助灰字）——交易员可读性 */
function NameCode({ name, code, size = "0.85rem" }: { name?: string; code: string; size?: string }) {
  // 港股代码标识（3~5 位数字或 0 前缀；与 A 股 6 位代码区分，避免 00189 vs 000831 混淆）
  const isHk = /^(\d{3,5}|0\d{4})$/.test(code) && !/^\d{6}$/.test(code);
  return (
    <span className="whitespace-nowrap">
      <span style={{ fontWeight: 600, fontSize: size }}>{name ?? code}</span>
      {isHk && <span style={{ marginLeft: 4, padding: "0 3px", borderRadius: 4, background: C.indigoBg, color: C.indigo, fontSize: "0.68rem", fontWeight: 600 }}>HK</span>}
      {name ? <span style={{ color: C.muted, marginLeft: 4, fontSize: "0.75rem" }}>{code}</span> : null}
      <a href={xueqiuUrl(code)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title={`雪球 ${code}`} style={{ marginLeft: 4, color: C.muted, textDecoration: "none", fontSize: "0.75rem" }}>🔗</a>
    </span>
  );
}

/** 雪球外链 URL（A/H 股市场前缀转换；北交所/未知代码返回 # 不跳转） */
function xueqiuUrl(code: string): string {
  const c = code.trim().toUpperCase();
  let sym = "";
  if (/^(SH|SZ|BJ)\d+/.test(c)) sym = c;
  else if (/^(HK)\d+/.test(c)) sym = c.slice(2); // 港股雪球 URL 不带 HK 前缀：/S/00189
  else if (/^\d{6}$/.test(c)) {
    if (/^[56]\d{5}$/.test(c)) sym = "SH" + c;      // 沪市 A 股（6 开头）/ 沪市 ETF（5 开头，如 512800）
    else if (/^[013]\d{5}$/.test(c)) sym = "SZ" + c; // 深市 A 股/ETF（0/1/3 开头，如 159745）
    else if (/^[489]\d{5}$/.test(c)) sym = "BJ" + c; // 北交所（4/8/9 开头）
  } else if (/^\d{3,5}$|^0\d{4}$/.test(c)) sym = c; // 港股：裸代码（雪球格式 /S/00189）
  return sym ? `https://xueqiu.com/S/${sym}` : "#";
}

// ---------- ECharts 容器 ----------

function EChart({ option, height = 280, style, emptyText }: { option: echarts.EChartsOption; height?: number; style?: React.CSSProperties; emptyText?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el);
    chart.setOption(option);
    chartRef.current = chart;
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
      chartRef.current = null;
    };
  }, [option]);
  // 有图例（series 带 name）才显示 全选/全不选 开关
  const hasLegend = !!(option.legend && ((option.series as any[]) ?? []).some((x) => x?.name));
  const all = (v: boolean) => {
    const chart = chartRef.current;
    if (!chart) return;
    // legendSelectAll/UnSelectAll 实测无效（memo）——手动逐个 dispatch，最可靠
    const names = ((option.series as any[]) ?? []).map((s) => s?.name).filter(Boolean);
    try {
      for (const n of names) chart.dispatchAction({ type: v ? "legendSelect" : "legendUnSelect", name: n });
    } catch { /* 静默 */ }
  };
  const btnStyle: React.CSSProperties = {
    fontSize: "0.7rem", lineHeight: 1, padding: "0.18rem 0.5rem", borderRadius: 999,
    border: "1px solid #e2e8f0", background: "#fff", color: "#64748b", cursor: "pointer",
  };
  return (
    <div style={{ position: "relative", width: "100%", height, ...style }}>
      {emptyText ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#94a3b8", fontSize: "0.8rem", textAlign: "center", padding: "0 1rem" }}>{emptyText}</div>
      ) : (
        <>
          <div ref={ref} style={{ width: "100%", height: "100%" }} />
          {hasLegend && (
            <div style={{ position: "absolute", top: 3, right: 6, display: "flex", gap: 4, zIndex: 9999 }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
              <button title="全部显示" onClick={(e) => { e.stopPropagation(); all(true); }} style={btnStyle}>全选</button>
              <button title="全部隐藏" onClick={(e) => { e.stopPropagation(); all(false); }} style={btnStyle}>全不选</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function NetValueChart({ daily, height = 240 }: { daily: TradeV2DailyPoint[]; height?: number }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // 收益率口径（memo：行业两种标准——净值收益率 TWR 默认 / 最大成本收益率 可切换）
  const [retMode, setRetMode] = useState<"nav" | "maxCost">("nav");
  const filtered = useMemo(() => daily.filter((d) => (!from || d.date >= from) && (!to || d.date <= to)), [daily, from, to]);
  const option = useMemo<echarts.EChartsOption>(() => {
    if (filtered.length === 0) return {};
    let cum = 0;
    const cumRealized = filtered.map((d) => { cum += d.realizedPnl; return Math.round(cum * 100) / 100; });
    let inv = 0;
    const investedSeries = filtered.map((d) => { inv += d.buyAmount - d.sellAmount; return Math.round(inv * 100) / 100; });
    const p0 = investedSeries[0] ?? 0;
    const navSeries = filtered.map((d, i) => Math.round((p0 + d.marketValue - investedSeries[i]) * 100) / 100);
    // ① 净值收益率（时间加权 TWR，默认）：区间起点净值归一，r=∏(1+日收益率)−1=NAV末/NAV初−1
    const base = navSeries[0] || 1;
    const navPct = navSeries.map((v) => Math.round((v / base - 1) * 10000) / 100);
    // ② 最大成本收益率：累计收益(NAV−期初本金) ÷ 历史最大净投入成本 C_max（保守口径）
    const cMax = Math.max(...investedSeries, 0);
    const mcPct = navSeries.map((v) => (cMax > 0 ? Math.round(((v - p0) / cMax) * 10000) / 100 : 0));
    const pctSeries = retMode === "nav" ? navPct : mcPct;
    const pctName = retMode === "nav" ? "净值收益率%" : "最大成本收益率%";
    return {
      tooltip: { trigger: "axis" },
      legend: { data: ["组合净值", "持仓市值(成本)", "累计已实现", pctName], top: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 44, bottom: 0, top: 28, containLabel: true },
      xAxis: { type: "category", data: filtered.map((d) => d.date), axisLabel: { fontSize: 10 } },
      yAxis: [
        { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => `${v >= 10000 ? (v / 10000).toFixed(1) + "万" : v}` } },
        { type: "value", axisLabel: { fontSize: 10, formatter: "{value}%" }, splitLine: { show: false } },
      ],
      series: [
        { name: "组合净值", type: "line", smooth: true, showSymbol: false, data: navSeries, lineStyle: { color: C.accent, width: 2 }, areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(37,99,235,.18)" }, { offset: 1, color: "rgba(37,99,235,.02)" }] } } },
        { name: "持仓市值(成本)", type: "line", smooth: true, showSymbol: false, data: filtered.map((d) => Math.round(d.marketValue)), lineStyle: { color: C.muted, width: 1.5, type: "dashed" } },
        { name: "累计已实现", type: "line", smooth: true, showSymbol: false, data: cumRealized, lineStyle: { color: C.gain, width: 1.5, type: "dotted" } },
        { name: pctName, type: "line", smooth: true, showSymbol: false, yAxisIndex: 1, data: pctSeries, lineStyle: { color: "#f59e0b", width: 1.5 } },
      ],
    };
  }, [filtered, retMode]);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.75rem", color: C.muted }}>区间</span>
        <Input autoComplete="off" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36" />
        <span style={{ color: C.muted, fontSize: "0.8rem" }}>—</span>
        <Input autoComplete="off" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-36" />
        {(from || to) && <Button size="sm" variant="ghost" onClick={() => { setFrom(""); setTo(""); }}>重置</Button>}
        <div style={{ display: "flex", gap: 4, marginLeft: "auto", alignItems: "center" }}>
          <span style={{ fontSize: "0.7rem", color: C.muted }}>收益率口径</span>
          {(["nav", "maxCost"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setRetMode(m)}
              style={{
                fontSize: "0.72rem", padding: "0.16rem 0.55rem", borderRadius: 999, cursor: "pointer",
                border: "1px solid " + (retMode === m ? C.accent : "#e2e8f0"),
                background: retMode === m ? C.accentBg : "#fff",
                color: retMode === m ? "#1d4ed8" : "#64748b",
                fontWeight: retMode === m ? 700 : 500,
              }}
            >
              {m === "nav" ? "净值收益率" : "最大成本收益率"}
            </button>
          ))}
        </div>
        <span style={{ fontSize: "0.7rem", color: C.muted, width: "100%" }}>
          {retMode === "nav" ? "净值收益率（时间加权 TWR）：区间起点净值归一 100%，r = ∏(1+日收益率) − 1，剔除资金进出影响" : "最大成本收益率：累计收益 ÷ 历史最大净投入成本，保守反映实际赚钱效率"}
        </span>
      </div>
      <EChart option={option} height={height} emptyText={filtered.length === 0 ? "暂无交易数据——录入交易后生成净值曲线" : filtered.length === 1 ? "仅 1 个交易日（单点，暂无法成曲线）" : undefined} />
    </div>
  );
}



// ---------- 标的搜索输入 ----------

function StockSearchInput({ value, onPick, placeholder = "输入代码或名称", inputRef, onEnter, suggestions }: {
  value: { code: string; name?: string };
  onPick: (v: { code: string; name?: string }) => void;
  placeholder?: string;
  inputRef?: (el: HTMLInputElement | null) => void;
  onEnter?: () => void;
  /** 空白输入时展示的已有标的列表（memo mt4hi1zc：提交交易单时可直接点选已有标的） */
  suggestions?: { code: string; name?: string }[];
}) {
  const [text, setText] = useState(value.code);
  const [sugs, setSugs] = useState<{ code: string; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ up: boolean; top: number; left: number; width: number } | null>(null);
  /** 显示列表：空白输入 → 已有标的（suggestions）；否则 → 搜索结果 */
  const list = text.trim() ? sugs : (suggestions ?? []);
  const show = open && list.length > 0;

  useEffect(() => {
    setText(value.code);
  }, [value.code]);

  // 建议列表定位：portal 到 body 后按输入框视口坐标 fixed 定位；滚动/缩放跟随，视口下方空间不足时翻转到上方
  useLayoutEffect(() => {
    if (!show) { setPos(null); return; }
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      const estH = Math.min(320, list.length * 40) + 12;
      const up = r.bottom + estH > window.innerHeight - 8 && r.top > estH;
      setPos({ up, top: up ? r.top : r.bottom, left: r.left, width: r.width });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [show, list.length, suggestions]);

  const pick = (s: { code: string; name?: string }) => {
    onPick({ code: s.code, name: s.name });
    setText(s.code);
    setOpen(false);
    setActive(-1);
  };

  const search = (q: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setSugs([]);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const r = await api.watchlistSearchStock(q.trim(), 8);
        setSugs(r.items.map((i) => ({ code: i.code, name: i.name })));
        setActive(0);
        setOpen(true);
      } catch {
        setSugs([]);
      }
    }, 300);
  };

  // 键盘导航：↑↓ 选择建议，Enter 确认（无建议时交给行内 Enter 跳格），Esc 关闭 */
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) { if (list.length > 0) setOpen(true); return; }
      setActive((i) => (i + 1) % Math.max(1, list.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? list.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && list.length > 0 && active >= 0) pick(list[active]!);
      else onEnter?.();
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div style={{ position: "relative" }} ref={wrapRef}>
      <Input autoComplete="off"
        ref={inputRef}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          if (v.trim()) setOpen(false);
          else if ((suggestions ?? []).length > 0) setOpen(true); // 空白 → 显示已有标的
          onPick({ code: v });
          search(v);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        onFocus={() => { if (list.length > 0) setOpen(true); }}
        onKeyDown={onKeyDown}
        className="h-8"
      />
      {value.name && <div style={{ position: "absolute", right: 8, top: 7, fontSize: "0.72rem", color: C.sub, pointerEvents: "none" }}>{value.name}</div>}
      {show && createPortal(
        <div style={{
          position: "fixed",
          zIndex: 9999,
          top: pos ? (pos.up ? undefined : pos.top + 4) : 0,
          bottom: pos && pos.up ? window.innerHeight - pos.top + 4 : undefined,
          left: pos?.left ?? 0,
          width: pos?.width ?? 220,
          background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 6px 20px rgba(15,23,42,.12)", maxHeight: 320, overflowY: "auto",
        }}>
          {list.map((s, i) => (
            <div
              key={s.code}
              style={{ padding: "0.5rem 0.7rem", cursor: "pointer", fontSize: "0.85rem", display: "flex", justifyContent: "space-between", gap: 8, background: i === active ? C.accentBg : undefined }}
              onMouseDown={() => pick(s)}
              onMouseEnter={() => setActive(i)}
            >
              <span>{s.name}</span>
              <span style={{ color: C.muted, fontSize: "0.75rem" }}>{s.code}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ---------- 交易编辑器弹窗 ----------

function EntryEditor({ open, onClose, groups, initial, onSaved }: {
  open: boolean;
  onClose: () => void;
  groups: TradeV2GroupSummary[];
  initial: TradeV2Entry | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<TradeV2EntryDraft>(() => ({
    groupId: groups[0]?.id ?? "",
    date: nextTradingDay(),
    code: "",
    action: "buy",
    quantity: 0,
    price: 0,
  }));
  const [stock, setStock] = useState<{ code: string; name?: string }>({ code: "" });
// 空白补全：接口获取当前分组的标的列表（memo 补充：直接接口，前端不过滤）
const [groupStocks, setGroupStocks] = useState<{ code: string; name?: string }[]>([]);
// 当前分组持仓（信息-风险提醒：提交标的波动）
const [groupPositions, setGroupPositions] = useState<TradeV2Position[]>([]);
useEffect(() => {
  if (!open || !draft.groupId) { setGroupStocks([]); setGroupPositions([]); return; }
  let live = true;
  void (async () => {
    try {
      const [s, g] = await Promise.all([api.tradeV2GroupStocks(draft.groupId), api.tradeV2Group(draft.groupId)]);
      if (!live) return;
      if (s.ok) setGroupStocks(s.stocks ?? []);
      setGroupPositions(g.analysis?.positions ?? []);
    } catch { if (live) { setGroupStocks([]); setGroupPositions([]); } }
  })();
  return () => { live = false; };
}, [open, draft.groupId]);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<TradeV2CheckResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setDraft({
        groupId: initial.groupId,
        date: initial.date,
        code: initial.code,
        name: initial.name,
        action: initial.action,
        quantity: initial.quantity,
        price: initial.price,
        fee: initial.fee,
        initial: initial.initial,
        note: initial.note,
      });
      setStock({ code: initial.code, name: initial.name });
    } else {
      setDraft({ groupId: groups[0]?.id ?? "", date: nextTradingDay(), code: "", action: "buy", quantity: 0, price: 0 });
      setStock({ code: "" });
    }
    setResult(null);
    setMsg(null);
  }, [open, initial, groups]);

  const set = <K extends keyof TradeV2EntryDraft>(k: K, v: TradeV2EntryDraft[K]) => setDraft((p) => ({ ...p, [k]: v }));

  const doCheck = async () => {
    if (!draft.code.trim() || draft.quantity <= 0 || draft.price <= 0) {
      setMsg("请先填写代码、数量与价格");
      return;
    }
    setChecking(true);
    setMsg(null);
    try {
      const r = await api.tradeV2CheckEntry({ ...draft, code: stock.code.trim(), name: stock.name || draft.name });
      setResult(r.result ?? null);
    } catch (e) {
      setMsg("❌ " + errMsg(e));
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    if (!draft.groupId) { setMsg("请选择所属分组"); return; }
    if (!stock.code.trim()) { setMsg("请填写标的代码"); return; }
    if (!draft.quantity || draft.quantity <= 0) { setMsg("数量必须为正整数"); return; }
    if (!draft.price || draft.price <= 0) { setMsg("价格必须大于 0"); return; }
    setSaving(true);
    setMsg(null);
    try {
      const payload: TradeV2EntryDraft = { ...draft, code: stock.code.trim(), name: stock.name || draft.name };
      if (initial) await api.tradeV2UpdateEntry(initial.id, payload);
      else await api.tradeV2CreateEntry(payload);
      onSaved();
      onClose();
    } catch (e) {
      setMsg("❌ " + errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v: boolean) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-lg overflow-visible" style={{ minHeight: 660 }}>
        <DialogHeader>
          <DialogTitle>{initial ? "编辑交易" : "记一笔交易"}</DialogTitle>
          <DialogDescription>一笔交易进入账本后，仓位/盈亏/复盘全部自动重算（单一数据源）。</DialogDescription>
        </DialogHeader>

        <InfoRiskAlert infoType={groups.find((g) => g.id === draft.groupId)?.infoType} currentStock={groupPositions.find((p) => p.code === draft.code) ?? undefined} />

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">所属分组</label>
            <Select value={draft.groupId} onValueChange={(v: string | null) => set("groupId", v ?? "")}>
              <SelectTrigger className="w-full"><SelectValue>{groups.find((g) => g.id === draft.groupId)?.name ?? "选择分组"}</SelectValue></SelectTrigger>
              <SelectContent>
                {groups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}<InfoTypeBadge infoType={g.infoType} /><PaperBadge isPaper={g.isPaper} /></SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">成交日期</label>
            <Input autoComplete="off" type="date" className="h-8" value={draft.date} onChange={(e) => set("date", e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">标的（搜索补全名称）</label>
            <StockSearchInput value={stock} onPick={(v) => { setStock(v); set("code", v.code); set("name", v.name); }} placeholder="输入代码或名称搜索" suggestions={groupStocks} />
          </div>
          <div>
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">操作</label>
            <Select value={draft.action} onValueChange={(v: string | null) => set("action", (v ?? "buy") as "buy" | "sell")}>
              <SelectTrigger className="w-full"><SelectValue>{draft.action === "sell" ? "卖出" : "买入"}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value="buy">买入</SelectItem>
                <SelectItem value="sell">卖出</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">数量（股）</label>
            <Input autoComplete="off" type="number" min={0} step={1} className="h-8" value={draft.quantity || ""} placeholder="如 100" onChange={(e) => set("quantity", numInput(e.target.value))} />
          </div>
          <div>
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">成交价（元）</label>
            <Input autoComplete="off" type="number" min={0} step={0.01} className="h-8" value={draft.price || ""} placeholder="如 10.50" onChange={(e) => set("price", Number(e.target.value) || 0)} />
          </div>
          <div>
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">手续费（可选）</label>
            <Input autoComplete="off" type="number" min={0} step={0.01} className="h-8" value={draft.fee ?? ""} placeholder="0" onChange={(e) => set("fee", e.target.value === "" ? undefined : Number(e.target.value) || 0)} />
          </div>
          <div className="col-span-2">
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">备注（可选）</label>
            <Input autoComplete="off" className="h-8" value={draft.note ?? ""} placeholder="交易理由/复盘备注" onChange={(e) => set("note", e.target.value)} />
          </div>
          <div className="col-span-2 flex items-center gap-2">
            <Switch checked={!!draft.initial} onCheckedChange={(v: boolean) => set("initial", v)} />
            <span className="text-sm text-slate-600">期初建仓（存量起点：仅作仓位基准，不参与限额校验）</span>
          </div>
        </div>

        {result && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 180, overflowY: "auto" }}>
            {result.alerts.map((a, i) => (
              <div key={i} style={{ background: alertBg[a.level], color: alertColor[a.level], padding: "0.4rem 0.6rem", borderRadius: 8, fontSize: "0.8rem" }}>
                <b>{a.level === "error" ? "✖" : a.level === "warn" ? "⚠" : "ℹ"} {a.message}</b>
                {a.detail ? <span style={{ display: "block", marginTop: 2 }}>{a.detail}</span> : null}
              </div>
            ))}
          </div>
        )}
        {msg && <div style={{ color: C.gain, fontSize: "0.85rem" }}>{msg}</div>}

        <DialogFooter>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Button variant="outline" onClick={() => void doCheck()} disabled={checking}>{checking ? "校验中…" : "🔍 校验"}</Button>
            <Button onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : initial ? "💾 保存修改" : "✅ 记入账本"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 分组编辑器弹窗 ----------

function GroupEditor({ open, onClose, groups, initial, onSaved, inline }: {
  open: boolean;
  onClose: () => void;
  groups: TradeV2GroupSummary[];
  initial: TradeV2Group | null;
  onSaved: () => void;
  inline?: boolean;   // 内嵌模式（分组设置 tab）：不渲染 Dialog，直接渲染表单
}) {
  const [name, setName] = useState("");
  const [infoType, setInfoType] = useState<"info" | "noinfo" | "">("");
  const [isPaper, setIsPaper] = useState(false);
  const [aggType, setAggType] = useState<"base" | "agg">("base");
  const [aggSources, setAggSources] = useState<string[]>([]);
  const [totalCapital, setTotalCapital] = useState(0);
  const [dailyAddLimit, setDailyAddLimit] = useState(0);
  const [limits, setLimits] = useState<{ code: string; name?: string; maxWeightPct?: number }[]>([{ code: "" }]);
  const [allowShort, setAllowShort] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setInfoType(initial?.infoType ?? "");
    setIsPaper(initial?.isPaper ?? false);
    setAggType(initial?.aggSources && initial.aggSources.length > 0 ? "agg" : "base");
    setAggSources(initial?.aggSources ?? []);
    setTotalCapital(initial?.totalCapital ?? 0);
    setDailyAddLimit(initial?.dailyAddLimit ?? 0);
    setLimits(initial && initial.stockLimits.length > 0 ? initial.stockLimits.map((s) => ({ ...s })) : [{ code: "" }]);
    setAllowShort(initial?.allowShort ?? false);
    setMsg(null);
    setDeleting(false);
  }, [open, initial]);

  const save = async () => {
    if (!name.trim()) { setMsg("分组名称不能为空"); return; }
    setSaving(true);
    setMsg(null);
    try {
      const stockLimits = limits.filter((l) => l.code.trim() && l.maxWeightPct !== undefined).map((l) => ({ code: l.code.trim(), ...(l.name ? { name: l.name } : {}), maxWeightPct: l.maxWeightPct! }));
      const aggSourcesArg = aggType === "agg" && aggSources.length > 0 ? aggSources : null;
      // 聚合分组无信息类型/账本类型基础属性（memo：仅基础分组有）——agg 时清空
      const infoTypeArg = aggType === "base" ? (infoType || null) : null;
      const isPaperArg = aggType === "base" ? isPaper : false;
      if (initial) await api.tradeV2SaveGroup(initial.id, { name: name.trim(), totalCapital, dailyAddLimit, stockLimits, allowShort, isPaper: isPaperArg, aggSources: aggSourcesArg, ...(infoTypeArg ? { infoType: infoTypeArg } : { infoType: null }) });
      else await api.tradeV2CreateGroup(name.trim(), infoTypeArg || undefined, isPaperArg, aggSourcesArg ?? undefined);
      onSaved();
      if (!inline) onClose();
    } catch (e) {
      setMsg("❌ " + errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!initial) return;
    if (!window.confirm(`确定删除分组「${initial.name}」？其全部 ${groups.find((g) => g.id === initial.id)?.entryCount ?? "?"} 笔交易将一并删除（不可恢复）。`)) return;
    setDeleting(true);
    try {
      await api.tradeV2DeleteGroup(initial.id);
      onSaved();
      if (!inline) onClose();
    } catch (e) {
      setMsg("❌ " + errMsg(e));
    } finally {
      setDeleting(false);
    }
  };

  const form = (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">分组名称</label>
          <Input autoComplete="off" className="h-8" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：稳健成长 / 网格策略" />
          <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1 mt-2">分组类型</label>
          <Select value={aggType} onValueChange={(v: string | null) => setAggType((v as "base" | "agg") ?? "base")}>
            <SelectTrigger style={{ height: 32 }}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="base">基础分组（自主管理标的）</SelectItem>
              <SelectItem value="agg">聚合分组（标的是其他分组的并集）</SelectItem>
            </SelectContent>
          </Select>
          {aggType === "base" && (
          <>
<label className="text-[0.8rem] font-semibold text-slate-600 block mb-1 mt-2">信息分类（memo mt4hl5g9：交易噪声是否携带信息）</label>
          <Select value={infoType} onValueChange={(v: string | null) => setInfoType((v as "info" | "noinfo" | "") ?? "")}>
            <SelectTrigger style={{ height: 32 }}><SelectValue placeholder="未设置" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="info">有信息（基于信息/逻辑判断）</SelectItem>
              <SelectItem value="noinfo">无信息（纯执行/统计规律）</SelectItem>
            </SelectContent>
          </Select>
          <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1 mt-2">账本类型（memo mtbjkyro）</label>
          <Select value={isPaper ? "paper" : "real"} onValueChange={(v: string | null) => setIsPaper(v === "paper")}>
            <SelectTrigger style={{ height: 32 }}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="real">实盘（参与聚合/实盘实际金额计算）</SelectItem>
              <SelectItem value="paper">虚盘（仅独立记账，不参与聚合/实盘金额）</SelectItem>
            </SelectContent>
          </Select>
                    </>
          )}{aggType === "agg" && (
            <div className="mt-2">
              <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">来源分组（标的本分组的并集；支持基础/聚合嵌套）</label>
              <div style={{ maxHeight: 160, overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                {groups.filter((x) => x.id !== initial?.id).map((x) => (
                  <label key={x.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.8rem", color: C.text, cursor: "pointer" }}>
                    <input type="checkbox" checked={aggSources.includes(x.id)} onChange={(e) => setAggSources((prev) => (e.target.checked ? [...prev, x.id] : prev.filter((i) => i !== x.id)))} />
                    {x.name}
                    {x.isAgg ? <span style={{ fontSize: "0.68rem", color: C.sub }}>（聚合）</span> : null}
                    {x.isPaper ? <span style={{ fontSize: "0.68rem", color: C.sub }}>（虚盘）</span> : null}
                  </label>
                ))}
                {groups.filter((x) => x.id !== initial?.id).length === 0 && <span style={{ fontSize: "0.78rem", color: C.sub }}>暂无其他分组可作为来源</span>}
              </div>
            </div>
          )}
        </div>
        {aggType === "base" && (
        <>
        <div>
          <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">总仓位上限（元）</label>
          <Input autoComplete="off" type="number" min={0} className="h-8" value={totalCapital || ""} placeholder="0 = 不限" onChange={(e) => setTotalCapital(Number(e.target.value) || 0)} />
        </div>
        <div>
          <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">单日加仓上限（元）</label>
          <Input autoComplete="off" type="number" min={0} className="h-8" value={dailyAddLimit || ""} placeholder="0 = 不限" onChange={(e) => setDailyAddLimit(Number(e.target.value) || 0)} />
        </div>
        <div className="col-span-2">
          <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">单标的上限（% 占总仓位；可选）</label>
          <div style={{ maxHeight: 150, overflowY: "auto", paddingRight: 4 }}>
          {limits.map((l, i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
              <Input autoComplete="off" className="h-8 w-40" value={l.code} placeholder="代码" onChange={(e) => setLimits((p) => p.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} />
              <Input autoComplete="off" className="h-8 w-36" value={l.name ?? ""} placeholder="名称（可选）" onChange={(e) => setLimits((p) => p.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <Input autoComplete="off" type="number" min={0} max={100} className="h-8 w-24" value={l.maxWeightPct ?? ""} placeholder="上限%" onChange={(e) => setLimits((p) => p.map((x, j) => (j === i ? { ...x, maxWeightPct: e.target.value === "" ? undefined : Number(e.target.value) || 0 } : x)))} />
              <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:bg-red-50" onClick={() => setLimits((p) => (p.length > 1 ? p.filter((_, j) => j !== i) : p))}>✕</Button>
            </div>
          ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => setLimits((p) => [...p, { code: "" }])}>＋ 添加标的限制</Button>
        </div>
        <div className="col-span-2" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: "0.8rem", color: C.sub, fontWeight: 500 }}>
            <input type="checkbox" checked={allowShort} onChange={(e) => setAllowShort(e.target.checked)} style={{ accentColor: C.accent }} />
            🔻 允许做空（卖出可超持仓 → 负持仓）
          </label>
          <span style={{ fontSize: "0.72rem", color: C.muted }}>开启后卖出数量可超过当前持仓，超卖部分形成空头；未开启时超卖视为异常被拒绝</span>
        </div>
        </>)}
      </div>
      {msg && <div style={{ color: msg.startsWith("❌") ? C.gain : C.text, fontSize: "0.85rem", marginTop: 6 }}>{msg}</div>}

      <div style={{ display: "flex", gap: 8, width: "100%", justifyContent: "space-between", marginTop: 10 }}>
        {initial ? (
          <Button variant="destructive" size="sm" onClick={() => void remove()} disabled={deleting}>{deleting ? "删除中…" : "🗑 删除分组"}</Button>
        ) : <span />}
        <div style={{ display: "flex", gap: 8 }}>
          {!inline && <Button variant="outline" size="sm" onClick={onClose}>取消</Button>}
          <Button size="sm" onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "💾 保存"}</Button>
        </div>
      </div>
    </>
  );

  if (inline) return <div>{form}</div>;

  return (
    <Dialog open={open} onOpenChange={(v: boolean) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial ? "分组设置" : "新建分组"}</DialogTitle>
          <DialogDescription>分组 = 交易的组织单元（如策略）；组内可实施仓位限制（总仓位 / 单日加仓 / 单标的上限）。</DialogDescription>
        </DialogHeader>
        {form}
      </DialogContent>
    </Dialog>
  );
}

// ---------- V1 导入弹窗 ----------


// ---------- 统计分组盒（逻辑相关数据合并展示） ----------

interface StatItem { label: string; value: string; color?: string; sub?: string }
/** 统计分组盒（V1 审美）：tint 图标徽章 + 三数据列 */
function StatGroup({ title, icon, items, tone = "blue" }: { title: string; icon: string; items: StatItem[]; tone?: "blue" | "indigo" | "emerald" | "red" | "amber" }) {
  const chip = {
    blue: [C.accent, C.accentBg, C.accentBorder] as const,
    indigo: [C.indigo, C.indigoBg, "#e0e7ff"] as const,
    emerald: [C.loss, C.lossBg, C.lossBorder] as const,
    red: [C.gain, C.gainBg, C.gainBorder] as const,
    amber: [C.amber, C.amberBg, "#fde68a"] as const,
  }[tone];
  return (
    <Card style={{ boxShadow: "0 1px 2px rgba(15,23,42,0.04)" }}>
      <CardContent style={{ padding: "0.75rem 0.9rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
          <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 6, background: chip[1], border: "1px solid " + chip[2], color: chip[0], fontSize: "0.8rem", flexShrink: 0 }}>{icon}</span>
          <span style={{ fontSize: "0.74rem", fontWeight: 700, color: C.sub }}>{title}</span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {items.map((it) => (
            <div key={it.label} style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "0.66rem", color: C.muted }}>{it.label}</div>
              <div style={{ fontSize: "0.98rem", fontWeight: 700, color: it.color ?? C.text, whiteSpace: "nowrap", marginTop: 1 }}>{it.value}</div>
              {it.sub ? <div style={{ fontSize: "0.66rem", color: C.muted, marginTop: 1 }}>{it.sub}</div> : null}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- 仓位明细表 ----------

function PositionsTable({ positions, groupView, onRowClick, exportName, positionPct }: { positions: TradeV2Position[]; groupView: boolean; onRowClick?: (p: TradeV2Position) => void; exportName?: string; positionPct?: number }) {
  const [sortKey, setSortKey] = useState<"quantity" | "avgCost" | "costAvg" | "changePct" | "marketValue" | "realizedPnl" | "unrealizedPnl" | "totalPnl" | "totalPnlPct" | "weightPct" | null>("marketValue");   // 默认按市值降序（memo msuu4cw4）
  const [asc, setAsc] = useState(false);
  const [search, setSearch] = useState("");   // 标的模糊搜索（memo mta4nkop：按代码/名称过滤）
  const totalMv = positions.reduce((a, p) => a + Math.abs(p.marketValue), 0);   // 占比分母（含空头绝对值）
  const weightOf = (p: TradeV2Position): number | undefined => (p.weightPct !== undefined ? p.weightPct : totalMv > 0 ? (Math.abs(p.marketValue) / totalMv) * 100 : undefined);
  /** 成本金额（成本均价 × 数量；全部视图无 costAvg 时用买入均价成本口径） */
  const costOf = (p: TradeV2Position): number | undefined => {
    if (p.costAvg !== undefined) return p.costAvg * Math.abs(p.quantity);
    return Math.abs(p.avgCost * p.quantity);
  };
  const totalPnlOf = (p: TradeV2Position): number => (p.realizedPnl ?? 0) + (p.unrealizedPnl ?? 0);
  /** 总盈亏比例（对成本金额；成本 ≤0 时无意义显示 —） */
  const totalPnlPctOf = (p: TradeV2Position): string => {
    const c = costOf(p);
    if (c === undefined || c <= 0) return "—";
    const t = (totalPnlOf(p) / c) * 100;
    return `${t > 0 ? "+" : ""}${t.toFixed(1)}%`;
  };
  const sorted = useMemo(() => {
    // 先模糊搜索过滤（memo mta4nkop：代码/名称 + 拼音模糊 pinyin-pro），再排序
    const q = search.trim().toLowerCase();
    const list = q
      ? positions.filter((p) => {
          const code = (p.code ?? "").toLowerCase();
          const name = p.name ?? "";
          if (code.includes(q) || name.toLowerCase().includes(q)) return true;
          try {
            return !!match(name, q); // 拼音匹配：首字母/全拼/混合（如 gzmt / guizhoumaotai）
          } catch {
            return false;
          }
        })
      : positions;
    if (!sortKey) return list;
    const arr = [...list].sort((a, b) => {
      // weightPct 排序：组视图用服务端值；全局视图用市值绝对值；totalPnl = 已实现+未实现；totalPnlPct 按百分比数值
      const valOf = (x: TradeV2Position): number => sortKey === "weightPct" ? (weightOf(x) ?? 0) : sortKey === "totalPnl" ? (x.realizedPnl ?? 0) + (x.unrealizedPnl ?? 0) : sortKey === "totalPnlPct" ? parseFloat(totalPnlPctOf(x)) || 0 : (x[sortKey] ?? 0);
      return valOf(a) - valOf(b);
    });
    return asc ? arr : arr.reverse();
  }, [positions, sortKey, asc, totalMv, search]);
  const onSort = (k: typeof sortKey) => { if (sortKey === k) setAsc((v) => !v); else { setSortKey(k); setAsc(false); } };
  const sortableHead = (label: string, k: typeof sortKey, cls?: string) => (
    <TableHead className={cls} onClick={() => onSort(k)} style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}>
      {label}{sortKey === k ? (asc ? " ▲" : " ▼") : ""}
    </TableHead>
  );
  /** 仓位进度条颜色：<60% 安全绿 / <85% 警告琥珀 / ≥85% 危险红（memo mt2lzbcw） */
  const barColor = (pct: number): string => (pct < 60 ? "#059669" : pct < 85 ? "#d97706" : "#dc2626");
  return positions.length === 0 ? (
    <Card><CardContent style={{ padding: "1.5rem", textAlign: "center", color: C.muted, fontSize: "0.85rem" }}>暂无持仓（仓位明细由交易自动派生）。</CardContent></Card>
  ) : (
    <Card><CardContent>
      {exportName && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 搜索标的（代码/名称）…"
            style={{ maxWidth: 260, fontSize: "0.85rem", height: 32 }}
          />
          <Button size="sm" variant="outline" onClick={() => downloadCSV(exportName, ["代码", "名称", "数量", "均价", "最新价", "市值", "占总仓位", "已实现", "未实现", "未实现%"], positions.map((p) => [p.code, p.name ?? "", p.quantity, +p.avgCost.toFixed(3), p.latestPrice ? +p.latestPrice.toFixed(3) : "", Math.round(p.marketValue * 100) / 100, weightOf(p) !== undefined ? Math.round(weightOf(p)! * 100) / 100 : "", Math.round(p.realizedPnl * 100) / 100, Math.round(p.unrealizedPnl * 100) / 100, p.unrealizedPnlPct ?? ""]))}>📤 导出 CSV</Button>
        </div>
      )}
      {positionPct !== undefined && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: C.sub, marginBottom: 4 }}>
            <span>分组仓位（总市值/总仓位上限）</span>
            <span style={{ fontWeight: 700, color: barColor(positionPct) }}>{pct(positionPct)}</span>
          </div>
          <div style={{ height: 8, borderRadius: 4, background: "#e2e8f0", overflow: "hidden" }}>
            <div style={{ width: `${Math.min(100, Math.max(0, positionPct))}%`, height: "100%", background: barColor(positionPct), borderRadius: 4, transition: "width .3s ease" }} />
          </div>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>标的（点击行看交易历史）</TableHead>
            {sortableHead("涨跌幅", "changePct", "text-right")}
            <TableHead className="text-right">今日盈亏</TableHead>
            {sortableHead("数量", "quantity", "text-right")}
            <TableHead className="text-right">市价</TableHead>
            {sortableHead("买入均价", "avgCost", "text-right")}
            {sortableHead("成本均价", "costAvg", "text-right")}
            <TableHead className="text-right">成本</TableHead>
            {sortableHead("市值", "marketValue", "text-right")}
            {sortableHead("占总仓位", "weightPct", "text-right")}
            {sortableHead("已实现", "realizedPnl", "text-right")}
            {sortableHead("未实现", "unrealizedPnl", "text-right")}
            {sortableHead("未实现%", "unrealizedPnl", "text-right")}
            {sortableHead("总盈亏", "totalPnl", "text-right")}
            {sortableHead("总盈亏%", "totalPnlPct", "text-right")}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((p) => (
            <TableRow key={p.code} onClick={() => onRowClick?.(p)} style={onRowClick ? { cursor: "pointer" } : undefined} title={onRowClick ? "查看交易历史" : undefined}>
              <TableCell><NameCode name={p.name} code={p.code} />{p.quantity < 0 ? <Badge style={{ marginLeft: 6, background: "#fff7ed", color: "#c2410c" }} title="空头（做空）：数量为负，价格下跌盈利">空头</Badge> : p.avgCost < 0 ? <Badge style={{ marginLeft: 6, background: "#faf5ff", color: "#7c3aed" }} title="负成本（已回本/做空记账）：盈亏率无意义">负成本</Badge> : null}</TableCell>
              <TableCell className="text-right" style={{ color: p.changePct === undefined ? C.sub : p.changePct > 0 ? C.gain : p.changePct < 0 ? C.loss : C.sub, fontWeight: 600 }}>{p.changePct !== undefined ? `${p.changePct > 0 ? "+" : ""}${p.changePct}%` : "—"}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(p.todayPnl) }}>{p.todayPnl !== undefined ? cny2(p.todayPnl) : "—"}</TableCell>
              <TableCell className="text-right">{qtyFmt(Math.abs(p.quantity))}{p.quantity < 0 ? <span style={{ color: "#c2410c", fontSize: "0.72rem", marginLeft: 4 }}>卖</span> : null}</TableCell>
              <TableCell className="text-right" style={{ color: p.latestPrice !== undefined && p.latestPrice > 0 ? C.text : C.sub, fontWeight: 600 }} title="实时市价">{p.latestPrice !== undefined && p.latestPrice > 0 ? costFmt(p.latestPrice) : "—"}</TableCell>
              <TableCell className="text-right">{costFmt(p.avgCost)}</TableCell>
              <TableCell className="text-right" title={p.costAvg !== undefined ? "摊薄成本：把已实现盈亏摊入剩余持仓，卖出盈利后下降" : "未持仓"}>{p.costAvg !== undefined ? costFmt(p.costAvg) : "—"}</TableCell>
              <TableCell className="text-right" style={{ color: costOf(p) !== undefined && costOf(p)! < 0 ? C.loss : C.text }}>{costOf(p) !== undefined ? cny2(costOf(p)!) : "—"}</TableCell>
              <TableCell className="text-right" style={{ color: p.marketValue < 0 ? C.loss : C.text, fontWeight: 700 }}>{cny2(p.marketValue)}</TableCell>
              <TableCell className="text-right" style={{ color: weightOf(p) !== undefined && weightOf(p)! > 100 ? C.amber : C.sub, fontWeight: weightOf(p) !== undefined && weightOf(p)! > 100 ? 700 : 500 }}>{weightOf(p) !== undefined ? pct(weightOf(p)) : "—"}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(p.realizedPnl), fontWeight: 600 }}>{pnlText(p.realizedPnl)}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(p.unrealizedPnl), fontWeight: 600 }}>{pnlText(p.unrealizedPnl)}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(p.unrealizedPnl), fontWeight: 700 }}>{p.unrealizedPnlPct !== undefined ? pct(p.unrealizedPnlPct) : "—"}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(totalPnlOf(p)), fontWeight: 600 }}>{pnlText(totalPnlOf(p))}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(totalPnlOf(p)) }}>{totalPnlPctOf(p)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div style={{ fontSize: "0.72rem", color: C.muted, marginTop: 8 }}>
        {groupView ? "市值按最新行情（无行情时按成本口径）；已实现 = 该标的本组卖出/回补累计。" : "组合视图（聚合分析）：按成本口径估算（无行情标的）。"}
        {positions.some((p) => p.quantity < 0) ? " 空头（做空）：数量显示为卖出股数，未实现 = 股数×(开空均价−现价)，价格下跌盈利。" : ""}
      </div>
    </CardContent></Card>
  );
}

/** 全部视图的仓位（合并各分组持仓）——按 code 合并数量/成本（做空感知：卖出超持仓 → 负持仓） */
function positionsFromGlobal(entries: TradeV2Entry[]): TradeV2Position[] {
  const map = new Map<string, { code: string; name?: string; quantity: number; costBasis: number; realized: number }>();
  const apply = (st: { quantity: number; costBasis: number; realized: number }, e: TradeV2Entry) => {
    const fee = typeof e.fee === "number" && e.fee > 0 ? e.fee : 0;
    const q = e.quantity;
    if (e.action === "buy") {
      if (st.quantity >= 0) {
        st.quantity += q;
        st.costBasis += q * e.price + fee;
      } else {
        const cover = Math.min(q, -st.quantity);
        const shortAvg = st.costBasis / st.quantity;
        st.realized += (shortAvg - e.price) * cover - fee;
        st.costBasis -= shortAvg * cover;
        st.quantity += cover;
        const rest = q - cover;
        if (rest > 0) { st.quantity += rest; st.costBasis += rest * e.price; }
      }
    } else {
      if (st.quantity > 0) {
        const avg = st.costBasis / st.quantity;
        const sellQty = Math.min(q, st.quantity);
        st.realized += (e.price - avg) * sellQty - fee;
        st.costBasis -= avg * sellQty;
        st.quantity -= sellQty;
        const rest = q - sellQty;
        if (rest > 0) { st.quantity -= rest; st.costBasis -= rest * e.price; }
      } else {
        st.quantity -= q;
        st.costBasis -= q * e.price;
        st.realized -= fee;
      }
    }
  };
  for (const e of entries) {
    const st = map.get(e.code) ?? { code: e.code, name: e.name, quantity: 0, costBasis: 0, realized: 0 };
    apply(st, e);
    map.set(e.code, st);
  }
  const out: TradeV2Position[] = [];
  for (const st of map.values()) {
    if (st.quantity === 0) continue;
    const avgCost = st.quantity !== 0 ? st.costBasis / st.quantity : 0;
    out.push({
      code: st.code,
      name: st.name,
      quantity: st.quantity,
      avgCost,
      costValue: st.quantity * avgCost,
      marketValue: st.quantity * avgCost,
      unrealizedPnl: 0,
      realizedPnl: st.realized,
    });
  }
  return out.sort((a, b) => Math.abs(b.costValue) - Math.abs(a.costValue));
}


// ---------- 交易绩效（复盘深度：盈亏比 / 期望 / 持有天数对比） ----------

function PerformanceCard({ deals, metrics }: { deals: TradeV2Deal[]; metrics?: TradeV2Metrics }) {
  const closed = deals.filter((d) => d.status === "closed");
  if (closed.length === 0) return null;
  const wins = closed.filter((d) => (d.pnl ?? 0) > 0);
  const losses = closed.filter((d) => (d.pnl ?? 0) < 0);
  const avgWin = wins.length ? wins.reduce((a, d) => a + (d.pnl ?? 0), 0) / wins.length : undefined;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, d) => a + (d.pnl ?? 0), 0)) / losses.length : undefined;
  const pf = avgWin !== undefined && avgLoss !== undefined && avgLoss > 0 ? avgWin / avgLoss : undefined;
  const expectancy = closed.length ? closed.reduce((a, d) => a + (d.pnl ?? 0), 0) / closed.length : undefined;
  const winDays = wins.length ? wins.reduce((a, d) => a + (d.days ?? 0), 0) / wins.length : undefined;
  const lossDays = losses.length ? losses.reduce((a, d) => a + (d.days ?? 0), 0) / losses.length : undefined;
  const holdNote =
    winDays !== undefined && lossDays !== undefined
      ? winDays >= lossDays
        ? "✅ 盈利笔持得更久（让利润奔跑）"
        : "⚠️ 亏损笔持得更久（截断亏损？）"
      : undefined;
  const item = (label: string, value: string, color?: string) => (
    <div>
      <div style={{ color: C.muted, fontSize: "0.72rem" }}>{label}</div>
      <div style={{ fontWeight: 700, color: color ?? C.text, fontSize: "0.88rem" }}>{value}</div>
    </div>
  );
  return (
    <Card><CardContent>
      <SectionTitle icon="🧠" color={C.indigo}>交易绩效（已完结 {closed.length} 笔复盘）</SectionTitle>
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
        {item("平均盈利", cny2(avgWin), pnlColor(avgWin))}
        {item("平均亏损", cny2(avgLoss), pnlColor(-(avgLoss ?? 0)))}
        {item("盈亏比（均盈÷均亏）", pf !== undefined ? pf.toFixed(2) : "—", pf !== undefined && pf > 1 ? C.gain : pf !== undefined ? C.gain : C.text)}
        {item("单笔期望", pnlText(expectancy), pnlColor(expectancy))}
        {item("盈利笔平均持仓", winDays !== undefined ? winDays.toFixed(1) + " 天" : "—")}
        {item("亏损笔平均持仓", lossDays !== undefined ? lossDays.toFixed(1) + " 天" : "—")}
        {holdNote && <span style={{ color: holdNote.startsWith("✅") ? C.loss : C.gain, fontWeight: 600, fontSize: "0.82rem" }}>{holdNote}</span>}
      </div>
      {metrics && (metrics.annualVol !== undefined || metrics.sharpe !== undefined || metrics.maxDrawdown !== undefined) && (
        <>
          <div style={{ borderTop: `1px dashed ${C.border}`, margin: "10px 0 8px" }} />
          <div style={{ fontSize: "0.72rem", color: C.muted, marginBottom: 4 }}>风险指标（memo mt4hl5g9：基于日市值序列，成本口径近似）</div>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
            {item("年化波动率", metrics.annualVol !== undefined ? metrics.annualVol.toFixed(1) + "%" : "—", C.sub)}
            {item("夏普比率", metrics.sharpe !== undefined ? metrics.sharpe.toFixed(2) : "—", metrics.sharpe !== undefined && metrics.sharpe >= 1 ? C.gain : C.text)}
            {item("最大回撤", metrics.maxDrawdown !== undefined ? metrics.maxDrawdown.toFixed(1) + "%" : "—", C.loss)}
          </div>
        </>
      )}
    </CardContent></Card>
  );
}

// ---------- 交易复盘表 ----------


function DealsTable({ deals }: { deals: TradeV2Deal[] }) {
  if (deals.length === 0) return (
    <Card><CardContent style={{ padding: "1.5rem", textAlign: "center", color: C.muted, fontSize: "0.85rem" }}>
      暂无交易复盘（买入→清仓配对，从账本自动生成）。
    </CardContent></Card>
  );
  const closed = deals.filter((d) => d.status === "closed");
  const open = deals.filter((d) => d.status === "open");
  const winRate = closed.length > 0 ? (closed.filter((d) => (d.pnl ?? 0) > 0).length / closed.length) * 100 : undefined;
  const realized = closed.reduce((a, d) => a + (d.pnl ?? 0), 0);
  return (
    <Card><CardContent>
      <SectionTitle icon="📈" color={C.accent}>交易复盘（买入→清仓配对）</SectionTitle>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 8, fontSize: "0.8rem", color: C.sub }}>
        <span>已完结 <b>{closed.length}</b> 笔</span>
        <span>在途 <b>{open.length}</b> 笔</span>
        {winRate !== undefined && <span>胜率 <b style={{ color: pnlColor(winRate) }}>{winRate.toFixed(1)}%</b></span>}
        <span>已实现 <b style={{ color: pnlColor(realized) }}>{pnlText(realized)}</b></span>
      </div>
      <div style={{ maxHeight: 480, overflow: "auto" }}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>标的</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>建仓</TableHead>
            <TableHead>清仓</TableHead>
            <TableHead className="text-right">持仓天数</TableHead>
            <TableHead className="text-right">买入金额</TableHead>
            <TableHead className="text-right">卖出回款</TableHead>
            <TableHead className="text-right">手续费</TableHead>
            <TableHead className="text-right">已实现盈亏</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {deals.map((d, i) => (
            <TableRow key={i}>
              <TableCell><NameCode name={d.name} code={d.code} /></TableCell>
              <TableCell>
                <Badge style={d.status === "open" ? { background: C.accentBg, color: "#1d4ed8" } : { background: "#f1f5f9", color: C.sub }}>
                  {d.status === "open" ? "在途" : "已完结"}
                </Badge>
              </TableCell>
              <TableCell>{d.entryDate}</TableCell>
              <TableCell>{d.exitDate ?? "—"}</TableCell>
              <TableCell className="text-right">{d.days ?? "—"}</TableCell>
              <TableCell className="text-right">{cny2(d.buyAmount)}</TableCell>
              <TableCell className="text-right">{cny2(d.sellAmount)}</TableCell>
              <TableCell className="text-right">{cny2(d.feeTotal)}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(d.pnl) }}>{d.status === "closed" ? pnlText(d.pnl) : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>
    </CardContent></Card>
  );
}

// ---------- 收益归因表 ----------

function AttributionTable({ attribution, onRowClick }: { attribution: TradeV2PnlAttribution[]; onRowClick?: (a: TradeV2PnlAttribution) => void }) {
  if (attribution.length === 0) return null;
  return (
    <Card><CardContent>
      <SectionTitle icon="🏆" color={C.accent}>收益归因（按标的：已实现 + 未实现 贡献，点击行看交易历史）</SectionTitle>
      {/* 归因表滚动容器（长表不撑爆页面） */}
      <div style={{ maxHeight: 420, overflow: "auto" }}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>标的</TableHead>
            <TableHead className="text-right">已实现</TableHead>
            <TableHead className="text-right">未实现</TableHead>
            <TableHead className="text-right">合计</TableHead>
            <TableHead className="text-right">贡献度</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {attribution.map((a) => (
            <TableRow key={a.code} onClick={() => onRowClick?.(a)} style={onRowClick ? { cursor: "pointer" } : undefined} title={onRowClick ? "查看交易历史" : undefined}>
              <TableCell><NameCode name={a.name} code={a.code} /></TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(a.realizedPnl) }}>{pnlText(a.realizedPnl)}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(a.unrealizedPnl) }}>{pnlText(a.unrealizedPnl)}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(a.totalPnl), fontWeight: 600 }}>{pnlText(a.totalPnl)}</TableCell>
              <TableCell className="text-right">{a.sharePct !== undefined ? pct(a.sharePct) : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>
    </CardContent></Card>
  );
}

// ---------- 每日动态表 ----------

function DailyTable({ dailySeries }: { dailySeries: TradeV2DailyPoint[] }) {
  if (dailySeries.length === 0) return null;
  const rows = [...dailySeries].reverse();
  let cum = 0;
  const rowsWithCum = rows.map((d) => { cum += d.realizedPnl; return { ...d, cumRealized: Math.round(cum * 100) / 100 }; });
  return (
    <Card><CardContent>
      <SectionTitle icon="📅" color={C.accent}>每日动态（历史价口径 · 有行情时真实市值）</SectionTitle>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>日期</TableHead>
            <TableHead className="text-right">买入</TableHead>
            <TableHead className="text-right">卖出回款</TableHead>
            <TableHead className="text-right">当日已实现</TableHead>
            <TableHead className="text-right">累计已实现</TableHead>
            <TableHead className="text-right">收盘市值</TableHead>
            <TableHead className="text-right">持仓数</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rowsWithCum.map((d) => (
            <TableRow key={d.date}>
              <TableCell className="whitespace-nowrap">{d.date}</TableCell>
              <TableCell className="text-right">{cny2(d.buyAmount)}</TableCell>
              <TableCell className="text-right">{cny2(d.sellAmount)}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(d.realizedPnl) }}>{pnlText(d.realizedPnl)}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(d.cumRealized) }}>{pnlText(d.cumRealized)}</TableCell>
              <TableCell className="text-right">{cny2(d.marketValue)}</TableCell>
              <TableCell className="text-right">{d.openCount}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardContent></Card>
  );
}

// ---------- 月度收益表 ----------

function MonthlyTable({ monthlySeries }: { monthlySeries: TradeV2MonthlyPoint[] }) {
  if (monthlySeries.length === 0) return null;
  return (
    <Card><CardContent>
      <SectionTitle icon="🗓️" color={C.accent}>月度收益汇总</SectionTitle>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>月份</TableHead>
            <TableHead className="text-right">买入</TableHead>
            <TableHead className="text-right">卖出回款</TableHead>
            <TableHead className="text-right">已实现</TableHead>
            <TableHead className="text-right">月末市值</TableHead>
            <TableHead className="text-right">月收益率</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...monthlySeries].reverse().map((m) => (
            <TableRow key={m.month}>
              <TableCell className="whitespace-nowrap">{m.month}</TableCell>
              <TableCell className="text-right">{cny2(m.buyAmount)}</TableCell>
              <TableCell className="text-right">{cny2(m.sellAmount)}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(m.realizedPnl), fontWeight: 600 }}>{pnlText(m.realizedPnl)}</TableCell>
              <TableCell className="text-right">{cny2(m.marketValue)}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(m.pnlPct ?? 0) }}>{m.pnlPct !== undefined ? pctSigned(m.pnlPct) : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardContent></Card>
  );
}

// ---------- 每日交易单（批量录入体验） ----------

type RowField = "code" | "qty" | "price" | "fee" | "note";
const FIELD_ORDER: RowField[] = ["code", "qty", "price", "fee", "note"];

/** 📥 粘贴批量解析（纯函数，memo msvvn2v4）：每行「[买/卖] 代码 数量 价格 [手续费] [备注]」，空格/tab/逗号分隔；nextKey 生成行 key */

function OrderSheet({ initialGroup, groups, allEntries, todayAdd, positions, onSubmitted, onEditEntry, onDeleteEntry }: {
  initialGroup: TradeV2Group;
  groups: TradeV2GroupSummary[];
  allEntries: TradeV2Entry[];
  todayAdd: number;
  positions: TradeV2Position[];
  onSubmitted: () => void;
  onEditEntry?: (e: TradeV2Entry) => void;
  onDeleteEntry?: (e: TradeV2Entry) => void;
}) {
  const keySeq = useRef(0);
  const newRow = (): OrderRow => ({ key: ++keySeq.current, code: "", action: "buy", quantity: 0, price: 0 });
  const [groupId, setGroupId] = useState(initialGroup.id);
  // 跟随分组 tab（memo mswvpykt）：左侧切分组时交易单分组自动跟随（组件不重挂，需显式同步）
  useEffect(() => { setGroupId(initialGroup.id); }, [initialGroup.id]);
  const [date, setDate] = useState(nextTradingDay());
  const [rows, setRows] = useState<OrderRow[]>([newRow()]);
  const [result, setResult] = useState<TradeV2CheckResult | null>(null);
  // 空白补全：接口获取当前分组的标的列表（与提交交易单一致）
  const [groupStocks, setGroupStocks] = useState<{ code: string; name?: string }[]>([]);
  useEffect(() => {
    if (!groupId) { setGroupStocks([]); return; }
    let live = true;
    void (async () => {
      try {
        const r = await api.tradeV2GroupStocks(groupId);
        if (live && r.ok) setGroupStocks(r.stocks ?? []);
      } catch { if (live) setGroupStocks([]); }
    })();
    return () => { live = false; };
  }, [groupId]);
  const [summary, setSummary] = useState<TradeV2DayOrderSummary | null>(null);
  const [busy, setBusy] = useState<"check" | "submit" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [copiedMsg, setCopiedMsg] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const refs = useRef(new Map<number, Record<RowField, HTMLInputElement | null>>());

  const setRow = (key: number, patch: Partial<OrderRow>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const setRef = (key: number, field: RowField) => (el: HTMLInputElement | null) => {
    const m = refs.current.get(key) ?? { code: null, qty: null, price: null, fee: null, note: null };
    m[field] = el;
    refs.current.set(key, m);
  };
  const focusField = (key: number, field: RowField) => { const el = refs.current.get(key)?.[field]; el?.focus(); };

  // Enter 流式跳转：code→数量→价格→手续费→备注→下一行代码；末行备注 → 自动加行
  const handleEnter = (key: number, field: RowField) => {
    const idx = rows.findIndex((r) => r.key === key);
    const cur = FIELD_ORDER.indexOf(field);
    if (cur < FIELD_ORDER.length - 1) { focusField(key, FIELD_ORDER[cur + 1]!); return; }
    if (idx < rows.length - 1) { focusField(rows[idx + 1]!.key, "code"); return; }
    const nr = newRow();
    setRows((p) => [...p, nr]);
    setTimeout(() => focusField(nr.key, "code"), 0);
  };

  // 价格预填：选定标的后取该组持仓的最新价 ?? 均价（无持仓则保持原值）
  const onPickStock = (key: number, v: { code: string; name?: string }) => {
    setRow(key, { code: v.code, name: v.name });
    if (v.code.trim()) {
      const pos = positions.find((p) => p.code === v.code);
      if (pos && pos.quantity > 0) {
        const px = pos.latestPrice && pos.latestPrice > 0 ? pos.latestPrice : pos.avgCost > 0 ? pos.avgCost : undefined;
        if (px !== undefined) setRow(key, { price: px });
      }
    }
  };

  // ⚡ 一键取现价（行情接口，填充价格）
  const [priceBusy, setPriceBusy] = useState<string | null>(null);
  const fillLivePrice = async (key: number, code: string) => {
    if (!code || priceBusy) return;
    setPriceBusy(code);
    try {
      const r = await api.watchlistQuotes([code]);
      const q = r.quotes.find((x) => typeof (x as any)?.price === "number" && (x as any).price > 0);
      if (q) setRow(key, { price: +((q as any).price).toFixed(3) });
    } catch { /* 行情失败静默 */ } finally {
      setPriceBusy(null);
    }
  };

  // 每行手续费：用户手填优先，否则自动按规则算（memo msww20u5：ETF 万1 最低 0.1 / 个股 万1.154 最低 5）
  const rowFee = (r: OrderRow): number | undefined => {
    if (r.fee !== undefined && r.fee > 0) return r.fee;
    const auto = calcFee(r.code, r.quantity, r.price);
    return auto > 0 ? auto : undefined;
  };

  const valid = rows.filter((r) => r.code.trim() && r.quantity > 0 && r.price > 0);
  const drafts = (): TradeV2EntryDraft[] =>
    valid.map((r) => ({
      groupId,
      date,
      code: r.code.trim(),
      ...(r.name ? { name: r.name } : {}),
      action: r.action,
      quantity: r.quantity,
      price: r.price,
      ...(rowFee(r) ? { fee: rowFee(r) } : {}),
      ...(r.note && r.note.trim() ? { note: r.note.trim() } : {}),
    }));

  const clear = () => { setRows([newRow()]); setResult(null); setSummary(null); setCopiedMsg(null); setMsg(null); };

  // 📥 粘贴批量导入：每行「[买/卖] 代码 数量 价格 [手续费] [备注]」，空格/tab/逗号分隔（memo msvvn2v4）
  const applyPaste = () => {
    const parsed = parseBatchText(pasteText, (r) => ++keySeq.current);
    if (parsed.length === 0) { setMsg("未解析到有效行（格式：代码 数量 价格，每行一笔）"); return; }
    setRows(parsed);
    setResult(null);
    setSummary(null);
    setPasteOpen(false);
    setPasteText("");
    setCopiedMsg(`已从粘贴导入 ${parsed.length} 笔，可修改后提交`);
  };

  // 实时净归并预览（客户端；已实现需服务端校验补）
  const liveNet = useMemo(() => {
    const byCode = new Map<string, { name?: string; netQty: number; netAmount: number }>();
    let buyTotal = 0;
    let sellTotal = 0;
    for (const r of valid) {
      const fee = r.fee ?? 0;
      const amount = r.quantity * r.price;
      const n = byCode.get(r.code) ?? { name: r.name, netQty: 0, netAmount: 0 };
      if (r.action === "buy") { n.netQty += r.quantity; n.netAmount += amount + fee; buyTotal += amount + fee; }
      else { n.netQty -= r.quantity; n.netAmount -= amount - fee; sellTotal += amount - fee; }
      byCode.set(r.code, n);
    }
    return {
      buyTotal: Math.round(buyTotal * 100) / 100,
      sellTotal: Math.round(sellTotal * 100) / 100,
      netPerCode: [...byCode.entries()].map(([code, n]) => ({
        code,
        ...(n.name ? { name: n.name } : {}),
        netQty: n.netQty,
        netAmount: Math.round(n.netAmount * 100) / 100,
        action: n.netQty > 0 ? "buy" : n.netQty < 0 ? "sell" : "flat",
      })),
    };
  }, [rows]);

  const remain = initialGroup.dailyAddLimit > 0 ? initialGroup.dailyAddLimit - todayAdd - liveNet.buyTotal : undefined;

  const doCheck = async () => {
    if (valid.length === 0) { setMsg("至少填写一行（代码/数量/价格）"); return; }
    setBusy("check");
    setMsg(null);
    try {
      const r = await api.tradeV2BatchEntries(drafts(), true);
      setResult(r.result ?? null);
      setSummary(r.daySummary ?? null);
    } catch (e) {
      setMsg("❌ " + errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (valid.length === 0) { setMsg("至少填写一行（代码/数量/价格）"); return; }
    setBusy("submit");
    setMsg(null);
    try {
      const r = await api.tradeV2BatchEntries(drafts(), false);
      setResult(r.result ?? null);
      setSummary(r.daySummary ?? null);
      setMsg(`✅ 已提交 ${r.createdCount} 笔交易，仓位已自动归并重算（买入按加权平均重算均价、手续费摊入成本；卖出仅减数量、不影响均价）`);
      onSubmitted();
      setRows([newRow()]);
      setCopiedMsg(null);
    } catch (e) {
      setMsg("❌ " + errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
    <Card><CardContent>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        <Select value={groupId} onValueChange={(v: string | null) => setGroupId(v ?? groupId)}>
          <SelectTrigger className="w-40"><SelectValue>{groups.find((g) => g.id === groupId)?.name ?? "选择分组"}</SelectValue></SelectTrigger>
          <SelectContent>
            {groups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}<InfoTypeBadge infoType={g.infoType} /></SelectItem>)}
          </SelectContent>
        </Select>
        <Input autoComplete="off" type="date" className="h-8 w-40" value={date} onChange={(e) => setDate(e.target.value)} />
        <Button variant="outline" size="sm" onClick={() => { setPasteOpen(true); setPasteText(""); }}>📥 粘贴批量</Button>
        <Button variant="ghost" size="sm" onClick={clear}>🧹 清空</Button>
        <div style={{ flex: 1 }} />
        <Button variant="outline" size="sm" onClick={() => setRows((p) => [...p, newRow()])}>＋ 添加一行</Button>
      </div>
      {initialGroup.dailyAddLimit > 0 && (
        <div style={{ fontSize: "0.78rem", color: C.sub, marginBottom: 8, display: "flex", gap: 14, flexWrap: "wrap" }}>
          <span>日限 {cny(initialGroup.dailyAddLimit)}</span>
          <span>今日已用 {cny(todayAdd)}</span>
          <span>本单买入 {cny(liveNet.buyTotal)}</span>
          <span style={{ color: (remain ?? 0) < 0 ? C.gain : C.loss, fontWeight: 700 }}>剩余 {cny(remain)}</span>
        </div>
      )}
      {initialGroup.allowShort ? (
        <div style={{ fontSize: "0.78rem", color: "#c2410c", marginBottom: 8 }}>🔻 本组允许做空：卖出数量可超过当前持仓，超卖部分形成空头（价格下跌盈利）</div>
      ) : (
        <div style={{ fontSize: "0.78rem", color: C.muted, marginBottom: 8 }}>本组未开启做空：卖出数量不得超过当前持仓（超卖将被拒绝）</div>
      )}
      {copiedMsg && <div style={{ fontSize: "0.78rem", color: C.accent, marginBottom: 8 }}>{copiedMsg}</div>}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>标的（Enter 跳到下一格）</TableHead>
            <TableHead>操作</TableHead>
            <TableHead className="w-28">数量（股）</TableHead>
            <TableHead className="w-40">价格（元）</TableHead>
            <TableHead className="w-28">手续费（自动算）</TableHead>
            <TableHead>备注</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.key}>
              <TableCell style={{ minWidth: 190 }}>
                <StockSearchInput value={{ code: r.code, name: r.name }} onPick={(v) => onPickStock(r.key, v)} inputRef={setRef(r.key, "code")} onEnter={() => handleEnter(r.key, "code")} placeholder="代码或名称" suggestions={groupStocks} />
              </TableCell>
              <TableCell>
                <Select value={r.action} onValueChange={(v: string | null) => setRow(r.key, { action: (v ?? "buy") as "buy" | "sell" })}>
                  <SelectTrigger className="w-24"><SelectValue>{r.action === "sell" ? "卖出" : "买入"}</SelectValue></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="buy">买入</SelectItem>
                    <SelectItem value="sell">卖出</SelectItem>
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell><Input autoComplete="off" ref={setRef(r.key, "qty")} type="number" min={0} step={1} className="h-8" value={r.quantity || ""} placeholder="0" onChange={(e) => setRow(r.key, { quantity: numInput(e.target.value) })} onKeyDown={(e) => { if (e.key === "Enter") handleEnter(r.key, "qty"); }} /></TableCell>
              <TableCell>
                <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <Input autoComplete="off" ref={setRef(r.key, "price")} type="number" min={0} step={0.01} className="h-8" value={r.price || ""} placeholder="0.00" onChange={(e) => setRow(r.key, { price: Number(e.target.value) || 0 })} onKeyDown={(e) => { if (e.key === "Enter") handleEnter(r.key, "price"); }} />
                  <Button variant="ghost" size="icon" className="h-8 w-7 shrink-0" title="填入最新价" disabled={!r.code.trim() || priceBusy === r.code.trim()} onClick={() => void fillLivePrice(r.key, r.code.trim())}>{priceBusy === r.code.trim() ? "…" : "⚡"}</Button>
                </span>
              </TableCell>
              <TableCell><Input autoComplete="off" ref={setRef(r.key, "fee")} type="number" min={0} step={0.01} className="h-8" value={rowFee(r) ?? ""} placeholder="0" onChange={(e) => setRow(r.key, { fee: e.target.value === "" ? undefined : Number(e.target.value) || 0 })} onKeyDown={(e) => { if (e.key === "Enter") handleEnter(r.key, "fee"); }} title={rowFee(r) !== r.fee ? "自动按佣金规则计算（ETF 万1 最低0.1 / 个股 万1.154 最低5）；手填可覆盖" : undefined} /></TableCell>
              <TableCell><Input autoComplete="off" ref={setRef(r.key, "note")} className="h-8" value={r.note ?? ""} onChange={(e) => setRow(r.key, { note: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") handleEnter(r.key, "note"); }} /></TableCell>
              <TableCell><Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:bg-red-50" onClick={() => setRows((p) => (p.length > 1 ? p.filter((x) => x.key !== r.key) : p))}>✕</Button></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* 净归并预览（实时客户端 + 服务端校验补已实现） */}
      {(liveNet.netPerCode.length > 0 || summary) && (
        <div style={{ marginTop: 10, padding: "0.6rem 0.8rem", background: C.panel, border: "1px solid " + C.border, borderRadius: 10, fontSize: "0.82rem" }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 6, fontWeight: 600, color: C.text }}>
            <span>买入合计 {cny2(liveNet.buyTotal)}</span>
            <span>卖出回款 {cny2(liveNet.sellTotal)}</span>
            <span style={{ color: pnlColor(summary?.realizedPnl ?? 0) }}>当日已实现 {summary ? pnlText(summary.realizedPnl) : "—"}</span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(summary?.netPerCode ?? liveNet.netPerCode).map((n) => (
              <span key={n.code} style={{ padding: "0.2rem 0.5rem", borderRadius: 999, border: "1px solid " + C.border, background: "#fff" }}>
                <NameCode name={n.name} code={n.code} size="0.78rem" />
                <b style={{ marginLeft: 4 }}>{n.netQty > 0 ? "+" : ""}{qtyFmt(n.netQty)}</b>
                <Badge style={{ marginLeft: 4, background: n.action === "buy" ? C.gainBg : n.action === "sell" ? C.lossBg : "#f1f5f9", color: n.action === "buy" ? C.gain : n.action === "sell" ? C.loss : C.sub }}>
                  {n.action === "buy" ? "净买" : n.action === "sell" ? "净卖" : "持平"}
                </Badge>
                <span style={{ color: C.sub, marginLeft: 4 }}>{cny2(n.netAmount)}</span>
              </span>
            ))}
          </div>
        </div>
      )}


      {/* 本日已提交（该组当日已入账条目 —— 每日工作流闭环回看） */}
      {(() => {
        const todayEntries = allEntries.filter((e) => e.groupId === groupId && e.date === date);
        if (todayEntries.length === 0) return null;
        return (
          <div style={{ marginTop: 10, border: "1px solid " + C.border, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0.5rem 0.8rem", background: C.panel, fontSize: "0.82rem", fontWeight: 700, color: C.sub }}>
              ✅ 本日已提交（{todayEntries.length} 笔，仓位已自动归并）
              <span style={{ fontWeight: 400, color: C.muted, fontSize: "0.75rem" }}>可直接编辑或删除修正</span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>标的</TableHead>
                  <TableHead>操作</TableHead>
                  <TableHead className="text-right">数量</TableHead>
                  <TableHead className="text-right">价格</TableHead>
                  <TableHead className="text-right">金额</TableHead>
                  <TableHead className="text-right">手续费</TableHead>
                  <TableHead>备注</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {todayEntries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell><NameCode name={e.name} code={e.code} size="0.8rem" /></TableCell>
                    <TableCell>
                      <Badge style={e.action === "buy" ? { background: C.gainBg, color: C.gain } : { background: C.lossBg, color: C.loss }}>{e.action === "buy" ? "买入" : "卖出"}</Badge>
                      {e.initial && <Badge style={{ marginLeft: 4, background: "#fef3c7", color: "#b45309" }}>期初</Badge>}
                    </TableCell>
                    <TableCell className="text-right">{qtyFmt(e.quantity)}</TableCell>
                    <TableCell className="text-right">{costFmt(e.price)}</TableCell>
                    <TableCell className="text-right">{cny2(e.quantity * e.price)}</TableCell>
                    <TableCell className="text-right">{e.fee ? cny2(e.fee) : "—"}</TableCell>
                    <TableCell style={{ color: C.sub, fontSize: "0.8rem" }}>{e.note ?? ""}</TableCell>
                    <TableCell>
                      <span style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onEditEntry?.(e)}>编辑</Button>
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-red-500 hover:bg-red-50" onClick={() => onDeleteEntry?.(e)}>删除</Button>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        );
      })()}
      {result && result.alerts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          {result.alerts.map((a, i) => (
            <div key={i} style={{ background: alertBg[a.level], color: alertColor[a.level], padding: "0.4rem 0.6rem", borderRadius: 8, fontSize: "0.8rem" }}>
              <b>{a.level === "error" ? "✖" : a.level === "warn" ? "⚠" : "ℹ"} {a.message}</b>
              {a.detail ? <span style={{ display: "block", marginTop: 2 }}>{a.detail}</span> : null}
            </div>
          ))}
        </div>
      )}
      {msg && <div style={{ color: msg.startsWith("✅") ? C.loss : C.gain, fontSize: "0.85rem", marginTop: 8 }}>{msg}</div>}

      <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end", alignItems: "center" }}>
        {result && !result.ok && <span style={{ fontSize: "0.78rem", color: C.gain, marginRight: "auto" }}>✖ 校验未通过：请修正后重新校验</span>}
        <Button variant="outline" onClick={() => void doCheck()} disabled={busy !== null}>{busy === "check" ? "校验中…" : "🔍 校验"}</Button>
        <Button onClick={() => void submit()} disabled={busy !== null || valid.length === 0 || (result !== null && !result.ok)}>{busy === "submit" ? "提交中…" : "📤 提交交易单（整批入库）"}</Button>
      </div>
    </CardContent></Card>
      {/* 📥 粘贴批量导入对话框（memo msvvn2v4） */}
      <Dialog open={pasteOpen} onOpenChange={(v: boolean) => setPasteOpen(v)}>
        <DialogContent style={{ maxWidth: 540 }}>
          <DialogHeader>
            <DialogTitle>📥 粘贴批量导入交易</DialogTitle>
            <DialogDescription>
              每行一笔：<code>[买/卖] 代码 数量 价格 [手续费] [备注]</code>，空格 / tab / 逗号分隔。
              <br />示例：<code>买 600519 100 1500</code>、<code>卖,00700,200,380,5,减仓</code>、<code>000831 300 12.5</code>
            </DialogDescription>
          </DialogHeader>
          <textarea
            autoFocus
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={"买 600519 100 1500\n卖 00700 200 380 5 减仓\n000831 300 12.5"}
            style={{ width: "100%", minHeight: 150, fontSize: "0.85rem", fontFamily: "monospace", padding: "0.6rem", borderRadius: 8, border: "1px solid #e2e8f0", boxSizing: "border-box" }}
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setPasteOpen(false)}>取消</Button>
            <Button size="sm" onClick={applyPaste}>✅ 导入 {pasteText.split(/\r?\n/).filter((l) => l.trim()).length} 行</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}



// ---------- 分组贡献表（全部 = 组合整体统计） ----------

/** 日度交易汇总（memo msww7ny3）：按日分组汇总买卖金额/手续费/笔数，默认选中最近交易日 */
function DailySummaryCard({ entries }: { entries: TradeV2Entry[] }) {
  const byDate = useMemo(() => {
    const m = new Map<string, { buy: number; sell: number; fee: number; count: number; codes: Set<string> }>();
    for (const e of entries) {
      const d = e.date || "—";
      const cur = m.get(d) ?? { buy: 0, sell: 0, fee: 0, count: 0, codes: new Set<string>() };
      const amount = e.quantity * e.price;
      const fee = typeof e.fee === "number" ? e.fee : 0;
      if (e.action === "buy") cur.buy += amount + fee; else cur.sell += amount - fee;
      cur.fee += fee; cur.count++; cur.codes.add(e.code);
      m.set(d, cur);
    }
    return [...m.entries()].map(([date, v]) => ({ date, ...v, codes: v.codes.size })).sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [entries]);
  const [sel, setSel] = useState<string>("");
  useEffect(() => {
    if (byDate.length > 0 && !byDate.some((d) => d.date === sel)) setSel(byDate[0]!.date);
  }, [byDate, sel]);
  if (byDate.length === 0) return null;
  const cur = byDate.find((d) => d.date === sel);
  const net = cur ? cur.sell - cur.buy : 0;
  return (
    <Card><CardContent>
      <div style={{ fontSize: "0.85rem", fontWeight: 700, color: C.text, marginBottom: 8 }}>🗓️ 日度交易汇总</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {byDate.slice(0, 15).map((d) => (
          <button key={d.date} onClick={() => setSel(d.date)}
            style={{ padding: "0.25rem 0.6rem", borderRadius: 999, fontSize: "0.75rem", border: `1px solid ${sel === d.date ? C.accent : C.border}`, background: sel === d.date ? "#eff6ff" : "#fff", color: sel === d.date ? C.accent : C.sub, cursor: "pointer" }}>
            {d.date}（{d.count} 笔）
          </button>
        ))}
      </div>
      {cur && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
          {[
            { label: "笔数", value: `${cur.count} 笔` },
            { label: "买入金额（含费）", value: cny2(cur.buy) },
            { label: "卖出回款（含费）", value: cny2(cur.sell) },
            { label: "手续费合计", value: cny2(cur.fee) },
            { label: net >= 0 ? "净卖出（卖−买）" : "净买入（买−卖）", value: cny2(Math.abs(net)), tone: net >= 0 ? C.gain : C.loss },
            { label: "涉及标的", value: `${cur.codes} 只` },
          ].map((it) => (
            <div key={it.label} style={{ background: C.panel, borderRadius: 8, padding: "0.5rem 0.7rem", border: "1px solid #eef2f7" }}>
              <div style={{ fontSize: "0.68rem", color: C.muted }}>{it.label}</div>
              <div style={{ fontSize: "1rem", fontWeight: 700, color: it.tone ?? C.text }}>{it.value}</div>
            </div>
          ))}
        </div>
      )}
    </CardContent></Card>
  );
}

function GroupContributionTable({ groups, globalMv, onSelect }: { groups: TradeV2GroupSummary[]; globalMv: number; onSelect: (id: string) => void }) {
  if (groups.length === 0) return null;
  return (
    <Card><CardContent>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: "0.85rem", fontWeight: 700 }}>🧩 分组整体统计 · 贡献明细（点击行跳转该组）</div>
        <div style={{ flex: 1 }} />
        <Button size="sm" variant="outline" onClick={() => downloadCSV("分组贡献.csv", ["分组", "在途", "市值", "占总组合%", "已实现", "未实现", "总盈亏", "盈亏率%"], groups.map((g) => [g.name, g.openCount, Math.round(g.totalMv * 100) / 100, globalMv > 0 ? Math.round((g.totalMv / globalMv) * 1000) / 10 : "", Math.round(g.realizedPnl * 100) / 100, Math.round(g.unrealizedPnl * 100) / 100, Math.round(g.totalPnl * 100) / 100, g.totalMv - g.unrealizedPnl > 0 ? Math.round((g.totalPnl / (g.totalMv - g.unrealizedPnl)) * 1000) / 10 : ""]))}>📤 导出 CSV</Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>分组</TableHead>
            <TableHead className="text-right">风险</TableHead>
            <TableHead className="text-right">在途</TableHead>
            <TableHead className="text-right">市值</TableHead>
            <TableHead className="text-right">占总组合</TableHead>
            <TableHead className="text-right">已实现</TableHead>
            <TableHead className="text-right">未实现</TableHead>
            <TableHead className="text-right">总盈亏</TableHead>
            <TableHead className="text-right">盈亏率</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((g) => {
            const cost = g.totalMv - g.unrealizedPnl;
            const rate = cost > 0 ? (g.totalPnl / cost) * 100 : undefined;
            return (
              <TableRow key={g.id} onClick={() => onSelect(g.id)} style={{ cursor: "pointer" }}>
                <TableCell><span style={{ fontWeight: 600 }}>{g.name}</span><InfoTypeBadge infoType={g.infoType} /></TableCell>
                <TableCell className="text-right">{g.riskCount ? <span style={{ color: "#b45309", fontWeight: 700 }}>⚠️{g.riskCount}</span> : "—"}</TableCell>
                <TableCell className="text-right">{g.openCount}</TableCell>
                <TableCell className="text-right">{cny2(g.totalMv)}</TableCell>
                <TableCell className="text-right">{globalMv > 0 ? pct((g.totalMv / globalMv) * 100) : "—"}</TableCell>
                <TableCell className="text-right" style={{ color: pnlColor(g.realizedPnl) }}>{pnlText(g.realizedPnl)}</TableCell>
                <TableCell className="text-right" style={{ color: pnlColor(g.unrealizedPnl) }}>{pnlText(g.unrealizedPnl)}</TableCell>
                <TableCell className="text-right" style={{ color: pnlColor(g.totalPnl), fontWeight: 600 }}>{pnlText(g.totalPnl)}</TableCell>
                <TableCell className="text-right" style={{ color: pnlColor(rate ?? 0) }}>{rate !== undefined ? pctSigned(rate) : "—"}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </CardContent></Card>
  );
}

// ---------- 标的交易历史下钻 ----------

function StockHistoryDialog({ open, onClose, code, name, scopeName, entries, positions, deals, groups, onMoved }: {
  open: boolean;
  onClose: () => void;
  code: string;
  name?: string;
  scopeName: string;
  entries: TradeV2Entry[];
  positions: TradeV2Position[];
  deals: TradeV2Deal[];
  groups: TradeV2GroupSummary[];
  onMoved: () => void;
}) {
  const [moveTo, setMoveTo] = useState<string>("");
  const [moving, setMoving] = useState(false);
  const [limitPct, setLimitPct] = useState<string>("");
  const [savingLimit, setSavingLimit] = useState(false);
  const codeEntries = entries.filter((e) => e.code === code);
  const sortedEntries = [...codeEntries].sort((a, b) => (a.date < b.date ? 1 : -1));
  const pos = positions.find((p) => p.code === code);
  const codeDeals = deals.filter((d) => d.code === code);
  const fromGroupId = codeEntries[0]?.groupId ?? "";
  // 加载该标的分组限制（memo mt4hgp8b：标的下沉页直接配置"标的限制"）
  useEffect(() => {
    if (!open || !fromGroupId) return;
    void (async () => {
      try {
        const g = await api.tradeV2Group(fromGroupId);
        const lim = (g.group?.stockLimits ?? []).find((s) => s.code === code);
        setLimitPct(lim && lim.maxWeightPct !== undefined ? String(lim.maxWeightPct) : "");
      } catch { /* 静默 */ }
    })();
  }, [open, fromGroupId, code]);
  const saveLimit = async () => {
    if (!fromGroupId) return;
    setSavingLimit(true);
    try {
      const g = await api.tradeV2Group(fromGroupId);
      const limits = [...(g.group?.stockLimits ?? [])];
      const n = Number(limitPct);
      const i = limits.findIndex((s) => s.code === code);
      if (n > 0 && Number.isFinite(n)) {
        if (i >= 0) limits[i] = { ...limits[i]!, maxWeightPct: n };
        else limits.push({ code, name: name ?? code, maxWeightPct: n });
      } else if (i >= 0) {
        limits.splice(i, 1); // 空/0 → 移除该标的限制
      }
      await api.tradeV2SaveGroup(fromGroupId, { stockLimits: limits });
      onMoved();
    } catch (e) {
      alert("❌ " + errMsg(e));
    } finally {
      setSavingLimit(false);
    }
  };
  const move = async () => {
    if (!fromGroupId || !moveTo) return;
    if (!window.confirm(`把「${name ?? code}」在本分组的 ${codeEntries.length} 笔交易全部移动到「${groups.find((g) => g.id === moveTo)?.name}」？`)) return;
    setMoving(true);
    try {
      const r = await api.tradeV2MoveStock(fromGroupId, code, moveTo);
      onMoved();
      onClose();
    } catch (e) {
      alert("❌ " + errMsg(e));
    } finally {
      setMoving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(v: boolean) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle><NameCode name={name} code={code} /> <span style={{ fontSize: "0.75rem", color: C.muted, fontWeight: 400 }}>· {scopeName}</span></DialogTitle>
          <DialogDescription>该标的在此范围内的全部交易与盈亏归因（仓位/盈亏由账本自动派生）。</DialogDescription>
        </DialogHeader>

        {groups.length > 1 && fromGroupId && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.82rem", color: C.sub, flexWrap: "wrap" }}>
            <span>移动到分组：</span>
            <Select value={moveTo} onValueChange={(v: string | null) => setMoveTo(v ?? "")}>
              <SelectTrigger style={{ width: 200, height: 30 }}><SelectValue placeholder="选择目标分组" /></SelectTrigger>
              <SelectContent>
                {groups.filter((g) => g.id !== fromGroupId).map((g) => <SelectItem key={g.id} value={g.id}>{g.name}<InfoTypeBadge infoType={g.infoType} /></SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" disabled={!moveTo || moving} onClick={() => void move()}>{moving ? "移动中…" : "移动"}</Button>
          </div>
        )}
        {fromGroupId && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.82rem", color: C.sub, flexWrap: "wrap" }}>
            <span>该标的限制（占分组总仓位上限 %）：</span>
            <Input autoComplete="off" type="number" min={0} max={100} value={limitPct} onChange={(e) => setLimitPct(e.target.value)} placeholder="不限" style={{ width: 80, height: 30 }} />
            <Button size="sm" variant="outline" disabled={savingLimit} onClick={() => void saveLimit()}>{savingLimit ? "保存中…" : "保存"}</Button>
            {limitPct === "" && <span style={{ color: C.muted, fontSize: "0.72rem" }}>（空/0 表示不限）</span>}
          </div>
        )}

        {pos && (
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", background: C.panel, borderRadius: 10, padding: "0.6rem 0.8rem", fontSize: "0.8rem", color: C.sub }}>
            <span>持仓 <b style={{ color: C.text }}>{qtyFmt(pos.quantity)} 股</b></span>
            <span>买入均价 <b style={{ color: C.text }}>{costFmt(pos.avgCost)}</b></span>
            {pos.costAvg !== undefined && <span title="摊薄成本：已实现盈亏摊入剩余持仓">成本均价 <b style={{ color: pos.costAvg < pos.avgCost ? C.gain : C.text }}>{costFmt(pos.costAvg)}</b></span>}
            <span>市值 <b style={{ color: C.text }}>{cny2(pos.marketValue)}</b></span>
            <span>已实现 <b style={{ color: pnlColor(pos.realizedPnl) }}>{pnlText(pos.realizedPnl)}</b></span>
            <span>未实现 <b style={{ color: pnlColor(pos.unrealizedPnl) }}>{pnlText(pos.unrealizedPnl)}</b></span>
          </div>
        )}

        {codeDeals.length > 0 && (
          <div>
            <div style={{ fontSize: "0.8rem", fontWeight: 700, marginBottom: 4 }}>📈 交易段（买入→清仓复盘）</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>状态</TableHead>
                  <TableHead>建仓</TableHead>
                  <TableHead>清仓</TableHead>
                  <TableHead className="text-right">天数</TableHead>
                  <TableHead className="text-right">买入</TableHead>
                  <TableHead className="text-right">卖出</TableHead>
                  <TableHead className="text-right">盈亏</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {codeDeals.map((d, i) => (
                  <TableRow key={i}>
                    <TableCell><Badge style={d.status === "open" ? { background: C.accentBg, color: "#1d4ed8" } : { background: "#f1f5f9", color: C.sub }}>{d.status === "open" ? "在途" : "已完结"}</Badge></TableCell>
                    <TableCell>{d.entryDate}</TableCell>
                    <TableCell>{d.exitDate ?? "—"}</TableCell>
                    <TableCell className="text-right">{d.days ?? "—"}</TableCell>
                    <TableCell className="text-right">{cny2(d.buyAmount)}</TableCell>
                    <TableCell className="text-right">{cny2(d.sellAmount)}</TableCell>
                    <TableCell className="text-right" style={{ color: pnlColor(d.pnl), fontWeight: 600 }}>{d.status === "closed" ? pnlText(d.pnl) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div>
          <div style={{ fontSize: "0.8rem", fontWeight: 700, marginBottom: 4 }}>💹 全部交易（{sortedEntries.length} 笔）</div>
          <div style={{ maxHeight: 280, overflowY: "auto" }}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead>操作</TableHead>
                  <TableHead className="text-right">数量</TableHead>
                  <TableHead className="text-right">价格</TableHead>
                  <TableHead className="text-right">金额</TableHead>
                  <TableHead className="text-right">手续费</TableHead>
                  <TableHead>备注</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedEntries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap">{e.date}</TableCell>
                    <TableCell>
                      <Badge style={e.action === "buy" ? { background: C.gainBg, color: C.gain } : { background: C.lossBg, color: C.loss }}>{e.action === "buy" ? "买入" : "卖出"}</Badge>
                      {e.initial && <Badge style={{ marginLeft: 4, background: "#fef3c7", color: "#b45309" }}>期初</Badge>}
                    </TableCell>
                    <TableCell className="text-right">{qtyFmt(e.quantity)}</TableCell>
                    <TableCell className="text-right">{costFmt(e.price)}</TableCell>
                    <TableCell className="text-right">{cny2(e.quantity * e.price)}</TableCell>
                    <TableCell className="text-right">{e.fee ? cny2(e.fee) : "—"}</TableCell>
                    <TableCell style={{ color: C.sub, fontSize: "0.8rem" }}>{e.note ?? ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>

        <DialogFooter><Button onClick={onClose}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
// ---------- 主页面（全横向 Tab 布局） ----------

export default function TradeV2Tool() {
  const [groups, setGroups] = useState<TradeV2GroupSummary[]>([]);
  const [entries, setEntries] = useState<TradeV2Entry[]>([]);
  // 分组选择：localStorage 记忆上次选中；无记忆时默认第一分组（有分组），无分组才 all
  const [pillHover, setPillHover] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem("tradeV2:selectedGroup") : null;
    return saved ?? "";
  });
  const [detail, setDetail] = useState<{ group: TradeV2Group; analysis: TradeV2GroupAnalysis } | null>(null);
  const [global, setGlobal] = useState<TradeV2AggregateAnalysis | null>(null);
  /** 聚合分组：当前选中的聚合分组对象（global 渲染的来源分组/名称） */
  const [globalGroup, setGlobalGroup] = useState<TradeV2Group | null>(null);
  /** 聚合分组：派生条目（服务端 groupAnalysis 返回的来源分组条目并集，交易流水用） */
  const [aggEntries, setAggEntries] = useState<TradeV2Entry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [tab, setTab] = useState("positions");   // 默认仓位明细（memo msvpak4x）
  const [entryEditorOpen, setEntryEditorOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<TradeV2Entry | null>(null);
  const [groupEditorOpen, setGroupEditorOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<TradeV2Group | null>(null);
    const [stockDlg, setStockDlg] = useState<{ code: string; name?: string } | null>(null);

  const [fAction, setFAction] = useState<string>("all");
  const [fCode, setFCode] = useState("");
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [ledgerPage, setLedgerPage] = useState(1); // 流水分页（每页 100）

  const loadOverview = useCallback(async () => {
    try {
      const r = await api.tradeV2Overview();
      setGroups(r.groups);
      setEntries(r.entries);
      return r.groups; // init 用（state 更新前闭包拿不到新值）
    } catch (e) {
      setMsg("❌ 数据加载失败：" + errMsg(e));
      return [];
    }
  }, []);

  const loadAnalysis = useCallback(async (groupId: string) => {
    try {
      if (!groupId) { setDetail(null); setGlobal(null); setGlobalGroup(null); setAggEntries(null); return; }
      const r = await api.tradeV2Group(groupId);
      if (r.analysis && r.group) {
        // 聚合分组：分析是聚合结构（buildAggregateAnalysis）→ 走 global 渲染（组合分析/仓位/收益/流水）
        if (r.group.aggSources && r.group.aggSources.length > 0) {
          setGlobal(r.analysis as unknown as TradeV2AggregateAnalysis);
          setGlobalGroup(r.group);
          setAggEntries(r.entries ?? null);
          setDetail(null);
        } else {
          setDetail({ group: r.group, analysis: r.analysis });
          setGlobal(null);
          setGlobalGroup(null);
          setAggEntries(null);
        }
      } else {
        setDetail(null); setGlobal(null); setGlobalGroup(null); setAggEntries(null);
      }
    } catch (e) {
      setMsg("❌ 分析加载失败：" + errMsg(e));
    }
  }, []);

  const reloadAll = useCallback(async () => {
    await loadOverview();
    await loadAnalysis(selectedId);
  }, [loadOverview, loadAnalysis, selectedId]);

  // 初始化一次：loadOverview 填充 groups；恢复 localStorage 记忆的分组（若有），否则全部
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    setLoading(true);
    void (async () => {
      const loaded = (await loadOverview()) ?? []; // 填充 groups 并取回
      const saved = typeof localStorage !== "undefined" ? localStorage.getItem("tradeV2:selectedGroup") : null;
      const initialId = saved && loaded.some((g) => g.id === saved) ? saved : loaded[0]?.id ?? "";
      setSelectedId(initialId);
      await loadAnalysis(initialId);
      setLoading(false);
    })();
  }, [loadOverview, loadAnalysis]);

  useEffect(() => {
    if (selectedId && groups.some((g) => g.id === selectedId)) {
      void loadAnalysis(selectedId);
    }
  }, [selectedId, groups, loadAnalysis]);

  const isGroupView = selectedId !== "all" && !!detail;
  const analysis = detail?.analysis ?? null;
  // 功能区 tab：全部视图默认组合分析（analysis-global），分组视图默认收益分区（analysis）；其余 tab 共用
  // 功能区 tab 视图感知：仅分组视图需把 analysis-global 映射为 analysis；全部视图 analysis/analysis-global 均有效
  const activeTab = isGroupView && tab === "analysis-global" ? "analysis" : tab;
  const selectedGroup = detail?.group ?? null;
  // 流水分组过滤已由 filteredEntries 直接跟随顶部 selectedId（memo msx4rs60），无需额外同步

  const cur = useMemo(() => {
    if (isGroupView && analysis) {
      return {
        totalMv: analysis.totalMv,
        totalCost: analysis.totalCost,
        unrealizedPnl: analysis!.unrealizedPnl,
        realizedPnl: analysis!.realizedPnl,
        totalPnl: analysis.totalPnl,
        invested: analysis.invested,
        openCount: analysis.openCount,
        closedCount: analysis.closedCount,
        winRate: analysis.winRate,
        avgDays: analysis.avgDays,
        positionPct: analysis.positionPct,
        remaining: analysis.remaining,
        todayAdd: analysis.todayAdd,
        negCount: analysis.negCount,
      };
    }
    if (global) {
      return {
        totalMv: global.totalMv,
        totalCost: global.totalCost,
        unrealizedPnl: global.unrealizedPnl,
        realizedPnl: global.realizedPnl,
        totalPnl: global.totalPnl,
        invested: global.invested,
        openCount: global.openCount,
        closedCount: global.closedCount,
        winRate: global.winRate,
        avgDays: global.avgDays,
        negCount: global.negCount,
        positionPct: (() => {
          // 组合视图（聚合）：总市值 / 来源各分组总仓位上限之和（未设上限的分组不计入分母）
          const cap = groups.reduce((a, g) => a + (g.totalCapital > 0 ? g.totalCapital : 0), 0);
          return cap > 0 ? (global.totalMv / cap) * 100 : undefined;
        })(),
      };
    }
    return null;
  }, [isGroupView, analysis, global, groups]);

  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);

  // 当前视图范围的账本（分组视图 = 该组；全部 = 全部）——供标的交易历史下钻 */
  const groupEntries = useMemo(
    () => (isGroupView ? entries.filter((e) => e.groupId === selectedId) : entries),
    [entries, isGroupView, selectedId],
  );

  // 组合整体统计（全部视图）：盈亏率 + 集中度（最大分组市值占比）
  const globalCost = global ? global.totalMv - global.unrealizedPnl : 0;
  const globalRate = global && globalCost > 0 ? (global.totalPnl / globalCost) * 100 : undefined;
  const maxGroup = useMemo(() => {
    if (groups.length === 0 || !global || global.totalMv <= 0) return undefined;
    const g = [...groups].sort((a, b) => b.totalMv - a.totalMv)[0]!;
    return { name: g.name, pct: (g.totalMv / global.totalMv) * 100 };
  }, [groups, global]);

  const pieOption = useMemo<echarts.EChartsOption>(() => {
    const data = isGroupView && analysis
      ? analysis.positions.filter((p) => p.marketValue > 0).map((p) => ({ name: p.name ? `${p.name} ${p.code}` : p.code, value: Math.round(p.marketValue) }))
      : groups.filter((g) => g.totalMv > 0).map((g) => ({ name: g.name, value: Math.round(g.totalMv) }));
    return {
      tooltip: { trigger: "item", formatter: "{b}<br/>市值 {c} 元（{d}%）" },
      legend: { type: "scroll", bottom: 0, textStyle: { fontSize: 11 } },
      series: [{ type: "pie", radius: ["38%", "66%"], center: ["50%", "44%"], data, label: { fontSize: 11, formatter: "{b}: {d}%" }, itemStyle: { borderRadius: 4, borderColor: "#fff", borderWidth: 1 } }],
    };
  }, [isGroupView, analysis, groups]);

  const barOption = useMemo<echarts.EChartsOption>(() => {
    const names = groups.map((g) => g.name);
    return {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      legend: { data: ["已实现", "未实现"], top: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 8, bottom: 0, top: 32, containLabel: true },
      xAxis: { type: "category", data: names, axisLabel: { fontSize: 11, interval: 0, rotate: names.length > 4 ? 20 : 0 } },
      yAxis: { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => `${v >= 10000 ? (v / 10000).toFixed(1) + "万" : v}` } },
      series: [
        { name: "已实现", type: "bar", stack: "pnl", data: groups.map((g) => Math.round(g.realizedPnl)), itemStyle: { color: C.accent } },
        { name: "未实现", type: "bar", stack: "pnl", data: groups.map((g) => Math.round(g.unrealizedPnl)), itemStyle: { color: "#93c5fd" } },
      ],
    };
  }, [groups]);

  const globalLineOption = useMemo<echarts.EChartsOption>(() => ({
    tooltip: { trigger: "axis", formatter: (p: unknown) => {
      const arr = (p as { axisValue: number; value: unknown }[]);
      const v = Array.isArray(arr[0]?.value) ? (arr[0].value[1] as number) : 0;
      return `${arr[0]?.axisValue ? new Date(arr[0].axisValue).toISOString().slice(0, 10) : ""}<br/>累计已实现：<b>${cny2(v)}</b>`;
    } },
    grid: { left: 8, right: 8, bottom: 0, top: 24, containLabel: true },
    xAxis: { type: "time", axisLabel: { fontSize: 10 } },
    yAxis: { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => `${v >= 10000 ? (v / 10000).toFixed(1) + "万" : v}` } },
    series: [{
      name: "累计已实现",
      type: "line",
      smooth: true,
      showSymbol: false,
      data: (global?.realizedTimeline ?? []).map((t) => [t.date + "T00:00:00", t.cumulative]),
      lineStyle: { color: C.accent, width: 2 },
      areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(37,99,235,.25)" }, { offset: 1, color: "rgba(37,99,235,.02)" }] } },
    }],
  }), [global]);

  // 组合净值曲线（现金+市值口径）：净值 = 期初本金 P0 + (市值 − 累计净投入)
  const donutOption = useMemo<echarts.EChartsOption>(() => {
    const src = isGroupView ? analysis : (global?.analysis ?? null);
      if (!src) return {};
    const data = [
      { name: "已实现", value: Math.abs(Math.round(src.realizedPnl)), signed: src.realizedPnl, color: C.accent },
      { name: "未实现", value: Math.abs(Math.round(src.unrealizedPnl)), signed: src.unrealizedPnl, color: "#93c5fd" },
    ].filter((d) => d.value > 0);
    return {
      tooltip: { trigger: "item", formatter: (p: unknown) => {
        const it = (p as { name: string; value: number; data: { signed: number } });
        return `${it.name}<br/><b>${cny2(it.data.signed)}</b>（绝对值 ${cny2(it.value)}）`;
      } },
      legend: { bottom: 0, textStyle: { fontSize: 11 } },
      series: [{ type: "pie", radius: ["45%", "70%"], center: ["50%", "44%"], data, label: { fontSize: 11, formatter: "{b}: {d}%" } }],
    };
  }, [analysis, global, isGroupView]);

  const attrOption = useMemo<echarts.EChartsOption>(() => {
    const src = isGroupView ? analysis : (global?.analysis ?? null);
      if (!src) return {};
    const top = src.pnlAttribution.slice(0, 10);
    return {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: (p: unknown) => {
        const arr = (p as { name: string; value: unknown }[]);
        const v = typeof arr[0]?.value === "number" ? arr[0].value : 0;
        return `${arr[0]?.name ?? ""}<br/>总收益：<b>${cny2(v)}</b>`;
      } },
      grid: { left: 8, right: 8, bottom: 0, top: 8, containLabel: true },
      xAxis: { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => `${v >= 10000 ? (v / 10000).toFixed(1) + "万" : v}` } },
      yAxis: { type: "category", data: [...top].reverse().map((a) => a.name ?? a.code), axisLabel: { fontSize: 10 } },
      series: [{ type: "bar", data: [...top].reverse().map((a) => ({ value: Math.round(a.totalPnl), itemStyle: { color: a.totalPnl >= 0 ? C.gain : C.loss, borderRadius: 3 } })), barMaxWidth: 16 }],
    };
  }, [analysis, global, isGroupView]);

  const scaleOption = useMemo<echarts.EChartsOption>(() => {
    if (!analysis) return {};
    const daily = analysis!.dailySeries;
    let cum = 0;
    const cumRealized = daily.map((d) => { cum += d.realizedPnl; return Math.round(cum * 100) / 100; });
    let inv = 0;
    const investedSeries = daily.map((d) => { inv += d.buyAmount - d.sellAmount; return Math.round(inv * 100) / 100; });
    const p0 = investedSeries[0] ?? 0;
    const navSeries = daily.map((d, i) => Math.round((p0 + d.marketValue - investedSeries[i]) * 100) / 100);
    return {
      tooltip: { trigger: "axis" },
      legend: { data: ["组合净值(现金+市值)", "持仓市值(成本)", "累计已实现"], top: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 8, bottom: 0, top: 28, containLabel: true },
      xAxis: { type: "category", data: daily.map((d) => d.date), axisLabel: { fontSize: 10 } },
      yAxis: { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => `${v >= 10000 ? (v / 10000).toFixed(1) + "万" : v}` } },
      series: [
        { name: "组合净值(现金+市值)", type: "line", smooth: true, showSymbol: false, data: navSeries, lineStyle: { color: C.accent, width: 2 }, areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(37,99,235,.18)" }, { offset: 1, color: "rgba(37,99,235,.02)" }] } } },
        { name: "持仓市值(成本)", type: "line", smooth: true, showSymbol: false, data: daily.map((d) => Math.round(d.marketValue)), lineStyle: { color: C.muted, width: 1.5, type: "dashed" } },
        { name: "累计已实现", type: "line", smooth: true, showSymbol: false, data: cumRealized, lineStyle: { color: C.gain, width: 1.5, type: "dotted" } },
      ],
    };
  }, [analysis]);

  /** 日度买卖量（股数）柱状图（memo mt72jjg7 补充图表） */
  const dailyVolOption = useMemo<echarts.EChartsOption>(() => {
    const src = isGroupView ? analysis : (global?.analysis ?? null);
      if (!src) return {};
    const days = src.dailySeries.slice(-20);
    return {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v: unknown) => cny2(typeof v === "number" ? Math.abs(v) : 0) },
      legend: { data: ["买入", "卖出"], top: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 8, bottom: 0, top: 28, containLabel: true },
      xAxis: { type: "category", data: days.map((d) => d.date.slice(5)), axisLabel: { fontSize: 9, rotate: 45 } },
      yAxis: { type: "value", name: "金额", nameTextStyle: { fontSize: 10 }, axisLabel: { fontSize: 9, formatter: (v: number) => (Math.abs(v) >= 10000 ? Math.round(Math.abs(v) / 10000) + "万" : String(Math.round(Math.abs(v)))) } },
      series: [
        { name: "买入", type: "bar", stack: "amt", data: days.map((d) => d.buyAmount), itemStyle: { color: C.gain } },
        { name: "卖出", type: "bar", stack: "amt", data: days.map((d) => -d.sellAmount), itemStyle: { color: C.loss } },
      ],
    };
  }, [analysis, global, isGroupView]);

  const monthOption = useMemo<echarts.EChartsOption>(() => {
    const src = isGroupView ? analysis : (global?.analysis ?? null);
      if (!src) return {};
    const months = src.monthlySeries.map((m) => m.month);
    return {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      legend: { data: ["买入", "卖出回款", "已实现"], top: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 8, bottom: 0, top: 28, containLabel: true },
      xAxis: { type: "category", data: months, axisLabel: { fontSize: 10 } },
      yAxis: { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => `${v >= 10000 ? (v / 10000).toFixed(1) + "万" : v}` } },
      series: [
        { name: "买入", type: "bar", data: src.monthlySeries.map((m) => Math.round(m.buyAmount)), itemStyle: { color: "#93c5fd" }, barMaxWidth: 18 },
        { name: "卖出回款", type: "bar", data: src.monthlySeries.map((m) => Math.round(m.sellAmount)), itemStyle: { color: "#c4b5fd" }, barMaxWidth: 18 },
        { name: "已实现", type: "bar", data: src.monthlySeries.map((m) => Math.round(m.realizedPnl)), itemStyle: { color: "#f59e0b" }, barMaxWidth: 18 },
      ],
    };
  }, [analysis, global, isGroupView]);

  const filteredEntries = useMemo(() => {
    // 聚合分组：用派生条目（来源分组并集，服务端已过滤）；基础分组按 selectedId 过滤（memo msx4rs60）
    const base = globalGroup ? (aggEntries ?? entries) : entries;
    return base.filter((e) => {
      if (!globalGroup && selectedId && e.groupId !== selectedId) return false;
      if (fAction !== "all" && e.action !== fAction) return false;
      if (fCode.trim() && !e.code.includes(fCode.trim()) && !(e.name ?? "").includes(fCode.trim())) return false;
      if (fFrom && e.date < fFrom) return false;
      if (fTo && e.date > fTo) return false;
      return true;
    });
  }, [entries, aggEntries, globalGroup, selectedId, fAction, fCode, fFrom, fTo]);

  // 流水分页：每页 100（长流水不卡顿）
  const PAGE_SIZE = 100;
  const pagedEntries = filteredEntries.slice(0, ledgerPage * PAGE_SIZE);
  const hasMore = pagedEntries.length < filteredEntries.length;

  const openEdit = (e: TradeV2Entry) => {
    setEditingEntry(e);
    setEntryEditorOpen(true);
  };
  const removeEntry = async (e: TradeV2Entry) => {
    if (!window.confirm(`删除 ${e.date} ${e.name ?? e.code} 的这笔${e.action === "buy" ? "买入" : "卖出"}？仓位/盈亏将自动重算。`)) return;
    try {
      await api.tradeV2DeleteEntry(e.id);
      await reloadAll();
    } catch (err) {
      setMsg("❌ " + errMsg(err));
    }
  };

  /** 盈亏率基准（对持仓成本）：已实现/未实现/总 各带率——金额与率成对（资金逻辑链） */
  const totalRate = cur && cur.totalCost > 0 && !cur.negCount ? (cur.totalPnl / cur.totalCost) * 100 : undefined;
  const realizedRate = cur && cur.totalCost > 0 && !cur.negCount ? (cur.realizedPnl / cur.totalCost) * 100 : undefined;
  const unrealizedRate = cur && cur.totalCost > 0 && !cur.negCount ? (cur.unrealizedPnl / cur.totalCost) * 100 : undefined;
  // 交易量按金额统计（memo：统计对象是金额不是股数）——从每日动态汇总累计买入/卖出金额
  const srcD = isGroupView ? analysis : global;
  const buyAmt = Math.round((srcD?.dailySeries ?? []).reduce((t: number, d: { buyAmount?: number }) => t + (d.buyAmount ?? 0), 0));
  const sellAmt = Math.round((srcD?.dailySeries ?? []).reduce((t: number, d: { sellAmount?: number }) => t + (d.sellAmount ?? 0), 0));

  const groupTabStyle = (sel: boolean, hover = false, isPaper = false, isAgg = false): React.CSSProperties => {
    // 属性驱动外观（memo mtbjkyro 优化）：虚盘=紫色虚线（"虚拟"语义），实盘=蓝色实线（默认认知），聚合=青色虚线（合并视图）
    const base: React.CSSProperties = { padding: "0.4rem 0.85rem", borderRadius: 10, fontSize: "0.82rem", cursor: "pointer", fontWeight: 600, transition: "all .15s ease", position: "relative" };
    if (isPaper) {
      return {
        ...base,
        border: "1.5px dashed " + (sel ? "#7c3aed" : "#b7a4e8"),
        background: sel ? "#faf5ff" : hover ? "#f7f3ff" : "#fcfaff",
        color: sel ? "#5b21b6" : "#7c5cc4",
        boxShadow: sel ? "0 1px 2px rgba(124,58,237,0.15)" : "none",
      };
    }
    if (isAgg) {
      return {
        ...base,
        border: "1.5px dashed " + (sel ? "#0d9488" : "#7dd3c8"),
        background: sel ? "#f0fdfa" : hover ? "#f2fbf9" : "#fafefd",
        color: sel ? "#115e59" : "#2d7d72",
        boxShadow: sel ? "0 1px 2px rgba(13,148,136,0.15)" : "none",
      };
    }
    return {
      ...base,
      border: "1.5px solid " + (sel ? C.accent : C.faint),
      background: sel ? C.accentBg : hover ? C.panel : "#fff",
      color: sel ? "#1d4ed8" : C.sub,
      boxShadow: sel ? "0 1px 2px rgba(37,99,235,0.15)" : "none",
    };
  };

  /** 信息类型小图标（属性驱动：有信息💡思考/灯泡，无信息🗿死板/不动脑筋——融入 pill 而非角标堆叠） */
  const infoIcon = (infoType?: "info" | "noinfo"): string | null =>
    infoType === "info" ? "💡" : infoType === "noinfo" ? "🗿" : null;

  
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: "1.125rem", fontWeight: 700, margin: 0, color: C.text }}>📋 {isGroupView && selectedGroup ? selectedGroup.name : "仓位管理 v2"}</h1>
        <div style={{ fontSize: "0.82rem", color: C.sub }}>逐笔交易 → 仓位自动归并 · 分组约束 · 收益分析 · 每日交易单</div>
        <div style={{ flex: 1 }} />
      </div>

      {msg && <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0.5rem 0.8rem", borderRadius: 8, fontSize: "0.84rem", fontWeight: 500, border: "1px solid " + C.gainBorder, background: C.gainBg, color: "#b91c1c" }}>{msg}</div>}

      {loading ? (
        <div style={{ padding: "3rem", textAlign: "center", color: C.muted }}>加载中…</div>
      ) : groups.length === 0 ? (
        <Card><CardContent style={{ padding: "2rem", textAlign: "center", color: C.sub }}>
          <div style={{ fontSize: "2rem" }}>🗂️</div>
          还没有分组。先「新建分组」（如策略），再「记一笔交易」——仓位明细与分析会自动生成。
        </CardContent></Card>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: "0.8rem", fontWeight: 700, color: C.sub }}>分组</span>
            {groups.map((g) => {
              const sel = selectedId === g.id;
              return (
                <button key={g.id} onClick={() => { setSelectedId(g.id); try { localStorage.setItem("tradeV2:selectedGroup", g.id); } catch {} }} onMouseEnter={() => setPillHover(g.id)} onMouseLeave={() => setPillHover(null)} style={groupTabStyle(sel, pillHover === g.id, g.isPaper, g.isAgg)}
                  title={`${g.name}${g.isAgg ? " · 聚合分组（标的 = 来源分组并集，合并视图）" : ""}${g.infoType ? " · " + (g.infoType === "info" ? "有信息（基于信息/逻辑判断）" : "无信息（纯执行/统计规律）") : ""}${g.isPaper ? " · 虚盘（不参与聚合/实盘金额）" : " · 实盘"}`}>
                  {g.isAgg ? <span style={{ marginRight: 4, fontSize: "0.78rem" }}>🔗</span> : null}
                  {!g.isAgg && infoIcon(g.infoType) ? <span style={{ marginRight: 4, fontSize: "0.78rem" }}>{infoIcon(g.infoType)}</span> : null}
                  {g.name}
                  {/* 右上角角标：虚盘 paper / 聚合 agg（聚合无信息/实虚属性，仅 🔗+agg） */}
                  {g.isPaper && !g.isAgg ? (
                    <span style={{ position: "absolute", top: -9, right: -3, fontSize: "0.6rem", fontWeight: 700, padding: "0 0.4rem", borderRadius: 999, background: "#faf5ff", color: "#7c3aed", lineHeight: "1.35rem", whiteSpace: "nowrap", border: "1px solid #7c3aed33" }}>paper</span>
                  ) : g.isAgg ? (
                    <span style={{ position: "absolute", top: -9, right: -3, fontSize: "0.6rem", fontWeight: 700, padding: "0 0.4rem", borderRadius: 999, background: "#f0fdfa", color: "#0d9488", lineHeight: "1.35rem", whiteSpace: "nowrap", border: "1px solid #0d948833" }}>agg</span>
                  ) : null}
                  {g.openCount > 0 ? `（${g.openCount}）` : ""}
                  {g.riskCount ? <span style={{ marginLeft: 4, color: "#b45309" }}>⚠️{g.riskCount}</span> : null}
                </button>
              );
            })}
            <div style={{ flex: 1 }} />
            <Button size="sm" variant="outline" onClick={() => { setEditingGroup(null); setGroupEditorOpen(true); }}>🗂️ 新建分组</Button>
                      </div>

          {/* 功能区横向分段控件（通栏等宽）——置于具体功能区上方 */}
          <Tabs value={activeTab} onValueChange={setTab}>
            <TabsList style={{ width: "100%" }}>
              {!isGroupView && <TabsTrigger value="analysis-global" style={{ flex: 1 }}>🧩 组合分析</TabsTrigger>}
              <TabsTrigger value="analysis" style={{ flex: 1 }}>📊 收益分析</TabsTrigger>
              <TabsTrigger value="positions" style={{ flex: 1 }}>📈 仓位明细</TabsTrigger>
              <TabsTrigger value="ledger" style={{ flex: 1 }}>💹 交易流水</TabsTrigger>
              {(isGroupView && selectedGroup) || globalGroup ? <TabsTrigger value="group-settings" style={{ flex: 1 }}>⚙️ 分组设置</TabsTrigger> : null}
            </TabsList>

            {/* 共享统计区：仅「收益分析」tab 展示（资金概览与收益分析绑定） */}
            <SectionTitle icon="📊" color={C.indigo}>资金概览（市值 − 成本 = 浮动盈亏；已实现 + 未实现 = 总盈亏；仓位控制在右下）</SectionTitle>
            {activeTab === "analysis" && cur && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10 }}>
              {/* 资金逻辑链①：市值 − 成本 = 浮动盈亏（金额与率成对） */}
              <StatGroup title="持仓" icon="📦" tone="blue" items={[
                { label: "持仓市值", value: cny(cur.totalMv) },
                { label: "持仓成本", value: cny(cur.totalCost), sub: cur.negCount ? `不含 ${cur.negCount} 个负成本（已回本）· 净投入 ${cny(cur.invested)}` : `累计净投入 ${cny(cur.invested)}` },
                { label: "仓位比例", value: cur.positionPct !== undefined ? pct(cur.positionPct) : "—", sub: cur.positionPct !== undefined ? `占总仓位 ${pct(cur.positionPct)}` : undefined },
              ]} />
              {/* 资金逻辑链②：已实现（落袋）+ 未实现（浮动）= 总盈亏，各带率 */}
              <StatGroup title="盈亏" icon="💰" tone="red" items={[
                { label: "已实现", value: pnlText(cur.realizedPnl), color: pnlColor(cur.realizedPnl), sub: cur.realizedPnl !== 0 && realizedRate !== undefined ? `率 ${pctSigned(realizedRate)}` : undefined },
                { label: "未实现", value: pnlText(cur.unrealizedPnl), color: pnlColor(cur.unrealizedPnl), sub: cur.unrealizedPnl !== 0 && unrealizedRate !== undefined ? `率 ${pctSigned(unrealizedRate)}` : undefined },
                { label: "总盈亏", value: pnlText(cur.totalPnl), color: pnlColor(cur.totalPnl), sub: cur.totalPnl !== 0 && totalRate !== undefined ? `总率 ${pctSigned(totalRate)}` : undefined },
              ]} />
              {/* 交易量统计（memo mt72jjg7）：累计买卖量 + 净买入 */}
              <StatGroup title="交易量" icon="🔄" tone="indigo" items={[
                { label: "累计买入", value: cny(buyAmt) },
                { label: "累计卖出", value: cny(sellAmt) },
                { label: "净买入", value: cny(buyAmt - sellAmt), color: buyAmt - sellAmt >= 0 ? C.gain : C.loss },
              ]} />
              {isGroupView ? (
                <StatGroup title="仓位" icon="🏦" tone="emerald" items={[
                  { label: "今日加仓", value: cny(cur.todayAdd ?? 0) },
                  { label: "剩余可用", value: cny(cur.remaining ?? 0) },
                  { label: "累计净投入", value: cny(cur.invested) },
                ]} />
              ) : null}
            </div>
          )}

            {!isGroupView && (
              <TabsContent value="analysis-global">
          {/* 全部视图：组合整体（组合逻辑与展示单独抽出——mt52hjgp） */}
          {!isGroupView && global && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10, marginBottom: 12 }}>
              <StatGroup title="组合整体" icon="🧩" tone="amber" items={[
                { label: "组合数", value: `${groups.length} 组`, sub: `在途 ${global.openCount} 笔` },
                { label: "组合盈亏", value: pnlText(global.totalPnl), color: pnlColor(global.totalPnl), sub: globalRate !== undefined ? `盈亏率 ${pctSigned(globalRate)}` : undefined },
                { label: "集中度", value: maxGroup ? pct(maxGroup.pct) : "—", sub: maxGroup ? `最大：${maxGroup.name}` : undefined },
              ]} />
            </div>
          )}
          {/* 组合视图：分组贡献明细（聚合分组=来源分组；点击行跳转该组） */}
          {!isGroupView && global && (
            <GroupContributionTable groups={globalGroup?.aggSources?.length ? groups.filter((g) => globalGroup.aggSources!.includes(g.id)) : groups} globalMv={global.totalMv} onSelect={(id) => { setSelectedId(id); try { localStorage.setItem("tradeV2:selectedGroup", id); } catch {} }} />
          )}

          {!isGroupView && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Card><CardContent>
                <SectionTitle icon="🥧" color={C.indigo}>分组市值占比</SectionTitle>
                <EChart option={pieOption} height={220} />
              </CardContent></Card>
              <Card><CardContent>
                <SectionTitle icon="📊" color={C.indigo}>分组盈亏对比（已实现 + 未实现）</SectionTitle>
                <EChart option={barOption} height={220} />
              </CardContent></Card>
              <Card style={{ gridColumn: "1 / -1" }}><CardContent>
                <SectionTitle icon="📈" color={C.indigo}>累计已实现盈亏曲线（按清仓日）</SectionTitle>
                <EChart option={globalLineOption} height={200} />
              </CardContent></Card>
              <Card style={{ gridColumn: "1 / -1" }}><CardContent>
                <SectionTitle icon="📊" color={C.indigo}>组合净值曲线（现金+市值口径 · 历史价：期初本金 + 已实现 + 未实现）</SectionTitle>
                <NetValueChart daily={global?.dailySeries ?? []} />
              </CardContent></Card>
            </div>
          )}
              </TabsContent>
            )}

            {(isGroupView && analysis) || (!isGroupView && global) ? (
              <TabsContent value="analysis">
                {(() => {
                  // 组合视图（聚合分组）首先是一般组合：收益分析 tab 与分组完全一致（mt52hjgp），仅数据源不同
                  const src = isGroupView ? analysis : (global?.analysis ?? null);
                  if (!src) return null;
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      {isGroupView && src.dailySeries.length === 0 && (
                        <Card><CardContent style={{ padding: "1.2rem", textAlign: "center" }}>
                          <div style={{ fontSize: "1.6rem", marginBottom: 6 }}>🗒️</div>
                          <div style={{ fontSize: "0.9rem", fontWeight: 600, color: C.text, marginBottom: 4 }}>该分组还没有任何交易</div>
                          <div style={{ fontSize: "0.8rem", color: C.muted, marginBottom: 10 }}>去「💼 交易单」记入第一笔买入（期初建仓），仓位明细与收益分析会自动生成。</div>
                          <Button size="sm" onClick={() => setTab("order")}>💼 去记一笔交易</Button>
                        </CardContent></Card>
                      )}
                      <div style={{ fontSize: "0.75rem", color: C.muted, marginBottom: 2 }}>💡 图例操作：点击图例项切换单个系列；右上角「全选 / 全不选」批量控制</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                        <Card><CardContent>
                          <SectionTitle icon="🍩" color={C.accent}>收益构成（已实现 vs 未实现）</SectionTitle>
                          {Math.abs(src.realizedPnl) + Math.abs(src.unrealizedPnl) > 0 ? <EChart option={donutOption} height={220} /> : <div style={{ color: C.muted, fontSize: "0.8rem", padding: "2rem 0", textAlign: "center" }}>暂无收益</div>}
                        </CardContent></Card>
                        <Card><CardContent>
                          <SectionTitle icon="🏆" color={C.accent}>收益归因（Top 10 标的，红涨绿跌）</SectionTitle>
                          {src.pnlAttribution.length > 0 ? <EChart option={attrOption} height={220} /> : <div style={{ color: C.muted, fontSize: "0.8rem", padding: "2rem 0", textAlign: "center" }}>暂无交易</div>}
                        </CardContent></Card>
                        <Card style={{ gridColumn: "1 / -1" }}><CardContent>
                          <SectionTitle icon="📊" color={C.accent}>组合净值曲线（现金+市值口径 · 历史价时间性）</SectionTitle>
                          <NetValueChart daily={src.dailySeries} />
                        </CardContent></Card>
                        <Card style={{ gridColumn: "1 / -1" }}><CardContent>
                          <SectionTitle icon="🗓️" color={C.accent}>月度买入/卖出/已实现（时间性）</SectionTitle>
                          <EChart option={monthOption} height={220} />
                          <SectionTitle icon="🔄" color={C.accent}>日度买卖量（近 20 交易日，金额）</SectionTitle>
                          <EChart option={dailyVolOption} height={200} />
                        </CardContent></Card>
                      </div>
                      <DailyTable dailySeries={src.dailySeries} />
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                        <MonthlyTable monthlySeries={src.monthlySeries} />
                        <AttributionTable attribution={src.pnlAttribution} onRowClick={(a) => setStockDlg({ code: a.code, name: a.name })} />
                      </div>
                      <PerformanceCard deals={src.deals} metrics={src.metrics} />
                      <DealsTable deals={src.deals} />
                    </div>
                  );
                })()}
              </TabsContent>
            ) : null}

            <TabsContent value="positions">
              <PositionsTable
                positions={isGroupView && analysis ? analysis.positions : (global?.positions ?? positionsFromGlobal(entries))}
                groupView={isGroupView}
                onRowClick={(p) => setStockDlg({ code: p.code, name: p.name })}
                exportName={isGroupView && selectedGroup ? `仓位明细_${selectedGroup.name}.csv` : globalGroup ? `仓位明细_${globalGroup.name}.csv` : "全部持仓.csv"}
                positionPct={cur?.positionPct}
              />
            </TabsContent>


            <TabsContent value="ledger">
              {/* 信息-风险提醒（memo：无信息高波暂停/有信息降仓；放交易流水 tab） */}
              {isGroupView && selectedGroup && <InfoRiskAlert infoType={selectedGroup.infoType} positions={analysis?.positions} />}
              {/* 日度交易汇总：流水 tab 最上方（memo mt2tzfw3；聚合分组用派生条目） */}
              <DailySummaryCard entries={globalGroup ? (aggEntries ?? entries) : entries.filter((e) => e.groupId === selectedId)} />
              {/* 分组视图：交易流水整合录入（记一笔/批量提交 → 流水下方即时可见） */}
              {isGroupView && selectedGroup && analysis && !(selectedGroup.aggSources && selectedGroup.aggSources.length > 0) && (
                <OrderSheet
                  initialGroup={selectedGroup}
                  groups={groups}
                  allEntries={entries}
                  todayAdd={analysis.todayAdd}
                  positions={analysis.positions}
                  onSubmitted={() => void reloadAll()}
                  onEditEntry={openEdit}
                  onDeleteEntry={(e) => void removeEntry(e)}
                />
              )}
              <Card><CardContent>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                  <Select value={fAction} onValueChange={(v: string | null) => setFAction(v ?? "all")}>
                    <SelectTrigger className="w-28"><SelectValue>{fAction === "all" ? "全部操作" : fAction === "sell" ? "卖出" : "买入"}</SelectValue></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部操作</SelectItem>
                      <SelectItem value="buy">买入</SelectItem>
                      <SelectItem value="sell">卖出</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input autoComplete="off" className="h-8 w-36" placeholder="名称/代码过滤" value={fCode} onChange={(e) => setFCode(e.target.value)} />
                  <Input autoComplete="off" type="date" className="h-8 w-36" value={fFrom} onChange={(e) => setFFrom(e.target.value)} />
                  <span style={{ color: C.muted, fontSize: "0.8rem" }}>至</span>
                  <Input autoComplete="off" type="date" className="h-8 w-36" value={fTo} onChange={(e) => setFTo(e.target.value)} />
                  <span style={{ color: C.sub, fontSize: "0.8rem" }}>共 {filteredEntries.length} 笔</span>
                  <div style={{ flex: 1 }} />
                  <Button size="sm" variant="outline" onClick={() => downloadCSV("交易流水.csv", ["日期", "分组", "代码", "名称", "操作", "数量", "价格", "金额", "手续费", "备注"], filteredEntries.map((e) => [e.date, groupById.get(e.groupId)?.name ?? "", e.code, e.name ?? "", e.action === "buy" ? "买入" : "卖出", e.quantity, e.price, Math.round(e.quantity * e.price * 100) / 100, e.fee ?? "", e.note ?? ""]))}>📤 导出 CSV</Button>
                </div>

                {filteredEntries.length === 0 ? (
                  <div style={{ padding: "1.5rem", textAlign: "center", color: C.muted, fontSize: "0.85rem" }}>暂无符合条件的交易。</div>
                ) : (
                  <div style={{ maxHeight: 520, overflow: "auto" }}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="sticky top-0 z-10 bg-white">日期</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white">分组</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white">标的</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white">操作</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white text-right">数量</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white text-right">价格</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white text-right">金额</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white text-right">手续费</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white">备注</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pagedEntries.map((e) => {
                        const amount = e.quantity * e.price;
                        const g = groupById.get(e.groupId);
                        return (
                          <TableRow key={e.id}>
                            <TableCell className="whitespace-nowrap">{e.date}</TableCell>
                            <TableCell><Badge variant="outline" style={{ background: "#f1f5f9" }}>{g?.name ?? "—"}</Badge></TableCell>
                            <TableCell>
                              <NameCode name={e.name} code={e.code} />
                              {e.initial && <Badge style={{ marginLeft: 6, background: "#fef3c7", color: "#b45309" }}>期初</Badge>}
                            </TableCell>
                            <TableCell>
                              <Badge style={e.action === "buy" ? { background: C.gainBg, color: C.gain } : { background: C.lossBg, color: C.loss }}>
                                {e.action === "buy" ? "买入" : "卖出"}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right">{qtyFmt(e.quantity)}</TableCell>
                            <TableCell className="text-right">{costFmt(e.price)}</TableCell>
                            <TableCell className="text-right">{cny2(amount)}</TableCell>
                            <TableCell className="text-right">{e.fee ? cny2(e.fee) : "—"}</TableCell>
                            <TableCell style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.sub, fontSize: "0.8rem" }}>{e.note ?? ""}</TableCell>
                            <TableCell>
                              <span style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => openEdit(e)}>编辑</Button>
                                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-red-500 hover:bg-red-50" onClick={() => void removeEntry(e)}>删除</Button>
                              </span>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  </div>
                )}
                {hasMore && (
                  <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
                    <Button variant="outline" size="sm" onClick={() => setLedgerPage((p) => p + 1)}>显示更多（已显示 {pagedEntries.length} / {filteredEntries.length} 笔）</Button>
                  </div>
                )}
              </CardContent></Card>
            </TabsContent>
            {isGroupView && selectedGroup && (
              <TabsContent value="group-settings">
                <Card><CardContent>
                  <SectionTitle icon="⚙️" color={C.indigo}>分组设置 · {(globalGroup ?? selectedGroup)!.name}（memo msvvra4c tab 化）</SectionTitle>
                  {/* 分组概览统计（丰富内容） */}
                  {analysis && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
                      <div style={{ background: C.panel, borderRadius: 8, padding: "0.6rem 0.8rem" }}>
                        <div style={{ fontSize: "0.72rem", color: C.muted }}>组内标的</div>
                        <div style={{ fontSize: "1.05rem", fontWeight: 700, color: C.text }}>{analysis.positions.length} 个</div>
                      </div>
                      <div style={{ background: C.panel, borderRadius: 8, padding: "0.6rem 0.8rem" }}>
                        <div style={{ fontSize: "0.72rem", color: C.muted }}>交易笔数</div>
                        <div style={{ fontSize: "1.05rem", fontWeight: 700, color: C.text }}>{analysis.deals.length} 笔</div>
                      </div>
                      <div style={{ background: C.panel, borderRadius: 8, padding: "0.6rem 0.8rem" }}>
                        <div style={{ fontSize: "0.72rem", color: C.muted }}>当前市值</div>
                        <div style={{ fontSize: "1.05rem", fontWeight: 700, color: C.accent }}>{cny(analysis.positions.reduce((s, p) => s + p.marketValue, 0))}</div>
                      </div>
                      <div style={{ background: C.panel, borderRadius: 8, padding: "0.6rem 0.8rem" }}>
                        <div style={{ fontSize: "0.72rem", color: C.muted }}>占用总仓位</div>
                        <div style={{ fontSize: "1.05rem", fontWeight: 700, color: selectedGroup.totalCapital > 0 ? C.text : C.muted }}>
                          {selectedGroup.totalCapital > 0 ? pct((analysis.positions.reduce((s, p) => s + p.marketValue, 0) / selectedGroup.totalCapital) * 100) : "未设上限"}
                        </div>
                      </div>
                    </div>
                  )}
                  <GroupEditor inline open initial={globalGroup ?? selectedGroup} onSaved={() => void reloadAll()} groups={groups} onClose={() => {}} />
                </CardContent></Card>
              </TabsContent>
            )}
          </Tabs>
        </>
      )}

      <EntryEditor open={entryEditorOpen} onClose={() => setEntryEditorOpen(false)} groups={groups} initial={editingEntry} onSaved={() => void reloadAll()} />
      <GroupEditor open={groupEditorOpen} onClose={() => setGroupEditorOpen(false)} groups={groups} initial={editingGroup} onSaved={() => void reloadAll()} />
            <StockHistoryDialog
        open={!!stockDlg}
        onClose={() => setStockDlg(null)}
        code={stockDlg?.code ?? ""}
        name={stockDlg?.name}
        scopeName={isGroupView && selectedGroup ? selectedGroup.name : "全部组合"}
        entries={groupEntries}
        positions={isGroupView && analysis ? analysis.positions : (global?.positions ?? positionsFromGlobal(entries))}
        deals={analysis?.deals ?? []}
        groups={groups}
        onMoved={() => void reloadAll()}
      />
    </div>
  );
}
