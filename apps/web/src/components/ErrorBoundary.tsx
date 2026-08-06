// ============================================================
// 通用组件：错误边界（页面渲染崩溃时显示错误而非白屏）
// 包在页面/工具外层，运行时异常可被捕获并展示定位信息
// ============================================================
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** 错误提示标题（默认「页面渲染异常」） */
  title?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // 输出到控制台，便于开发者定位
    console.error("[ErrorBoundary]", error);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          background: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: 12,
          padding: "1.25rem 1.5rem",
          marginBottom: "1rem",
          color: "#b91c1c",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: "0.4rem" }}>⚠️ {this.props.title ?? "页面渲染异常"}</div>
        <div style={{ fontSize: "0.85rem", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "monospace" }}>
          {this.state.error.message}
        </div>
        <div style={{ fontSize: "0.78rem", color: "#7f1d1d", marginTop: "0.5rem", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {this.state.error.stack?.split("\n").slice(0, 6).join("\n")}
        </div>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          style={{ marginTop: "0.7rem", padding: "0.35rem 0.9rem", background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer" }}
        >
          ↻ 重试渲染
        </button>
      </div>
    );
  }
}
