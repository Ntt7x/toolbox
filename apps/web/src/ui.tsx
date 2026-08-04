// ============================================================
// 共享 UI 基础件：页头 / 错误卡 / 代码块 / 卡片容器
// 各页面通用结构统一于此，减少重复；样式保持与既有页面一致。
// ============================================================

import type { CSSProperties, ReactNode } from "react";

/** 白色圆角卡片容器（页面主要区块） */
export const card: CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.25rem 1.5rem",
  marginBottom: "1rem",
};

/** 页面标题 + 描述（灰色小字） */
export function PageHeader({ title, desc }: { title: ReactNode; desc?: ReactNode }) {
  return (
    <>
      <h1 style={{ marginTop: 0 }}>{title}</h1>
      {desc !== undefined && desc !== null && <p style={{ color: "#666", marginTop: "-0.4rem" }}>{desc}</p>}
    </>
  );
}

/** 红色错误提示卡 */
export function ErrorCard({ children }: { children: ReactNode }) {
  return (
    <div style={{ ...card, borderColor: "#fca5a5", background: "#fef2f2", color: "#b91c1c" }}>
      {children}
    </div>
  );
}

/** 深色等宽代码/文本块（计划全文、原始输出等） */
export function CodeBlock({ children, maxHeight = "32rem" }: { children: ReactNode; maxHeight?: string }) {
  return (
    <pre
      style={{
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        background: "#0f172a",
        color: "#e2e8f0",
        padding: "1rem 1.25rem",
        borderRadius: 10,
        fontSize: "0.85rem",
        lineHeight: 1.7,
        maxHeight,
        overflowY: "auto",
      }}
    >
      {children}
    </pre>
  );
}
