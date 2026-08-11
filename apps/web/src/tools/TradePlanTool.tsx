// ============================================================
// 交易规划（tools/trade-plan）—— shadcn/ui 重写版
// 多策略：每策略独立配置（总仓位/交易标的/单日加仓上限）+ 当前仓位（positions，独立管理）。
// 日度交易计划保存即应用：自动按计划更新当前仓位（同日覆盖先回滚再重应用）。
// 标的输入支持名称搜索补全（复用专题自选股 search-stock）。
// 业务逻辑（状态/回调/校验）与重写前一致；UI 渲染层用 shadcn/ui 组件。
// ============================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  TradePlanAlert,
  TradePlanCheckResult,
  TradePlanDealSummary,
  TradePlanItem,
  TradePlanStrategy,
  TradePlanStrategySummary,
  TradePlanDay,
  TradePlanPnl,
  TradePlanPosition,
} from "@toolbox/shared";
import { api, errMsg } from "../api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const alertColor: Record<TradePlanAlert["level"], string> = { error: "#dc2626", warn: "#d97706", info: "#2563eb" };
const alertBg: Record<TradePlanAlert["level"], string> = { error: "#fef2f2", warn: "#fffbeb", info: "#eff6ff" };
const cny = (v: number) => `¥${Math.round(v).toLocaleString("zh-CN")}`;
/** 金额保留 2 位小数（盈亏等不截断整数）；负数带符号 */
const cny2 = (v: number) => `${v < 0 ? "-¥" : "¥"}${Math.abs(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** 成本价显示不截断：保留 6 位并去尾零（0.1 → "0.1"，0.123456 → "0.123456"） */
const costFmt = (v?: number) => (typeof v === "number" && !isNaN(v) ? String(+v.toFixed(6)) : "—");
/** 日度计划条目文本：数量（股）+ 可选约金额（有成本价时）——避免把数量当金额显示 */
/** Base UI Slider onValueChange 的 value 可能是 number（单值）或数组，统一取数值 */
const sliderNum = (v: number | readonly number[]): number => (typeof v === "number" ? v : (v[0] ?? 0));
const itemText = (it: TradePlanItem, price?: number) => {
  const cost = it.cost ?? price;
  const money = typeof cost === "number" && !isNaN(cost) ? it.amount * cost : 0;   // 负/零成本合法
  const act = it.action === "add" ? "加仓" : "减仓";
  const px = typeof cost === "number" && !isNaN(cost) && cost !== 0 ? costFmt(cost) : "";
  return `${it.name ? it.name + " " : ""}${it.code} ${act} ${it.amount.toLocaleString("zh-CN")} 股${px ? ` @ ¥${px}` : ""}${money !== 0 ? ` ≈ ${cny2(money)}` : ""}`;
};
/** 消除前导零（如 "007" → "7"；避免输入框/计算异常） */
const stripLeadZeros = (v: string) => v.replace(/^0+(?=\d)/, "");
const numInput = (v: string) => Number(stripLeadZeros(v).replace(/[,，\s]/g, "")) || 0;

/** 数字输入 + 上下步进（半受控：输入过程保留原始文本含中间态 "1."，失焦/步进才提交） */
function StepInput({ value, onChange, step = 1, min = 0, max, width = "w-20", placeholder, title }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; width?: string; placeholder?: string; title?: string }) {
  const [text, setText] = useState<string | null>(null);
  const clamp = (v: number) => {
    let r = Math.round(v * 1e6) / 1e6;
    if (max !== undefined) r = Math.min(max, r);
    return Math.max(min, r);
  };
  const commit = (v: number) => {
    onChange(clamp(v));
    setText(null);
  };
  const parsed = (): number => {
    const n = numInput(text ?? "");
    return Number.isFinite(n) ? n : 0;
  };
  const stepFn = (dir: 1 | -1) => () => {
    // 基值 = 输入中的 text（若有）否则当前 value——避免未输入时从 0 步进
    const base = text !== null ? parsed() : value;
    commit(base + dir * step);
  };
  return (
    <span className="inline-flex items-center gap-0.5">
      <Input
        type="text"
        inputMode="decimal"
        className={cn("h-8 px-2 text-sm", width)}
        value={text ?? (value !== 0 ? value.toLocaleString("zh-CN") : "")}   // 负数成本/金额也显示（原 value>0 时 -1.5 显示空）
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text !== null) commit(parsed()); }}
        placeholder={placeholder}
        title={title}
      />
      <span className="inline-flex flex-col gap-px">
        <Button type="button" variant="ghost" size="icon" className="h-3.5 w-4 text-[0.5rem] leading-none" onClick={stepFn(1)} title={`+${step}`}>▲</Button>
        <Button type="button" variant="ghost" size="icon" className="h-3.5 w-4 text-[0.5rem] leading-none" onClick={stepFn(-1)} title={`-${step}`}>▼</Button>
      </span>
    </span>
  );
}

export default function TradePlanTool() {
  const [strategies, setStrategies] = useState<TradePlanStrategySummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [strategy, setStrategy] = useState<TradePlanStrategy | null>(null);
  const [pnl, setPnl] = useState<TradePlanPnl | null>(null);   // 盈亏（详情接口附行情）
  const [deals, setDeals] = useState<TradePlanDealSummary | null>(null);   // 交易复盘（详情接口附）
  const [showDeals, setShowDeals] = useState(false);   // 交易复盘明细展开
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [listMsg, setListMsg] = useState<string | null>(null);

  const [date, setDate] = useState(() => {
    // 默认下一个交易日：周六/周日 → 下周一
    const n = new Date();
    const d = n.getDay();
    if (d === 0) n.setDate(n.getDate() + 1);
    else if (d === 6) n.setDate(n.getDate() + 2);
    return n.toISOString().slice(0, 10);
  });
  const [items, setItems] = useState<TradePlanItem[]>([]);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<TradePlanCheckResult | null>(null);
  const [dayMsg, setDayMsg] = useState<string | null>(null);
  const [days, setDays] = useState<TradePlanDay[]>([]);
  const [viewDay, setViewDay] = useState<TradePlanDay | null>(null);
  const [calView, setCalView] = useState(false);
  const [allCalOpen, setAllCalOpen] = useState(false);
  const [cfgCollapsed, setCfgCollapsed] = useState(false);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<"none" | "desc" | "asc">("none");
  const [newStock, setNewStock] = useState<{ code: string; name?: string; maxWeightPct?: number }>({ code: "" });
  const [cfgMsg, setCfgMsg] = useState<string | null>(null);
  const [addMsg, setAddMsg] = useState<string | null>(null);
  const savedCfgRef = useRef<string>("");

  const loadStrategies = useCallback(async () => {
    setListLoading(true);
    try {
      const r = await api.tradePlanStrategies();
      setStrategies(r.strategies);
      setSelectedId((prev) => (prev && r.strategies.some((s) => s.id === prev) ? prev : r.strategies[0]?.id ?? ""));
    } catch (e) {
      setMsg("❌ 策略列表加载失败：" + errMsg(e));
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStrategies();
  }, [loadStrategies]);

  useEffect(() => {
    if (!selectedId) return;
    void api.tradePlanStrategy(selectedId).then((r) => {
      if (r.ok && r.strategy) {
        setStrategy(r.strategy);
        savedCfgRef.current = JSON.stringify(r.strategy);
        setPnl(r.pnl ?? null);   // 盈亏（详情接口附行情计算）
        setDeals(r.deals ?? null);   // 交易复盘（详情接口附）
      }
      setResult(null);
      setViewDay(null);
      setItems([]);
      void loadDays(selectedId);
    }).catch(() => {});
 
  }, [selectedId]);

  const loadDays = useCallback(async (sid: string) => {
    try {
      const r = await api.tradePlanDays(sid);
      setDays(r.days);
    } catch { /* 静默 */ }
  }, []);

  const saveCfg = useCallback(async (strat?: TradePlanStrategy, opts?: { silent?: boolean }) => {
    const s = strat ?? strategy;
    if (!s) return;
    const bad = s.stocks.find((x) => x.maxWeightPct !== undefined && (x.maxWeightPct < 0 || x.maxWeightPct > 100));
    if (bad) {
      setCfgMsg("❌ 标的 " + (bad.code || "（未填代码）") + " 的仓位上限需在 0-100% 之间");
      return;
    }
    const badPos = s.positions.find((x) => x.code && x.quantity > 0 && (typeof x.avgCost !== "number" || isNaN(x.avgCost)));   // 负数成本合法
    if (badPos) {
      setCfgMsg("❌ 标的 " + badPos.code + " 当前数量为 " + badPos.quantity + "，成本价必填");
      return;
    }
    setCfgMsg(null);
    try {
      const r = await api.tradePlanSaveStrategy(s.id, s);
      if (r.ok && r.strategy) setStrategy(r.strategy);
      savedCfgRef.current = JSON.stringify(r.strategy ?? s);
      if (!opts?.silent) {
        setCfgMsg("✅ 已自动保存");
        setTimeout(() => setCfgMsg((m) => (m && m.startsWith("✅") ? null : m)), 2000);
      }
      await loadStrategies();
    } catch (e) {
      setCfgMsg("❌ 保存失败：" + errMsg(e));
    }
  }, [strategy]);
  // 配置修改统一入口：patchStrategy 计算 next 并 setStrategy，随后防抖自动保存（传最新 next，
  // 避免 setTimeout 闭包捕获旧 strategy 导致保存旧值；防抖合并滑块/连续步进的多次触发）
  const cfgSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleCfgSave = (strat: TradePlanStrategy) => {
    if (cfgSaveTimer.current) clearTimeout(cfgSaveTimer.current);
    cfgSaveTimer.current = setTimeout(() => { void saveCfg(strat, { silent: true }); }, 400);
  };
  const patchStrategy = (patch: (prev: TradePlanStrategy) => TradePlanStrategy) => {
    if (!strategy) return;
    const next = patch(strategy);
    setStrategy(next);
    scheduleCfgSave(next);
  };
  const createSt = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const r = await api.tradePlanCreateStrategy(name);
      setNewName("");
      if (r.ok && r.strategy) setSelectedId(r.strategy.id);
      await loadStrategies();
    } catch (e) {
      setListMsg("❌ " + errMsg(e));
    } finally {
      setCreating(false);
    }
  };

  const deleteSt = async (id: string, name: string) => {
    if (!confirm(`确定删除策略「${name}」？该策略的全部日度计划将一并删除。`)) return;
    try {
      await api.tradePlanDeleteStrategy(id);
      setSelectedId("");
      await loadStrategies();
    } catch (e) {
      setListMsg("❌ " + errMsg(e));
    }
  };

  const setStockAt = (i: number, patch: Partial<{ code: string; name?: string; maxWeightPct: number }>) => {
    patchStrategy((s) => {
      const stocks = s.stocks.slice();
      stocks[i] = { ...stocks[i], ...patch };
      return { ...s, stocks };
    });
  };
  const setPosByCode = (code: string, patch: Partial<{ quantity: number; avgCost: number }>) => {
    patchStrategy((s) => {
      const positions = s.positions.slice();
      const idx = positions.findIndex((p) => p.code === code);
      if (idx >= 0) positions[idx] = { ...positions[idx], ...patch };
      else if (code) positions.push({ code, quantity: patch.quantity ?? 0, avgCost: patch.avgCost ?? 0 });
      return { ...s, positions };
    });
  };
  const removeStockByCode = (code: string) => {
    patchStrategy((s) => ({
      ...s,
      stocks: s.stocks.filter((x) => x.code !== code),
      positions: s.positions.filter((p) => p.code !== code),
    }));
  };
  const addNewStock = () => {
    if (!strategy || !newStock.code.trim()) return;
    const code = newStock.code.trim();
    if (strategy.stocks.some((x) => x.code === code)) {
      setAddMsg("❌ 标的 " + code + " 已在策略中，不允许重复添加");
      setTimeout(() => setAddMsg((m) => (m && m.startsWith("❌") ? null : m)), 3000);
      return;
    }
    patchStrategy((s) => ({
      ...s,
      stocks: [
        { code, name: newStock.name, ...(newStock.maxWeightPct && newStock.maxWeightPct > 0 ? { maxWeightPct: newStock.maxWeightPct } : {}) },
        ...s.stocks,
      ],
    }));
    setNewStock({ code: "" });
    setAddMsg(null);
  };
  const mvOf = (code: string) => {
    const pos = strategy?.positions.find((p) => p.code === code);
    if (!pos || (pos.quantity || 0) <= 0) return 0;
    // 当前市值（最新价，fallback 成本价）——排序用市值而非成本（memo msohisx9）；
    // 内联计算避免引用后定义变量（marketValueOf/latestPriceOf 在其后声明，TDZ 崩溃）
    const price = pnl?.byCode[code]?.latestPrice ?? pos.avgCost ?? 0;
    return pos.quantity * price;
  };
  const viewStocks = useMemo(() => {
    if (!strategy || sortMode === "none") return strategy?.stocks ?? [];
    return [...strategy.stocks].sort((a, b) => {
      const d = mvOf(b.code) - mvOf(a.code);
      return sortMode === "desc" ? d : -d;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy, sortMode, pnl]);
  const setItemAt = (i: number, patch: Partial<TradePlanItem>) => {
    const next = items.slice();
    next[i] = { ...next[i], ...patch };
    setItems(next);
    setResult(null);
    scheduleAutoCheck(next);
  };

  /** 持仓标的最新价（pnl 详情接口附行情；无则 undefined） */
  const latestPriceOf = (code: string) => pnl?.byCode[code]?.latestPrice;
  /** 按最新价计算市值（无行情 fallback 成本价）——总市值按当前价格，成本无影响 */
  const marketValueOf = (p: TradePlanPosition) => p.quantity * (latestPriceOf(p.code) ?? p.avgCost ?? 0);
  /** 本地重算盈亏（成本/数量变化即时反映；用 pnl 的最新价，负成本 pnlPct undefined） */
  const pnlOfCode = (code: string) => {
    const price = latestPriceOf(code);
    const pos = strategy?.positions.find((x) => x.code === code);
    if (!price || !pos || pos.quantity <= 0) return undefined;
    const costValue = pos.quantity * (pos.avgCost ?? 0);
    const mv = pos.quantity * price;
    const pnlv = mv - costValue;
    if (costValue < 0) return { latestPrice: price, pnl: pnlv, costNegative: true };   // 负成本：显示盈亏金额，盈亏率无意义
    return { latestPrice: price, pnl: pnlv, pnlPct: costValue !== 0 ? (pnlv / costValue) * 100 : 0 };
  };

  const changeDate = (d: string) => {
    setDate(d);
    // 该日期已有计划 → 载入供修改（保存=同日覆盖）；无计划 → 空输入
    const existing = days.find((x) => x.date === d);
    if (existing && existing.items.length > 0) {
      setItems(existing.items.map((it) => ({ ...it })));
    } else {
      setItems([]);
    }
    setResult(null);
  };
  const autoCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAutoCheck = (list: TradePlanItem[]) => {
    if (autoCheckTimer.current) clearTimeout(autoCheckTimer.current);
    if (list.length === 0 || list.some((it) => !it.code || !it.amount)) return;
    autoCheckTimer.current = setTimeout(() => {
      void runCheck(false, list); // 传触发时的 list，避免闭包捕获旧 items state（闭包陷阱）
    }, 600);
  };

  const runCheck = async (save: boolean, list?: TradePlanItem[]) => {
    if (!strategy) return;
    const useItems = list ?? items;
    setChecking(true);
    setDayMsg(null);
    setResult(null);
    try {
      if (save) {
        const r = await api.tradePlanCreateDay(strategy.id, date, useItems);
        setResult(null);   // 保存成功：清检查结果，只保留「✅ 已保存并应用」提示（不与检查提示混淆）
        setItems([]);   // 保存成功即清空输入，防止重复保存同一计划
        const baseMsg = r.day?.applied ? `✅ 已保存 ${r.day.date} 并应用（当前仓位已自动更新）` : r.message ?? "已保存";
        setDayMsg(r.chainWarnings && r.chainWarnings.length > 0 ? `${baseMsg}\n⚠️ ${r.chainWarnings.join("\n⚠️ ")}` : baseMsg);
        await loadDays(strategy.id);
        if (r.strategy) {
          setStrategy(r.strategy);
          savedCfgRef.current = JSON.stringify(r.strategy);
        }
      } else {
        const r = await api.tradePlanCheck(strategy.id, useItems);
        setResult(r.result);
        if (r.result.ok) setDayMsg("校验通过，保存后自动应用并更新当前仓位");
      }
    } catch (e) {
      setDayMsg("❌ " + errMsg(e));
    } finally {
      setChecking(false);
    }
  };

  const deleteOne = async (dayId: string) => {
    if (!strategy) return;
    if (!confirm("删除该日度计划？已应用的计划会同步回滚当前仓位。")) return;
    try {
      const r = await api.tradePlanDeleteDay(strategy.id, dayId);
      if (viewDay?.id === dayId) setViewDay(null);
      if (r.chainWarnings && r.chainWarnings.length > 0) {
        setDayMsg(`⚠️ 已删除，但后续计划无法完整执行：\n${r.chainWarnings.join("\n⚠️ ")}`);
      }
      await loadDays(strategy.id);
      const r2 = await api.tradePlanStrategy(strategy.id);
      if (r2.ok && r2.strategy) {
        setStrategy(r2.strategy);
        savedCfgRef.current = JSON.stringify(r2.strategy);
      }
    } catch (e) {
      setDayMsg("❌ " + errMsg(e));
    }
  };

  const stockOptions = useMemo(() => strategy?.stocks ?? [], [strategy]);
  const displayResult = viewDay?.result ?? result;
  const isDirty = (strategy?.stocks ?? []).some((s) => s.code);
  const cfgUnsaved = () => !!strategy && !!savedCfgRef.current && JSON.stringify(strategy) !== savedCfgRef.current;
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (cfgUnsaved()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  });

  return (
    <div className="mx-auto max-w-[1240px] text-sm">
      <div className="mb-3">
        <h2 className="mb-0.5 text-lg font-bold">📋 策略仓位管理</h2>
        <div className="text-[0.82rem] text-slate-500">
          多策略管理：配置策略保护仓位不失控；每日输入交易计划，自动校验并应用更新当前仓位
        </div>
      </div>
      {msg && (
        <div className={cn("mb-2 flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[0.84rem] font-medium", msg.startsWith("❌") ? "border-red-300 bg-red-50 text-red-700" : "border-emerald-300 bg-emerald-50 text-emerald-700")}>
          {msg}
        </div>
      )}

      {/* 全部策略总计划已收敛到左栏「总仓位概览」功能区（2026-08-10） */}

      <div className="grid items-start gap-4" style={{ gridTemplateColumns: "280px 1fr" }}>
        {/* 左：总仓位概览功能区 + 策略列表 */}
        <div className="flex flex-col gap-3">
          <Card>
            <CardContent className="p-4">
              <div className="mb-2 font-bold"><span className="mr-1.5 inline-block h-4 w-1 rounded-full bg-blue-500 align-middle" />📊 总仓位概览</div>
              {(() => {
                const totCap = strategies.reduce((a, x) => a + (x.totalCapital || 0), 0);
                const totMv = strategies.reduce((a, x) => a + (x.pnl?.totalMv ?? 0), 0);   // 市价口径（与详情/概览一致；不再用成本口径 positionPct 反推）
                const totPct = totCap > 0 ? ((totMv / totCap) * 100).toFixed(1) : "—";
                const remain = Math.max(0, totCap - totMv);
                const card = "rounded-md border px-2 py-1.5";
                return (
                  <div className="grid grid-cols-2 gap-1.5">
                    <div className={`${card} border-blue-100 bg-blue-50/70`}>
                      <div className="text-[0.72rem] text-blue-700/70">总仓位</div>
                      <div className="truncate text-[0.9rem] font-bold text-blue-700">{cny(totCap)}</div>
                    </div>
                    <div className={`${card} border-indigo-100 bg-indigo-50/70`}>
                      <div className="text-[0.72rem] text-indigo-700/70">当前总市值</div>
                      <div className="truncate text-[0.9rem] font-bold text-indigo-700">{cny(totMv)}</div>
                    </div>
                    <div className={`${card} border-slate-100 bg-slate-50`}>
                      <div className="text-[0.72rem] text-slate-500">当前占比</div>
                      <div className={`text-[0.9rem] font-bold ${Number(totPct) > 80 ? "text-red-600" : "text-slate-800"}`}>{totPct}%</div>
                    </div>
                    <div className={`${card} border-emerald-100 bg-emerald-50/70`}>
                      <div className="text-[0.72rem] text-emerald-700/70">剩余可用</div>
                      <div className="truncate text-[0.9rem] font-bold text-emerald-700">{cny(remain)}</div>
                    </div>
                  </div>
                );
              })()}
              <Button variant="secondary" size="sm" className="mt-2 w-full" type="button" onClick={() => setAllCalOpen((v) => !v)}>
                {allCalOpen ? "▾ 收起全部策略总计划" : "📅 全部策略总计划"}
              </Button>
              {allCalOpen && (
                <div className="mt-2">
                  <AllCalendar />
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
            <div className="mb-2 font-bold"><span className="mr-1.5 inline-block h-4 w-1 rounded-full bg-indigo-500 align-middle" />📁 策略仓位列表</div>
            {listMsg && <div className="mb-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[0.76rem] text-red-700">{listMsg}</div>}
            <div className="mb-2 flex gap-1.5">
              <Input
                className="min-w-0 flex-1"
                placeholder="新策略名称"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void createSt(); }}
              />
              <Button onClick={() => void createSt()} disabled={creating || !newName.trim()} type="button">＋</Button>
            </div>
            {listLoading && <div className="text-[0.82rem] text-slate-400">加载中…</div>}
            {!listLoading && strategies.length === 0 && <div className="text-[0.82rem] text-slate-400">暂无策略，先新建一个</div>}
            {strategies.map((s) => (
              <div
                key={s.id}
                onClick={() => { if (cfgUnsaved() && !confirm("策略配置有改动尚未保存，确定切换？")) return; setSelectedId(s.id); }}
                className={cn("mb-1.5 flex cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] px-2.5 py-2", selectedId === s.id ? "border-blue-600 bg-blue-50" : "border-slate-200 bg-white")}
              >
                <div className="min-w-0 flex-1">
                  <div className={cn("text-[0.9rem] font-bold", selectedId === s.id ? "text-blue-600" : "text-slate-800")}>{s.name}</div>
                  <div className="text-[0.76rem] leading-snug text-slate-500">
                    仓位 {cny(s.totalCapital)} · 当前市值 {s.pnl ? cny(s.pnl.totalMv) : "—"}
                    {s.pnl && s.pnl.negCount > 0 ? (
                      <> · 浮动盈亏 <span className={s.pnl.totalPnl > 0 ? "font-semibold text-red-600" : "font-semibold text-emerald-600"}>{s.pnl.totalPnl > 0 ? "+" : ""}{cny2(s.pnl.totalPnl)}（—）</span></>
                    ) : s.pnl && s.pnl.totalCost > 0 ? (
                      <> · 浮动盈亏 <span className={s.pnl.totalPnl > 0 ? "font-semibold text-red-600" : "font-semibold text-emerald-600"}>{s.pnl.totalPnl > 0 ? "+" : ""}{cny2(s.pnl.totalPnl)}（{s.pnl.totalPnlPct?.toFixed(2) ?? "—"}%）</span></>
                    ) : null}{" "}
                    · {s.stockCount} 标的 · {s.dayCount} 计划
                  </div>
                </div>
                <Button variant="ghost" size="sm" className="text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={(e) => { e.stopPropagation(); void deleteSt(s.id, s.name); }} title="删除策略" type="button">✕</Button>
              </div>
            ))}
          </CardContent>
          </Card>
        </div>

        {/* 右：选中策略 */}
        <div>
          {!strategy ? (
            <Card><CardContent className="p-6 text-center text-slate-400">请选择或新建一个策略</CardContent></Card>
          ) : (
            <>
              {/* 策略配置（可折叠） */}
              <Card className="mb-3">
                <CardContent className="p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="inline-block h-4 w-1 rounded-full bg-blue-500 align-middle" />
                    <span className="font-bold">⚙️ 策略仓位配置</span>
                    <Input
                      className="w-40 font-bold"
                      value={strategy.name}
                      onChange={(e) => patchStrategy((s) => ({ ...s, name: e.target.value }))}
                      placeholder="策略名称"
                    />
                    <span className="flex-1" />
                    <Button variant="secondary" size="sm" onClick={() => setCfgCollapsed((v) => !v)} type="button">
                      {cfgCollapsed ? "▸ 展开配置" : "▾ 收起"}
                    </Button>
                  </div>

                  {!cfgCollapsed && (
                    <>
                      {cfgMsg && <div className={cn("mb-2 rounded-lg border px-2.5 py-1.5 text-[0.8rem]", cfgMsg.startsWith("❌") ? "border-red-200 bg-red-50" : "border-emerald-200 bg-emerald-50")}>{cfgMsg}</div>}
                      <div className="mb-2 grid grid-cols-2 gap-2">
                        <label>
                          <span className="text-[0.8rem] text-slate-500">总仓位（元）</span>
                          <div className="mt-1"><StepInput value={strategy.totalCapital} onChange={(v) => patchStrategy((s) => ({ ...s, totalCapital: v }))} step={10000} width="w-36" placeholder="如 1000000" /></div>
                        </label>
                        <label>
                          <span className="text-[0.8rem] text-slate-500">单日加仓上限（元）</span>
                          <div className="mt-1"><StepInput value={strategy.dailyAddLimit} onChange={(v) => patchStrategy((s) => ({ ...s, dailyAddLimit: v }))} step={5000} width="w-36" placeholder="如 50000" /></div>
                        </label>
                      </div>

                      <div className="mb-1.5 text-[0.82rem] font-semibold text-slate-500">交易标的与当前仓位（点击 ✏️ 编辑行；新增在下方区域完成）</div>
                      {/* 当前仓位概览：彩色信息卡 + 占比色阶进度条 */}
                      {(() => {
                        const totalMv = strategy.positions.reduce((a, p) => a + marketValueOf(p), 0);   // 按最新价（memo：总市值按当前价格）
                        const pctNum = strategy.totalCapital > 0 ? (totalMv / strategy.totalCapital) * 100 : 0;
                        const pct = strategy.totalCapital > 0 ? pctNum.toFixed(1) : "—";
                        const held = strategy.positions.filter((p) => (p.quantity || 0) > 0).length;
                        const barColor = pctNum > 80 ? "#dc2626" : pctNum > 50 ? "#d97706" : "#16a34a";
                        const card = "rounded-lg border px-3 py-2";
                        return (
                          <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
                            <div className={`${card} border-blue-100 bg-blue-50/70`}>
                              <div className="text-[0.72rem] text-blue-700/70">总仓位</div>
                              <div className="text-[0.95rem] font-bold text-blue-700">{cny(strategy.totalCapital)}</div>
                            </div>
                            <div className={`${card} border-indigo-100 bg-indigo-50/70`}>
                              <div className="text-[0.72rem] text-indigo-700/70">当前总市值</div>
                              <div className="text-[0.95rem] font-bold text-indigo-700">{cny(totalMv)}</div>
                              {(() => {
                                let tp = 0, tc = 0, neg = false;
                                for (const x of strategy.positions) { const o = pnlOfCode(x.code); if (o) { tp += o.pnl; if (o.costNegative) neg = true; else tc += x.quantity * (x.avgCost ?? 0); } }
                                if (tp === 0 && tc === 0 && !neg) return null;
                                if (neg) return (
                                  <div className={`text-[0.74rem] font-semibold ${tp > 0 ? "text-red-600" : tp < 0 ? "text-emerald-600" : "text-slate-500"}`}>
                                    浮动盈亏 {tp > 0 ? "+" : ""}{cny2(tp)}（—）
                                  </div>
                                );
                                if (tc <= 0) return null;
                                return (
                                  <div className={`text-[0.74rem] font-semibold ${tp > 0 ? "text-red-600" : tp < 0 ? "text-emerald-600" : "text-slate-500"}`}>
                                    浮动盈亏 {tp > 0 ? "+" : ""}{cny2(tp)}（{((tp / Math.abs(tc)) * 100).toFixed(2)}%）
                                  </div>
                                );
                              })()}
                            </div>
                            <div className={`${card} border-slate-100 bg-slate-50`}>
                              <div className="text-[0.72rem] text-slate-500">总仓位占比</div>
                              <div className="text-[0.95rem] font-bold" style={{ color: barColor }}>{pct}%</div>
                              {/* 进度条底色加深（memo：进度条增加底色） */}
                              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-200">
                                <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, pctNum)}%`, background: barColor }} />
                              </div>
                            </div>
                            <div className={`${card} border-slate-100 bg-slate-50`}>
                              <div className="text-[0.72rem] text-slate-500">剩余可用</div>
                              <div className={`text-[0.95rem] font-bold ${strategy.totalCapital > 0 && totalMv > strategy.totalCapital ? "text-red-600" : "text-slate-800"}`}>
                                {cny(Math.max(0, strategy.totalCapital - totalMv))}
                              </div>
                            </div>
                            <div className="col-span-2 text-[0.78rem] text-slate-500 lg:col-span-4">持仓 {held} / {strategy.stocks.length} 标的</div>
                          </div>
                        );
                      })()}
                      {/* 交易复盘（Deal：加仓→清仓按笔配对，平均成本法归因；学习自 profitmaker Deals） */}
                      {deals && deals.closedCount + deals.openCount > 0 && (() => {
                        const d = deals;
                        const cell = "rounded-md border px-2 py-1";
                        const openDays = d.deals.filter((x) => x.status === "open");
                        return (
                          <div className="mb-3 rounded-lg border border-slate-100 bg-slate-50/70 p-2">
                            <div className="mb-1.5 flex items-center gap-1.5">
                              <span className="text-[0.82rem] font-semibold text-slate-700">📈 交易复盘</span>
                              <span className="text-[0.7rem] text-slate-400">加仓→清仓按笔配对 · 平均成本法</span>
                              <span className="flex-1" />
                              {d.deals.length > 0 && (
                                <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[0.72rem]" onClick={() => setShowDeals((v) => !v)} type="button">
                                  {showDeals ? "▾ 收起明细" : "▸ 交易明细"}
                                </Button>
                              )}
                            </div>
                            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6">
                              <div className={`${cell} border-slate-200 bg-white`}>
                                <div className="text-[0.7rem] text-slate-500">已完结 / 在途</div>
                                <div className="text-[0.85rem] font-bold">{d.closedCount} / {d.openCount} 笔</div>
                              </div>
                              <div className={`${cell} border-slate-200 bg-white`}>
                                <div className="text-[0.7rem] text-slate-500">胜率</div>
                                <div className="text-[0.85rem] font-bold text-emerald-700">{d.winRate !== undefined ? d.winRate.toFixed(1) + "%" : "—"}</div>
                              </div>
                              <div className={`${cell} border-slate-200 bg-white`}>
                                <div className="text-[0.7rem] text-slate-500">已实现盈亏</div>
                                <div className={`text-[0.85rem] font-bold ${d.realizedPnl >= 0 ? "text-red-600" : "text-emerald-600"}`}>{d.realizedPnl >= 0 ? "+" : ""}{cny2(d.realizedPnl)}</div>
                              </div>
                              <div className={`${cell} border-slate-200 bg-white`}>
                                <div className="text-[0.7rem] text-slate-500">总盈利 / 总亏损</div>
                                <div className="text-[0.82rem] font-bold"><span className="text-red-600">{cny2(d.totalProfit)}</span> / <span className="text-emerald-600">{cny2(d.totalLoss)}</span></div>
                              </div>
                              <div className={`${cell} border-slate-200 bg-white`}>
                                <div className="text-[0.7rem] text-slate-500">平均持仓</div>
                                <div className="text-[0.85rem] font-bold">{d.avgDays !== undefined ? d.avgDays.toFixed(1) + " 天" : "—"}</div>
                              </div>
                              <div className={`${cell} border-slate-200 bg-white`}>
                                <div className="text-[0.7rem] text-slate-500">在途最长</div>
                                <div className="text-[0.85rem] font-bold">{openDays.length > 0 ? Math.max(...openDays.map((x) => x.days ?? 0)) + " 天" : "—"}</div>
                              </div>
                            </div>
                            {showDeals && (
                              <div className="mt-1.5 max-h-40 overflow-auto rounded-md border border-slate-200 bg-white text-[0.76rem]">
                                {d.deals.map((dl, i) => (
                                  <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-slate-100 px-2 py-1 last:border-0">
                                    <span className="font-semibold">{strategy?.stocks.find((s) => s.code === dl.code)?.name ?? dl.code}</span>
                                    <span className={dl.status === "open" ? "text-blue-600" : "text-slate-500"}>{dl.status === "open" ? "🟦 在途" : "🟩 已完结"}</span>
                                    <span className="text-slate-500">{dl.entryDate}{dl.exitDate ? ` → ${dl.exitDate}` : ""}</span>
                                    <span className="text-slate-400">{dl.days} 天 · 买 {dl.buyQty.toLocaleString("zh-CN")} 股 @ {costFmt(dl.avgCost)}</span>
                                    {dl.status === "closed" && dl.pnl !== undefined && (
                                      <span className={`font-semibold ${dl.pnl >= 0 ? "text-red-600" : "text-emerald-600"}`}>{dl.pnl >= 0 ? "+" : ""}{cny2(dl.pnl)}</span>
                                    )}
                                    {dl.status === "open" && dl.qty > 0 && <span className="text-slate-400">剩 {dl.qty.toLocaleString("zh-CN")} 股</span>}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {/* 新增区 */}
                      <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-blue-200 bg-blue-50/50 p-2">
                        <span className="flex-shrink-0 text-[0.8rem] font-semibold text-blue-600">＋ 新增标的</span>
                        <StockCodeInput
                          code={newStock.code}
                          name={newStock.name}
                          onPick={(code, name) => setNewStock({ code, name })}
                          onChange={(code) => setNewStock({ code, name: undefined })}
                        />
                        <label className="flex flex-shrink-0 items-center gap-1.5 text-[0.76rem] text-slate-500">
                          上限
                          <Slider min={0} max={100} step={1} value={newStock.maxWeightPct ?? 0} onValueChange={(v) => setNewStock((st) => ({ ...st, maxWeightPct: sliderNum(v) || undefined }))} className="w-16" title="单标的上限（占总仓位百分比）" />
                          <StepInput value={newStock.maxWeightPct ?? 0} onChange={(v) => setNewStock((st) => ({ ...st, maxWeightPct: Math.min(100, v) || undefined }))} step={1} max={100} width="w-12" placeholder="%" />
                        </label>
                        <Button size="sm" onClick={addNewStock} disabled={!newStock.code.trim()} type="button">添加</Button>
                        {addMsg && <span className="flex-shrink-0 text-[0.76rem] text-red-600">{addMsg}</span>}
                        <span className="flex-1" />
                        <span className="flex-shrink-0 text-[0.78rem] text-slate-500">按市值排序：</span>
                        {([["none", "默认"], ["desc", "↓ 高→低"], ["asc", "↑ 低→高"]] as const).map(([v, l]) => (
                          <Button key={v} type="button" variant={sortMode === v ? "default" : "secondary"} size="sm" className="h-6 px-2 text-[0.76rem]" onClick={() => setSortMode(v)}>{l}</Button>
                        ))}
                      </div>
                      {strategy.stocks.length === 0 && <div className="mb-1 text-[0.8rem] text-slate-400">暂无标的，用上方新增区添加</div>}
                      {viewStocks.map((s, i) => {
                        const pos = strategy.positions.find((p) => p.code === s.code);
                        const mv = pos ? marketValueOf(pos) : 0;   // 按最新价
                        const pct = strategy.totalCapital > 0 ? ((mv / strategy.totalCapital) * 100).toFixed(1) : "—";
                        const isEdit = editingCode === s.code;
                        return (
                          <div key={s.code + "-" + i} className={cn("mb-1.5 rounded-lg border p-2", isEdit ? "border-blue-300 bg-blue-50" : "border-slate-100 bg-slate-50")}>
                            <div className="mb-1 flex items-center gap-1.5">
                              <span className="text-[0.85rem] font-semibold text-slate-800">{s.name ? s.name + " " + s.code : s.code}</span>
                              {mv > 0 && <Badge variant="secondary" className="text-[0.76rem]">{cny(mv)} · {pct}%</Badge>}
                              {(() => { const o = pnlOfCode(s.code); if (!o) return null; if (o.costNegative) return (
                                <Badge className={`border-amber-200 bg-amber-50 text-amber-700 text-[0.74rem]`}>最新 {o.latestPrice.toFixed(2)} · {o.pnl! > 0 ? "盈" : o.pnl! < 0 ? "亏" : "平"} {cny2(Math.abs(o.pnl!))}（—）</Badge>
                              ); return (
                                <Badge className={`text-[0.74rem] ${o.pnl! > 0 ? "border-red-200 bg-red-50 text-red-700" : o.pnl! < 0 ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-600"}`}>
                                  最新 {o.latestPrice.toFixed(2)} · {o.pnl! > 0 ? "盈" : o.pnl! < 0 ? "亏" : "平"} {cny2(Math.abs(o.pnl!))}（{o.pnlPct != null ? o.pnlPct.toFixed(2) + "%" : "—"}）
                                </Badge>
                              ); })()}
                              <span className="flex-1" />
                              <Button variant="secondary" size="sm" className="h-6 px-2 text-[0.76rem]" onClick={() => setEditingCode(isEdit ? null : s.code)} type="button">{isEdit ? "✅ 完成" : "✏️ 编辑"}</Button>
                              <Button variant="destructive" size="sm" className="h-6 px-2 text-[0.76rem]" title="移除标的（同步删除当前仓位）" onClick={() => { if (confirm("移除标的 " + (s.name || s.code) + "？（同步删除其当前仓位）")) removeStockByCode(s.code); }} type="button">✕</Button>
                            </div>
                            {isEdit ? (
                              <div className="mt-1 flex flex-wrap items-center gap-3">
                                <label className="flex items-center gap-1.5 text-[0.76rem] text-slate-500">
                                  单标的上限
                                  <Slider min={0} max={100} step={1} value={s.maxWeightPct ?? 0} onValueChange={(v) => setStockAt(i, { maxWeightPct: sliderNum(v) || 0 })} className="w-20" />
                                  <StepInput value={s.maxWeightPct ?? 0} onChange={(v) => setStockAt(i, { maxWeightPct: v })} step={1} max={100} width="w-12" placeholder="--" />%
                                </label>
                                <label className="flex items-center gap-1.5 text-[0.76rem] text-slate-500">
                                  当前数量
                                  <StepInput value={pos?.quantity ?? 0} onChange={(v) => setPosByCode(s.code, { quantity: v })} step={100} width="w-24" placeholder="0" />
                                </label>
                                <label className="flex items-center gap-1.5 text-[0.76rem] text-slate-500">
                                  成本价
                                  <StepInput value={pos?.avgCost ?? 0} onChange={(v) => setPosByCode(s.code, { avgCost: v })} step={0.01} min={-999999} width="w-20" placeholder="0.00" />
                                </label>
                                <span className="text-[0.72rem] text-slate-400">数量非零时成本价必填</span>
                              </div>
                            ) : (
                              <div className="text-[0.76rem] text-slate-500">
                                单标的上限 {s.maxWeightPct !== undefined ? s.maxWeightPct + "%" : "未设"} · 当前数量 {pos?.quantity ? pos.quantity.toLocaleString("zh-CN") : "0"} · 成本价 {costFmt(pos?.avgCost)}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {!isDirty && <div className="mt-1 text-[0.76rem] text-slate-400">保存配置后日度计划才能按此策略校验</div>}
                    </>
                  )}
                </CardContent>
              </Card>

              {/* 日度交易计划 */}
              <Card className="mb-3">
                <CardContent className="p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="mr-1.5 inline-block h-4 w-1 rounded-full bg-emerald-500 align-middle" /><span className="font-bold">📅 日度交易计划</span>
                    <Input type="date" className="h-9 w-36" value={date} onChange={(e) => changeDate(e.target.value)} />
                    <span className="text-[0.78rem] text-slate-400">策略：{strategy.name}</span>
                  </div>

                  {items.length === 0 && <div className="mb-2 text-[0.82rem] text-slate-400">添加今日的交易操作（加仓 / 减仓）</div>}
                  {items.map((it, i) => (
                    <div key={i} className="mb-1.5 flex items-center gap-1.5">
                      <Select value={it.code} onValueChange={(v) => setItemAt(i, { code: v ?? "" })}>
                        <SelectTrigger className="h-9 w-56"><SelectValue placeholder="选择标的" /></SelectTrigger>
                        <SelectContent>
                          {stockOptions.map((s) => {
                            const used = items.some((it2, j) => j !== i && it2.code === s.code);
                            return (
                              <SelectItem key={s.code} value={s.code} disabled={used}>
                                {used ? `✓ 已添加 ${s.name ? s.name + " " + s.code : s.code}` : s.name ? `${s.name} ${s.code}` : s.code}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                      <Select value={it.action} onValueChange={(v) => setItemAt(i, { action: v as "add" | "reduce" })}>
                        <SelectTrigger className="h-9 w-20"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="add">加仓</SelectItem>
                          <SelectItem value="reduce">减仓</SelectItem>
                        </SelectContent>
                      </Select>
                      <StepInput value={it.amount} onChange={(v) => setItemAt(i, { amount: v })} step={100} width="w-24" placeholder="数量（股）" />
                      <StepInput value={it.cost ?? 0} onChange={(v) => setItemAt(i, { cost: v || undefined })} step={0.01} width="w-24" placeholder={it.action === "add" ? "买入价（必填）" : "卖出价（必填）"} title={it.action === "add" ? "买入价：本次加仓的成交价，用于重算持仓均价" : "卖出价：本次减仓的成交价，用于计算卖出回款"} />
                      {(() => {
                        const price = strategy.positions.find((p) => p.code === it.code)?.avgCost ?? 0;
                        const cost = typeof it.cost === "number" && !isNaN(it.cost) ? it.cost : price;   // 负/零成本合法
                        const est = it.amount * cost;
                        return (
                          <span className={cn("w-24 flex-shrink-0 text-[0.72rem]", typeof cost === "number" && !isNaN(cost) && cost !== 0 ? "text-slate-500" : "text-amber-700")}>
                            {typeof cost === "number" && !isNaN(cost) && cost !== 0 ? `≈ ${cny2(est)}` : "请填买入价/卖出价"}
                          </span>
                        );
                      })()}
                      {strategy.totalCapital > 0 && (() => {
                        const price = strategy.positions.find((p) => p.code === it.code)?.avgCost ?? 0;
                        const cost = typeof it.cost === "number" && !isNaN(it.cost) ? it.cost : price;   // 负/零成本合法
                        if (cost <= 0) return null;
                        const pct = it.amount > 0 ? Math.min(100, Math.round((it.amount * cost / strategy.totalCapital) * 100)) : 0;
                        return (
                          <span className="flex flex-shrink-0 items-center gap-1">
                            <Slider min={0} max={100} step={1} value={pct} onValueChange={(v) => setItemAt(i, { amount: Math.round((strategy.totalCapital * sliderNum(v)) / 100 / cost) })} className="w-16" title="按占策略总仓位的百分比换算金额后折算股数" />
                            <span className="w-9 text-[0.72rem] text-slate-500">{pct}%</span>
                          </span>
                        );
                      })()}
                      <Input className="h-9 min-w-16 flex-1" placeholder="备注（可选）" value={it.note ?? ""} onChange={(e) => setItemAt(i, { note: e.target.value })} />
                      <Button variant="destructive" size="icon" className="h-8 w-8" onClick={() => setItems((arr) => arr.filter((_, j) => j !== i))} type="button">✕</Button>
                    </div>
                  ))}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setItems((arr) => [...arr, { code: "", action: "add", amount: 0 }])} type="button">＋ 添加操作</Button>
                    <Button
                      className={cn(result && !result.ok && "bg-slate-400")}
                      onClick={() => void runCheck(true)}
                      disabled={checking || items.length === 0 || items.some((it) => !it.code) || items.some((it) => !it.amount || !Number.isInteger(it.amount)) || items.some((it) => !it.cost || it.cost <= 0) || stockOptions.length === 0 || (result !== null && !result.ok)}
                      title={result && !result.ok ? "违反策略仓位管理，无法保存" : items.some((it) => !it.code) ? "请先为每个操作选择交易标的" : items.some((it) => !it.amount || !Number.isInteger(it.amount)) ? "数量（股）必须为正整数" : items.some((it) => !it.cost || it.cost <= 0) ? "请为每个操作填写买入价/卖出价（>0）" : "保存并应用为日度计划"}
                      type="button"
                    >
                      💾 保存并应用
                    </Button>
                    <span className="text-[0.78rem] text-slate-400">保存后自动按计划更新当前仓位</span>
                    {dayMsg && <span className={cn("rounded-md px-2 py-1 text-[0.82rem] font-medium", dayMsg.startsWith("❌") ? "bg-red-50 text-red-700 ring-1 ring-red-200" : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200")}>{dayMsg}</span>}
                  </div>

                  {displayResult && <ResultView result={displayResult} />}
                </CardContent>
              </Card>

              {/* 历史 */}
              <Card>
                <CardContent className="p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="mr-1.5 inline-block h-4 w-1 rounded-full bg-violet-500 align-middle" /><span className="font-bold">🗂️ 历史日度计划</span>
                    <span className="flex-1" />
                    <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
                      {([["list", "📋 列表"], ["cal", "🗓️ 日历"]] as const).map(([v, l]) => (
                        <Button key={v} type="button" size="sm" variant={calView === (v === "cal") ? "default" : "ghost"} className="h-7 px-2.5 text-[0.78rem]" onClick={() => setCalView(v === "cal")}>{l}</Button>
                      ))}
                    </div>
                  </div>

                  {calView ? (
                    <MonthCalendar days={days} selected={date} onSelect={changeDate} />
                  ) : (
                    <>
                      {days.length === 0 && <div className="text-[0.82rem] text-slate-400">暂无记录，保存后自动累积</div>}
                      {days.map((d) => (
                        <div key={d.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-1.5">
                          <span className="font-semibold">{d.date}</span>
                          <span className={cn("text-[0.8rem]", d.result.ok ? "text-emerald-600" : "text-red-600")}>
                            {d.result.ok ? "✅ 通过" : `⚠️ ${d.result.alerts.filter((a) => a.level === "error").length} 项告警`}
                          </span>
                          {d.applied ? (
                            <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700" title={d.appliedAt ? `应用时间 ${new Date(d.appliedAt).toLocaleString("zh-CN")}` : ""}>✅ 已应用</Badge>
                          ) : (
                            <Badge variant="outline" className="text-slate-400">未应用</Badge>
                          )}
                          <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-[0.78rem] text-slate-500">
                            {d.items.map((it, i) => {
                              const st = strategy?.stocks.find((x) => x.code === it.code);
                              const t = itemText({ ...it, name: st?.name ?? it.name }, it.cost ?? strategy?.positions.find((x) => x.code === it.code)?.avgCost);
                              return <span key={i} className="w-full truncate whitespace-nowrap" title={t}>{t}</span>;
                            })}
                          </span>
                          <span className="flex-1" />
                          <Button variant="secondary" size="sm" className="h-6 px-2 text-[0.76rem]" onClick={() => setViewDay(viewDay?.id === d.id ? null : d)} type="button">
                            {viewDay?.id === d.id ? "收起" : "查看"}
                          </Button>
                          <Button variant="destructive" size="sm" className="h-6 px-2 text-[0.76rem]" onClick={() => void deleteOne(d.id)} type="button">删除</Button>
                        </div>
                      ))}
                    </>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 交易日历视图：当月网格 + 有计划的日期标记（绿=通过/红=告警），点击日期查看当日操作汇总 */
function MonthCalendar({ days, selected, onSelect }: { days: TradePlanDay[]; selected: string; onSelect: (d: string) => void }) {
  const [month, setMonth] = useState(selected.slice(0, 7) || new Date().toISOString().slice(0, 7));
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);

  const [y, m] = month.split("-").map(Number);
  const firstDay = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const pad = (v: number) => String(v).padStart(2, "0");
  const dateStr = (d: number) => `${y}-${pad(m)}-${pad(d)}`;

  const prev = () => setMonth(m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`);
  const next = () => setMonth(m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`);
  const selectedDay = byDate.get(selected);

  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5">
        <Button variant="secondary" size="sm" onClick={prev} type="button">◀</Button>
        <span className="flex-1 text-center font-bold">{month}</span>
        <Button variant="secondary" size="sm" onClick={next} type="button">▶</Button>
      </div>
      <div className="mb-1.5 grid grid-cols-7 gap-0.5 text-center">
        {["日", "一", "二", "三", "四", "五", "六"].map((w) => (
          <div key={w} className="py-0.5 text-[0.72rem] text-slate-400">{w}</div>
        ))}
        {Array.from({ length: firstDay }).map((_, i) => <div key={"e" + i} />)}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const d = i + 1;
          const ds = dateStr(d);
          const day = byDate.get(ds);
          const isSel = ds === selected;
          return (
            <button
              key={d}
              type="button"
              onClick={() => onSelect(ds)}
              className={cn(
                "relative rounded-lg py-1.5 text-[0.84rem] font-medium",
                isSel ? "border-[1.5px] border-blue-600 bg-blue-50 text-blue-600" : "border-[1.5px] border-transparent",
                day ? (day.result.ok ? "bg-emerald-50" : "bg-red-50") : "bg-white",
              )}
              title={day ? `${ds}：${day.items.map((it) => `${it.code} ${it.action === "add" ? "加" : "减"}${it.amount.toLocaleString("zh-CN")}股`).join("；")}` : ds}
            >
              {d}
              {day && (
                <span className="absolute bottom-0.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full" style={{ background: day.result.ok ? "#16a34a" : "#dc2626" }} />
              )}
            </button>
          );
        })}
      </div>
      {selectedDay ? (
        <div className="rounded-lg border border-slate-100 bg-slate-50 p-2 text-[0.8rem]">
          <div className="mb-1 font-bold">
            {selected} {selectedDay.result.ok ? "✅ 通过" : "⚠️ 有告警"} {selectedDay.applied ? "· ✅ 已应用" : "· 未应用"}
          </div>
          {selectedDay.items.map((it, i) => (
            <div key={i} className="py-0.5 text-slate-500">
              {itemText(it, it.cost)}
              {it.note ? `（${it.note}）` : ""}
            </div>
          ))}
          <div className="mt-0.5 text-[0.76rem] text-slate-500">
            当日加仓 {cny(selectedDay.result.totals.addTotal)} · 执行后仓位 {selectedDay.result.totals.positionPct.toFixed(1)}%
          </div>
        </div>
      ) : (
        <div className="py-1 text-center text-[0.78rem] text-slate-400">{selected} 无交易计划</div>
      )}
    </div>
  );
}

/** 全部策略总计划日历：跨策略聚合，某天显示所有策略的操作 */
function AllCalendar() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<{ date: string; strategies: { id: string; name: string; items: TradePlanItem[]; result: TradePlanCheckResult }[] }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setData(null);
    setErr(null);
    void api.tradePlanCalendar(month).then((r) => {
      setData(r.days);
      if (r.days.length > 0) setSelected(r.days[0].date);
    }).catch((e) => setErr(errMsg(e)));
  }, [month, refreshKey]);

  const byDate = useMemo(() => new Map((data ?? []).map((d) => [d.date, d])), [data]);
  const [y, m] = month.split("-").map(Number);
  const firstDay = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const pad = (v: number) => String(v).padStart(2, "0");
  const dateStr = (d: number) => `${y}-${pad(m)}-${pad(d)}`;
  const selectedDay = byDate.get(selected);

  return (
    <div className="mt-2 border-t border-dashed border-emerald-200 pt-2">
      <div className="mb-2 flex items-center gap-1.5">
        <Button variant="secondary" size="sm" onClick={() => setMonth(m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`)} type="button">◀</Button>
        <span className="flex-1 text-center font-bold">{month}</span>
        <Button variant="secondary" size="sm" onClick={() => setMonth(m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`)} type="button">▶</Button>
        <Button variant="default" size="sm" onClick={() => setRefreshKey((k) => k + 1)} type="button">🔄</Button>
      </div>
      {err && <div className="mb-1.5 text-[0.82rem] text-red-600">❌ {err}</div>}
      <div className="mb-1.5 grid grid-cols-7 gap-0.5 text-center">
        {["日", "一", "二", "三", "四", "五", "六"].map((w) => (
          <div key={w} className="py-0.5 text-[0.72rem] text-slate-400">{w}</div>
        ))}
        {Array.from({ length: firstDay }).map((_, i) => <div key={"e" + i} />)}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const d = i + 1;
          const ds = dateStr(d);
          const day = byDate.get(ds);
          const hasErr = day?.strategies.some((s) => !s.result.ok);
          const isSel = ds === selected;
          return (
            <button
              key={d}
              type="button"
              onClick={() => setSelected(ds)}
              className={cn(
                "relative rounded-lg py-1.5 text-[0.84rem] font-medium",
                isSel ? "border-[1.5px] border-blue-600 bg-blue-50 text-blue-600" : "border-[1.5px] border-transparent",
                day ? (hasErr ? "bg-red-50" : "bg-emerald-50") : "bg-white",
              )}
              title={day ? `${ds}：${day.strategies.map((s) => `${s.name} ${s.items.length}项`).join("；")}` : ds}
            >
              {d}
              {day && (
                <span className="absolute bottom-0.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full" style={{ background: hasErr ? "#dc2626" : "#16a34a" }} />
              )}
            </button>
          );
        })}
      </div>
      {selectedDay ? (
        <div className="rounded-lg border border-slate-100 bg-slate-50 p-2 text-[0.8rem]">
          <div className="mb-1 font-bold">{selected} 全部策略计划</div>
          {selectedDay.strategies.map((s) => (
            <div key={s.id} className="border-b border-slate-100 py-1">
              <div className={cn("font-semibold", s.result.ok ? "text-emerald-600" : "text-red-600")}>
                {s.name} {s.result.ok ? "✅" : "⚠️"}
              </div>
              <div className="text-slate-500">
                {s.items.map((it, i) => (
                  <div key={i} className="py-0.5">
                    {itemText(it, it.cost)}
                    {it.note ? `（${it.note}）` : ""}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="py-1 text-center text-[0.78rem] text-slate-400">{selected || month} 无任何策略计划</div>
      )}
    </div>
  );
}

/** 股票代码/名称搜索补全输入（名称 → 代码候选，复用专题自选股 search-stock；有名称时显示「名称 代码」） */
function StockCodeInput({ code, name, onChange, onPick }: { code: string; name?: string; onChange: (v: string) => void; onPick: (code: string, name?: string) => void }) {
  const [cands, setCands] = useState<{ code: string; name: string }[]>([]);
  const [focus, setFocus] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [disp, setDisp] = useState(code ? (name ? name + " " + code : code) : "");
  useEffect(() => {
    const target = code ? (name ? name + " " + code : code) : "";
    setDisp((d) => (d === target ? d : target));
  }, [code, name]);

  const onInput = (v: string) => {
    setDisp(v);
    onChange(v);
    if (timer.current) clearTimeout(timer.current);
    const t = v.trim();
    if (!t || /^\d{5,6}$/.test(t)) { setCands([]); return; }
    timer.current = setTimeout(async () => {
      try {
        const r = await api.watchlistSearchStock(t, 6);
        if (r.ok) setCands(r.items.map((x) => ({ code: x.code, name: x.name })));
        else setCands([]);
      } catch {
        setCands([]);
      }
    }, 300);
  };

  return (
    <div className="relative min-w-[100px] flex-[0.85]">
      <Input
        className="w-full"
        placeholder="代码 / 名称（搜索补全）"
        value={disp}
        onChange={(e) => onInput(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setTimeout(() => setFocus(false), 200)}
      />
      {focus && cands.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-0.5 max-h-56 overflow-auto rounded-lg border border-slate-200 bg-white shadow-md">
          {cands.map((c) => (
            <div
              key={c.code}
              onMouseDown={() => { setDisp(c.name + " " + c.code); onChange(c.code); onPick(c.code, c.name); setCands([]); }}
              className="flex cursor-pointer justify-between px-2.5 py-1.5 text-[0.84rem] hover:bg-slate-100"
            >
              <span>{c.name}</span>
              <span className="text-[0.78rem] text-slate-400">{c.code}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ResultView({ result }: { result: TradePlanCheckResult }) {
  return (
    <div className="mt-3 border-t border-dashed border-slate-200 pt-3">
      <div className="mb-2 flex flex-wrap gap-2">
        {[
          { label: "当日加仓", value: cny(result.totals.addTotal), tone: "bg-blue-50 border-blue-100 text-blue-700" },
          { label: "当日减仓回款", value: cny(result.totals.reduceTotal), tone: "bg-cyan-50 border-cyan-100 text-cyan-700" },
          { label: "执行后总市值", value: cny(result.totals.totalMarketValue), tone: "bg-indigo-50 border-indigo-100 text-indigo-700" },
          { label: "总仓位占比", value: `${result.totals.positionPct.toFixed(1)}%`, tone: result.totals.positionPct > 80 ? "bg-red-50 border-red-200 text-red-700" : result.totals.positionPct > 50 ? "bg-amber-50 border-amber-200 text-amber-700" : "bg-emerald-50 border-emerald-100 text-emerald-700" },
          { label: "剩余可用", value: cny(Math.max(0, result.totals.remaining)), tone: result.totals.remaining < 0 ? "bg-red-50 border-red-200 text-red-700" : "bg-slate-50 border-slate-100 text-slate-800" },
        ].map((s) => (
          <div key={s.label} className={`rounded-lg border px-3 py-1.5 ${s.tone}`}>
            <div className="text-[0.72rem] opacity-70">{s.label}</div>
            <div className="text-[0.95rem] font-bold">{s.value}</div>
          </div>
        ))}
      </div>

      {result.alerts.map((a, i) => (
        <div
          key={i}
          className="mb-1 rounded-md border-l-[3px] px-2.5 py-1.5 text-[0.84rem]"
          style={{ background: alertBg[a.level], borderLeftColor: alertColor[a.level] }}
        >
          <span style={{ color: alertColor[a.level] }} className="font-semibold">
            {a.level === "error" ? "⛔" : a.level === "warn" ? "⚠️" : "ℹ️"} {a.message}
          </span>
          {a.detail && <div className="mt-0.5 text-[0.78rem] text-slate-500">{a.detail}</div>}
        </div>
      ))}

      {result.after.length > 0 && (
        <Table className="mt-2 text-[0.8rem]">
          <TableHeader>
            <TableRow>
              {["标的", "持仓市值", "占比", "份额", "成本", "操作价", "本次加仓", "实现盈亏"].map((h) => (
                <TableHead key={h}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.after.map((p) => (
              <TableRow key={p.code}>
                <TableCell className="font-semibold">{p.name ? `${p.name} ${p.code}` : p.code}</TableCell>
                <TableCell>{cny(p.marketValue)}</TableCell>
                <TableCell>{p.weightPct.toFixed(1)}%</TableCell>
                <TableCell>{p.shares.toLocaleString("zh-CN")}</TableCell>
                <TableCell>{costFmt(p.avgCost)}</TableCell>
                <TableCell>{p.tradePrice !== undefined && p.tradePrice !== 0 ? `¥${costFmt(p.tradePrice)}` : "—"}</TableCell>
                <TableCell>{p.addAmount !== 0 ? cny2(p.addAmount) : "—"}</TableCell>
                <TableCell>
                  {p.realizedPnl !== undefined && p.realizedPnl !== 0 ? (
                    <span style={{ color: p.realizedPnl >= 0 ? "#dc2626" : "#16a34a" }} title="减仓已实现盈亏 = (卖出价 − 持仓均价) × 减仓数量">
                      {cny2(p.realizedPnl)}
                    </span>
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
