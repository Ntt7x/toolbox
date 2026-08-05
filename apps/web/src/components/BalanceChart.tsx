// ============================================================
// 余额曲线组件（ECharts）：买断式逆回购存量余额
// - 余额折线：月度累计净投放（= 存量余额），x 轴精确到月；
//   权威月份实心蓝点，模型推算月份（estimated）空心灰点、tooltip 标注「推算」，
//   全月份连续不断开（推算基于 逐笔投放 − 到期 模型）
// - 投放量柱：逐笔操作（精确到日期），右侧副轴展示
// - 交互：tooltip（日期/权威-推算）、框选/滑块缩放、渐变面积
// ============================================================

import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { ReverseRepoOperation } from "@toolbox/shared";

interface BalancePoint {
  month: string;
  balance: number;
  estimated?: boolean;
}

interface Props {
  /** 余额序列（estimated=true 为模型推算） */
  series: BalancePoint[];
  /** 逐笔操作（投放日精确到日期，画投放量柱） */
  operations?: ReverseRepoOperation[];
  height?: number;
}

const fmtYM = (v: number | Date): string => {
  const d = new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export default function BalanceChart({ series, operations = [], height = 330 }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el);

    const sorted = [...series].sort((a, b) => (a.month < b.month ? -1 : 1));
    const balanceData = sorted.map((s) => ({
      value: [s.month + "-01", s.balance] as (string | number)[],
      // 推算点：空心灰点；权威点：实心蓝点
      ...(s.estimated
        ? { symbol: "circle", symbolSize: 5, itemStyle: { color: "#ffffff", borderColor: "#64748b", borderWidth: 1.5 } }
        : { symbol: "circle", symbolSize: 6, itemStyle: { color: "#2563eb", borderColor: "#fff", borderWidth: 1.5 } }),
    }));
    const opData = operations
      .filter((o) => o.amount > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((o) => [o.date, o.amount] as (string | number)[]);

    chart.setOption({
      animation: true,
      animationDuration: 400,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross", label: { backgroundColor: "#334155" } },
        formatter: (params: unknown) => {
          const arr = (params as { axisValue: number; seriesName: string; value: unknown }[]);
          const d = new Date(arr[0]?.axisValue ?? 0);
          const line = arr.find((p) => p.seriesName === "存量余额");
          const bar = arr.find((p) => p.seriesName === "投放量");
          const point = sorted.find((s) => s.month === fmtYM(d));
          const lines = [];
          if (line) {
            const v = Array.isArray(line.value) ? (line.value[1] as number) : line.value;
            lines.push(
              `<div>余额：<b>${typeof v === "number" ? v.toLocaleString() : v}</b> 亿元${point?.estimated ? " <span style='color:#64748b'>(模型推算)</span>" : ""}</div>`,
            );
          }
          if (bar) {
            const v = Array.isArray(bar.value) ? (bar.value[1] as number) : bar.value;
            lines.push(`<div>投放：<b>${typeof v === "number" ? v.toLocaleString() : v}</b> 亿元</div>`);
          }
          return `<div style="font-weight:600">${fmtYM(d)}</div>${lines.join("")}`;
        },
      },
      legend: { data: ["存量余额", "投放量"], top: 0, textStyle: { color: "#475569" } },
      grid: { left: 70, right: 74, top: 34, bottom: 66 },
      xAxis: {
        type: "time",
        axisLabel: { color: "#64748b", hideOverlap: true, formatter: fmtYM },
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
        // 仅保留滚轮/拖拽缩放（inside），不显示底部拉伸轴
        { type: "inside", xAxisIndex: 0, filterMode: "none" },
      ],
      series: [
        {
          name: "存量余额",
          type: "line",
          data: balanceData,
          connectNulls: false,
          lineStyle: { width: 2.5, color: "#2563eb" },
          areaStyle: {
            color: {
              type: "linear",
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
