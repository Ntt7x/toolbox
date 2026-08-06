// ============================================================
// 后台管理 → 架构图（依赖图）
// 服务端自动扫描源码 import 生成 {nodes, edges}（core/dependencyGraph），
// 前端用 ECharts graph（力导向）展示：缩放/拖拽/点击节点详情。
// ============================================================
import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts";
import { api } from "../api";

interface DepNode {
  id: string;
  name: string;
  type: "feature" | "core" | "external" | "data";
  desc?: string;
}
interface DepEdge {
  from: string;
  to: string;
  kind: string;
  label?: string;
}
interface GraphData {
  ok: boolean;
  generatedAt: string;
  nodes: DepNode[];
  edges: DepEdge[];
}

const TYPE_META: Record<string, { label: string; color: string }> = {
  feature: { label: "业务模块", color: "#2563eb" },
  core: { label: "公共模块", color: "#7c3aed" },
  external: { label: "外部系统", color: "#dc2626" },
  data: { label: "数据层", color: "#059669" },
};

const EDGE_KIND_LABEL: Record<string, string> = {
  import: "依赖",
  "llm-mode": "LLM 模式",
  acp: "ACP 会话",
  api: "API 调用",
  data: "数据读写",
};

export default function ArchGraph() {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInst = useRef<echarts.ECharts | null>(null);
  const [data, setData] = useState<GraphData | null>(null);
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<DepNode | null>(null);
  const [related, setRelated] = useState<DepEdge[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const d = await api.dependencyGraph();
        if (d.ok && "nodes" in d) setData(d as GraphData);
        else setErr("依赖图数据加载失败");
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [reloadKey]);

  useEffect(() => {
    if (!data || !chartRef.current) return;
    if (!chartInst.current) {
      chartInst.current = echarts.init(chartRef.current);
    }
    const chart = chartInst.current;

    // ---- 分层静态布局（按模块类型分列，消除 force 抖动/跳变） ----
    // 列 x 坐标：业务模块 → 公共模块 → 外部系统/数据层（单向流）
    const COL_X: Record<string, number> = { feature: 150, core: 520, external: 850, data: 960 };
    const CHART_H = 600;
    const TOP = 70;
    const typeOrder = ["feature", "core", "external", "data"] as const;
    const colNodes = new Map<string, { id: string; name: string; type: string }[]>();
    for (const n of data.nodes) {
      const arr = colNodes.get(n.type) ?? [];
      arr.push(n);
      colNodes.set(n.type, arr);
    }
    const pos = new Map<string, [number, number]>();
    for (const t of typeOrder) {
      const arr = colNodes.get(t) ?? [];
      // 出边多的节点放列中间（减少交叉）：按出度降序排布，再映射到 y
      const outDeg = new Map<string, number>();
      for (const e of data.edges) outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
      const sorted = [...arr].sort((a, b) => (outDeg.get(b.id) ?? 0) - (outDeg.get(a.id) ?? 0));
      const n = sorted.length;
      sorted.forEach((node, i) => {
        // 折线交错：偶数位从中间向上、奇数位从中间向下（避免同列直线重叠）
        const mid = (n - 1) / 2;
        const y = n === 1 ? CHART_H / 2 : TOP + ((i - mid) * ((CHART_H - 2 * TOP) / Math.max(n - 1, 1)));
        pos.set(node.id, [COL_X[t] ?? 520, y]);
      });
    }

    const EDGE_COLOR: Record<string, string> = {
      import: "#94a3b8",
      "llm-mode": "#7c3aed",
      acp: "#dc2626",
      api: "#0ea5e9",
      data: "#059669",
    };

    chart.setOption({
      animationDuration: 500,
      animationDurationUpdate: 350,
      animationEasingUpdate: "cubicOut",
      legend: {
        top: 0,
        textStyle: { fontSize: 11, color: "#475569" },
        data: Object.entries(TYPE_META).map(([, v]) => v.label),
      },
      tooltip: {
        formatter: (p: { dataType?: string; data?: { name?: string; desc?: string; type?: string } }) => {
          if (p.dataType === "node") {
            const t = p.data?.type ? TYPE_META[p.data.type]?.label ?? p.data.type : "";
            return `<b>${p.data?.name ?? ""}</b><br/>${t}${p.data?.desc ? `<br/><span style="color:#64748b">${p.data.desc.slice(0, 120)}</span>` : ""}`;
          }
          return "";
        },
      },
      series: [
        {
          type: "graph",
          layout: "none", // 手工分层布局：稳定无抖动，可拖拽（roam）
          roam: true,
          draggable: true,
          data: data.nodes.map((n) => ({
            id: n.id,
            name: n.name,
            desc: n.desc,
            type: n.type,
            x: pos.get(n.id)?.[0],
            y: pos.get(n.id)?.[1],
            symbolSize: n.type === "feature" ? 48 : n.type === "core" ? 40 : n.type === "data" ? 32 : 40,
            itemStyle: {
              color: TYPE_META[n.type]?.color ?? "#64748b",
              borderColor: "#fff",
              borderWidth: 2,
              shadowBlur: 10,
              shadowColor: "rgba(100,116,139,0.35)",
            },
            label: { position: n.type === "feature" ? "top" : "right", distance: 8, fontSize: 11, color: "#334155", fontWeight: n.type === "feature" ? 700 : 500 },
          })),
          links: data.edges.map((e) => ({
            source: e.from,
            target: e.to,
            kind: e.kind,
            label: e.label,
            lineStyle: { color: EDGE_COLOR[e.kind] ?? "#94a3b8", width: e.kind === "import" ? 1.2 : 1.6, curveness: 0.18, opacity: 0.85 },
          })),
          edgeSymbol: ["none", "arrow"],
          edgeSymbolSize: 7,
          edgeLabel: {
            show: true,
            fontSize: 9,
            color: "#94a3b8",
            formatter: (p: { data?: { label?: string; kind?: string } }) => p.data?.label ?? (p.data?.kind ? EDGE_KIND_LABEL[p.data.kind] ?? "" : ""),
          },
          emphasis: { focus: "adjacency", lineStyle: { width: 2.4 }, label: { fontSize: 13, fontWeight: 700 } },
          categories: Object.entries(TYPE_META).map(([k, v]) => ({ name: v.label, itemStyle: { color: v.color } })),
        },
      ],
    });
    chart.off("click");
    chart.on("click", (p: echarts.ECElementEvent) => {
      if (p.dataType === "node" && p.data && typeof p.data === "object" && "id" in p.data) {
        const n = data.nodes.find((x) => x.id === (p.data as { id: string }).id);
        if (n) {
          setSelected(n);
          setRelated(data.edges.filter((e) => e.from === n.id || e.to === n.id));
        }
      }
    });
    // 自适应
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [data]);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.2rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
        <h2 style={{ fontSize: "1.1rem", margin: 0 }}>🗺️ 项目架构依赖图</h2>
        <span style={{ fontSize: "0.75rem", color: "#94a3b8" }}>自动扫描源码 import 生成（新增模块即自动更新）</span>
        <span style={{ flex: 1 }} />
        {Object.entries(TYPE_META).map(([k, v]) => (
          <span key={k} style={{ fontSize: "0.72rem", display: "inline-flex", alignItems: "center", gap: "0.3rem", color: "#475569" }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: v.color, display: "inline-block" }} />
            {v.label}
          </span>
        ))}
        <button
          type="button"
          style={{ fontSize: "0.72rem", padding: "0.25rem 0.7rem", borderRadius: 6, border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer" }}
          onClick={() => setReloadKey((k) => k + 1)}
        >
          ⟳ 重新生成
        </button>
      </div>
      <div style={{ fontSize: "0.74rem", color: "#64748b", marginBottom: "0.6rem" }}>
        架构分层：<b>features（业务层）→ core（公共层）→ 外部系统</b>，单向依赖；LLM 三种调用模式（direct / chatSession / reasonix）
        与数据层（SQLite KV/表）以带标签边标注。支持拖拽节点、滚轮缩放、点击节点查看详情与关联。
      </div>
      {err && <div style={{ color: "#b91c1c", fontSize: "0.8rem", marginBottom: "0.5rem" }}>❌ {err}</div>}
      <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap" }}>
        <div ref={chartRef} style={{ flex: 1, minWidth: 620, height: 640, border: "1px solid #e2e8f0", borderRadius: 12, background: "#fff" }} />
        <div style={{ width: 300, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {selected ? (
            <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: "0.8rem", background: "#f8fafc" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: TYPE_META[selected.type]?.color, display: "inline-block" }} />
                <b style={{ fontSize: "0.9rem" }}>{selected.name}</b>
              </div>
              <div style={{ fontSize: "0.72rem", color: TYPE_META[selected.type]?.color, marginTop: "0.2rem" }}>{TYPE_META[selected.type]?.label}</div>
              {selected.desc && <div style={{ fontSize: "0.76rem", color: "#475569", marginTop: "0.4rem", lineHeight: 1.6 }}>{selected.desc}</div>}
              <div style={{ fontSize: "0.72rem", color: "#94a3b8", marginTop: "0.4rem", fontFamily: "monospace" }}>{selected.id}</div>
              <div style={{ marginTop: "0.6rem", fontSize: "0.78rem", fontWeight: 600, color: "#334155" }}>关联（{related.length}）</div>
              <div style={{ maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.25rem", marginTop: "0.3rem" }}>
                {related.map((e, i) => {
                  const isFrom = e.from === selected.id;
                  const other = data?.nodes.find((n) => n.id === (isFrom ? e.to : e.from))?.name ?? (isFrom ? e.to : e.from);
                  return (
                    <div key={i} style={{ fontSize: "0.72rem", color: "#475569", border: "1px solid #e2e8f0", borderRadius: 6, padding: "0.25rem 0.5rem", background: "#fff" }}>
                      {isFrom ? "→" : "←"} {other}
                      <span style={{ color: "#94a3b8", marginLeft: "0.3rem" }}>{e.label ?? EDGE_KIND_LABEL[e.kind] ?? e.kind}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div style={{ border: "1px dashed #cbd5e1", borderRadius: 10, padding: "0.8rem", color: "#94a3b8", fontSize: "0.78rem" }}>
              点击图中任意节点查看：模块说明、类型、关联依赖（入边/出边）。
              <br />
              <br />
              数据源：<code style={{ fontSize: "0.7rem" }}>GET /api/dependency-graph</code>（扫描 src 自动生成）
            </div>
          )}
          {data && (
            <div style={{ fontSize: "0.7rem", color: "#94a3b8" }}>
              {data.nodes.length} 节点 · {data.edges.length} 边 · 生成于 {new Date(data.generatedAt).toLocaleString("zh-CN")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
