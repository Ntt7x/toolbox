// ============================================================
// 轻量 Modal 组件（统一风格弹层，替代原生 prompt/confirm）
// - 遮罩 + 居中卡片 + 标题/内容/底部按钮
// - 点击遮罩或关闭按钮触发 onClose；Esc 键关闭
// ============================================================
import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";

interface ModalProps {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  onClose?: () => void;
}

export default function Modal({ open, title, children, footer, width = 480, onClose }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const maskStyle: CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(15, 23, 42, 0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: "1rem",
  };
  const boxStyle: CSSProperties = {
    background: "#fff",
    borderRadius: 14,
    boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
    width: "100%",
    maxWidth: width,
    maxHeight: "85vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  };

  return (
    <div style={maskStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div style={boxStyle} role="dialog" aria-modal="true">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.9rem 1.2rem", borderBottom: "1px solid #eef2f7" }}>
          <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "#1e293b" }}>{title}</div>
          <button
            onClick={onClose}
            style={{ border: "none", background: "none", fontSize: "1.1rem", cursor: "pointer", color: "#94a3b8", lineHeight: 1, padding: "0.2rem 0.4rem" }}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <div style={{ padding: "1rem 1.2rem", overflowY: "auto", color: "#334155", fontSize: "0.88rem", lineHeight: 1.7 }}>{children}</div>
        {footer && <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.6rem", padding: "0.8rem 1.2rem", borderTop: "1px solid #eef2f7" }}>{footer}</div>}
      </div>
    </div>
  );
}
