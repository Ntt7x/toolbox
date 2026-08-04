import { Link } from "react-router-dom";
import type { ToolMeta } from "@toolbox/shared";

interface ToolPlaceholderProps {
  /** 工具元信息；null 表示未找到该页面 */
  tool: ToolMeta | null;
}

export default function ToolPlaceholder({ tool }: ToolPlaceholderProps) {
  if (!tool) {
    return (
      <section>
        <h1 style={{ marginTop: 0 }}>404</h1>
        <p>页面不存在。</p>
        <Link to="/">← 返回工作台</Link>
      </section>
    );
  }

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>🧰 {tool.name}</h1>
      <p style={{ color: "#666" }}>{tool.description}</p>
      <div
        style={{
          marginTop: "1.5rem",
          padding: "2rem",
          background: "#fff",
          border: "1px dashed #cbd5e1",
          borderRadius: 10,
          textAlign: "center",
          color: "#94a3b8",
        }}
      >
        功能开发中…（路由 {tool.path}）
      </div>
      <p style={{ marginTop: "1.5rem" }}>
        <Link to="/">← 返回工作台</Link>
      </p>
    </section>
  );
}
