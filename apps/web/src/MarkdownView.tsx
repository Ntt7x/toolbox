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
//   - maxWidth：内容区最大宽度（居中阅读）
// 注：minimap 已按用户要求移除（设计见 docs/design/reading-minimap.md，暂缓规划 2026-08-16）
// 样式与既有页面配色一致（浅色卡片、蓝链、表格边框斑马纹）
// ============================================================
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentPropsWithoutRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";

type MdProps = ComponentPropsWithoutRef<typeof ReactMarkdown> & {
  fontScale?: number;
  showToc?: boolean;      // 左侧 TOC 目录（vscode outline，可收起）
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

export function MarkdownView({ fontScale = 1, showToc = false, maxWidth, ...props }: MdProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [tocOpen, setTocOpen] = useState(true);   // TOC 可收起（memo msv0h3uv-2）
  const jumpAt = useRef(0);                       // 点击跳转时间戳（onScroll 短暂不覆盖高亮）

  const toc = useMemo(() => extractToc(String(props.children ?? "")), [props.children]);
  const [tocCollapsed, setTocCollapsed] = useState<Set<number>>(new Set());  // 一级标题折叠（memo msvp46y5）
  // 每个一级标题的子标题区间（[start, end) 不含一级本身）
  const tocGroups = useMemo(() => {
    const gs: { level1Idx: number; start: number; end: number }[] = [];
    let cur: { level1Idx: number; start: number; end: number } | null = null;
    toc.forEach((t, i) => {
      if (t.level === 1) {
        if (cur) { cur.end = i; gs.push(cur); }
        cur = { level1Idx: i, start: i + 1, end: toc.length };
      }
    });
    if (cur) gs.push(cur);
    return gs;
  }, [toc]);
  const isTocHidden = (i: number) => tocGroups.some((g) => g.level1Idx !== i && g.start <= i && i < g.end && tocCollapsed.has(g.level1Idx));
  const toggleTocGroup = (level1Idx: number) => setTocCollapsed((p) => { const n = new Set(p); if (n.has(level1Idx)) n.delete(level1Idx); else n.add(level1Idx); return n; });

  // 渲染后给标题加锚点 id（md-h-{i}），供 TOC 点击定位
  useEffect(() => {
    if (!showToc) return;
    const root = scrollRef.current;
    if (!root) return;
    const hs = root.querySelectorAll("h1, h2, h3, h4");
    hs.forEach((h, i) => { h.id = "md-h-" + i; });
  }, [props.children, showToc, fontScale]);

  // 滚动 → 当前阅读标题（相对内容区顶部：标题滚到内容区视口顶部 44px 内即当前项）
  // 修复（memo 目录严重 bug）：此前用视口绝对坐标 top<=96，但内容区在页面中部（y≈350），
  // 标题永远到不了视口 96px → 高亮滞后/错位/消失。
  const onScroll = () => {
    // 点击跳转后 600ms 内不覆盖高亮（避免 smooth/滚动途中把点击项覆盖成中间标题）
    if (Date.now() - jumpAt.current < 600) return;
    const root = scrollRef.current;
    if (!root) return;
    const hs = root.querySelectorAll("h1, h2, h3, h4");
    const top = root.getBoundingClientRect().top;
    let cur = -1;
    for (let i = 0; i < hs.length; i++) {
      if (hs[i].getBoundingClientRect().top - top <= 80) cur = i;
    }
    setActiveIdx(cur);
  };

  const scrollTo = (i: number) => {
    // 瞬间跳转（auto）+ 标记时间戳——点击目标明确，高亮锁定该项（memo 目录严重 bug 修复）
    jumpAt.current = Date.now();
    const root = scrollRef.current;
    const hs = root?.querySelectorAll("h1, h2, h3, h4");
    hs?.[i]?.scrollIntoView({ block: "start" });
    setActiveIdx(i);
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

  // 无 TOC：保持原有简单渲染（父容器负责滚动）
  if (!showToc) {
    return <div style={blockStyle(fontScale)} className="md-view">{md}</div>;
  }

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, ...blockStyle(fontScale) }} className="md-view">
      {/* 左侧 TOC（vscode outline 风格，可收起；滚动容器用 shadcn ScrollArea——memo 文本重叠修复） */}
      {tocOpen ? (
        <div style={{ width: 200, flexShrink: 0, borderRight: "1px solid #eef2f7", background: "#f8fafc", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", padding: "0.6rem 0.5rem 0.3rem", flexShrink: 0 }}>
            <span style={{ fontSize: "0.68rem", color: "#94a3b8", fontWeight: 700, flex: 1 }}>目录</span>
            <span
              onClick={() => setTocOpen(false)}
              title="收起目录"
              style={{ fontSize: "0.75rem", color: "#94a3b8", cursor: "pointer", padding: "0.1rem 0.3rem", borderRadius: 4 }}
            >»</span>
          </div>
          <ScrollArea style={{ flex: 1, minHeight: 0 }}>
            {toc.length === 0 && <div style={{ fontSize: "0.75rem", color: "#cbd5e1", padding: "0.3rem 0.5rem" }}>无标题</div>}
            {toc.map((t, i) => {
              if (isTocHidden(i)) return null;
              const isL1 = t.level === 1;
              const hasSub = tocGroups.some((g) => g.level1Idx === i && g.start < g.end);
              const collapsedHere = isL1 && tocCollapsed.has(i);
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                  {isL1 && hasSub ? (
                    <span
                      onClick={(e) => { e.stopPropagation(); toggleTocGroup(i); }}
                      title={collapsedHere ? "展开" : "收起"}
                      style={{ fontSize: "0.55rem", color: "#94a3b8", width: 12, textAlign: "center", cursor: "pointer", flexShrink: 0 }}
                    >{collapsedHere ? "▶" : "▼"}</span>
                  ) : (
                    <span style={{ width: 12, flexShrink: 0 }} />
                  )}
                  <div
                    onClick={() => scrollTo(i)}
                    title={t.text}
                    style={{
                      flex: 1, padding: "0.22rem 0.3rem", paddingLeft: `${(t.level - 1) * 0.75}rem`, cursor: "pointer", borderRadius: 5,
                      fontSize: isL1 ? "0.8rem" : "0.75rem", fontWeight: isL1 ? 600 : 400,
                      color: i === activeIdx ? "#2563eb" : "#64748b",
                      background: i === activeIdx ? "#eff6ff" : "transparent",
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}
                  >
                    {t.text}
                  </div>
                </div>
              );
            })}
          </ScrollArea>
        </div>
      ) : (
        <div
          onClick={() => setTocOpen(true)}
          title="展开目录"
          style={{ width: 30, flexShrink: 0, borderRight: "1px solid #eef2f7", background: "#f8fafc", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
        >
          <span style={{ writingMode: "vertical-rl", fontSize: "0.72rem", color: "#94a3b8", letterSpacing: "0.15rem" }}>📑 目录</span>
        </div>
      )}
      {/* 内容区（自身滚动 + 标题锚点） */}
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
        <div style={{ maxWidth: maxWidth ?? 820, margin: "0 auto", padding: "1.25rem 1.5rem 3rem" }}>
          {md}
        </div>
      </div>
    </div>
  );
}
