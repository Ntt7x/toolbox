// ============================================================
// LLM 用量图表（ECharts）
// - DailyTokensBar：逐日用量条形图（x=日期，y=tokens）
// - DayModulePie：单日用量扇形图（某日各模块 tokens 占比）
// ============================================================

import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { LlmUsageSummary } from "@toolbox/shared";

const PALETTE = [
  "#2563eb", "#7c3aed", "#0891b2", "#f59e0b", "#16a34a",
  "#dc2626", "#db2777", "#65a30d", "#0d9488", "#9333ea",
];

function kfmt(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`;
}

/** 逐日用量条形图 */
export function DailyTokensBar({ byDay, height = 240 }: { byDay: LlmUsageSummary["byDay"]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el);
    const days = [...byDay].reverse().map((d) => d.day);
    const tokens = [...byDay].reverse().map((d) => d.totalTokens);
    const calls = [...byDay].reverse().map((d) => d.calls);
    chart.setOption({
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (ps: { axisValue: string; data: number; seriesName?: string }[]) => {
          const i = days.indexOf(ps[0]?.axisValue ?? "");
          const d = byDay.find((x) => x.day === ps[0]?.axisValue);
          const head = `${ps[0]?.axisValue ?? ""}`;
          const lines = ps.map((p) => `${p.seriesName ?? "tokens"}：${kfmt(p.data)}`).join("<br/>");
          return `${head}<br/>${lines}${d ? `<br/>调用 ${d.calls} 次` : ""}${i >= 0 ? "" : ""}`;
        },
      },
      grid: { left: 64, right: 16, top: 20, bottom: 42 },
      xAxis: {
        type: "category",
        data: days,
        axisLabel: { color: "#64748b", fontSize: 10 },
        axisLine: { lineStyle: { color: "#e2e8f0" } },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: "#64748b", formatter: (v: number) => kfmt(v) },
        splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } },
      },
      series: [
        {
          name: "tokens",
          type: "bar",
          data: tokens,
          barMaxWidth: 36,
          itemStyle: {
            color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "#3b82f6" }, { offset: 1, color: "#93c5fd" }] },
            borderRadius: [4, 4, 0, 0],
          },
          label: { show: calls.some((c) => c > 0) && tokens.length <= 31, position: "top", color: "#475569", fontSize: 9, formatter: (p: { data: number }) => kfmt(p.data) },
        },
      ],
      dataZoom: tokens.length > 31 ? [{ type: "slider", height: 14, bottom: 4, start: Math.max(0, 100 - (31 / tokens.length) * 100), end: 100 }] : undefined,
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [byDay]);
  return <div ref={ref} style={{ width: "100%", height, overflow: "hidden" }} />;
}

/** 单日用量扇形图（模块占比） */
export function DayModulePie({ byModule, mode = "tokens", height = 260 }: { byModule: { label: string; totalTokens: number; costCny?: number }[]; mode?: "tokens" | "cost"; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || byModule.length === 0) return;
    const chart = echarts.init(el);
    const total = byModule.reduce((s, m) => s + (mode === "cost" ? m.costCny ?? 0 : m.totalTokens), 0);
    chart.setOption({
      color: PALETTE,
      tooltip: {
        trigger: "item",
        formatter: (p: { name: string; value: number; percent: number }) =>
          mode === "cost" ? `${p.name}<br/>¥${(p.value).toFixed(2)}（${p.percent}%）` : `${p.name}<br/>${kfmt(p.value)} tokens（${p.percent}%）`,
      },
      legend: {
        orient: "vertical",
        right: 4,
        top: "middle",
        textStyle: { color: "#475569", fontSize: 11 },
        formatter: (name: string) => {
          const m = byModule.find((x) => x.label === name);
          if (!m) return name;
            return mode === "cost" ? `${name} · ¥${(m.costCny ?? 0).toFixed(2)}` : `${name} · ${kfmt(m.totalTokens)}`;
        },
      },
      series: [
        {
          name: mode === "cost" ? "费用" : "用量",
          type: "pie",
          radius: ["42%", "68%"],
          center: ["38%", "50%"],
          itemStyle: { borderColor: "#fff", borderWidth: 2, borderRadius: 4 },
          label: { show: false },
          emphasis: { label: { show: true, fontSize: 11, fontWeight: 600, formatter: "{b}\n{d}%" } },
          data: byModule.map((m) => ({ name: m.label, value: mode === "cost" ? m.costCny ?? 0 : m.totalTokens })),
        },
      ],
      graphic: [
        {
          type: "text",
          left: "30%",
          top: "43%",
          style: { text: mode === "cost" ? `¥${total.toFixed(2)}` : kfmt(total), textAlign: "center", fill: "#334155", fontSize: 16, fontWeight: 700 },
        },
        {
          type: "text",
          left: "30%",
          top: "52%",
          style: { text: mode === "cost" ? "估算费用" : "tokens", textAlign: "center", fill: "#94a3b8", fontSize: 10 },
        },
      ],
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [byModule, mode]);
  return <div ref={ref} style={{ width: "100%", height }} />;
}
