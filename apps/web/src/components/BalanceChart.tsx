// ============================================================
// 余额曲线组件（ECharts）：买断式逆回购存量余额
// - 余额折线：月度累计净投放（= 存量余额），x 轴精确到月；缺失月份置 null 断开
// - 投放量柱：逐笔操作（精确到日期），右侧副轴展示
// - 支持 tooltip 十字准星、框选/滑块缩放、双 y 轴、峰谷标注
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

/** 补全月份序列：首尾之间的每个月都有位（缺失置 null，折线断开） */
function expandMonths(series: { month: string; balance: number }[]): (string | number | null)[][] {
  if (series.length === 0) return [];
  const sorted = [...series].sort((a, b) => (a.month < b.month ? -1 : 1));
  const start = new Date(sorted[0].month + "-01");
  const end = new Date(sorted[sorted.length - 1].month + "-01");
  const byMonth = new Map(sorted.map((s) => [s.month, s.balance]));
  const out: (string | number | null)[][] = [];
  for (const d = new Date(start); d <= end; d.setMonth(d.getMonth() + 1)) {
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const v = byMonth.get(ym);
    out.push([ym + "-01", v === undefined ? null : v]);
  }
  return out;
}

export default function BalanceChart({ series, operations = [], height = 330 }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el);
    const balanceData = expandMonths(series);
    const opData = operations
      .filter((o) => o.amount > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((o) => [o.date, o.amount] as (string | number)[]);

    chart.setOption({
      animation: true,
      animationDuration: 500,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross", label: { backgroundColor: "#334155" } },
      },
      legend: { data: ["存量余额", "投放量"], top: 0, textStyle: { color: "#475569" } },
      grid: { left: 70, right: 74, top: 34, bottom: 66 },
      xAxis: {
        type: "time",
        axisLabel: {
          color: "#64748b",
          formatter: (v: number) => {
            const d = new Date(v);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          },
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
        {
          name: "存量余额",
          type: "line",
          data: balanceData,
          connectNulls: false,
          showSymbol: true,
          symbol: "circle",
          symbolSize: 6,
          lineStyle: { width: 2.5, color: "#2563eb" },
          itemStyle: { color: "#2563eb", borderColor: "#fff", borderWidth: 1.5 },
          areaStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: "rgba(37,99,235,0.25)" },
                { offset: 1, color: "rgba(37,99,235,0.02)" },
              ],
            },
          },
          markPoint: {
            data: [
              { type: "max", name: "峰值", itemStyle: { color: "#dc2626" } },
              { type: "min", name: "最低", itemStyle: { color: "#16a34a" } },
            ],
          },
          z: 3,
        },
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
