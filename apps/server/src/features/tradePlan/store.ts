// ============================================================
// 交易规划：存储（KV）——多策略 + 日度计划（按策略隔离）
// 策略：tradePlan:strategy:<id>；列表键 tradePlan:strategies:list
// 日度计划：tradePlan:day:<strategyId>:<dayId>；列表键 tradePlan:days:list:<strategyId>
// ============================================================
import {
  type TradePlanCheckResult,
  type TradePlanDay,
  type TradePlanItem,
  type TradePlanStrategy,
  type TradePlanStrategySummary,
} from "@toolbox/shared";
import { kvGet, kvSet, kvDelete, kvCount, kvListRaw } from "../../core/kvStore.js";

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
      out.push({
        id: st.id,
        name: st.name,
        totalCapital: st.totalCapital,
        dailyAddLimit: st.dailyAddLimit,
        stockCount: Array.isArray(st.stocks) ? st.stocks.length : 0,
        dayCount: kvCount(DAY_PREFIX + id + ":") > 0 ? listDayIds(id).length : 0,
        updatedAt: st.updatedAt,
      });
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getStrategy(id: string): TradePlanStrategy | null {
  const st = kvGet<TradePlanStrategy>(STRATEGY_PREFIX + id);
  return st && typeof st.name === "string" ? st : null;
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
    initialPositions: [],
    updatedAt: now,
    createdAt: now,
  };
  kvSet(STRATEGY_PREFIX + st.id, st);
  const list = (kvGet<string[]>(STRATEGY_LIST) ?? []).filter((x) => x !== st.id);
  list.unshift(st.id);
  kvSet(STRATEGY_LIST, list.slice(0, MAX_STRATEGIES));
  return st;
}

/** 更新策略（名称/配置） */
export function updateStrategy(id: string, patch: { name?: string; totalCapital?: number; dailyAddLimit?: number; stocks?: TradePlanStrategy["stocks"]; initialPositions?: TradePlanStrategy["initialPositions"] }): TradePlanStrategy | null {
  const st = getStrategy(id);
  if (!st) return null;
  if (patch.name !== undefined && patch.name.trim()) st.name = patch.name.trim().slice(0, 30);
  if (patch.totalCapital !== undefined) st.totalCapital = patch.totalCapital;
  if (patch.dailyAddLimit !== undefined) st.dailyAddLimit = patch.dailyAddLimit;
  if (patch.stocks !== undefined) st.stocks = patch.stocks;
  if (patch.initialPositions !== undefined) st.initialPositions = patch.initialPositions;
  st.updatedAt = new Date().toISOString();
  kvSet(STRATEGY_PREFIX + id, st);
  return st;
}

/** 删除策略（连带其日度计划） */
export function deleteStrategy(id: string): boolean {
  if (!getStrategy(id)) return false;
  kvDelete(STRATEGY_PREFIX + id);
  // 清理该策略全部日度计划
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
export function createDay(strategyId: string, date: string, items: TradePlanItem[], result: TradePlanCheckResult): TradePlanDay | null {
  if (!getStrategy(strategyId)) return null;
  const existing = listDays(strategyId).find((d) => d.date === date);
  if (existing) kvDelete(DAY_PREFIX + strategyId + ":" + existing.id);

  const day: TradePlanDay = {
    id: genId(),
    date,
    items,
    result,
    createdAt: new Date().toISOString(),
  };
  kvSet(DAY_PREFIX + strategyId + ":" + day.id, day);
  const list = (listDayIds(strategyId) ?? []).filter((x) => x !== day.id);
  list.unshift(day.id);
  kvSet(DAY_LIST_PREFIX + strategyId, list.slice(0, MAX_DAYS_PER_STRATEGY));
  return day;
}

/** 删除日度计划 */
export function deleteDay(strategyId: string, dayId: string): boolean {
  const key = DAY_PREFIX + strategyId + ":" + dayId;
  if (!kvGet<TradePlanDay>(key)) return false;
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
  const legacy = kvGet<{ totalCapital?: number; dailyAddLimit?: number; stocks?: TradePlanStrategy["stocks"]; initialPositions?: TradePlanStrategy["initialPositions"] }>("tradePlan:config");
  if (legacy && typeof legacy.totalCapital === "number") {
    const st = createStrategy("默认策略");
    updateStrategy(st.id, {
      totalCapital: legacy.totalCapital,
      dailyAddLimit: legacy.dailyAddLimit,
      stocks: legacy.stocks,
      initialPositions: legacy.initialPositions,
    });
    kvDelete("tradePlan:config");
  }
}
