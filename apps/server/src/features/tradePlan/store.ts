// ============================================================
// 交易规划：存储（KV）——多策略 + 日度计划（按策略隔离）
// 策略：tradePlan:strategy:<id>；列表键 tradePlan:strategies:list
// 日度计划：tradePlan:day:<strategyId>:<dayId>；列表键 tradePlan:days:list:<strategyId>
// ============================================================
import {
  type TradePlanCheckResult,
  type TradePlanDay,
  type TradePlanItem,
  type TradePlanPosition,
  type TradePlanStrategy,
  type TradePlanStrategySummary,
} from "@toolbox/shared";
import { kvGet, kvSet, kvDelete, kvCount } from "../../core/kvStore.js";
import { applyItems, checkTradePlan } from "./compute.js";

const STRATEGY_PREFIX = "tradePlan:strategy:";
const STRATEGY_LIST = "tradePlan:strategies:list";
const DAY_PREFIX = "tradePlan:day:";
const DAY_LIST_PREFIX = "tradePlan:days:list:";
const MAX_STRATEGIES = 50;
const MAX_DAYS_PER_STRATEGY = 200;

// ---------- 策略 ----------

export function listStrategies(): TradePlanStrategySummary[] {
  const ids = kvGet<string[]>(STRATEGY_LIST) ?? [];
  const out: TradePlanStrategySummary[] = [];
  for (const id of ids) {
    const st = kvGet<TradePlanStrategy>(STRATEGY_PREFIX + id);
    if (st && typeof st.name === "string") {
      const positions = Array.isArray(st.positions) ? st.positions : [];
      const totalMv = positions.reduce((a, p) => a + (p.quantity || 0) * (p.avgCost || 0), 0);
      out.push({
        id: st.id,
        name: st.name,
        totalCapital: st.totalCapital,
        dailyAddLimit: st.dailyAddLimit,
        stockCount: Array.isArray(st.stocks) ? st.stocks.length : 0,
        dayCount: kvCount(DAY_PREFIX + id + ":") > 0 ? listDayIds(id).length : 0,
        positionPct: st.totalCapital > 0 ? Math.round((totalMv / st.totalCapital) * 1000) / 10 : 0,
        updatedAt: st.updatedAt,
      });
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getStrategy(id: string): TradePlanStrategy | null {
  const st = kvGet<TradePlanStrategy>(STRATEGY_PREFIX + id);
  if (!st || typeof st.name !== "string") return null;
  // 兼容迁移：旧数据 stocks[].initShares/initCost → positions（幂等）
  if (!Array.isArray(st.positions)) {
    const migrated = migratePositions(st);
    kvSet(STRATEGY_PREFIX + id, migrated);
    return migrated;
  }
  // basePositions 迁移：无基线时以当前 positions 为基线（幂等）
  if (!Array.isArray(st.basePositions)) {
    st.basePositions = st.positions.map((p) => ({ ...p }));
    kvSet(STRATEGY_PREFIX + id, st);
  }
  return st;
}

/** 手动保存仓位时的基线重算（差值法，2026-08-10 修复重复应用）：
 * 直接把当前 positions 固化为 base 会"双重计入"已应用日度计划（重放时再算一次）。
 * 正确：新 base = 旧 base + (提交 positions − 全量重放结果)，即只固化"手动调整量"。
 * 提交中已删除的标的（前端移除标的）→ 从基线移除（否则重放时已删标的重放复活）。
 */
export function rebasePositions(
  oldBase: TradePlanPosition[],
  replayed: TradePlanPosition[],
  submitted: TradePlanPosition[],
): TradePlanPosition[] {
  const out: TradePlanPosition[] = [];
  for (const b of oldBase) {
    const submit = submitted.find((p) => p.code === b.code);
    const re = replayed.find((p) => p.code === b.code);
    if (!submit) continue; // 提交中已删除该标的 → 从基线移除（2026-08-10 修复：否则重放会复活已删标的）
    const deltaQty = (submit.quantity ?? 0) - (re?.quantity ?? 0);
    out.push({ ...b, quantity: Math.max(0, (b.quantity ?? 0) + deltaQty), avgCost: submit.avgCost ?? b.avgCost });
  }
  // 提交中出现但旧基线没有的 code → 直接加入（新增仓位）
  for (const p of submitted) {
    if (!out.some((b) => b.code === p.code)) out.push({ ...p });
  }
  return out;
}

/** 重放所有已应用日度计划（按日期升序）→ 最新仓位；excludeDate 用于同日覆盖/删除时剔除该日 */
export function replayPositions(st: TradePlanStrategy, excludeDate?: string): TradePlanPosition[] {
  let positions: TradePlanPosition[] = (st.basePositions ?? st.positions ?? []).map((p) => ({ ...p }));
  const applied = listDays(st.id)
    .filter((d) => d.applied && d.date !== excludeDate && Array.isArray(d.items))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const d of applied) {
    positions = applyItems(positions, d.items);
  }
  return positions;
}

/** 重放「某日期之前」的已应用计划（严格 < date，不含该日与之后）→ 该日应用前的仓位。
 * 覆盖（重刷）历史日计划时用作 before 快照与校验基础——2026-08-10 修复：
 * 旧实现用 replayPositions(st, date) 只剔除该日，会把「该日之后的计划」也重放进 before，
 * 导致校验的当前持仓被未来计划污染（误拦减仓）、快照错误。 */
export function replayBefore(st: TradePlanStrategy, date: string): TradePlanPosition[] {
  let positions: TradePlanPosition[] = (st.basePositions ?? st.positions ?? []).map((p) => ({ ...p }));
  const applied = listDays(st.id)
    .filter((d) => d.applied && d.date < date && Array.isArray(d.items))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const d of applied) {
    positions = applyItems(positions, d.items);
  }
  return positions;
}

/** 校验「已应用计划链」在重放时是否出现无法完整执行的计划（如减仓超过当前持仓）。
 * 覆盖/删除日计划后调用：若后续某日因仓位变化无法完整执行，返回可读警告（供前端提示）。
 * 数学上重放会 clamp 截断（不能负持仓），此函数让「静默截断」变得可见。 */
export function appliedDayWarnings(st: TradePlanStrategy, excludeDate?: string): string[] {
  let positions: TradePlanPosition[] = (st.basePositions ?? st.positions ?? []).map((p) => ({ ...p }));
  const warnings: string[] = [];
  const applied = listDays(st.id)
    .filter((d) => d.applied && d.date !== excludeDate && Array.isArray(d.items))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const d of applied) {
    const r = checkTradePlan(
      { totalCapital: st.totalCapital, dailyAddLimit: st.dailyAddLimit, stocks: st.stocks, positions },
      d.items,
    );
    const blocked = r.alerts.filter((a) => a.level === "error");
    if (blocked.length > 0) {
      warnings.push(`${d.date} 的计划无法完整执行：${blocked.map((a) => a.detail ?? a.message).join("；")}`);
    }
    positions = applyItems(positions, d.items);
  }
  return warnings;
}

/** 旧数据迁移：stocks[].initShares/initCost（或旧 initialPositions）→ positions，并清掉内联字段 */
export function migratePositions(st: TradePlanStrategy): TradePlanStrategy {
  const legacy = (st as unknown as { initialPositions?: TradePlanPosition[] }).initialPositions;
  const positions: TradePlanPosition[] = Array.isArray(st.positions)
    ? st.positions
    : (legacy ?? []).map((p) => ({
        code: p.code,
        name: p.name,
        quantity: (p as { shares?: number }).shares ?? p.quantity ?? 0,
        avgCost: (p as { cost?: number }).cost ?? p.avgCost ?? 0,
      }));
  if (positions.length === 0 && Array.isArray(st.stocks)) {
    for (const stk of st.stocks) {
      const sc = stk as unknown as { initShares?: number; initCost?: number };
      if (sc.initShares && sc.initCost) {
        positions.push({ code: stk.code, name: stk.name, quantity: sc.initShares, avgCost: sc.initCost });
      }
    }
  }
  const cleanStocks = (Array.isArray(st.stocks) ? st.stocks : []).map((stk) => {
    const s = { ...stk } as Record<string, unknown>;
    delete s.initShares;
    delete s.initCost;
    return s as unknown as TradePlanStrategy["stocks"][number];
  });
  return { ...st, stocks: cleanStocks, positions };
}

/** 新建策略（默认空配置） */
export function createStrategy(name: string): TradePlanStrategy {
  const now = new Date().toISOString();
  const st: TradePlanStrategy = {
    id: genId(),
    name: name.trim().slice(0, 30),
    totalCapital: 0,
    dailyAddLimit: 0,
    stocks: [],
    positions: [],
    updatedAt: now,
    createdAt: now,
  };
  kvSet(STRATEGY_PREFIX + st.id, st);
  const list = (kvGet<string[]>(STRATEGY_LIST) ?? []).filter((x) => x !== st.id);
  list.unshift(st.id);
  kvSet(STRATEGY_LIST, list.slice(0, MAX_STRATEGIES));
  return st;
}

/** 更新策略（名称/配置/当前仓位） */
export function updateStrategy(
  id: string,
  patch: {
    name?: string;
    totalCapital?: number;
    dailyAddLimit?: number;
    stocks?: TradePlanStrategy["stocks"];
    positions?: TradePlanStrategy["positions"];
    basePositions?: TradePlanStrategy["basePositions"];
  },
): TradePlanStrategy | null {
  const st = getStrategy(id);
  if (!st) return null;
  if (patch.name !== undefined && patch.name.trim()) st.name = patch.name.trim().slice(0, 30);
  if (patch.totalCapital !== undefined) st.totalCapital = patch.totalCapital;
  if (patch.dailyAddLimit !== undefined) st.dailyAddLimit = patch.dailyAddLimit;
  if (patch.stocks !== undefined) st.stocks = patch.stocks;
  if (patch.positions !== undefined) st.positions = patch.positions;
  if (patch.basePositions !== undefined) st.basePositions = patch.basePositions;
  st.updatedAt = new Date().toISOString();
  kvSet(STRATEGY_PREFIX + id, st);
  return st;
}

/** 删除策略（连带其日度计划） */
export function deleteStrategy(id: string): boolean {
  if (!getStrategy(id)) return false;
  kvDelete(STRATEGY_PREFIX + id);
  for (const dayId of listDayIds(id)) kvDelete(DAY_PREFIX + id + ":" + dayId);
  kvDelete(DAY_LIST_PREFIX + id);
  const list = (kvGet<string[]>(STRATEGY_LIST) ?? []).filter((x) => x !== id);
  kvSet(STRATEGY_LIST, list);
  return true;
}

// ---------- 日度计划（按策略） ----------

export function listDayIds(strategyId: string): string[] {
  return kvGet<string[]>(DAY_LIST_PREFIX + strategyId) ?? [];
}

export function listDays(strategyId: string): TradePlanDay[] {
  const out: TradePlanDay[] = [];
  for (const dayId of listDayIds(strategyId)) {
    const d = kvGet<TradePlanDay>(DAY_PREFIX + strategyId + ":" + dayId);
    if (d && typeof d.date === "string") out.push(d);
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** 创建日度计划（含校验快照；同日再次创建覆盖） */
export function createDay(
  strategyId: string,
  date: string,
  items: TradePlanItem[],
  result: TradePlanCheckResult,
  extra?: { applied?: boolean; before?: TradePlanPosition[]; after?: TradePlanPosition[]; appliedAt?: string },
): TradePlanDay | null {
  if (!getStrategy(strategyId)) return null;
  const existing = listDays(strategyId).find((d) => d.date === date);
  if (existing) kvDelete(DAY_PREFIX + strategyId + ":" + existing.id);

  const day: TradePlanDay = {
    id: genId(),
    date,
    items,
    result,
    applied: extra?.applied ?? false,
    ...(extra?.before ? { before: extra.before } : {}),
    ...(extra?.after ? { after: extra.after } : {}),
    ...(extra?.appliedAt ? { appliedAt: extra.appliedAt } : {}),
    createdAt: new Date().toISOString(),
  };
  kvSet(DAY_PREFIX + strategyId + ":" + day.id, day);
  // 覆盖时同时移除旧 dayId，避免列表残留死 id（2026-08-10 修复）
  const list = (listDayIds(strategyId) ?? []).filter((x) => x !== day.id && x !== existing?.id);
  list.unshift(day.id);
  kvSet(DAY_LIST_PREFIX + strategyId, list.slice(0, MAX_DAYS_PER_STRATEGY));
  return day;
}

/** 删除日度计划 */
export function deleteDay(strategyId: string, dayId: string): boolean {
  const key = DAY_PREFIX + strategyId + ":" + dayId;
  const day = kvGet<TradePlanDay>(key);
  if (!day) return false;
  kvDelete(key);
  const list = listDayIds(strategyId).filter((x) => x !== dayId);
  kvSet(DAY_LIST_PREFIX + strategyId, list);
  return true;
}

function genId(): string {
  return `tp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 兼容：旧单配置键（tradePlan:config）迁移为默认策略「默认策略」
export function migrateLegacyConfig(): void {
  if (kvGet<string[]>(STRATEGY_LIST)?.length) return; // 已有策略
  const legacy = kvGet<{ totalCapital?: number; dailyAddLimit?: number; stocks?: TradePlanStrategy["stocks"]; positions?: TradePlanPosition[] }>("tradePlan:config");
  if (legacy && typeof legacy.totalCapital === "number") {
    const st = createStrategy("默认策略");
    updateStrategy(st.id, {
      totalCapital: legacy.totalCapital,
      dailyAddLimit: legacy.dailyAddLimit,
      stocks: legacy.stocks,
      positions: legacy.positions,
    });
    kvDelete("tradePlan:config");
  }
}
