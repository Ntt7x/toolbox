// ============================================================
// 共享 UI：Markdown 渲染组件（react-markdown + remark-gfm）
// 用于展示抓取内容等 markdown 文本：标题/列表/表格/代码/引用
// 样式与既有页面配色一致（浅色卡片、蓝链、表格边框斑马纹）
// ============================================================
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ComponentPropsWithoutRef } from "react";

type MdProps = ComponentPropsWithoutRef<typeof ReactMarkdown>;

/** 表格/列表等块级元素共享的浅色容器样式 */
const blockStyle: React.CSSProperties = {
  fontSize: "0.82rem",
  lineHeight: 1.75,
  color: "#334155",
};

const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  margin: "0.5rem 0",
  fontSize: "0.8rem",
};

export function MarkdownView(props: MdProps) {
  return (
    <div style={blockStyle} className="md-view">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h1 style={{ fontSize: "1.15rem", margin: "0.8rem 0 0.4rem", color: "#0f172a" }} {...p} />,
          h2: (p) => <h2 style={{ fontSize: "1.05rem", margin: "0.7rem 0 0.35rem", color: "#0f172a", borderBottom: "1px solid #e2e8f0", paddingBottom: "0.2rem" }} {...p} />,
          h3: (p) => <h3 style={{ fontSize: "0.95rem", margin: "0.6rem 0 0.3rem", color: "#1e293b" }} {...p} />,
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
    </div>
  );
}
