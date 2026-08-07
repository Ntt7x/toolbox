// ============================================================
// 交易规划：存储（KV）——配置 + 日度计划
// ============================================================
import {
  type TradePlanCheckResult,
  type TradePlanConfig,
  type TradePlanDay,
  type TradePlanItem,
} from "@toolbox/shared";
import { kvGet, kvSet, kvListRaw, kvDelete, kvCount } from "../../core/kvStore.js";

const CONFIG_KEY = "tradePlan:config";
const DAY_PREFIX = "tradePlan:days:";
const LIST_KEY = "tradePlan:days:list";
const MAX_DAYS = 200;

const DEFAULT_CONFIG: TradePlanConfig = {
  totalCapital: 0,
  dailyAddLimit: 0,
  stocks: [],
  initialPositions: [],
  updatedAt: new Date().toISOString(),
};

/** 读取配置（无则默认空配置） */
export function getConfig(): TradePlanConfig {
  const c = kvGet<TradePlanConfig>(CONFIG_KEY);
  if (c && typeof c.totalCapital === "number") return c;
  return { ...DEFAULT_CONFIG };
}

/** 保存配置 */
export function saveConfig(config: Omit<TradePlanConfig, "updatedAt">): TradePlanConfig {
  const next: TradePlanConfig = { ...config, updatedAt: new Date().toISOString() };
  kvSet(CONFIG_KEY, next);
  return next;
}

/** 创建日度计划（含校验快照；自动按日期去重：同日再次创建则覆盖） */
export function createDay(date: string, items: TradePlanItem[], result: TradePlanCheckResult): TradePlanDay {
  // 同日已存在则删除旧记录（保证一天一条）
  const existing = listDays().find((d) => d.date === date);
  if (existing) kvDelete(DAY_PREFIX + existing.id);

  const day: TradePlanDay = {
    id: genId(),
    date,
    items,
    result,
    createdAt: new Date().toISOString(),
  };
  kvSet(DAY_PREFIX + day.id, day);

  // 维护列表键（时间倒序，上限 200）
  const list = (kvGet<string[]>(LIST_KEY) ?? []).filter((id) => id !== day.id);
  list.unshift(day.id);
  kvSet(LIST_KEY, list.slice(0, MAX_DAYS));
  return day;
}

/** 历史列表（时间倒序） */
export function listDays(): TradePlanDay[] {
  const list = kvGet<string[]>(LIST_KEY) ?? [];
  const out: TradePlanDay[] = [];
  for (const id of list) {
    const d = kvGet<TradePlanDay>(DAY_PREFIX + id);
    if (d && typeof d.date === "string") out.push(d);
  }
  // 兜底：列表键缺失时扫描全量
  if (out.length === 0 && kvCount(DAY_PREFIX) > 0) {
    for (const r of kvListRaw(DAY_PREFIX, 300)) {
      if (!/^[A-Za-z0-9:_-]+$/.test(r.key)) continue;
      const d = r.value ? (JSON.parse(r.value) as TradePlanDay) : null;
      if (d && typeof d.date === "string") out.push(d);
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** 删除日度计划 */
export function deleteDay(id: string): boolean {
  const existed = !!kvGet<TradePlanDay>(DAY_PREFIX + id);
  if (!existed) return false;
  kvDelete(DAY_PREFIX + id);
  const list = (kvGet<string[]>(LIST_KEY) ?? []).filter((x) => x !== id);
  kvSet(LIST_KEY, list);
  return true;
}

function genId(): string {
  return `tp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
