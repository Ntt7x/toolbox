// ============================================================
// 仓位管理 v2（tools/trade-v2）—— 交易员视角体验版
// 布局：全横向 Tab（分组行 + 功能区行）；名称优先（代码辅助）；统计分组盒；友好配色
// 数据：逐笔交易账本（增量）→ 仓位明细（存量，自动归并派生）→ 分组约束 → 收益分析
// 每日工作流：💼 交易单 批量录入（Enter 流式跳转/复制上日/价格预填）→ 提交 → 仓位自动重算
// ============================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import type {
  TradeV2Alert,
  TradeV2CheckResult,
  TradeV2DailyPoint,
  TradeV2DayOrderSummary,
  TradeV2Deal,
  TradeV2Entry,
  TradeV2EntryDraft,
  TradeV2GlobalAnalysis,
  TradeV2Group,
  TradeV2GroupAnalysis,
  TradeV2GroupSummary,
  TradeV2MonthlyPoint,
  TradeV2PnlAttribution,
  TradeV2Position,
} from "@toolbox/shared";
import { api, errMsg } from "../api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";

// ---------- 配色（友好可读） ----------

// 调色板对齐 V1（策略仓位管理）审美：slate 灰系 + blue/indigo/emerald/red 柔和 tint 卡片
const C = {
  gain: "#dc2626",       // 盈利 · red-600（A股红涨）
  gainBg: "#fef2f2",     // red-50
  gainBorder: "#fee2e2", // red-100
  loss: "#059669",       // 亏损 · emerald-600（A股绿跌）
  lossBg: "#ecfdf5",     // emerald-50
  lossBorder: "#d1fae5", // emerald-100
  accent: "#2563eb",     // blue-600
  accentBg: "#eff6ff",   // blue-50
  accentBorder: "#dbeafe", // blue-100
  indigo: "#4f46e5",
  indigoBg: "#eef2ff",
  amber: "#d97706",
  amberBg: "#fffbeb",
  text: "#1e293b",       // slate-800（主文字）
  sub: "#64748b",        // slate-500
  muted: "#94a3b8",      // slate-400
  faint: "#cbd5e1",      // slate-300
  border: "#e2e8f0",     // slate-200
  panel: "#f8fafc",      // slate-50
};

/** V1 风格小节标题：彩色竖条 + 图标 + 加粗文字 */
function SectionTitle({ icon, children, color = C.accent }: { icon?: string; children: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
      <span style={{ width: 4, height: 14, borderRadius: 999, background: color, flexShrink: 0 }} />
      <span style={{ fontSize: "0.88rem", fontWeight: 700, color: C.text }}>{icon} {children}</span>
    </div>
  );
}

/** 盈亏着色 */
const pnlColor = (v: number | undefined | null): string => {
  if (typeof v !== "number" || !isFinite(v) || v === 0) return C.sub;
  return v > 0 ? C.gain : C.loss;
};
/** 盈亏文本：▲/▼ + 金额（红涨绿跌；undefined/非数 → —；0 → ¥0.00 表示确为零） */
const pnlText = (v: number | undefined | null): string => {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  if (v === 0) return "¥0.00";
  const a = Math.abs(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v > 0 ? `▲ ¥${a}` : `▼ ¥${a}`;
};
const alertColor: Record<TradeV2Alert["level"], string> = { error: C.gain, warn: "#d97706", info: C.accent };
const alertBg: Record<TradeV2Alert["level"], string> = { error: C.gainBg, warn: "#fffbeb", info: C.accentBg };

// ---------- 格式化 ----------

const cny = (v: number | undefined | null) => (typeof v === "number" && isFinite(v) ? `¥${Math.round(v).toLocaleString("zh-CN")}` : "—");
const cny2 = (v: number | undefined | null) => {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}¥${Math.abs(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const pct = (v: number | undefined | null, digits = 1) => (typeof v === "number" && isFinite(v) ? `${v.toFixed(digits)}%` : "—");
const pctSigned = (v: number | undefined | null, digits = 1) => (typeof v === "number" && isFinite(v) ? (v > 0 ? "+" : "") + `${v.toFixed(digits)}%` : "—");
const qtyFmt = (v: number) => v.toLocaleString("zh-CN");
const costFmt = (v?: number) => (typeof v === "number" && !isNaN(v) ? String(+v.toFixed(6)) : "—");

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** 默认下一个交易日（周六/周日 → 下周一） */
function nextTradingDay(): string {
  const n = new Date();
  const d = n.getDay();
  if (d === 0) n.setDate(n.getDate() + 1);
  else if (d === 6) n.setDate(n.getDate() + 2);
  return localDateStr(n);
}
const numInput = (v: string) => Number(v.replace(/[,，\s]/g, "")) || 0;

/** 导出 CSV（UTF-8 BOM，Excel 中文兼容） */
function downloadCSV(filename: string, headers: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    // 含逗号/引号/换行时加引号包裹（CSV 规范）
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = "\uFEFF" + [headers.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 名称优先展示（名称加粗 + 代码辅助灰字）——交易员可读性 */
function NameCode({ name, code, size = "0.85rem" }: { name?: string; code: string; size?: string }) {
  // 港股代码标识（3~5 位数字或 0 前缀；与 A 股 6 位代码区分，避免 00189 vs 000831 混淆）
  const isHk = /^(\d{3,5}|0\d{4})$/.test(code) && !/^\d{6}$/.test(code);
  return (
    <span className="whitespace-nowrap">
      <span style={{ fontWeight: 600, fontSize: size }}>{name ?? code}</span>
      {isHk && <span style={{ marginLeft: 4, padding: "0 3px", borderRadius: 4, background: "#eef2ff", color: "#4f46e5", fontSize: "0.68rem", fontWeight: 600 }}>HK</span>}
      {name ? <span style={{ color: C.muted, marginLeft: 4, fontSize: "0.75rem" }}>{code}</span> : null}
    </span>
  );
}

// ---------- ECharts 容器 ----------

function EChart({ option, height = 280, style }: { option: echarts.EChartsOption; height?: number; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el);
    chart.setOption(option);
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [option]);
  return <div ref={ref} style={{ width: "100%", height, ...style }} />;
}

// ---------- 标的搜索输入 ----------

function StockSearchInput({ value, onPick, placeholder = "输入代码或名称", inputRef, onEnter }: {
  value: { code: string; name?: string };
  onPick: (v: { code: string; name?: string }) => void;
  placeholder?: string;
  inputRef?: (el: HTMLInputElement | null) => void;
  onEnter?: () => void;
}) {
  const [text, setText] = useState(value.code);
  const [sugs, setSugs] = useState<{ code: string; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setText(value.code);
  }, [value.code]);

  const pick = (s: { code: string; name: string }) => {
    onPick({ code: s.code, name: s.name });
    setText(s.code);
    setOpen(false);
    setActive(-1);
  };

  const search = (q: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setSugs([]);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const r = await api.watchlistSearchStock(q.trim(), 8);
        setSugs(r.items.map((i) => ({ code: i.code, name: i.name })));
        setActive(0);
        setOpen(true);
      } catch {
        setSugs([]);
      }
    }, 300);
  };

  // 键盘导航：↑↓ 选择建议，Enter 确认（无建议时交给行内 Enter 跳格），Esc 关闭 */
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) { if (sugs.length > 0) setOpen(true); return; }
      setActive((i) => (i + 1) % Math.max(1, sugs.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? sugs.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && sugs.length > 0 && active >= 0) pick(sugs[active]!);
      else onEnter?.();
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div style={{ position: "relative" }}>
      <Input
        ref={inputRef}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          setOpen(false);
          onPick({ code: v });
          search(v);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        onFocus={() => { if (sugs.length > 0) setOpen(true); }}
        onKeyDown={onKeyDown}
        className="h-8"
      />
      {value.name && <div style={{ position: "absolute", right: 8, top: 7, fontSize: "0.72rem", color: C.sub, pointerEvents: "none" }}>{value.name}</div>}
      {open && sugs.length > 0 && (
        <div style={{ position: "absolute", zIndex: 30, top: "100%", left: 0, right: 0, marginTop: 4, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 6px 20px rgba(15,23,42,.12)", maxHeight: 220, overflowY: "auto" }}>
          {sugs.map((s, i) => (
            <div
              key={s.code}
              style={{ padding: "0.5rem 0.7rem", cursor: "pointer", fontSize: "0.85rem", display: "flex", justifyContent: "space-between", gap: 8, background: i === active ? C.accentBg : undefined }}
              onMouseDown={() => pick(s)}
              onMouseEnter={() => setActive(i)}
            >
              <span>{s.name}</span>
              <span style={{ color: C.muted, fontSize: "0.75rem" }}>{s.code}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- 交易编辑器弹窗 ----------

function EntryEditor({ open, onClose, groups, initial, onSaved }: {
  open: boolean;
  onClose: () => void;
  groups: TradeV2GroupSummary[];
  initial: TradeV2Entry | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<TradeV2EntryDraft>(() => ({
    groupId: groups[0]?.id ?? "",
    date: nextTradingDay(),
    code: "",
    action: "buy",
    quantity: 0,
    price: 0,
  }));
  const [stock, setStock] = useState<{ code: string; name?: string }>({ code: "" });
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<TradeV2CheckResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setDraft({
        groupId: initial.groupId,
        date: initial.date,
        code: initial.code,
        name: initial.name,
        action: initial.action,
        quantity: initial.quantity,
        price: initial.price,
        fee: initial.fee,
        initial: initial.initial,
        note: initial.note,
      });
      setStock({ code: initial.code, name: initial.name });
    } else {
      setDraft({ groupId: groups[0]?.id ?? "", date: nextTradingDay(), code: "", action: "buy", quantity: 0, price: 0 });
      setStock({ code: "" });
    }
    setResult(null);
    setMsg(null);
  }, [open, initial, groups]);

  const set = <K extends keyof TradeV2EntryDraft>(k: K, v: TradeV2EntryDraft[K]) => setDraft((p) => ({ ...p, [k]: v }));

  const doCheck = async () => {
    if (!draft.code.trim() || draft.quantity <= 0 || draft.price <= 0) {
      setMsg("请先填写代码、数量与价格");
      return;
    }
    setChecking(true);
    setMsg(null);
    try {
      const r = await api.tradeV2CheckEntry({ ...draft, code: stock.code.trim(), name: stock.name || draft.name });
      setResult(r.result ?? null);
    } catch (e) {
      setMsg("❌ " + errMsg(e));
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    if (!draft.groupId) { setMsg("请选择所属分组"); return; }
    if (!stock.code.trim()) { setMsg("请填写标的代码"); return; }
    if (!draft.quantity || draft.quantity <= 0) { setMsg("数量必须为正整数"); return; }
    if (!draft.price || draft.price <= 0) { setMsg("价格必须大于 0"); return; }
    setSaving(true);
    setMsg(null);
    try {
      const payload: TradeV2EntryDraft = { ...draft, code: stock.code.trim(), name: stock.name || draft.name };
      if (initial) await api.tradeV2UpdateEntry(initial.id, payload);
      else await api.tradeV2CreateEntry(payload);
      onSaved();
      onClose();
    } catch (e) {
      setMsg("❌ " + errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v: boolean) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? "编辑交易" : "记一笔交易"}</DialogTitle>
          <DialogDescription>一笔交易进入账本后，仓位/盈亏/复盘全部自动重算（单一数据源）。</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">所属分组</label>
            <Select value={draft.groupId} onValueChange={(v: string | null) => set("groupId", v ?? "")}>
              <SelectTrigger className="w-full"><SelectValue placeholder="选择分组" /></SelectTrigger>
              <SelectContent>
                {groups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">成交日期</label>
            <Input type="date" className="h-8" value={draft.date} onChange={(e) => set("date", e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">标的（搜索补全名称）</label>
            <StockSearchInput value={stock} onPick={(v) => { setStock(v); set("code", v.code); set("name", v.name); }} />
          </div>
          <div>
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">操作</label>
            <Select value={draft.action} onValueChange={(v: string | null) => set("action", (v ?? "buy") as "buy" | "sell")}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="buy">买入</SelectItem>
                <SelectItem value="sell">卖出</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">数量（股）</label>
            <Input type="number" min={0} step={1} className="h-8" value={draft.quantity || ""} placeholder="如 100" onChange={(e) => set("quantity", numInput(e.target.value))} />
          </div>
          <div>
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">成交价（元）</label>
            <Input type="number" min={0} step={0.01} className="h-8" value={draft.price || ""} placeholder="如 10.50" onChange={(e) => set("price", Number(e.target.value) || 0)} />
          </div>
          <div>
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">手续费（可选）</label>
            <Input type="number" min={0} step={0.01} className="h-8" value={draft.fee ?? ""} placeholder="0" onChange={(e) => set("fee", e.target.value === "" ? undefined : Number(e.target.value) || 0)} />
          </div>
          <div className="col-span-2">
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">备注（可选）</label>
            <Input className="h-8" value={draft.note ?? ""} placeholder="交易理由/复盘备注" onChange={(e) => set("note", e.target.value)} />
          </div>
          <div className="col-span-2 flex items-center gap-2">
            <Switch checked={!!draft.initial} onCheckedChange={(v: boolean) => set("initial", v)} />
            <span className="text-sm text-slate-600">期初建仓（存量起点：仅作仓位基准，不参与限额校验）</span>
          </div>
        </div>

        {result && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 180, overflowY: "auto" }}>
            {result.alerts.map((a, i) => (
              <div key={i} style={{ background: alertBg[a.level], color: alertColor[a.level], padding: "0.4rem 0.6rem", borderRadius: 8, fontSize: "0.8rem" }}>
                <b>{a.level === "error" ? "✖" : a.level === "warn" ? "⚠" : "ℹ"} {a.message}</b>
                {a.detail ? <span style={{ display: "block", marginTop: 2 }}>{a.detail}</span> : null}
              </div>
            ))}
          </div>
        )}
        {msg && <div style={{ color: C.gain, fontSize: "0.85rem" }}>{msg}</div>}

        <DialogFooter>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Button variant="outline" onClick={() => void doCheck()} disabled={checking}>{checking ? "校验中…" : "🔍 校验"}</Button>
            <Button onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : initial ? "💾 保存修改" : "✅ 记入账本"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- 分组编辑器弹窗 ----------

function GroupEditor({ open, onClose, groups, initial, onSaved }: {
  open: boolean;
  onClose: () => void;
  groups: TradeV2GroupSummary[];
  initial: TradeV2Group | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [totalCapital, setTotalCapital] = useState(0);
  const [dailyAddLimit, setDailyAddLimit] = useState(0);
  const [limits, setLimits] = useState<{ code: string; name?: string; maxWeightPct?: number }[]>([{ code: "" }]);
  const [allowShort, setAllowShort] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setTotalCapital(initial?.totalCapital ?? 0);
    setDailyAddLimit(initial?.dailyAddLimit ?? 0);
    setLimits(initial && initial.stockLimits.length > 0 ? initial.stockLimits.map((s) => ({ ...s })) : [{ code: "" }]);
    setAllowShort(initial?.allowShort ?? false);
    setMsg(null);
    setDeleting(false);
  }, [open, initial]);

  const save = async () => {
    if (!name.trim()) { setMsg("分组名称不能为空"); return; }
    setSaving(true);
    setMsg(null);
    try {
      const stockLimits = limits.filter((l) => l.code.trim() && l.maxWeightPct !== undefined).map((l) => ({ code: l.code.trim(), ...(l.name ? { name: l.name } : {}), maxWeightPct: l.maxWeightPct! }));
      if (initial) await api.tradeV2SaveGroup(initial.id, { name: name.trim(), totalCapital, dailyAddLimit, stockLimits, allowShort });
      else await api.tradeV2CreateGroup(name.trim());
      onSaved();
      onClose();
    } catch (e) {
      setMsg("❌ " + errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!initial) return;
    if (!window.confirm(`确定删除分组「${initial.name}」？其全部 ${groups.find((g) => g.id === initial.id)?.entryCount ?? "?"} 笔交易将一并删除（不可恢复）。`)) return;
    setDeleting(true);
    try {
      await api.tradeV2DeleteGroup(initial.id);
      onSaved();
      onClose();
    } catch (e) {
      setMsg("❌ " + errMsg(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v: boolean) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? "分组设置" : "新建分组"}</DialogTitle>
          <DialogDescription>分组 = 交易的组织单元（如策略）；组内可实施仓位限制（总仓位 / 单日加仓 / 单标的上限）。</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">分组名称</label>
            <Input className="h-8" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：稳健成长 / 网格策略" />
          </div>
          <div>
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">总仓位上限（元）</label>
            <Input type="number" min={0} className="h-8" value={totalCapital || ""} placeholder="0 = 不限" onChange={(e) => setTotalCapital(Number(e.target.value) || 0)} />
          </div>
          <div>
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">单日加仓上限（元）</label>
            <Input type="number" min={0} className="h-8" value={dailyAddLimit || ""} placeholder="0 = 不限" onChange={(e) => setDailyAddLimit(Number(e.target.value) || 0)} />
          </div>
          <div className="col-span-2">
            <label className="text-[0.8rem] font-semibold text-slate-600 block mb-1">单标的上限（% 占总仓位；可选）</label>
            {limits.map((l, i) => (
              <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                <Input className="h-8 w-40" value={l.code} placeholder="代码" onChange={(e) => setLimits((p) => p.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} />
                <Input className="h-8 w-36" value={l.name ?? ""} placeholder="名称（可选）" onChange={(e) => setLimits((p) => p.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <Input type="number" min={0} max={100} className="h-8 w-24" value={l.maxWeightPct ?? ""} placeholder="上限%" onChange={(e) => setLimits((p) => p.map((x, j) => (j === i ? { ...x, maxWeightPct: e.target.value === "" ? undefined : Number(e.target.value) || 0 } : x)))} />
                <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:bg-red-50" onClick={() => setLimits((p) => (p.length > 1 ? p.filter((_, j) => j !== i) : p))}>✕</Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setLimits((p) => [...p, { code: "" }])}>＋ 添加标的限制</Button>
          </div>
          <div className="col-span-2" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: "0.8rem", color: C.sub, fontWeight: 500 }}>
              <input type="checkbox" checked={allowShort} onChange={(e) => setAllowShort(e.target.checked)} style={{ accentColor: C.accent }} />
              🔻 允许做空（卖出可超持仓 → 负持仓）
            </label>
            <span style={{ fontSize: "0.72rem", color: C.muted }}>开启后卖出数量可超过当前持仓，超卖部分形成空头；未开启时超卖视为异常被拒绝</span>
          </div>
        </div>
        {msg && <div style={{ color: C.gain, fontSize: "0.85rem" }}>{msg}</div>}

        <DialogFooter>
          <div style={{ display: "flex", gap: 8, width: "100%", justifyContent: "space-between" }}>
            {initial ? (
              <Button variant="destructive" onClick={() => void remove()} disabled={deleting}>{deleting ? "删除中…" : "🗑 删除分组"}</Button>
            ) : <span />}
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="outline" onClick={onClose}>取消</Button>
              <Button onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "💾 保存"}</Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- V1 导入弹窗 ----------


// ---------- 统计分组盒（逻辑相关数据合并展示） ----------

interface StatItem { label: string; value: string; color?: string; sub?: string }
/** 统计分组盒（V1 审美）：tint 图标徽章 + 三数据列 */
function StatGroup({ title, icon, items, tone = "blue" }: { title: string; icon: string; items: StatItem[]; tone?: "blue" | "indigo" | "emerald" | "red" | "amber" }) {
  const chip = {
    blue: [C.accent, C.accentBg, C.accentBorder] as const,
    indigo: [C.indigo, C.indigoBg, "#e0e7ff"] as const,
    emerald: [C.loss, C.lossBg, C.lossBorder] as const,
    red: [C.gain, C.gainBg, C.gainBorder] as const,
    amber: [C.amber, C.amberBg, "#fde68a"] as const,
  }[tone];
  return (
    <Card style={{ boxShadow: "0 1px 2px rgba(15,23,42,0.04)" }}>
      <CardContent style={{ padding: "0.75rem 0.9rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
          <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 6, background: chip[1], border: "1px solid " + chip[2], color: chip[0], fontSize: "0.8rem", flexShrink: 0 }}>{icon}</span>
          <span style={{ fontSize: "0.74rem", fontWeight: 700, color: C.sub }}>{title}</span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {items.map((it) => (
            <div key={it.label} style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "0.66rem", color: C.muted }}>{it.label}</div>
              <div style={{ fontSize: "0.98rem", fontWeight: 700, color: it.color ?? C.text, whiteSpace: "nowrap", marginTop: 1 }}>{it.value}</div>
              {it.sub ? <div style={{ fontSize: "0.66rem", color: C.muted, marginTop: 1 }}>{it.sub}</div> : null}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- 仓位明细表 ----------

function PositionsTable({ positions, groupView, onRowClick, exportName }: { positions: TradeV2Position[]; groupView: boolean; onRowClick?: (p: TradeV2Position) => void; exportName?: string }) {
  const [sortKey, setSortKey] = useState<"quantity" | "avgCost" | "marketValue" | "realizedPnl" | "unrealizedPnl" | "weightPct" | null>(null);
  const [asc, setAsc] = useState(false);
  const sorted = useMemo(() => {
    if (!sortKey) return positions;
    const arr = [...positions].sort((a, b) => (a[sortKey] ?? 0) - (b[sortKey] ?? 0));
    return asc ? arr : arr.reverse();
  }, [positions, sortKey, asc]);
  const onSort = (k: typeof sortKey) => { if (sortKey === k) setAsc((v) => !v); else { setSortKey(k); setAsc(false); } };
  const sortableHead = (label: string, k: typeof sortKey, cls?: string) => (
    <TableHead className={cls} onClick={() => onSort(k)} style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}>
      {label}{sortKey === k ? (asc ? " ▲" : " ▼") : ""}
    </TableHead>
  );
  return positions.length === 0 ? (
    <Card><CardContent style={{ padding: "1.5rem", textAlign: "center", color: C.muted, fontSize: "0.85rem" }}>暂无持仓（仓位明细由交易自动派生）。</CardContent></Card>
  ) : (
    <Card><CardContent>
      {exportName && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
          <Button size="sm" variant="outline" onClick={() => downloadCSV(exportName, ["代码", "名称", "数量", "均价", "最新价", "市值", "已实现", "未实现", "未实现%"], positions.map((p) => [p.code, p.name ?? "", p.quantity, p.avgCost, p.latestPrice ?? "", Math.round(p.marketValue * 100) / 100, Math.round(p.realizedPnl * 100) / 100, Math.round(p.unrealizedPnl * 100) / 100, p.unrealizedPnlPct ?? ""]))}>📤 导出 CSV</Button>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>标的（点击行看交易历史）</TableHead>
            {sortableHead("数量", "quantity", "text-right")}
            {sortableHead("均价", "avgCost", "text-right")}
            <TableHead className="text-right">最新价</TableHead>
            {sortableHead("市值", "marketValue", "text-right")}
            {groupView && sortableHead("占总仓位", "weightPct", "text-right")}
            {sortableHead("已实现", "realizedPnl", "text-right")}
            {groupView && sortableHead("未实现", "unrealizedPnl", "text-right")}
            {groupView && sortableHead("未实现%", "unrealizedPnl", "text-right")}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((p) => (
            <TableRow key={p.code} onClick={() => onRowClick?.(p)} style={onRowClick ? { cursor: "pointer" } : undefined} title={onRowClick ? "查看交易历史" : undefined}>
              <TableCell><NameCode name={p.name} code={p.code} />{p.quantity < 0 ? <Badge style={{ marginLeft: 6, background: "#fff7ed", color: "#c2410c" }} title="空头（做空）：数量为负，价格下跌盈利">空头</Badge> : p.avgCost < 0 ? <Badge style={{ marginLeft: 6, background: "#faf5ff", color: "#7c3aed" }} title="负成本（已回本/做空记账）：盈亏率无意义">负成本</Badge> : null}</TableCell>
              <TableCell className="text-right">{qtyFmt(Math.abs(p.quantity))}{p.quantity < 0 ? <span style={{ color: "#c2410c", fontSize: "0.72rem", marginLeft: 4 }}>卖</span> : null}</TableCell>
              <TableCell className="text-right">{costFmt(p.avgCost)}</TableCell>
              <TableCell className="text-right">{p.latestPrice ? costFmt(p.latestPrice) : "—"}</TableCell>
              <TableCell className="text-right" style={{ fontWeight: 600 }}>{cny2(p.marketValue)}</TableCell>
              {groupView && <TableCell className="text-right">{p.weightPct !== undefined ? pct(p.weightPct) : "—"}</TableCell>}
              <TableCell className="text-right" style={{ color: pnlColor(p.realizedPnl) }}>{pnlText(p.realizedPnl)}</TableCell>
              {groupView && <TableCell className="text-right" style={{ color: pnlColor(p.unrealizedPnl) }}>{pnlText(p.unrealizedPnl)}</TableCell>}
              {groupView && <TableCell className="text-right" style={{ color: pnlColor(p.unrealizedPnl) }}>{p.unrealizedPnlPct !== undefined ? pct(p.unrealizedPnlPct) : "—"}</TableCell>}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div style={{ fontSize: "0.72rem", color: C.muted, marginTop: 8 }}>
        {groupView ? "市值按最新行情（无行情时按成本口径）；已实现 = 该标的本组卖出/回补累计。" : "全部组合并视图：按成本口径估算（无行情标的）。"}
        {positions.some((p) => p.quantity < 0) ? " 空头（做空）：数量显示为卖出股数，未实现 = 股数×(开空均价−现价)，价格下跌盈利。" : ""}
      </div>
    </CardContent></Card>
  );
}

/** 全部视图的仓位（合并各分组持仓）——按 code 合并数量/成本（做空感知：卖出超持仓 → 负持仓） */
function positionsFromGlobal(entries: TradeV2Entry[]): TradeV2Position[] {
  const map = new Map<string, { code: string; name?: string; quantity: number; costBasis: number; realized: number }>();
  const apply = (st: { quantity: number; costBasis: number; realized: number }, e: TradeV2Entry) => {
    const fee = typeof e.fee === "number" && e.fee > 0 ? e.fee : 0;
    const q = e.quantity;
    if (e.action === "buy") {
      if (st.quantity >= 0) {
        st.quantity += q;
        st.costBasis += q * e.price + fee;
      } else {
        const cover = Math.min(q, -st.quantity);
        const shortAvg = st.costBasis / st.quantity;
        st.realized += (shortAvg - e.price) * cover - fee;
        st.costBasis -= shortAvg * cover;
        st.quantity += cover;
        const rest = q - cover;
        if (rest > 0) { st.quantity += rest; st.costBasis += rest * e.price; }
      }
    } else {
      if (st.quantity > 0) {
        const avg = st.costBasis / st.quantity;
        const sellQty = Math.min(q, st.quantity);
        st.realized += (e.price - avg) * sellQty - fee;
        st.costBasis -= avg * sellQty;
        st.quantity -= sellQty;
        const rest = q - sellQty;
        if (rest > 0) { st.quantity -= rest; st.costBasis -= rest * e.price; }
      } else {
        st.quantity -= q;
        st.costBasis -= q * e.price;
        st.realized -= fee;
      }
    }
  };
  for (const e of entries) {
    const st = map.get(e.code) ?? { code: e.code, name: e.name, quantity: 0, costBasis: 0, realized: 0 };
    apply(st, e);
    map.set(e.code, st);
  }
  const out: TradeV2Position[] = [];
  for (const st of map.values()) {
    if (st.quantity === 0) continue;
    const avgCost = st.quantity !== 0 ? st.costBasis / st.quantity : 0;
    out.push({
      code: st.code,
      name: st.name,
      quantity: st.quantity,
      avgCost,
      costValue: st.quantity * avgCost,
      marketValue: st.quantity * avgCost,
      unrealizedPnl: 0,
      realizedPnl: st.realized,
    });
  }
  return out.sort((a, b) => Math.abs(b.costValue) - Math.abs(a.costValue));
}


// ---------- 交易绩效（复盘深度：盈亏比 / 期望 / 持有天数对比） ----------

function PerformanceCard({ deals }: { deals: TradeV2Deal[] }) {
  const closed = deals.filter((d) => d.status === "closed");
  if (closed.length === 0) return null;
  const wins = closed.filter((d) => (d.pnl ?? 0) > 0);
  const losses = closed.filter((d) => (d.pnl ?? 0) < 0);
  const avgWin = wins.length ? wins.reduce((a, d) => a + (d.pnl ?? 0), 0) / wins.length : undefined;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, d) => a + (d.pnl ?? 0), 0)) / losses.length : undefined;
  const pf = avgWin !== undefined && avgLoss !== undefined && avgLoss > 0 ? avgWin / avgLoss : undefined;
  const expectancy = closed.length ? closed.reduce((a, d) => a + (d.pnl ?? 0), 0) / closed.length : undefined;
  const winDays = wins.length ? wins.reduce((a, d) => a + (d.days ?? 0), 0) / wins.length : undefined;
  const lossDays = losses.length ? losses.reduce((a, d) => a + (d.days ?? 0), 0) / losses.length : undefined;
  const holdNote =
    winDays !== undefined && lossDays !== undefined
      ? winDays >= lossDays
        ? "✅ 盈利笔持得更久（让利润奔跑）"
        : "⚠️ 亏损笔持得更久（截断亏损？）"
      : undefined;
  const item = (label: string, value: string, color?: string) => (
    <div>
      <div style={{ color: C.muted, fontSize: "0.72rem" }}>{label}</div>
      <div style={{ fontWeight: 700, color: color ?? C.text, fontSize: "0.88rem" }}>{value}</div>
    </div>
  );
  return (
    <Card><CardContent>
      <SectionTitle icon="🧠" color={C.indigo}>交易绩效（已完结 {closed.length} 笔复盘）</SectionTitle>
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
        {item("平均盈利", cny2(avgWin), pnlColor(avgWin))}
        {item("平均亏损", cny2(avgLoss), pnlColor(-(avgLoss ?? 0)))}
        {item("盈亏比（均盈÷均亏）", pf !== undefined ? pf.toFixed(2) : "—", pf !== undefined && pf > 1 ? C.gain : pf !== undefined ? C.gain : C.text)}
        {item("单笔期望", pnlText(expectancy), pnlColor(expectancy))}
        {item("盈利笔平均持仓", winDays !== undefined ? winDays.toFixed(1) + " 天" : "—")}
        {item("亏损笔平均持仓", lossDays !== undefined ? lossDays.toFixed(1) + " 天" : "—")}
        {holdNote && <span style={{ color: holdNote.startsWith("✅") ? C.loss : C.gain, fontWeight: 600, fontSize: "0.82rem" }}>{holdNote}</span>}
      </div>
    </CardContent></Card>
  );
}

// ---------- 交易复盘表 ----------


function DealsTable({ deals }: { deals: TradeV2Deal[] }) {
  if (deals.length === 0) return (
    <Card><CardContent style={{ padding: "1.5rem", textAlign: "center", color: C.muted, fontSize: "0.85rem" }}>
      暂无交易复盘（买入→清仓配对，从账本自动生成）。
    </CardContent></Card>
  );
  const closed = deals.filter((d) => d.status === "closed");
  const open = deals.filter((d) => d.status === "open");
  const winRate = closed.length > 0 ? (closed.filter((d) => (d.pnl ?? 0) > 0).length / closed.length) * 100 : undefined;
  const realized = closed.reduce((a, d) => a + (d.pnl ?? 0), 0);
  return (
    <Card><CardContent>
      <SectionTitle icon="📈" color={C.accent}>交易复盘（买入→清仓配对）</SectionTitle>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 8, fontSize: "0.8rem", color: C.sub }}>
        <span>已完结 <b>{closed.length}</b> 笔</span>
        <span>在途 <b>{open.length}</b> 笔</span>
        {winRate !== undefined && <span>胜率 <b style={{ color: pnlColor(winRate) }}>{winRate.toFixed(1)}%</b></span>}
        <span>已实现 <b style={{ color: pnlColor(realized) }}>{pnlText(realized)}</b></span>
      </div>
      <div style={{ maxHeight: 480, overflow: "auto" }}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>标的</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>建仓</TableHead>
            <TableHead>清仓</TableHead>
            <TableHead className="text-right">持仓天数</TableHead>
            <TableHead className="text-right">买入金额</TableHead>
            <TableHead className="text-right">卖出回款</TableHead>
            <TableHead className="text-right">手续费</TableHead>
            <TableHead className="text-right">已实现盈亏</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {deals.map((d, i) => (
            <TableRow key={i}>
              <TableCell><NameCode name={d.name} code={d.code} /></TableCell>
              <TableCell>
                <Badge style={d.status === "open" ? { background: C.accentBg, color: "#1d4ed8" } : { background: "#f1f5f9", color: C.sub }}>
                  {d.status === "open" ? "在途" : "已完结"}
                </Badge>
              </TableCell>
              <TableCell>{d.entryDate}</TableCell>
              <TableCell>{d.exitDate ?? "—"}</TableCell>
              <TableCell className="text-right">{d.days ?? "—"}</TableCell>
              <TableCell className="text-right">{cny2(d.buyAmount)}</TableCell>
              <TableCell className="text-right">{cny2(d.sellAmount)}</TableCell>
              <TableCell className="text-right">{cny2(d.feeTotal)}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(d.pnl) }}>{d.status === "closed" ? pnlText(d.pnl) : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>
    </CardContent></Card>
  );
}

// ---------- 收益归因表 ----------

function AttributionTable({ attribution, onRowClick }: { attribution: TradeV2PnlAttribution[]; onRowClick?: (a: TradeV2PnlAttribution) => void }) {
  if (attribution.length === 0) return null;
  return (
    <Card><CardContent>
      <SectionTitle icon="🏆" color={C.accent}>收益归因（按标的：已实现 + 未实现 贡献，点击行看交易历史）</SectionTitle>
      {/* 归因表滚动容器（长表不撑爆页面） */}
      <div style={{ maxHeight: 420, overflow: "auto" }}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>标的</TableHead>
            <TableHead className="text-right">已实现</TableHead>
            <TableHead className="text-right">未实现</TableHead>
            <TableHead className="text-right">合计</TableHead>
            <TableHead className="text-right">贡献度</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {attribution.map((a) => (
            <TableRow key={a.code} onClick={() => onRowClick?.(a)} style={onRowClick ? { cursor: "pointer" } : undefined} title={onRowClick ? "查看交易历史" : undefined}>
              <TableCell><NameCode name={a.name} code={a.code} /></TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(a.realizedPnl) }}>{pnlText(a.realizedPnl)}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(a.unrealizedPnl) }}>{pnlText(a.unrealizedPnl)}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(a.totalPnl), fontWeight: 600 }}>{pnlText(a.totalPnl)}</TableCell>
              <TableCell className="text-right">{a.sharePct !== undefined ? pct(a.sharePct) : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>
    </CardContent></Card>
  );
}

// ---------- 每日动态表 ----------

function DailyTable({ dailySeries }: { dailySeries: TradeV2DailyPoint[] }) {
  if (dailySeries.length === 0) return null;
  const rows = [...dailySeries].reverse();
  let cum = 0;
  const rowsWithCum = rows.map((d) => { cum += d.realizedPnl; return { ...d, cumRealized: Math.round(cum * 100) / 100 }; });
  return (
    <Card><CardContent>
      <SectionTitle icon="📅" color={C.accent}>每日动态（历史价口径 · 有行情时真实市值）</SectionTitle>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>日期</TableHead>
            <TableHead className="text-right">买入</TableHead>
            <TableHead className="text-right">卖出回款</TableHead>
            <TableHead className="text-right">当日已实现</TableHead>
            <TableHead className="text-right">累计已实现</TableHead>
            <TableHead className="text-right">收盘市值</TableHead>
            <TableHead className="text-right">持仓数</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rowsWithCum.map((d) => (
            <TableRow key={d.date}>
              <TableCell className="whitespace-nowrap">{d.date}</TableCell>
              <TableCell className="text-right">{cny2(d.buyAmount)}</TableCell>
              <TableCell className="text-right">{cny2(d.sellAmount)}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(d.realizedPnl) }}>{pnlText(d.realizedPnl)}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(d.cumRealized) }}>{pnlText(d.cumRealized)}</TableCell>
              <TableCell className="text-right">{cny2(d.marketValue)}</TableCell>
              <TableCell className="text-right">{d.openCount}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardContent></Card>
  );
}

// ---------- 月度收益表 ----------

function MonthlyTable({ monthlySeries }: { monthlySeries: TradeV2MonthlyPoint[] }) {
  if (monthlySeries.length === 0) return null;
  return (
    <Card><CardContent>
      <SectionTitle icon="🗓️" color={C.accent}>月度收益汇总</SectionTitle>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>月份</TableHead>
            <TableHead className="text-right">买入</TableHead>
            <TableHead className="text-right">卖出回款</TableHead>
            <TableHead className="text-right">已实现</TableHead>
            <TableHead className="text-right">月末市值</TableHead>
            <TableHead className="text-right">月收益率</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...monthlySeries].reverse().map((m) => (
            <TableRow key={m.month}>
              <TableCell className="whitespace-nowrap">{m.month}</TableCell>
              <TableCell className="text-right">{cny2(m.buyAmount)}</TableCell>
              <TableCell className="text-right">{cny2(m.sellAmount)}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(m.realizedPnl), fontWeight: 600 }}>{pnlText(m.realizedPnl)}</TableCell>
              <TableCell className="text-right">{cny2(m.marketValue)}</TableCell>
              <TableCell className="text-right" style={{ color: pnlColor(m.pnlPct ?? 0) }}>{m.pnlPct !== undefined ? pctSigned(m.pnlPct) : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardContent></Card>
  );
}

// ---------- 每日交易单（批量录入体验） ----------

interface OrderRow {
  key: number;
  code: string;
  name?: string;
  action: "buy" | "sell";
  quantity: number;
  price: number;
  fee?: number;
  note?: string;
}
type RowField = "code" | "qty" | "price" | "fee" | "note";
const FIELD_ORDER: RowField[] = ["code", "qty", "price", "fee", "note"];

function OrderSheet({ initialGroup, groups, allEntries, todayAdd, positions, onSubmitted, onEditEntry, onDeleteEntry }: {
  initialGroup: TradeV2Group;
  groups: TradeV2GroupSummary[];
  allEntries: TradeV2Entry[];
  todayAdd: number;
  positions: TradeV2Position[];
  onSubmitted: () => void;
  onEditEntry?: (e: TradeV2Entry) => void;
  onDeleteEntry?: (e: TradeV2Entry) => void;
}) {
  const keySeq = useRef(0);
  const newRow = (): OrderRow => ({ key: ++keySeq.current, code: "", action: "buy", quantity: 0, price: 0 });
  const [groupId, setGroupId] = useState(initialGroup.id);
  const [date, setDate] = useState(nextTradingDay());
  const [rows, setRows] = useState<OrderRow[]>([newRow()]);
  const [result, setResult] = useState<TradeV2CheckResult | null>(null);
  const [summary, setSummary] = useState<TradeV2DayOrderSummary | null>(null);
  const [busy, setBusy] = useState<"check" | "submit" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [copiedMsg, setCopiedMsg] = useState<string | null>(null);
  const refs = useRef(new Map<number, Record<RowField, HTMLInputElement | null>>());

  const setRow = (key: number, patch: Partial<OrderRow>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const setRef = (key: number, field: RowField) => (el: HTMLInputElement | null) => {
    const m = refs.current.get(key) ?? { code: null, qty: null, price: null, fee: null, note: null };
    m[field] = el;
    refs.current.set(key, m);
  };
  const focusField = (key: number, field: RowField) => { const el = refs.current.get(key)?.[field]; el?.focus(); };

  // Enter 流式跳转：code→数量→价格→手续费→备注→下一行代码；末行备注 → 自动加行
  const handleEnter = (key: number, field: RowField) => {
    const idx = rows.findIndex((r) => r.key === key);
    const cur = FIELD_ORDER.indexOf(field);
    if (cur < FIELD_ORDER.length - 1) { focusField(key, FIELD_ORDER[cur + 1]!); return; }
    if (idx < rows.length - 1) { focusField(rows[idx + 1]!.key, "code"); return; }
    const nr = newRow();
    setRows((p) => [...p, nr]);
    setTimeout(() => focusField(nr.key, "code"), 0);
  };

  // 价格预填：选定标的后取该组持仓的最新价 ?? 均价（无持仓则保持原值）
  const onPickStock = (key: number, v: { code: string; name?: string }) => {
    setRow(key, { code: v.code, name: v.name });
    if (v.code.trim()) {
      const pos = positions.find((p) => p.code === v.code);
      if (pos && pos.quantity > 0) {
        const px = pos.latestPrice && pos.latestPrice > 0 ? pos.latestPrice : pos.avgCost > 0 ? pos.avgCost : undefined;
        if (px !== undefined) setRow(key, { price: px });
      }
    }
  };

  // ⚡ 一键取现价（行情接口，填充价格）
  const [priceBusy, setPriceBusy] = useState<string | null>(null);
  const fillLivePrice = async (key: number, code: string) => {
    if (!code || priceBusy) return;
    setPriceBusy(code);
    try {
      const r = await api.watchlistQuotes([code]);
      const q = r.quotes.find((x) => typeof (x as any)?.price === "number" && (x as any).price > 0);
      if (q) setRow(key, { price: (q as any).price });
    } catch { /* 行情失败静默 */ } finally {
      setPriceBusy(null);
    }
  };

  const valid = rows.filter((r) => r.code.trim() && r.quantity > 0 && r.price > 0);
  const drafts = (): TradeV2EntryDraft[] =>
    valid.map((r) => ({
      groupId,
      date,
      code: r.code.trim(),
      ...(r.name ? { name: r.name } : {}),
      action: r.action,
      quantity: r.quantity,
      price: r.price,
      ...(r.fee && r.fee > 0 ? { fee: r.fee } : {}),
      ...(r.note && r.note.trim() ? { note: r.note.trim() } : {}),
    }));

  // 复制上一交易日（作为今日模板）
  const copyPrevDay = () => {
    const groupEntries = allEntries.filter((e) => e.groupId === groupId && e.date < date && !e.initial);
    const prevDate = groupEntries.map((e) => e.date).sort().pop();
    if (!prevDate) { setCopiedMsg("没有更早的交易可复制"); return; }
    const prevRows = groupEntries.filter((e) => e.date === prevDate).map((e) => ({
      key: ++keySeq.current, code: e.code, name: e.name, action: e.action, quantity: e.quantity, price: e.price, fee: e.fee, note: e.note,
    }));
    setRows(prevRows.length > 0 ? prevRows : [newRow()]);
    setResult(null);
    setSummary(null);
    setCopiedMsg(`已载入 ${prevDate} 的 ${prevRows.length} 笔，可直接修改后提交`);
  };
  const clear = () => { setRows([newRow()]); setResult(null); setSummary(null); setCopiedMsg(null); setMsg(null); };

  // 实时净归并预览（客户端；已实现需服务端校验补）
  const liveNet = useMemo(() => {
    const byCode = new Map<string, { name?: string; netQty: number; netAmount: number }>();
    let buyTotal = 0;
    let sellTotal = 0;
    for (const r of valid) {
      const fee = r.fee ?? 0;
      const amount = r.quantity * r.price;
      const n = byCode.get(r.code) ?? { name: r.name, netQty: 0, netAmount: 0 };
      if (r.action === "buy") { n.netQty += r.quantity; n.netAmount += amount + fee; buyTotal += amount + fee; }
      else { n.netQty -= r.quantity; n.netAmount -= amount - fee; sellTotal += amount - fee; }
      byCode.set(r.code, n);
    }
    return {
      buyTotal: Math.round(buyTotal * 100) / 100,
      sellTotal: Math.round(sellTotal * 100) / 100,
      netPerCode: [...byCode.entries()].map(([code, n]) => ({
        code,
        ...(n.name ? { name: n.name } : {}),
        netQty: n.netQty,
        netAmount: Math.round(n.netAmount * 100) / 100,
        action: n.netQty > 0 ? "buy" : n.netQty < 0 ? "sell" : "flat",
      })),
    };
  }, [rows]);

  const remain = initialGroup.dailyAddLimit > 0 ? initialGroup.dailyAddLimit - todayAdd - liveNet.buyTotal : undefined;

  const doCheck = async () => {
    if (valid.length === 0) { setMsg("至少填写一行（代码/数量/价格）"); return; }
    setBusy("check");
    setMsg(null);
    try {
      const r = await api.tradeV2BatchEntries(drafts(), true);
      setResult(r.result ?? null);
      setSummary(r.daySummary ?? null);
    } catch (e) {
      setMsg("❌ " + errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (valid.length === 0) { setMsg("至少填写一行（代码/数量/价格）"); return; }
    setBusy("submit");
    setMsg(null);
    try {
      const r = await api.tradeV2BatchEntries(drafts(), false);
      setResult(r.result ?? null);
      setSummary(r.daySummary ?? null);
      setMsg(`✅ 已提交 ${r.createdCount} 笔交易，仓位已自动归并重算`);
      onSubmitted();
      setRows([newRow()]);
      setCopiedMsg(null);
    } catch (e) {
      setMsg("❌ " + errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card><CardContent>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        <Select value={groupId} onValueChange={(v: string | null) => setGroupId(v ?? groupId)}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {groups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input type="date" className="h-8 w-40" value={date} onChange={(e) => setDate(e.target.value)} />
        <Button variant="outline" size="sm" onClick={copyPrevDay}>📋 复制上一交易日</Button>
        <Button variant="ghost" size="sm" onClick={clear}>🧹 清空</Button>
        <div style={{ flex: 1 }} />
        <Button variant="outline" size="sm" onClick={() => setRows((p) => [...p, newRow()])}>＋ 添加一行</Button>
      </div>
      {initialGroup.dailyAddLimit > 0 && (
        <div style={{ fontSize: "0.78rem", color: C.sub, marginBottom: 8, display: "flex", gap: 14, flexWrap: "wrap" }}>
          <span>日限 {cny(initialGroup.dailyAddLimit)}</span>
          <span>今日已用 {cny(todayAdd)}</span>
          <span>本单买入 {cny(liveNet.buyTotal)}</span>
          <span style={{ color: (remain ?? 0) < 0 ? C.gain : C.loss, fontWeight: 700 }}>剩余 {cny(remain)}</span>
        </div>
      )}
      {initialGroup.allowShort ? (
        <div style={{ fontSize: "0.78rem", color: "#c2410c", marginBottom: 8 }}>🔻 本组允许做空：卖出数量可超过当前持仓，超卖部分形成空头（价格下跌盈利）</div>
      ) : (
        <div style={{ fontSize: "0.78rem", color: C.muted, marginBottom: 8 }}>本组未开启做空：卖出数量不得超过当前持仓（超卖将被拒绝）</div>
      )}
      {copiedMsg && <div style={{ fontSize: "0.78rem", color: C.accent, marginBottom: 8 }}>{copiedMsg}</div>}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>标的（Enter 跳到下一格）</TableHead>
            <TableHead>操作</TableHead>
            <TableHead className="w-28">数量（股）</TableHead>
            <TableHead className="w-28">价格（元）</TableHead>
            <TableHead className="w-24">手续费</TableHead>
            <TableHead>备注</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.key}>
              <TableCell style={{ minWidth: 190 }}>
                <StockSearchInput value={{ code: r.code, name: r.name }} onPick={(v) => onPickStock(r.key, v)} inputRef={setRef(r.key, "code")} onEnter={() => handleEnter(r.key, "code")} />
              </TableCell>
              <TableCell>
                <Select value={r.action} onValueChange={(v: string | null) => setRow(r.key, { action: (v ?? "buy") as "buy" | "sell" })}>
                  <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="buy">买入</SelectItem>
                    <SelectItem value="sell">卖出</SelectItem>
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell><Input ref={setRef(r.key, "qty")} type="number" min={0} step={1} className="h-8" value={r.quantity || ""} placeholder="0" onChange={(e) => setRow(r.key, { quantity: numInput(e.target.value) })} onKeyDown={(e) => { if (e.key === "Enter") handleEnter(r.key, "qty"); }} /></TableCell>
              <TableCell>
                <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <Input ref={setRef(r.key, "price")} type="number" min={0} step={0.01} className="h-8" value={r.price || ""} placeholder="0.00" onChange={(e) => setRow(r.key, { price: Number(e.target.value) || 0 })} onKeyDown={(e) => { if (e.key === "Enter") handleEnter(r.key, "price"); }} />
                  <Button variant="ghost" size="icon" className="h-8 w-7 shrink-0" title="填入最新价" disabled={!r.code.trim() || priceBusy === r.code.trim()} onClick={() => void fillLivePrice(r.key, r.code.trim())}>{priceBusy === r.code.trim() ? "…" : "⚡"}</Button>
                </span>
              </TableCell>
              <TableCell><Input ref={setRef(r.key, "fee")} type="number" min={0} step={0.01} className="h-8" value={r.fee ?? ""} placeholder="0" onChange={(e) => setRow(r.key, { fee: e.target.value === "" ? undefined : Number(e.target.value) || 0 })} onKeyDown={(e) => { if (e.key === "Enter") handleEnter(r.key, "fee"); }} /></TableCell>
              <TableCell><Input ref={setRef(r.key, "note")} className="h-8" value={r.note ?? ""} onChange={(e) => setRow(r.key, { note: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") handleEnter(r.key, "note"); }} /></TableCell>
              <TableCell><Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:bg-red-50" onClick={() => setRows((p) => (p.length > 1 ? p.filter((x) => x.key !== r.key) : p))}>✕</Button></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* 净归并预览（实时客户端 + 服务端校验补已实现） */}
      {(liveNet.netPerCode.length > 0 || summary) && (
        <div style={{ marginTop: 10, padding: "0.6rem 0.8rem", background: C.panel, border: "1px solid " + C.border, borderRadius: 10, fontSize: "0.82rem" }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 6, fontWeight: 600, color: C.text }}>
            <span>买入合计 {cny2(liveNet.buyTotal)}</span>
            <span>卖出回款 {cny2(liveNet.sellTotal)}</span>
            <span style={{ color: pnlColor(summary?.realizedPnl ?? 0) }}>当日已实现 {summary ? pnlText(summary.realizedPnl) : "—"}</span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(summary?.netPerCode ?? liveNet.netPerCode).map((n) => (
              <span key={n.code} style={{ padding: "0.2rem 0.5rem", borderRadius: 999, border: "1px solid " + C.border, background: "#fff" }}>
                <NameCode name={n.name} code={n.code} size="0.78rem" />
                <b style={{ marginLeft: 4 }}>{n.netQty > 0 ? "+" : ""}{qtyFmt(n.netQty)}</b>
                <Badge style={{ marginLeft: 4, background: n.action === "buy" ? C.gainBg : n.action === "sell" ? C.lossBg : "#f1f5f9", color: n.action === "buy" ? C.gain : n.action === "sell" ? C.loss : C.sub }}>
                  {n.action === "buy" ? "净买" : n.action === "sell" ? "净卖" : "持平"}
                </Badge>
                <span style={{ color: C.sub, marginLeft: 4 }}>{cny2(n.netAmount)}</span>
              </span>
            ))}
          </div>
        </div>
      )}


      {/* 本日已提交（该组当日已入账条目 —— 每日工作流闭环回看） */}
      {(() => {
        const todayEntries = allEntries.filter((e) => e.groupId === groupId && e.date === date);
        if (todayEntries.length === 0) return null;
        return (
          <div style={{ marginTop: 10, border: "1px solid " + C.border, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0.5rem 0.8rem", background: C.panel, fontSize: "0.82rem", fontWeight: 700, color: C.sub }}>
              ✅ 本日已提交（{todayEntries.length} 笔，仓位已自动归并）
              <span style={{ fontWeight: 400, color: C.muted, fontSize: "0.75rem" }}>可直接编辑或删除修正</span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>标的</TableHead>
                  <TableHead>操作</TableHead>
                  <TableHead className="text-right">数量</TableHead>
                  <TableHead className="text-right">价格</TableHead>
                  <TableHead className="text-right">金额</TableHead>
                  <TableHead className="text-right">手续费</TableHead>
                  <TableHead>备注</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {todayEntries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell><NameCode name={e.name} code={e.code} size="0.8rem" /></TableCell>
                    <TableCell>
                      <Badge style={e.action === "buy" ? { background: C.gainBg, color: C.gain } : { background: C.lossBg, color: C.loss }}>{e.action === "buy" ? "买入" : "卖出"}</Badge>
                      {e.initial && <Badge style={{ marginLeft: 4, background: "#fef3c7", color: "#b45309" }}>期初</Badge>}
                    </TableCell>
                    <TableCell className="text-right">{qtyFmt(e.quantity)}</TableCell>
                    <TableCell className="text-right">{costFmt(e.price)}</TableCell>
                    <TableCell className="text-right">{cny2(e.quantity * e.price)}</TableCell>
                    <TableCell className="text-right">{e.fee ? cny2(e.fee) : "—"}</TableCell>
                    <TableCell style={{ color: C.sub, fontSize: "0.8rem" }}>{e.note ?? ""}</TableCell>
                    <TableCell>
                      <span style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onEditEntry?.(e)}>编辑</Button>
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-red-500 hover:bg-red-50" onClick={() => onDeleteEntry?.(e)}>删除</Button>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        );
      })()}
      {result && result.alerts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          {result.alerts.map((a, i) => (
            <div key={i} style={{ background: alertBg[a.level], color: alertColor[a.level], padding: "0.4rem 0.6rem", borderRadius: 8, fontSize: "0.8rem" }}>
              <b>{a.level === "error" ? "✖" : a.level === "warn" ? "⚠" : "ℹ"} {a.message}</b>
              {a.detail ? <span style={{ display: "block", marginTop: 2 }}>{a.detail}</span> : null}
            </div>
          ))}
        </div>
      )}
      {msg && <div style={{ color: msg.startsWith("✅") ? C.loss : C.gain, fontSize: "0.85rem", marginTop: 8 }}>{msg}</div>}

      <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end", alignItems: "center" }}>
        {result && !result.ok && <span style={{ fontSize: "0.78rem", color: C.gain, marginRight: "auto" }}>✖ 校验未通过：请修正后重新校验</span>}
        <Button variant="outline" onClick={() => void doCheck()} disabled={busy !== null}>{busy === "check" ? "校验中…" : "🔍 校验"}</Button>
        <Button onClick={() => void submit()} disabled={busy !== null || valid.length === 0 || (result !== null && !result.ok)}>{busy === "submit" ? "提交中…" : "📤 提交交易单（整批入库）"}</Button>
      </div>
    </CardContent></Card>
  );
}



// ---------- 分组贡献表（全部 = 组合整体统计） ----------

function GroupContributionTable({ groups, globalMv, onSelect }: { groups: TradeV2GroupSummary[]; globalMv: number; onSelect: (id: string) => void }) {
  if (groups.length === 0) return null;
  return (
    <Card><CardContent>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: "0.85rem", fontWeight: 700 }}>🧩 分组整体统计 · 贡献明细（点击行跳转该组）</div>
        <div style={{ flex: 1 }} />
        <Button size="sm" variant="outline" onClick={() => downloadCSV("分组贡献.csv", ["分组", "在途", "市值", "占总组合%", "已实现", "未实现", "总盈亏", "盈亏率%"], groups.map((g) => [g.name, g.openCount, Math.round(g.totalMv * 100) / 100, globalMv > 0 ? Math.round((g.totalMv / globalMv) * 1000) / 10 : "", Math.round(g.realizedPnl * 100) / 100, Math.round(g.unrealizedPnl * 100) / 100, Math.round(g.totalPnl * 100) / 100, g.totalMv - g.unrealizedPnl > 0 ? Math.round((g.totalPnl / (g.totalMv - g.unrealizedPnl)) * 1000) / 10 : ""]))}>📤 导出 CSV</Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>分组</TableHead>
            <TableHead className="text-right">风险</TableHead>
            <TableHead className="text-right">在途</TableHead>
            <TableHead className="text-right">市值</TableHead>
            <TableHead className="text-right">占总组合</TableHead>
            <TableHead className="text-right">已实现</TableHead>
            <TableHead className="text-right">未实现</TableHead>
            <TableHead className="text-right">总盈亏</TableHead>
            <TableHead className="text-right">盈亏率</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((g) => {
            const cost = g.totalMv - g.unrealizedPnl;
            const rate = cost > 0 ? (g.totalPnl / cost) * 100 : undefined;
            return (
              <TableRow key={g.id} onClick={() => onSelect(g.id)} style={{ cursor: "pointer" }}>
                <TableCell><span style={{ fontWeight: 600 }}>{g.name}</span></TableCell>
                <TableCell className="text-right">{g.riskCount ? <span style={{ color: "#b45309", fontWeight: 700 }}>⚠️{g.riskCount}</span> : "—"}</TableCell>
                <TableCell className="text-right">{g.openCount}</TableCell>
                <TableCell className="text-right">{cny2(g.totalMv)}</TableCell>
                <TableCell className="text-right">{globalMv > 0 ? pct((g.totalMv / globalMv) * 100) : "—"}</TableCell>
                <TableCell className="text-right" style={{ color: pnlColor(g.realizedPnl) }}>{pnlText(g.realizedPnl)}</TableCell>
                <TableCell className="text-right" style={{ color: pnlColor(g.unrealizedPnl) }}>{pnlText(g.unrealizedPnl)}</TableCell>
                <TableCell className="text-right" style={{ color: pnlColor(g.totalPnl), fontWeight: 600 }}>{pnlText(g.totalPnl)}</TableCell>
                <TableCell className="text-right" style={{ color: pnlColor(rate ?? 0) }}>{rate !== undefined ? pctSigned(rate) : "—"}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </CardContent></Card>
  );
}

// ---------- 标的交易历史下钻 ----------

function StockHistoryDialog({ open, onClose, code, name, scopeName, entries, positions, deals }: {
  open: boolean;
  onClose: () => void;
  code: string;
  name?: string;
  scopeName: string;
  entries: TradeV2Entry[];
  positions: TradeV2Position[];
  deals: TradeV2Deal[];
}) {
  const codeEntries = entries.filter((e) => e.code === code);
  const sortedEntries = [...codeEntries].sort((a, b) => (a.date < b.date ? 1 : -1));
  const pos = positions.find((p) => p.code === code);
  const codeDeals = deals.filter((d) => d.code === code);
  return (
    <Dialog open={open} onOpenChange={(v: boolean) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle><NameCode name={name} code={code} /> <span style={{ fontSize: "0.75rem", color: C.muted, fontWeight: 400 }}>· {scopeName}</span></DialogTitle>
          <DialogDescription>该标的在此范围内的全部交易与盈亏归因（仓位/盈亏由账本自动派生）。</DialogDescription>
        </DialogHeader>

        {pos && (
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", background: C.panel, borderRadius: 10, padding: "0.6rem 0.8rem", fontSize: "0.8rem", color: C.sub }}>
            <span>持仓 <b style={{ color: C.text }}>{qtyFmt(pos.quantity)} 股</b></span>
            <span>均价 <b style={{ color: C.text }}>{costFmt(pos.avgCost)}</b></span>
            <span>市值 <b style={{ color: C.text }}>{cny2(pos.marketValue)}</b></span>
            <span>已实现 <b style={{ color: pnlColor(pos.realizedPnl) }}>{pnlText(pos.realizedPnl)}</b></span>
            <span>未实现 <b style={{ color: pnlColor(pos.unrealizedPnl) }}>{pnlText(pos.unrealizedPnl)}</b></span>
          </div>
        )}

        {codeDeals.length > 0 && (
          <div>
            <div style={{ fontSize: "0.8rem", fontWeight: 700, marginBottom: 4 }}>📈 交易段（买入→清仓复盘）</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>状态</TableHead>
                  <TableHead>建仓</TableHead>
                  <TableHead>清仓</TableHead>
                  <TableHead className="text-right">天数</TableHead>
                  <TableHead className="text-right">买入</TableHead>
                  <TableHead className="text-right">卖出</TableHead>
                  <TableHead className="text-right">盈亏</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {codeDeals.map((d, i) => (
                  <TableRow key={i}>
                    <TableCell><Badge style={d.status === "open" ? { background: C.accentBg, color: "#1d4ed8" } : { background: "#f1f5f9", color: C.sub }}>{d.status === "open" ? "在途" : "已完结"}</Badge></TableCell>
                    <TableCell>{d.entryDate}</TableCell>
                    <TableCell>{d.exitDate ?? "—"}</TableCell>
                    <TableCell className="text-right">{d.days ?? "—"}</TableCell>
                    <TableCell className="text-right">{cny2(d.buyAmount)}</TableCell>
                    <TableCell className="text-right">{cny2(d.sellAmount)}</TableCell>
                    <TableCell className="text-right" style={{ color: pnlColor(d.pnl), fontWeight: 600 }}>{d.status === "closed" ? pnlText(d.pnl) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div>
          <div style={{ fontSize: "0.8rem", fontWeight: 700, marginBottom: 4 }}>💹 全部交易（{sortedEntries.length} 笔）</div>
          <div style={{ maxHeight: 280, overflowY: "auto" }}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead>操作</TableHead>
                  <TableHead className="text-right">数量</TableHead>
                  <TableHead className="text-right">价格</TableHead>
                  <TableHead className="text-right">金额</TableHead>
                  <TableHead className="text-right">手续费</TableHead>
                  <TableHead>备注</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedEntries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap">{e.date}</TableCell>
                    <TableCell>
                      <Badge style={e.action === "buy" ? { background: C.gainBg, color: C.gain } : { background: C.lossBg, color: C.loss }}>{e.action === "buy" ? "买入" : "卖出"}</Badge>
                      {e.initial && <Badge style={{ marginLeft: 4, background: "#fef3c7", color: "#b45309" }}>期初</Badge>}
                    </TableCell>
                    <TableCell className="text-right">{qtyFmt(e.quantity)}</TableCell>
                    <TableCell className="text-right">{costFmt(e.price)}</TableCell>
                    <TableCell className="text-right">{cny2(e.quantity * e.price)}</TableCell>
                    <TableCell className="text-right">{e.fee ? cny2(e.fee) : "—"}</TableCell>
                    <TableCell style={{ color: C.sub, fontSize: "0.8rem" }}>{e.note ?? ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>

        <DialogFooter><Button onClick={onClose}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
// ---------- 主页面（全横向 Tab 布局） ----------

export default function TradeV2Tool() {
  const [groups, setGroups] = useState<TradeV2GroupSummary[]>([]);
  const [entries, setEntries] = useState<TradeV2Entry[]>([]);
  // 分组选择：localStorage 记忆上次选中；无记忆时默认第一分组（有分组），无分组才 all
  const [pillHover, setPillHover] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem("tradeV2:selectedGroup") : null;
    return saved ?? "all";
  });
  const [detail, setDetail] = useState<{ group: TradeV2Group; analysis: TradeV2GroupAnalysis } | null>(null);
  const [global, setGlobal] = useState<TradeV2GlobalAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [tab, setTab] = useState("analysis");
  const [entryEditorOpen, setEntryEditorOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<TradeV2Entry | null>(null);
  const [groupEditorOpen, setGroupEditorOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<TradeV2Group | null>(null);
    const [stockDlg, setStockDlg] = useState<{ code: string; name?: string } | null>(null);

  const [fGroup, setFGroup] = useState<string>("all");
  const [fAction, setFAction] = useState<string>("all");
  const [fCode, setFCode] = useState("");
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [ledgerPage, setLedgerPage] = useState(1); // 流水分页（每页 100）

  const loadOverview = useCallback(async () => {
    try {
      const r = await api.tradeV2Overview();
      setGroups(r.groups);
      setEntries(r.entries);
      return r.groups; // init 用（state 更新前闭包拿不到新值）
    } catch (e) {
      setMsg("❌ 数据加载失败：" + errMsg(e));
      return [];
    }
  }, []);

  const loadAnalysis = useCallback(async (groupId: string) => {
    try {
      if (groupId === "all") {
        const r = await api.tradeV2Analysis();
        setGlobal(r.analysis ?? null);
        setDetail(null);
      } else {
        const r = await api.tradeV2Group(groupId);
        if (r.analysis && r.group) setDetail({ group: r.group, analysis: r.analysis });
        else setDetail(null);
        setGlobal(null);
      }
    } catch (e) {
      setMsg("❌ 分析加载失败：" + errMsg(e));
    }
  }, []);

  const reloadAll = useCallback(async () => {
    await loadOverview();
    await loadAnalysis(selectedId);
  }, [loadOverview, loadAnalysis, selectedId]);

  // 初始化一次：loadOverview 填充 groups；恢复 localStorage 记忆的分组（若有），否则全部
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    setLoading(true);
    void (async () => {
      const loaded = (await loadOverview()) ?? []; // 填充 groups 并取回
      const saved = typeof localStorage !== "undefined" ? localStorage.getItem("tradeV2:selectedGroup") : null;
      const initialId = saved && loaded.some((g) => g.id === saved) ? saved : "all";
      setSelectedId(initialId);
      await loadAnalysis(initialId);
      setLoading(false);
    })();
  }, [loadOverview, loadAnalysis]);

  useEffect(() => {
    if (selectedId === "all" || groups.some((g) => g.id === selectedId)) {
      void loadAnalysis(selectedId);
    }
  }, [selectedId, groups, loadAnalysis]);

  const isGroupView = selectedId !== "all" && !!detail;
  const analysis = detail?.analysis ?? null;
  // 功能区 tab：全部视图默认组合分析（analysis-global），分组视图默认收益分区（analysis）；其余 tab 共用
  // 功能区 tab 视图感知：仅分组视图需把 analysis-global 映射为 analysis；全部视图 analysis/analysis-global 均有效
  const activeTab = isGroupView && tab === "analysis-global" ? "analysis" : tab;
  const selectedGroup = detail?.group ?? null;

  const cur = useMemo(() => {
    if (isGroupView && analysis) {
      return {
        totalMv: analysis.totalMv,
        totalCost: analysis.totalCost,
        unrealizedPnl: analysis!.unrealizedPnl,
        realizedPnl: analysis!.realizedPnl,
        totalPnl: analysis.totalPnl,
        invested: analysis.invested,
        openCount: analysis.openCount,
        closedCount: analysis.closedCount,
        winRate: analysis.winRate,
        avgDays: analysis.avgDays,
        positionPct: analysis.positionPct,
        remaining: analysis.remaining,
        todayAdd: analysis.todayAdd,
        negCount: analysis.negCount,
      };
    }
    if (global) {
      return {
        totalMv: global.totalMv,
        totalCost: global.totalCost,
        unrealizedPnl: global.unrealizedPnl,
        realizedPnl: global.realizedPnl,
        totalPnl: global.totalPnl,
        invested: global.invested,
        openCount: global.openCount,
        closedCount: global.closedCount,
        winRate: global.winRate,
        avgDays: global.avgDays,
        negCount: global.negCount,
      };
    }
    return null;
  }, [isGroupView, analysis, global]);

  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);

  // 当前视图范围的账本（分组视图 = 该组；全部 = 全部）——供标的交易历史下钻 */
  const groupEntries = useMemo(
    () => (isGroupView ? entries.filter((e) => e.groupId === selectedId) : entries),
    [entries, isGroupView, selectedId],
  );

  // 组合整体统计（全部视图）：盈亏率 + 集中度（最大分组市值占比）
  const globalCost = global ? global.totalMv - global.unrealizedPnl : 0;
  const globalRate = global && globalCost > 0 ? (global.totalPnl / globalCost) * 100 : undefined;
  const maxGroup = useMemo(() => {
    if (groups.length === 0 || !global || global.totalMv <= 0) return undefined;
    const g = [...groups].sort((a, b) => b.totalMv - a.totalMv)[0]!;
    return { name: g.name, pct: (g.totalMv / global.totalMv) * 100 };
  }, [groups, global]);

  const pieOption = useMemo<echarts.EChartsOption>(() => {
    const data = isGroupView && analysis
      ? analysis.positions.filter((p) => p.marketValue > 0).map((p) => ({ name: p.name ? `${p.name} ${p.code}` : p.code, value: Math.round(p.marketValue) }))
      : groups.filter((g) => g.totalMv > 0).map((g) => ({ name: g.name, value: Math.round(g.totalMv) }));
    return {
      tooltip: { trigger: "item", formatter: "{b}<br/>市值 {c} 元（{d}%）" },
      legend: { type: "scroll", bottom: 0, textStyle: { fontSize: 11 } },
      series: [{ type: "pie", radius: ["38%", "66%"], center: ["50%", "44%"], data, label: { fontSize: 11, formatter: "{b}: {d}%" }, itemStyle: { borderRadius: 4, borderColor: "#fff", borderWidth: 1 } }],
    };
  }, [isGroupView, analysis, groups]);

  const barOption = useMemo<echarts.EChartsOption>(() => {
    const names = groups.map((g) => g.name);
    return {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      legend: { data: ["已实现", "未实现"], top: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 8, bottom: 0, top: 32, containLabel: true },
      xAxis: { type: "category", data: names, axisLabel: { fontSize: 11, interval: 0, rotate: names.length > 4 ? 20 : 0 } },
      yAxis: { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => `${v >= 10000 ? (v / 10000).toFixed(1) + "万" : v}` } },
      series: [
        { name: "已实现", type: "bar", stack: "pnl", data: groups.map((g) => Math.round(g.realizedPnl)), itemStyle: { color: C.accent } },
        { name: "未实现", type: "bar", stack: "pnl", data: groups.map((g) => Math.round(g.unrealizedPnl)), itemStyle: { color: "#93c5fd" } },
      ],
    };
  }, [groups]);

  const globalLineOption = useMemo<echarts.EChartsOption>(() => ({
    tooltip: { trigger: "axis", formatter: (p: unknown) => {
      const arr = (p as { axisValue: number; value: unknown }[]);
      const v = Array.isArray(arr[0]?.value) ? (arr[0].value[1] as number) : 0;
      return `${arr[0]?.axisValue ? new Date(arr[0].axisValue).toISOString().slice(0, 10) : ""}<br/>累计已实现：<b>${cny2(v)}</b>`;
    } },
    grid: { left: 8, right: 8, bottom: 0, top: 24, containLabel: true },
    xAxis: { type: "time", axisLabel: { fontSize: 10 } },
    yAxis: { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => `${v >= 10000 ? (v / 10000).toFixed(1) + "万" : v}` } },
    series: [{
      name: "累计已实现",
      type: "line",
      smooth: true,
      showSymbol: false,
      data: (global?.realizedTimeline ?? []).map((t) => [t.date + "T00:00:00", t.cumulative]),
      lineStyle: { color: C.accent, width: 2 },
      areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(37,99,235,.25)" }, { offset: 1, color: "rgba(37,99,235,.02)" }] } },
    }],
  }), [global]);

  // 组合净值曲线（现金+市值口径）：净值 = 期初本金 P0 + (市值 − 累计净投入)
  // 恒等：净值 = P0 + 已实现累计 + 未实现（卖出回款落袋为现金计入净值；追加投入不改变净值）
  const globalScaleOption = useMemo<echarts.EChartsOption>(() => {
    const daily = global?.dailySeries ?? [];
    let cum = 0;
    const cumRealized = daily.map((d) => { cum += d.realizedPnl; return Math.round(cum * 100) / 100; });
    let inv = 0;
    const investedSeries = daily.map((d) => { inv += d.buyAmount - d.sellAmount; return Math.round(inv * 100) / 100; });
    const p0 = investedSeries[0] ?? 0;
    const navSeries = daily.map((d, i) => Math.round((p0 + d.marketValue - investedSeries[i]) * 100) / 100);
    return {
      tooltip: { trigger: "axis" },
      legend: { data: ["组合净值(现金+市值)", "持仓市值(成本)", "累计已实现"], top: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 8, bottom: 0, top: 28, containLabel: true },
      xAxis: { type: "category", data: daily.map((d) => d.date), axisLabel: { fontSize: 10 } },
      yAxis: { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => `${v >= 10000 ? (v / 10000).toFixed(1) + "万" : v}` } },
      series: [
        { name: "组合净值(现金+市值)", type: "line", smooth: true, showSymbol: false, data: navSeries, lineStyle: { color: C.accent, width: 2 }, areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(37,99,235,.18)" }, { offset: 1, color: "rgba(37,99,235,.02)" }] } } },
        { name: "持仓市值(成本)", type: "line", smooth: true, showSymbol: false, data: daily.map((d) => Math.round(d.marketValue)), lineStyle: { color: "#94a3b8", width: 1.5, type: "dashed" } },
        { name: "累计已实现", type: "line", smooth: true, showSymbol: false, data: cumRealized, lineStyle: { color: C.gain, width: 1.5, type: "dotted" } },
      ],
    };
  }, [global]);

  const donutOption = useMemo<echarts.EChartsOption>(() => {
    if (!analysis) return {};
    const data = [
      { name: "已实现", value: Math.abs(Math.round(analysis!.realizedPnl)), signed: analysis!.realizedPnl, color: C.accent },
      { name: "未实现", value: Math.abs(Math.round(analysis!.unrealizedPnl)), signed: analysis!.unrealizedPnl, color: "#93c5fd" },
    ].filter((d) => d.value > 0);
    return {
      tooltip: { trigger: "item", formatter: (p: unknown) => {
        const it = (p as { name: string; value: number; data: { signed: number } });
        return `${it.name}<br/><b>${cny2(it.data.signed)}</b>（绝对值 ${cny2(it.value)}）`;
      } },
      legend: { bottom: 0, textStyle: { fontSize: 11 } },
      series: [{ type: "pie", radius: ["45%", "70%"], center: ["50%", "44%"], data, label: { fontSize: 11, formatter: "{b}: {d}%" } }],
    };
  }, [analysis]);

  const attrOption = useMemo<echarts.EChartsOption>(() => {
    if (!analysis) return {};
    const top = analysis!.pnlAttribution.slice(0, 10);
    return {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: (p: unknown) => {
        const arr = (p as { name: string; value: unknown }[]);
        const v = typeof arr[0]?.value === "number" ? arr[0].value : 0;
        return `${arr[0]?.name ?? ""}<br/>总收益：<b>${cny2(v)}</b>`;
      } },
      grid: { left: 8, right: 8, bottom: 0, top: 8, containLabel: true },
      xAxis: { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => `${v >= 10000 ? (v / 10000).toFixed(1) + "万" : v}` } },
      yAxis: { type: "category", data: [...top].reverse().map((a) => a.name ?? a.code), axisLabel: { fontSize: 10 } },
      series: [{ type: "bar", data: [...top].reverse().map((a) => ({ value: Math.round(a.totalPnl), itemStyle: { color: a.totalPnl >= 0 ? C.gain : C.loss, borderRadius: 3 } })), barMaxWidth: 16 }],
    };
  }, [analysis]);

  const scaleOption = useMemo<echarts.EChartsOption>(() => {
    if (!analysis) return {};
    const daily = analysis!.dailySeries;
    let cum = 0;
    const cumRealized = daily.map((d) => { cum += d.realizedPnl; return Math.round(cum * 100) / 100; });
    let inv = 0;
    const investedSeries = daily.map((d) => { inv += d.buyAmount - d.sellAmount; return Math.round(inv * 100) / 100; });
    const p0 = investedSeries[0] ?? 0;
    const navSeries = daily.map((d, i) => Math.round((p0 + d.marketValue - investedSeries[i]) * 100) / 100);
    return {
      tooltip: { trigger: "axis" },
      legend: { data: ["组合净值(现金+市值)", "持仓市值(成本)", "累计已实现"], top: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 8, bottom: 0, top: 28, containLabel: true },
      xAxis: { type: "category", data: daily.map((d) => d.date), axisLabel: { fontSize: 10 } },
      yAxis: { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => `${v >= 10000 ? (v / 10000).toFixed(1) + "万" : v}` } },
      series: [
        { name: "组合净值(现金+市值)", type: "line", smooth: true, showSymbol: false, data: navSeries, lineStyle: { color: C.accent, width: 2 }, areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(37,99,235,.18)" }, { offset: 1, color: "rgba(37,99,235,.02)" }] } } },
        { name: "持仓市值(成本)", type: "line", smooth: true, showSymbol: false, data: daily.map((d) => Math.round(d.marketValue)), lineStyle: { color: "#94a3b8", width: 1.5, type: "dashed" } },
        { name: "累计已实现", type: "line", smooth: true, showSymbol: false, data: cumRealized, lineStyle: { color: C.gain, width: 1.5, type: "dotted" } },
      ],
    };
  }, [analysis]);

  const monthOption = useMemo<echarts.EChartsOption>(() => {
    if (!analysis) return {};
    const months = analysis!.monthlySeries.map((m) => m.month);
    return {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      legend: { data: ["买入", "卖出回款", "已实现"], top: 0, textStyle: { fontSize: 11 } },
      grid: { left: 8, right: 8, bottom: 0, top: 28, containLabel: true },
      xAxis: { type: "category", data: months, axisLabel: { fontSize: 10 } },
      yAxis: { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => `${v >= 10000 ? (v / 10000).toFixed(1) + "万" : v}` } },
      series: [
        { name: "买入", type: "bar", data: analysis!.monthlySeries.map((m) => Math.round(m.buyAmount)), itemStyle: { color: "#93c5fd" }, barMaxWidth: 18 },
        { name: "卖出回款", type: "bar", data: analysis!.monthlySeries.map((m) => Math.round(m.sellAmount)), itemStyle: { color: "#c4b5fd" }, barMaxWidth: 18 },
        { name: "已实现", type: "bar", data: analysis!.monthlySeries.map((m) => Math.round(m.realizedPnl)), itemStyle: { color: "#f59e0b" }, barMaxWidth: 18 },
      ],
    };
  }, [analysis]);

  const filteredEntries = useMemo(() => {
    return entries.filter((e) => {
      if (fGroup !== "all" && e.groupId !== fGroup) return false;
      if (fAction !== "all" && e.action !== fAction) return false;
      if (fCode.trim() && !e.code.includes(fCode.trim()) && !(e.name ?? "").includes(fCode.trim())) return false;
      if (fFrom && e.date < fFrom) return false;
      if (fTo && e.date > fTo) return false;
      return true;
    });
  }, [entries, fGroup, fAction, fCode, fFrom, fTo]);

  // 流水分页：每页 100（长流水不卡顿）
  const PAGE_SIZE = 100;
  const pagedEntries = filteredEntries.slice(0, ledgerPage * PAGE_SIZE);
  const hasMore = pagedEntries.length < filteredEntries.length;

  const openCreate = () => {
    if (groups.length === 0) { setMsg("请先创建一个分组，再记交易"); return; }
    setEditingEntry(null);
    setEntryEditorOpen(true);
  };
  const openEdit = (e: TradeV2Entry) => {
    setEditingEntry(e);
    setEntryEditorOpen(true);
  };
  const removeEntry = async (e: TradeV2Entry) => {
    if (!window.confirm(`删除 ${e.date} ${e.name ?? e.code} 的这笔${e.action === "buy" ? "买入" : "卖出"}？仓位/盈亏将自动重算。`)) return;
    try {
      await api.tradeV2DeleteEntry(e.id);
      await reloadAll();
    } catch (err) {
      setMsg("❌ " + errMsg(err));
    }
  };

  /** 盈亏率基准（对持仓成本）：浮动/已实现/未实现/总 各带率——金额与率成对（资金逻辑链） */
  const floatPnl = cur ? cur.unrealizedPnl : 0; // 真实未实现（负成本标的计入；totalCost 为 V1 正成本口径）
  const floatRate = cur && cur.totalCost > 0 && !cur.negCount ? (floatPnl / cur.totalCost) * 100 : undefined;
  const totalRate = cur && cur.totalCost > 0 && !cur.negCount ? (cur.totalPnl / cur.totalCost) * 100 : undefined;
  const realizedRate = cur && cur.totalCost > 0 && !cur.negCount ? (cur.realizedPnl / cur.totalCost) * 100 : undefined;
  const unrealizedRate = cur && cur.totalCost > 0 && !cur.negCount ? (cur.unrealizedPnl / cur.totalCost) * 100 : undefined;

  const groupTabStyle = (sel: boolean, hover = false): React.CSSProperties => ({
    padding: "0.4rem 0.85rem",
    borderRadius: 10,
    border: "1.5px solid " + (sel ? C.accent : C.faint),
    background: sel ? C.accentBg : hover ? C.panel : "#fff",
    color: sel ? "#1d4ed8" : C.sub,
    fontSize: "0.82rem",
    cursor: "pointer",
    fontWeight: 600,
    boxShadow: sel ? "0 1px 2px rgba(37,99,235,0.15)" : "none",
    transition: "all .15s ease",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: "1.125rem", fontWeight: 700, margin: 0, color: C.text }}>📋 {isGroupView && selectedGroup ? selectedGroup.name : "仓位管理 v2"}</h1>
        <div style={{ fontSize: "0.82rem", color: C.sub }}>逐笔交易 → 仓位自动归并 · 分组约束 · 收益分析 · 每日交易单</div>
        <div style={{ flex: 1 }} />
        <Button size="sm" onClick={openCreate}>➕ 记一笔交易</Button>
      </div>

      {msg && <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0.5rem 0.8rem", borderRadius: 8, fontSize: "0.84rem", fontWeight: 500, border: "1px solid " + C.gainBorder, background: C.gainBg, color: "#b91c1c" }}>{msg}</div>}

      {loading ? (
        <div style={{ padding: "3rem", textAlign: "center", color: C.muted }}>加载中…</div>
      ) : groups.length === 0 ? (
        <Card><CardContent style={{ padding: "2rem", textAlign: "center", color: C.sub }}>
          <div style={{ fontSize: "2rem" }}>🗂️</div>
          还没有分组。先「新建分组」（如策略），再「记一笔交易」——仓位明细与分析会自动生成。
        </CardContent></Card>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: "0.8rem", fontWeight: 700, color: C.sub }}>分组</span>
            <button onClick={() => { setSelectedId("all"); try { localStorage.setItem("tradeV2:selectedGroup", "all"); } catch {} }} onMouseEnter={() => setPillHover("all")} onMouseLeave={() => setPillHover(null)} style={groupTabStyle(selectedId === "all", pillHover === "all")}>
              全部组合（{groups.length}）
            </button>
            {groups.map((g) => {
              const sel = selectedId === g.id;
              return (
                <button key={g.id} onClick={() => { setSelectedId(g.id); try { localStorage.setItem("tradeV2:selectedGroup", g.id); } catch {} }} onMouseEnter={() => setPillHover(g.id)} onMouseLeave={() => setPillHover(null)} style={groupTabStyle(sel, pillHover === g.id)}>
                  {g.name}
                  {g.openCount > 0 ? `（${g.openCount}）` : ""}
                  {g.riskCount ? <span style={{ marginLeft: 4, color: "#b45309" }}>⚠️{g.riskCount}</span> : null}
                </button>
              );
            })}
            <div style={{ flex: 1 }} />
            {isGroupView && selectedGroup && (
              <Button size="sm" variant="outline" onClick={() => { setEditingGroup(selectedGroup); setGroupEditorOpen(true); }}>⚙️ 分组设置</Button>
            )}
            <Button size="sm" variant="outline" onClick={() => { setEditingGroup(null); setGroupEditorOpen(true); }}>🗂️ 新建分组</Button>
                      </div>

          {/* 功能区横向分段控件（通栏等宽）——置于具体功能区上方 */}
          <Tabs value={activeTab} onValueChange={setTab}>
            <TabsList style={{ width: "100%" }}>
              {!isGroupView && <TabsTrigger value="analysis-global" style={{ flex: 1 }}>🧩 组合分析</TabsTrigger>}
              <TabsTrigger value="analysis" style={{ flex: 1 }}>📊 收益分区</TabsTrigger>
              <TabsTrigger value="positions" style={{ flex: 1 }}>📈 仓位明细</TabsTrigger>
              <TabsTrigger value="ledger" style={{ flex: 1 }}>💹 交易流水</TabsTrigger>
            </TabsList>

            {/* 共享统计区：Tab 条之下、各功能区内容之上（始终可见） */}
            <SectionTitle icon="📊" color={C.indigo}>资金概览（市值 − 成本 = 浮动盈亏；已实现 + 未实现 = 总盈亏；仓位控制在右下）</SectionTitle>
            {cur && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10 }}>
              {/* 资金逻辑链①：市值 − 成本 = 浮动盈亏（金额与率成对） */}
              <StatGroup title="持仓" icon="📦" tone="blue" items={[
                { label: "持仓市值", value: cny(cur.totalMv), sub: cur.positionPct !== undefined ? `占总仓位 ${pct(cur.positionPct)}` : undefined },
                { label: "持仓成本", value: cny(cur.totalCost), sub: cur.negCount ? `不含 ${cur.negCount} 个负成本（已回本）· 净投入 ${cny(cur.invested)}` : `累计净投入 ${cny(cur.invested)}` },
                { label: "浮动盈亏", value: pnlText(floatPnl), color: pnlColor(floatPnl), sub: floatRate !== undefined ? `浮动率 ${pctSigned(floatRate)}` : undefined },
              ]} />
              {/* 资金逻辑链②：已实现（落袋）+ 未实现（浮动）= 总盈亏，各带率 */}
              <StatGroup title="盈亏" icon="💰" tone="red" items={[
                { label: "已实现", value: pnlText(cur.realizedPnl), color: pnlColor(cur.realizedPnl), sub: cur.realizedPnl !== 0 && realizedRate !== undefined ? `率 ${pctSigned(realizedRate)}` : undefined },
                { label: "未实现", value: pnlText(cur.unrealizedPnl), color: pnlColor(cur.unrealizedPnl), sub: cur.unrealizedPnl !== 0 && unrealizedRate !== undefined ? `率 ${pctSigned(unrealizedRate)}` : undefined },
                { label: "总盈亏", value: pnlText(cur.totalPnl), color: pnlColor(cur.totalPnl), sub: cur.totalPnl !== 0 && totalRate !== undefined ? `总率 ${pctSigned(totalRate)}` : undefined },
              ]} />
              {isGroupView ? (
                <StatGroup title="仓位" icon="🏦" tone="emerald" items={[
                  { label: "今日加仓", value: cny(cur.todayAdd ?? 0) },
                  { label: "剩余可用", value: cny(cur.remaining ?? 0) },
                  { label: "累计净投入", value: cny(cur.invested) },
                ]} />
              ) : (
                <StatGroup title="组合整体" icon="🧩" tone="amber" items={[
                  { label: "组合数", value: `${groups.length} 组`, sub: `在途 ${cur.openCount} 笔` },
                  { label: "组合盈亏", value: pnlText(global?.totalPnl), color: pnlColor(global?.totalPnl), sub: globalRate !== undefined ? `盈亏率 ${pctSigned(globalRate)}` : undefined },
                  { label: "集中度", value: maxGroup ? pct(maxGroup.pct) : "—", sub: maxGroup ? `最大：${maxGroup.name}` : undefined },
                ]} />
              )}
            </div>
          )}

            {!isGroupView && (
              <TabsContent value="analysis-global">
          {/* 全部视图：分组贡献明细（点击行跳转该组） */}
          {!isGroupView && global && (
            <GroupContributionTable groups={groups} globalMv={global.totalMv} onSelect={(id) => { setSelectedId(id); try { localStorage.setItem("tradeV2:selectedGroup", id); } catch {} }} />
          )}

          {!isGroupView && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Card><CardContent>
                <SectionTitle icon="🥧" color={C.indigo}>分组市值占比</SectionTitle>
                <EChart option={pieOption} height={220} />
              </CardContent></Card>
              <Card><CardContent>
                <SectionTitle icon="📊" color={C.indigo}>分组盈亏对比（已实现 + 未实现）</SectionTitle>
                <EChart option={barOption} height={220} />
              </CardContent></Card>
              <Card style={{ gridColumn: "1 / -1" }}><CardContent>
                <SectionTitle icon="📈" color={C.indigo}>累计已实现盈亏曲线（按清仓日）</SectionTitle>
                <EChart option={globalLineOption} height={200} />
              </CardContent></Card>
              <Card style={{ gridColumn: "1 / -1" }}><CardContent>
                <SectionTitle icon="📊" color={C.indigo}>组合净值曲线（现金+市值口径 · 历史价：期初本金 + 已实现 + 未实现）</SectionTitle>
                <EChart option={globalScaleOption} height={220} />
              </CardContent></Card>
            </div>
          )}
              </TabsContent>
            )}

            {(isGroupView && analysis) || (!isGroupView && global) ? (
              <TabsContent value="analysis">
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {isGroupView && analysis && (
                  <>
                  {analysis!.dailySeries.length === 0 && (
                    <Card><CardContent style={{ padding: "1.2rem", textAlign: "center" }}>
                      <div style={{ fontSize: "1.6rem", marginBottom: 6 }}>🗒️</div>
                      <div style={{ fontSize: "0.9rem", fontWeight: 600, color: C.text, marginBottom: 4 }}>该分组还没有任何交易</div>
                      <div style={{ fontSize: "0.8rem", color: C.muted, marginBottom: 10 }}>去「💼 交易单」记入第一笔买入（期初建仓），仓位明细与收益分析会自动生成。</div>
                      <Button size="sm" onClick={() => setTab("order")}>💼 去记一笔交易</Button>
                    </CardContent></Card>
                  )}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <Card><CardContent>
                      <SectionTitle icon="🍩" color={C.accent}>收益构成（已实现 vs 未实现）</SectionTitle>
                      {Math.abs(analysis!.realizedPnl) + Math.abs(analysis!.unrealizedPnl) > 0 ? <EChart option={donutOption} height={220} /> : <div style={{ color: C.muted, fontSize: "0.8rem", padding: "2rem 0", textAlign: "center" }}>暂无收益</div>}
                    </CardContent></Card>
                    <Card><CardContent>
                      <SectionTitle icon="🏆" color={C.accent}>收益归因（Top 10 标的，红涨绿跌）</SectionTitle>
                      {analysis!.pnlAttribution.length > 0 ? <EChart option={attrOption} height={220} /> : <div style={{ color: C.muted, fontSize: "0.8rem", padding: "2rem 0", textAlign: "center" }}>暂无交易</div>}
                    </CardContent></Card>
                    <Card style={{ gridColumn: "1 / -1" }}><CardContent>
                      <SectionTitle icon="📊" color={C.accent}>组合净值曲线（现金+市值口径 · 历史价时间性）</SectionTitle>
                      <EChart option={scaleOption} height={220} />
                    </CardContent></Card>
                    <Card style={{ gridColumn: "1 / -1" }}><CardContent>
                      <SectionTitle icon="🗓️" color={C.accent}>月度买入/卖出/已实现（时间性）</SectionTitle>
                      <EChart option={monthOption} height={220} />
                    </CardContent></Card>
                  </div>
                  <DailyTable dailySeries={analysis!.dailySeries} />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <MonthlyTable monthlySeries={analysis!.monthlySeries} />
                    <AttributionTable attribution={analysis!.pnlAttribution} onRowClick={(a) => setStockDlg({ code: a.code, name: a.name })} />
                  </div>
                  <PerformanceCard deals={analysis!.deals} />
                  <DealsTable deals={analysis!.deals} />
                  </>
                  )}
                </div>
                  {!isGroupView && global && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <Card style={{ gridColumn: "1 / -1" }}><CardContent>
                        <SectionTitle icon="📅" color={C.accent}>组合每日动态（历史价口径 · 跨组合合并）</SectionTitle>
                        <DailyTable dailySeries={global.dailySeries} />
                      </CardContent></Card>
                    </div>
                  )}
              </TabsContent>
            ) : null}

            <TabsContent value="positions">
              <PositionsTable
                positions={isGroupView && analysis ? analysis.positions : positionsFromGlobal(entries)}
                groupView={isGroupView}
                onRowClick={(p) => setStockDlg({ code: p.code, name: p.name })}
                exportName={isGroupView && selectedGroup ? `仓位明细_${selectedGroup.name}.csv` : "全部持仓.csv"}
              />
            </TabsContent>


            <TabsContent value="ledger">
              {/* 分组视图：交易流水整合录入（记一笔/批量提交 → 流水下方即时可见） */}
              {isGroupView && selectedGroup && analysis && (
                <OrderSheet
                  initialGroup={selectedGroup}
                  groups={groups}
                  allEntries={entries}
                  todayAdd={analysis.todayAdd}
                  positions={analysis.positions}
                  onSubmitted={() => void reloadAll()}
                  onEditEntry={openEdit}
                  onDeleteEntry={(e) => void removeEntry(e)}
                />
              )}
              <Card><CardContent>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                  <Select value={fGroup} onValueChange={(v: string | null) => setFGroup(v ?? "all")}>
                    <SelectTrigger className="w-36"><SelectValue placeholder="全部分组" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部分组</SelectItem>
                      {groups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select value={fAction} onValueChange={(v: string | null) => setFAction(v ?? "all")}>
                    <SelectTrigger className="w-28"><SelectValue placeholder="全部操作" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部操作</SelectItem>
                      <SelectItem value="buy">买入</SelectItem>
                      <SelectItem value="sell">卖出</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input className="h-8 w-36" placeholder="名称/代码过滤" value={fCode} onChange={(e) => setFCode(e.target.value)} />
                  <Input type="date" className="h-8 w-36" value={fFrom} onChange={(e) => setFFrom(e.target.value)} />
                  <span style={{ color: C.muted, fontSize: "0.8rem" }}>至</span>
                  <Input type="date" className="h-8 w-36" value={fTo} onChange={(e) => setFTo(e.target.value)} />
                  <span style={{ color: C.sub, fontSize: "0.8rem" }}>共 {filteredEntries.length} 笔</span>
                  <div style={{ flex: 1 }} />
                  <Button size="sm" variant="outline" onClick={() => downloadCSV("交易流水.csv", ["日期", "分组", "代码", "名称", "操作", "数量", "价格", "金额", "手续费", "备注"], filteredEntries.map((e) => [e.date, groupById.get(e.groupId)?.name ?? "", e.code, e.name ?? "", e.action === "buy" ? "买入" : "卖出", e.quantity, e.price, Math.round(e.quantity * e.price * 100) / 100, e.fee ?? "", e.note ?? ""]))}>📤 导出 CSV</Button>
                </div>

                {filteredEntries.length === 0 ? (
                  <div style={{ padding: "1.5rem", textAlign: "center", color: C.muted, fontSize: "0.85rem" }}>暂无符合条件的交易。</div>
                ) : (
                  <div style={{ maxHeight: 520, overflow: "auto" }}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="sticky top-0 z-10 bg-white">日期</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white">分组</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white">标的</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white">操作</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white text-right">数量</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white text-right">价格</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white text-right">金额</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white text-right">手续费</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white">备注</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-white text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pagedEntries.map((e) => {
                        const amount = e.quantity * e.price;
                        const g = groupById.get(e.groupId);
                        return (
                          <TableRow key={e.id}>
                            <TableCell className="whitespace-nowrap">{e.date}</TableCell>
                            <TableCell><Badge variant="outline" style={{ background: "#f1f5f9" }}>{g?.name ?? "—"}</Badge></TableCell>
                            <TableCell>
                              <NameCode name={e.name} code={e.code} />
                              {e.initial && <Badge style={{ marginLeft: 6, background: "#fef3c7", color: "#b45309" }}>期初</Badge>}
                            </TableCell>
                            <TableCell>
                              <Badge style={e.action === "buy" ? { background: C.gainBg, color: C.gain } : { background: C.lossBg, color: C.loss }}>
                                {e.action === "buy" ? "买入" : "卖出"}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right">{qtyFmt(e.quantity)}</TableCell>
                            <TableCell className="text-right">{costFmt(e.price)}</TableCell>
                            <TableCell className="text-right">{cny2(amount)}</TableCell>
                            <TableCell className="text-right">{e.fee ? cny2(e.fee) : "—"}</TableCell>
                            <TableCell style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.sub, fontSize: "0.8rem" }}>{e.note ?? ""}</TableCell>
                            <TableCell>
                              <span style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => openEdit(e)}>编辑</Button>
                                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-red-500 hover:bg-red-50" onClick={() => void removeEntry(e)}>删除</Button>
                              </span>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  </div>
                )}
                {hasMore && (
                  <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
                    <Button variant="outline" size="sm" onClick={() => setLedgerPage((p) => p + 1)}>显示更多（已显示 {pagedEntries.length} / {filteredEntries.length} 笔）</Button>
                  </div>
                )}
              </CardContent></Card>
            </TabsContent>
          </Tabs>
        </>
      )}

      <EntryEditor open={entryEditorOpen} onClose={() => setEntryEditorOpen(false)} groups={groups} initial={editingEntry} onSaved={() => void reloadAll()} />
      <GroupEditor open={groupEditorOpen} onClose={() => setGroupEditorOpen(false)} groups={groups} initial={editingGroup} onSaved={() => void reloadAll()} />
            <StockHistoryDialog
        open={!!stockDlg}
        onClose={() => setStockDlg(null)}
        code={stockDlg?.code ?? ""}
        name={stockDlg?.name}
        scopeName={isGroupView && selectedGroup ? selectedGroup.name : "全部组合"}
        entries={groupEntries}
        positions={isGroupView && analysis ? analysis.positions : positionsFromGlobal(entries)}
        deals={analysis?.deals ?? []}
      />
    </div>
  );
}
