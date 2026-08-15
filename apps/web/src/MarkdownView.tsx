// ============================================================
// 共享 UI：Markdown 渲染组件（react-markdown + remark-gfm + remark-math + rehype-katex）
// 用于展示抓取内容等 markdown 文本：标题/列表/表格/代码/引用/数学公式
// 数学公式支持（与 DeepSeek 网页版一致）：
//   - 块级 $$...$$（行首）始终支持
//   - 行内公式：singleDollarTextMath=false（工业界推荐，避免 $5 货币/价格被误判为公式）
//     —— 行内请用 $$x^2$$（双美元，markdown 中即 $x^2$ 无效但不会破坏正文）
//   - 渲染失败：rehype-katex 内置兜底（红字显示原文，不崩页面）；errorColor 自定义
// 阅读增强（memo msuzib4d / msv0h3uv，vscode 风格）：
//   - showToc：左侧 TOC 目录（标题层级，可收起；点击滚动定位 + 当前阅读高亮）
//   - showMinimap：右侧 minimap（参考 vscode：canvas 内容缩略图 + 视口指示 + 点击跳转）
//   - maxWidth：内容区最大宽度（居中阅读）
// 样式与既有页面配色一致（浅色卡片、蓝链、表格边框斑马纹）
// ============================================================
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentPropsWithoutRef } from "react";

type MdProps = ComponentPropsWithoutRef<typeof ReactMarkdown> & {
  fontScale?: number;
  showToc?: boolean;      // 左侧 TOC 目录（vscode outline，可收起）
  showMinimap?: boolean;  // 右侧 minimap（vscode 风格内容缩略图）
  maxWidth?: number;      // 内容区最大宽度（居中阅读，默认 820）
};

/** 表格/列表等块级元素共享的浅色容器样式（fontScale 支持阅读字号调节） */
const blockStyle = (fontScale: number): React.CSSProperties => ({
  fontSize: `${0.82 * fontScale}rem`,
  lineHeight: 1.75,
  color: "#334155",
});

const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  margin: "0.5rem 0",
  fontSize: "0.8rem",
};

/** 从 markdown 源码提取标题（跳过代码块；清理 markdown 符号） */
export function extractToc(src: string): { level: number; text: string }[] {
  const items: { level: number; text: string }[] = [];
  let inCode = false;
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (t.startsWith("```")) { inCode = !inCode; continue; }
    if (inCode) continue;
    const m = line.match(/^(#{1,4})\s+(.+)/);
    if (m) items.push({ level: m[1].length, text: m[2].replace(/[#*_`]/g, "").trim() });
  }
  return items;
}

/** minimap 行色：按 md 源码行类型映射色块（参考 vscode minimap 内容缩略） */
function lineColor(line: string, inCode: boolean): string | null {
  const t = line.trim();
  if (t.startsWith("```")) return "#334155";
  if (inCode) return "#0f172a";
  if (/^#{1,4}\s/.test(line)) return "#3b82f6";
  if (t.startsWith(">")) return "#bfdbfe";
  if (t.startsWith("|")) return "#94a3b8";
  if (t.startsWith("- ") || t.startsWith("* ") || /^\d+\.\s/.test(t)) return "#cbd5e1";
  if (!t) return null;
  return "#e2e8f0";
}

export function MarkdownView({ fontScale = 1, showToc = false, showMinimap = false, maxWidth, ...props }: MdProps) {
  const usePanels = showToc || showMinimap;
  const scrollRef = useRef<HTMLDivElement>(null);
  const mmCanvasRef = useRef<HTMLCanvasElement>(null);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [tocOpen, setTocOpen] = useState(true);   // TOC 可收起（memo msv0h3uv-2）
  const [mmPos, setMmPos] = useState(0);          // minimap 视口位置 0~1

  const toc = useMemo(() => extractToc(String(props.children ?? "")), [props.children]);

  // 渲染后给标题加锚点 id（md-h-{i}），供 TOC 点击定位
  useEffect(() => {
    if (!usePanels) return;
    const root = scrollRef.current;
    if (!root) return;
    const hs = root.querySelectorAll("h1, h2, h3, h4");
    hs.forEach((h, i) => { h.id = "md-h-" + i; });
  }, [props.children, usePanels, fontScale]);

  // 滚动 → 当前阅读标题（顶部 96px 内的最后一个）+ minimap 视口位置
  const onScroll = () => {
    const root = scrollRef.current;
    if (!root) return;
    const hs = root.querySelectorAll("h1, h2, h3, h4");
    let cur = -1;
    for (let i = 0; i < hs.length; i++) {
      if (hs[i].getBoundingClientRect().top <= 96) cur = i;
    }
    setActiveIdx(cur);
    if (root.scrollHeight > root.clientHeight) setMmPos(root.scrollTop / (root.scrollHeight - root.clientHeight));
  };

  const scrollTo = (i: number) => {
    // 直接查标题元素定位（不依赖 id——重渲染后 id 可能丢失）
    const root = scrollRef.current;
    const hs = root?.querySelectorAll("h1, h2, h3, h4");
    hs?.[i]?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveIdx(i);
  };

  // minimap canvas 绘制（md 源码行色条 → 内容缩略，参考 vscode）
  useEffect(() => {
    if (!showMinimap) return;
    const canvas = mmCanvasRef.current;
    const root = scrollRef.current;
    if (!canvas || !root) return;
    const H = Math.max(100, root.clientHeight);
    const W = 56;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const lines = String(props.children ?? "").split("\n");
    if (lines.length === 0) return;
    let inCode = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l.startsWith("```")) { inCode = !inCode; }
      const c = lineColor(lines[i], inCode);
      if (c) {
        const y = (i / lines.length) * H;
        const h = Math.max(1.5, (1 / lines.length) * H);
        ctx.fillStyle = c;
        ctx.fillRect(0, Math.round(y), W, Math.max(1, Math.round(h)));
      }
    }
  }, [props.children, showMinimap, fontScale]);

  // minimap 点击/拖动 → 按比例滚动内容
  const mmJump = (e: React.MouseEvent<HTMLDivElement>) => {
    const root = scrollRef.current;
    if (!root) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    root.scrollTop = ratio * (root.scrollHeight - root.clientHeight);
    setMmPos(ratio);
  };

  const md = (
    <ReactMarkdown
      remarkPlugins={[[remarkMath, { singleDollarTextMath: false }], remarkGfm]}
      rehypePlugins={[[rehypeKatex, { errorColor: "#dc2626" }]]}
      components={{
        h1: (p) => <h1 style={{ fontSize: `${1.15 * fontScale}rem`, margin: "0.8rem 0 0.4rem", color: "#0f172a" }} {...p} />,
        h2: (p) => <h2 style={{ fontSize: `${1.05 * fontScale}rem`, margin: "0.7rem 0 0.35rem", color: "#0f172a", borderBottom: "1px solid #e2e8f0", paddingBottom: "0.2rem" }} {...p} />,
        h3: (p) => <h3 style={{ fontSize: `${0.95 * fontScale}rem`, margin: "0.6rem 0 0.3rem", color: "#1e293b" }} {...p} />,
        h4: (p) => <h4 style={{ fontSize: `${0.88 * fontScale}rem`, margin: "0.5rem 0 0.25rem", color: "#334155" }} {...p} />,
        p: (p) => <p style={{ margin: "0.4rem 0" }} {...p} />,
        ul: (p) => <ul style={{ margin: "0.4rem 0", paddingLeft: "1.3rem" }} {...p} />,
        ol: (p) => <ol style={{ margin: "0.4rem 0", paddingLeft: "1.3rem" }} {...p} />,
        li: (p) => <li style={{ margin: "0.15rem 0" }} {...p} />,
        blockquote: (p) => (
          <blockquote
            style={{ margin: "0.5rem 0", padding: "0.3rem 0.8rem", borderLeft: "3px solid #3b82f6", background: "#f1f5f9", borderRadius: 6, color: "#475569" }}
            {...p}
          />
        ),
        code: (p) => (
          <code style={{ background: "#eef2f7", padding: "0.1rem 0.35rem", borderRadius: 4, fontSize: "0.78em", color: "#be123c" }} {...p} />
        ),
        pre: (p) => (
          <pre
            style={{ background: "#0f172a", color: "#e2e8f0", padding: "0.7rem 0.9rem", borderRadius: 8, overflowX: "auto", fontSize: "0.78rem", lineHeight: 1.6 }}
            {...p}
          />
        ),
        a: (p) => <a style={{ color: "#2563eb" }} target="_blank" rel="noreferrer" {...p} />,
        table: (p) => <table style={tableStyle} {...p} />,
        thead: (p) => <thead style={{ background: "#f1f5f9" }} {...p} />,
        th: (p) => <th style={{ border: "1px solid #e2e8f0", padding: "0.4rem 0.6rem", textAlign: "left", fontWeight: 600, color: "#0f172a" }} {...p} />,
        td: (p) => <td style={{ border: "1px solid #e2e8f0", padding: "0.4rem 0.6rem", verticalAlign: "top" }} {...p} />,
        tr: (p) => <tr style={{ background: "transparent" }} {...p} />,
        hr: (p) => <hr style={{ border: "none", borderTop: "1px solid #e2e8f0", margin: "0.8rem 0" }} {...p} />,
        strong: (p) => <strong style={{ color: "#0f172a" }} {...p} />,
        em: (p) => <em style={{ color: "#475569" }} {...p} />,
      }}
      {...props}
    />
  );

  // 无阅读面板：保持原有简单渲染（父容器负责滚动）
  if (!usePanels) {
    return <div style={blockStyle(fontScale)} className="md-view">{md}</div>;
  }

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, ...blockStyle(fontScale) }} className="md-view">
      {/* 左侧 TOC（vscode outline 风格，可收起） */}
      {showToc && (tocOpen ? (
        <div style={{ width: 200, flexShrink: 0, borderRight: "1px solid #eef2f7", background: "#f8fafc", overflowY: "auto", padding: "0.6rem 0.4rem", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", padding: "0.1rem 0.5rem 0.5rem" }}>
            <span style={{ fontSize: "0.68rem", color: "#94a3b8", fontWeight: 700, flex: 1 }}>目录</span>
            <span
              onClick={() => setTocOpen(false)}
              title="收起目录"
              style={{ fontSize: "0.75rem", color: "#94a3b8", cursor: "pointer", padding: "0.1rem 0.3rem", borderRadius: 4 }}
            >»</span>
          </div>
          {toc.length === 0 && <div style={{ fontSize: "0.75rem", color: "#cbd5e1", padding: "0.3rem 0.5rem" }}>无标题</div>}
          {toc.map((t, i) => (
            <div
              key={i}
              onClick={() => scrollTo(i)}
              title={t.text}
              style={{
                padding: "0.22rem 0.5rem", paddingLeft: `${0.5 + (t.level - 1) * 0.75}rem`, cursor: "pointer", borderRadius: 5,
                fontSize: t.level === 1 ? "0.8rem" : "0.75rem", fontWeight: t.level === 1 ? 600 : 400,
                color: i === activeIdx ? "#2563eb" : "#64748b",
                background: i === activeIdx ? "#eff6ff" : "transparent",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}
            >
              {t.text}
            </div>
          ))}
        </div>
      ) : (
        <div
          onClick={() => setTocOpen(true)}
          title="展开目录"
          style={{ width: 30, flexShrink: 0, borderRight: "1px solid #eef2f7", background: "#f8fafc", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
        >
          <span style={{ writingMode: "vertical-rl", fontSize: "0.72rem", color: "#94a3b8", letterSpacing: "0.15rem" }}>📑 目录</span>
        </div>
      ))}
      {/* 内容区（自身滚动 + 标题锚点） */}
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
        <div style={{ maxWidth: maxWidth ?? 820, margin: "0 auto", padding: "1.25rem 1.5rem 3rem" }}>
          {md}
        </div>
      </div>
      {/* 右侧 minimap（参考 vscode：canvas 内容缩略 + 视口指示 + 点击跳转，memo msv0h3uv-3） */}
      {showMinimap && (
        <div
          onClick={mmJump}
          title="点击/拖动跳转"
          style={{ width: 58, flexShrink: 0, borderLeft: "1px solid #eef2f7", background: "#f8fafc", position: "relative", overflow: "hidden", cursor: "pointer" }}
        >
          <canvas ref={mmCanvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
          {/* 视口指示块 */}
          <div
            style={{ position: "absolute", left: 0, right: 0, top: `${mmPos * 100}%`, height: `${Math.max(4, 100 * (1 / 3))}%`, background: "rgba(37,99,235,0.14)", borderTop: "1px solid rgba(37,99,235,0.45)", borderBottom: "1px solid rgba(37,99,235,0.45)", pointerEvents: "none" }}
          />
        </div>
      )}
    </div>
  );
}
