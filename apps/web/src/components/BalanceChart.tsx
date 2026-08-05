// ============================================================
// 余额曲线组件（ECharts）：买断式逆回购存量余额
// - 余额折线：月度累计净投放（= 存量余额），x 轴精确到月；
//   数据缺失段【拆分为独立 series】——折线与面积都真实断开，不跨 null 假连接
// - 投放量柱：逐笔操作（精确到日期），右侧副轴展示
// - 交互：tooltip（日期格式化）、框选/滑块缩放、峰谷标注、渐变面积
// ============================================================

import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { ReverseRepoOperation } from "@toolbox/shared";

interface Props {
  /** 月度余额序列（累计净投放） */
  series: { month: string; balance: number }[];
  /** 逐笔操作（投放日精确到日期，画投放量柱） */
  operations?: ReverseRepoOperation[];
  height?: number;
}

const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** a 的下一个月是否等于 b（用于判断连续性） */
function isNextMonth(a: string, b: string): boolean {
  const ma = MONTH_RE.exec(a);
  const mb = MONTH_RE.exec(b);
  if (!ma || !mb) return false;
  const [ya, moa] = [Number(ma[1]), Number(ma[2])];
  const [yb, mob] = [Number(mb[1]), Number(mb[2])];
  if (ya === yb) return mob === moa + 1;
  if (yb === ya + 1) return moa === 12 && mob === 1;
  return false;
}

/** 按连续月份拆段：缺失处断开（每段独立 series，折线与面积都不跨断档） */
function splitSegments(series: { month: string; balance: number }[]): (string | number)[][][] {
  const sorted = [...series].sort((a, b) => (a.month < b.month ? -1 : 1));
  const segs: (string | number)[][][] = [];
  let cur: (string | number)[][] = [];
  let prev: string | null = null;
  for (const s of sorted) {
    if (prev !== null && !isNextMonth(prev, s.month)) {
      segs.push(cur);
      cur = [];
    }
    cur.push([s.month + "-01", s.balance]);
    prev = s.month;
  }
  if (cur.length > 0) segs.push(cur);
  return segs;
}

const fmtYM = (v: number): string => {
  const d = new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export default function BalanceChart({ series, operations = [], height = 330 }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el);

    const segments = splitSegments(series);
    const opData = operations
      .filter((o) => o.amount > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((o) => [o.date, o.amount] as (string | number)[]);

    const lineSeries = segments.map((seg, i) => ({
      name: "存量余额",
      type: "line" as const,
      data: seg,
      connectNulls: false,
      showSymbol: true,
      symbol: "circle" as const,
      symbolSize: 6,
      lineStyle: { width: 2.5, color: "#2563eb" },
      itemStyle: { color: "#2563eb", borderColor: "#fff", borderWidth: 1.5 },
      areaStyle: {
        color: {
          type: "linear" as const,
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: "rgba(37,99,235,0.22)" },
            { offset: 1, color: "rgba(37,99,235,0.02)" },
          ],
        },
      },
      // 只在最后一段标注峰谷，避免重复
      ...(i === segments.length - 1
        ? {
            markPoint: {
              data: [
                { type: "max" as const, name: "峰值", itemStyle: { color: "#dc2626" } },
                { type: "min" as const, name: "最低", itemStyle: { color: "#16a34a" } },
              ],
            },
          }
        : {}),
      z: 3,
    }));

    chart.setOption({
      animation: true,
      animationDuration: 400,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross", label: { backgroundColor: "#334155" } },
        valueFormatter: (v: unknown) => (typeof v === "number" ? v.toLocaleString() : `${v ?? "—"}`),
      },
      legend: { data: ["存量余额", "投放量"], top: 0, textStyle: { color: "#475569" } },
      grid: { left: 70, right: 74, top: 34, bottom: 66 },
      xAxis: {
        type: "time",
        axisLabel: {
          color: "#64748b",
          hideOverlap: true,
          formatter: fmtYM,
        },
        splitLine: { show: false },
      },
      yAxis: [
        {
          type: "value",
          name: "余额（亿元）",
          nameTextStyle: { color: "#64748b" },
          axisLabel: {
            color: "#64748b",
            formatter: (v: number) => (v >= 10000 ? `${(v / 10000).toFixed(1)}万亿` : `${v}`),
          },
          splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } },
        },
        {
          type: "value",
          name: "投放（亿元）",
          nameTextStyle: { color: "#64748b" },
          axisLabel: { color: "#64748b" },
          splitLine: { show: false },
        },
      ],
      dataZoom: [
        { type: "inside", xAxisIndex: 0, filterMode: "none" },
        { type: "slider", xAxisIndex: 0, bottom: 6, height: 18, filterMode: "none" },
      ],
      series: [
        ...lineSeries,
        {
          name: "投放量",
          type: "bar",
          yAxisIndex: 1,
          data: opData,
          barWidth: "50%",
          itemStyle: { color: "rgba(147,197,253,0.75)", borderRadius: [2, 2, 0, 0] },
          z: 1,
        },
      ],
    });

    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [series, operations]);

  return <div ref={ref} style={{ width: "100%", height }} />;
}
