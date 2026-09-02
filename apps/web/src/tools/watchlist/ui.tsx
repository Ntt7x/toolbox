// ============================================================
// 自选股：通用 UI 件（风格对齐「仓位管理 v2」）
// - ConfirmButton：危险操作前的确认模态（删除类操作统一走它，避免误删）
// - SectionTitle：彩色竖条 + 图标小节标题（与仓位管理 v2 同一范式）
// ============================================================

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { C } from "./shared";

/**
 * 带删除确认的按钮：点击后先弹确认框，确认才执行 onConfirm。
 * 用于 tag 删除、标的删除等不可撤销操作。
 */
export function ConfirmButton({
  children,
  title = "确认删除",
  description,
  confirmText = "删除",
  variant = "ghost",
  disabled,
  onConfirm,
}: {
  children: React.ReactNode;
  /** 确认框标题 */
  title?: string;
  /** 确认框说明（应说清影响面：是否连带子级、标的如何处理） */
  description: React.ReactNode;
  confirmText?: string;
  variant?: "ghost" | "outline" | "destructive";
  disabled?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size="sm"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation(); // 不触发所在行的选中
          setOpen(true);
        }}
        className={variant === "ghost" ? "h-6 w-6 p-0 text-slate-400 hover:text-red-600 hover:bg-red-50" : undefined}
        title={typeof children === "string" ? children : title}
      >
        {children}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle style={{ color: C.text }}>{title}</DialogTitle>
            <DialogDescription style={{ color: C.faint, fontSize: "0.86rem", lineHeight: 1.6 }}>
              {description}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              style={{ background: "#dc2626", color: "#fff" }}
              onClick={() => void run()}
            >
              {busy ? "处理中…" : confirmText}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 小节标题（与仓位管理 v2 同款：彩色竖条 + 图标 + 加粗） */
export function SectionTitle({
  icon,
  children,
  color = C.accent,
  extra,
}: {
  icon?: string;
  children: React.ReactNode;
  color?: string;
  extra?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "0.7rem 0 0.4rem" }}>
      <span style={{ width: 4, height: 14, borderRadius: 999, background: color, flexShrink: 0 }} />
      <span style={{ fontSize: "0.9rem", fontWeight: 700, color: C.text }}>
        {icon ? `${icon} ` : ""}
        {children}
      </span>
      <span style={{ flex: 1 }} />
      {extra}
    </div>
  );
}
