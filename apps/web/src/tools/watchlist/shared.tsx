// ============================================================
// 自选股：页面内共用层（配色 / 格式化 / 小组件）
// 抽取目的：四个功能面 Tab 复用同一套视觉与工具函数，避免 1500 行单文件难维护。
// ============================================================

import type { CSSProperties, ReactNode } from "react";
import type { WatchDataMeta } from "@toolbox/shared";

/** 页面配色（与仓位管理 v2 同系；A 股红涨绿跌） */
export const C = {
  text: "#1e293b",
  faint: "#64748b",
  faintest: "#94a3b8",
  gain: "#dc2626",
  gainBg: "#fef2f2",
  loss: "#16a34a",
  lossBg: "#f0fdf4",
  flat: "#334155",
  accent: "#2563eb",
  accentBg: "#eff6ff",
  accentBorder: "#bfdbfe",
  warn: "#d97706",
  warnBg: "#fffbeb",
  border: "#e2e8f0",
  bg: "#f8fafc",
};

/** 基础按钮 */
export const btn: CSSProperties = {
  padding: "0.5rem 1.1rem",
  borderRadius: 8,
  border: "none",
  background: "#3b82f6",
  color: "#fff",
  fontSize: "0.9rem",
  fontWeight: 600,
  cursor: "pointer",
};

export const btnSmall: CSSProperties = { ...btn, padding: "0.3rem 0.8rem", fontSize: "0.8rem" };
export const btnGhost: CSSProperties = { ...btnSmall, background: "transparent", color: "#dc2626", border: "1px solid #fca5a5" };

export const input: CSSProperties = {
  padding: "0.5rem 0.7rem",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  fontSize: "0.9rem",
  outline: "none",
  minWidth: 0,
};

export const table: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" };
export const thTd: CSSProperties = { border: "1px solid #e2e8f0", padding: "0.45rem 0.5rem", textAlign: "center", verticalAlign: "top" };
export const th: CSSProperties = { ...thTd, background: "#f1f5f9", fontWeight: 600 };

/** 涨跌幅着色（A 股：红涨绿跌） */
export function pctColor(v: number | undefined): string {
  if (typeof v !== "number" || Number.isNaN(v)) return C.faintest;
  if (v > 0) return C.gain;
  if (v < 0) return C.loss;
  return C.flat;
}

/** 涨跌幅文本（带符号、两位小数） */
export function fmtPct(v: number | undefined, digits = 2): string {
  if (typeof v !== "number" || Number.isNaN(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

/** 价格文本（缺失返回 —） */
export function fmtPrice(v: number | undefined, digits = 3): string {
  if (typeof v !== "number" || Number.isNaN(v)) return "—";
  return v.toFixed(digits).replace(/\.?0+$/, "");
}

/** 数字文本（缺失返回 —） */
export function fmtNum(v: number | undefined, digits = 2): string {
  if (typeof v !== "number" || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

/**
 * 雪球外链 URL（与「仓位管理 v2」共用同一套转换逻辑：A/H 股市场前缀转换；
 * 北交所/未知代码回退到雪球搜索，避免跳到错误页）。
 * - 已带市场前缀（SH/SZ/BJ/HK + 数字）→ 原样
 * - 6 位纯数字：5/6 开头→SH（沪市 A/ETF），0/1/3→SZ（深市 A/ETF），4/8/9→BJ（北交所）
 * - 3~5 位（或 0 前缀 4 位）→ 港股裸码（雪球 /S/00189 不带 HK 前缀）
 */
export function xueqiuUrl(code: string): string {
  const c = code.trim().toUpperCase();
  if (/^(SH|SZ|BJ)\d+/.test(c)) return `https://xueqiu.com/S/${c}`;
  if (/^HK\d+/.test(c)) return `https://xueqiu.com/S/${c.slice(2)}`; // 港股雪球 URL 不带 HK 前缀
  if (/^\d{6}$/.test(c)) {
    if (/^[56]\d{5}$/.test(c)) return `https://xueqiu.com/S/SH${c}`; // 沪市 A 股（6 开头）/ 沪市 ETF（5 开头）
    if (/^[013]\d{5}$/.test(c)) return `https://xueqiu.com/S/SZ${c}`; // 深市 A 股/ETF（0/1/3 开头）
    if (/^[489]\d{5}$/.test(c)) return `https://xueqiu.com/S/BJ${c}`; // 北交所（4/8/9 开头）
  }
  if (/^\d{3,5}$|^0\d{4}$/.test(c)) return `https://xueqiu.com/S/${c}`; // 港股裸码
  return `https://xueqiu.com/k?q=${encodeURIComponent(code)}`; // 未知 → 雪球搜索兜底
}

/** 标的详情页跳转：场外基金 → 天天基金；股票/ETF → 雪球（复用 xueqiuUrl） */
export function stockDetailUrl(code: string, kind?: string): string {
  if (kind === "fund") return `https://fund.eastmoney.com/${code}.html`;
  return xueqiuUrl(code);
}

/** 区块小标题 */
export function SectionTitle({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", margin: "1rem 0 0.5rem", flexWrap: "wrap" }}>
      <span style={{ fontWeight: 700, fontSize: "0.92rem", color: C.text }}>{children}</span>
      <span style={{ flex: 1 }} />
      {extra}
    </div>
  );
}

/** 空态占位 */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div style={{ color: C.faintest, fontSize: "0.85rem", padding: "1.2rem 0", textAlign: "center" }}>{children}</div>
  );
}

/** 加载态占位 */
export function Loading({ text = "加载中…" }: { text?: string }) {
  return <div style={{ color: C.faint, fontSize: "0.85rem", padding: "0.8rem 0" }}>{text}</div>;
}

/**
 * 数据链路元信息条（血缘 + 质量标注）：数据源 / 缓存 / 降级 / 提取时间。
 * 缺失即标注（dev.md §数据工程·质量）——不让用户把「无数据」误读为「数据为零」。
 */
export function MetaBar({ meta }: { meta?: WatchDataMeta }) {
  if (!meta) return null;
  const items: ReactNode[] = [];
  if (meta.sources.length > 0) items.push(<span key="s" title="数据来源（数据链路血缘）">🔗 {meta.sources.join(" / ")}</span>);
  if (meta.fromCache) items.push(<span key="c">💾 缓存</span>);
  if (meta.degraded) items.push(<span key="d" style={{ color: C.warn }}>⚠️ 部分降级</span>);
  if (meta.fetchedAt) {
    items.push(<span key="t">{new Date(meta.fetchedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>);
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.7rem", alignItems: "center", fontSize: "0.72rem", color: C.faintest, margin: "0.4rem 0 0.6rem" }}>
      {items.map((it, i) => <span key={i}>{it}</span>)}
    </div>
  );
}

/** 数据缺失/受限提示（caveats 逐条展示） */
export function Caveats({ meta }: { meta?: WatchDataMeta }) {
  if (!meta?.caveats?.length) return null;
  return (
    <div style={{ background: C.warnBg, border: "1px solid #fde68a", borderRadius: 8, padding: "0.5rem 0.7rem", marginBottom: "0.6rem", fontSize: "0.78rem", color: "#92400e" }}>
      {meta.caveats.map((c, i) => (
        <div key={i}>⚠️ {c}</div>
      ))}
    </div>
  );
}

/** 横向分段切换器（分组切换 / 周期切换 / 子 Tab 共用） */
export function SegTabs<T extends string>({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: T;
  options: { value: T; label: string; badge?: number; title?: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  const pad = size === "sm" ? "0.28rem 0.7rem" : "0.4rem 0.95rem";
  return (
    <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            title={o.title}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            style={{
              padding: pad,
              borderRadius: 999,
              border: active ? `1px solid ${C.accentBorder}` : "1px solid transparent",
              background: active ? C.accentBg : "transparent",
              color: active ? C.accent : C.faint,
              fontSize: size === "sm" ? "0.78rem" : "0.85rem",
              fontWeight: active ? 700 : 500,
              cursor: o.disabled ? "not-allowed" : "pointer",
              opacity: o.disabled ? 0.4 : 1,
              whiteSpace: "nowrap",
              display: "flex",
              alignItems: "center",
              gap: "0.3rem",
            }}
          >
            {o.label}
            {typeof o.badge === "number" && o.badge > 0 ? (
              <span style={{ background: C.gain, color: "#fff", borderRadius: 999, padding: "0 0.35rem", fontSize: "0.68rem", fontWeight: 700 }}>{o.badge}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** 标的选择条（四 Tab 共用：横向切换当前操作的标的） */
export function ItemPicker({
  items,
  value,
  onChange,
}: {
  items: { code: string; name?: string; badge?: string; badgeColor?: string }[];
  value: string;
  onChange: (code: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: "0.35rem", overflowX: "auto", paddingBottom: "0.3rem", marginBottom: "0.3rem" }}>
      {items.map((it) => {
        const active = it.code === value;
        return (
          <button
            key={it.code}
            type="button"
            onClick={() => onChange(it.code)}
            style={{
              padding: "0.3rem 0.75rem",
              borderRadius: 8,
              border: active ? `1px solid ${C.accent}` : `1px solid ${C.border}`,
              background: active ? C.accentBg : "#fff",
              color: active ? C.accent : C.text,
              fontSize: "0.8rem",
              fontWeight: active ? 700 : 500,
              cursor: "pointer",
              whiteSpace: "nowrap",
              display: "flex",
              alignItems: "center",
              gap: "0.3rem",
            }}
          >
            {it.name || it.code}
            {it.badge ? <span style={{ color: it.badgeColor ?? C.faintest, fontSize: "0.72rem" }}>{it.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
