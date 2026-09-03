// ============================================================
// 仓位管理 v2：存储（KV）
// 分组：tradeV2:group:<id>；列表键 tradeV2:groups:list
// 交易：tradeV2:trade:<id>；列表键 tradeV2:trades:list
// 交易条目自带 groupId → 组内条目 = listEntries().filter(groupId)
// ============================================================
import type { TradeV2Entry, TradeV2Group } from "@toolbox/shared";
import { kvGet, kvSet, kvDelete } from "../../core/kvStore.js";
import { enqueueVolUpdate } from "../../core/volatilityStore.js";

export const GROUP_PREFIX = "tradeV2:group:";
export const GROUP_LIST = "tradeV2:groups:list";
export const TRADE_PREFIX = "tradeV2:trade:";
export const TRADE_LIST = "tradeV2:trades:list";
export const MAX_GROUPS = 50;
export const MAX_TRADES = 5000;

function genId(tag: string): string {
  return `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- 分组 ----------

export function listGroupIds(): string[] {
  return kvGet<string[]>(GROUP_LIST) ?? [];
}

export function listGroups(): TradeV2Group[] {
  const out: TradeV2Group[] = [];
  for (const id of listGroupIds()) {
    const g = getGroup(id);
    if (g) out.push(g);
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function getGroup(id: string): TradeV2Group | null {
  const g = kvGet<TradeV2Group>(GROUP_PREFIX + id);
  if (!g || typeof g.id !== "string" || typeof g.name !== "string") return null;
  return g;
}

export function createGroup(name: string, infoType?: "info" | "noinfo", isPaper?: boolean, aggSources?: string[]): TradeV2Group {
  const now = new Date().toISOString();
  const g: TradeV2Group = {
    id: genId("g"),
    name: name.trim().slice(0, 30),
    totalCapital: 0,
    dailyAddLimit: 0,
    stockLimits: [],
    infoType,
    ...(isPaper ? { isPaper: true } : {}),
    ...(Array.isArray(aggSources) && aggSources.length > 0 ? { aggSources } : {}),
    createdAt: now,
    updatedAt: now,
  };
  kvSet(GROUP_PREFIX + g.id, g);
  const list = (listGroupIds() ?? []).filter((x) => x !== g.id);
  list.unshift(g.id);
  kvSet(GROUP_LIST, list.slice(0, MAX_GROUPS));
  return g;
}

export function updateGroup(
  id: string,
  patch: { name?: string; totalCapital?: number; dailyAddLimit?: number; stockLimits?: TradeV2Group["stockLimits"]; allowShort?: boolean; infoType?: "info" | "noinfo" | null; isPaper?: boolean; aggSources?: string[] | null },
): TradeV2Group | null {
  const g = getGroup(id);
  if (!g) return null;
  if (patch.name !== undefined && patch.name.trim()) g.name = patch.name.trim().slice(0, 30);
  if (patch.infoType !== undefined) g.infoType = patch.infoType ?? undefined;
  if (patch.totalCapital !== undefined) g.totalCapital = patch.totalCapital;
  if (patch.dailyAddLimit !== undefined) g.dailyAddLimit = patch.dailyAddLimit;
  if (patch.stockLimits !== undefined) {
    g.stockLimits = patch.stockLimits;
    // 新增标的感知：分组加标的 → 立即入队波动率初始化（幂等，消费端按 lastDate 跳过）
    for (const s of patch.stockLimits ?? []) enqueueVolUpdate(s?.code ?? "");
  }
  if (patch.allowShort !== undefined) g.allowShort = patch.allowShort;
  if (patch.isPaper !== undefined) { if (patch.isPaper) g.isPaper = true; else delete g.isPaper; }
  if (patch.aggSources !== undefined) { if (Array.isArray(patch.aggSources) && patch.aggSources.length > 0) g.aggSources = patch.aggSources; else delete g.aggSources; }
  g.updatedAt = new Date().toISOString();
  kvSet(GROUP_PREFIX + id, g);
  return g;
}

/** 删除分组（连带其全部交易条目） */
export function deleteGroup(id: string): boolean {
  if (!getGroup(id)) return false;
  kvDelete(GROUP_PREFIX + id);
  for (const t of listEntriesByGroup(id)) kvDelete(TRADE_PREFIX + t.id);
  // 列表自愈：剔除已删条目与死 id
  kvSet(
    TRADE_LIST,
    listEntryIds().filter((x) => {
      const e = getEntry(x);
      return e !== null && e.groupId !== id;
    }),
  );
  kvSet(GROUP_LIST, listGroupIds().filter((x) => x !== id));
  // 一致性：清理其他聚合分组对已删分组的来源引用（悬空 aggSources 不留脏数据）
  for (const g of listGroups()) {
    if (Array.isArray(g.aggSources) && g.aggSources.includes(id)) {
      const next = g.aggSources.filter((x) => x !== id);
      const g2 = { ...g };
      if (next.length > 0) g2.aggSources = next;
      else delete g2.aggSources;
      kvSet(GROUP_PREFIX + g.id, g2);
    }
  }
  return true;
}

// ---------- 交易 ----------

export function listEntryIds(): string[] {
  return kvGet<string[]>(TRADE_LIST) ?? [];
}

/** 全部交易（按日期、录入时间倒序——最新在前） */
export function listEntries(): TradeV2Entry[] {
  const out: TradeV2Entry[] = [];
  for (const id of listEntryIds()) {
    const e = getEntry(id);
    if (e) out.push(e);
  }
  return out.sort((a, b) =>
    a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : a.date < b.date ? 1 : -1,
  );
}

/** 组内交易（按日期、录入时间升序——重放顺序） */
export function listEntriesByGroup(groupId: string): TradeV2Entry[] {
  return sortReplay(listEntries().filter((e) => e.groupId === groupId));
}

/** 组内交易（基于已加载的全量条目——批量派生场景复用，避免每组重读一次全部 KV） */
export function listEntriesByGroupFrom(all: TradeV2Entry[], groupId: string): TradeV2Entry[] {
  return sortReplay(all.filter((e) => e.groupId === groupId));
}

/** 重放顺序排序（日期升序，同日按录入时间升序） */
function sortReplay(entries: TradeV2Entry[]): TradeV2Entry[] {
  return entries.sort((a, b) =>
    a.date === b.date ? a.createdAt.localeCompare(b.createdAt) : a.date < b.date ? -1 : 1,
  );
}

/**
 * 分组条目派生（聚合分组核心，memo 新增）：
 * 基础分组 = 自有条目；聚合分组 = 来源分组（基础/聚合均可）条目递归并集。
 * 环检测：聚合嵌套循环引用时跳过已访问分组，避免死循环。
 *
 * 性能：批量派生（如总览一次性算全部分组）用 getGroupEntriesFrom 复用已加载条目，
 * 否则每分组都要重读一次全量 KV 并排序（组数 × 条目数的重复 IO）。
 */
export function getGroupEntries(groupId: string): TradeV2Entry[] {
  return getGroupEntriesFrom(listEntries(), groupId);
}

/** 分组条目派生（基于已加载的全量条目） */
export function getGroupEntriesFrom(all: TradeV2Entry[], groupId: string): TradeV2Entry[] {
  const seen = new Set<string>();
  const out: TradeV2Entry[] = [];
  const visit = (gid: string): void => {
    if (seen.has(gid)) return;
    seen.add(gid);
    const g = getGroup(gid);
    if (!g) return;
    if (Array.isArray(g.aggSources) && g.aggSources.length > 0) {
      for (const src of g.aggSources) visit(src);
    } else {
      out.push(...listEntriesByGroupFrom(all, gid));
    }
  };
  visit(groupId);
  return sortReplay(out);
}

export function getEntry(id: string): TradeV2Entry | null {
  const e = kvGet<TradeV2Entry>(TRADE_PREFIX + id);
  if (!e || typeof e.id !== "string" || typeof e.groupId !== "string") return null;
  return e;
}

export function createEntry(
  input: Omit<TradeV2Entry, "id" | "createdAt" | "updatedAt">,
  opts?: { createdAt?: string },
): TradeV2Entry {
  const now = new Date().toISOString();
  const e: TradeV2Entry = { ...input, id: genId("t"), createdAt: opts?.createdAt ?? now, updatedAt: now };
  kvSet(TRADE_PREFIX + e.id, e);
  const list = listEntryIds().filter((x) => x !== e.id);
  list.unshift(e.id);
  kvSet(TRADE_LIST, list.slice(0, MAX_TRADES));
  return e;
}

export function updateEntry(id: string, patch: Partial<Omit<TradeV2Entry, "id" | "createdAt">>): TradeV2Entry | null {
  const e = getEntry(id);
  if (!e) return null;
  const next: TradeV2Entry = { ...e, ...patch, id: e.id, createdAt: e.createdAt, updatedAt: new Date().toISOString() };
  kvSet(TRADE_PREFIX + id, next);
  return next;
}

export function deleteEntry(id: string): boolean {
  if (!getEntry(id)) return false;
  kvDelete(TRADE_PREFIX + id);
  kvSet(TRADE_LIST, listEntryIds().filter((x) => x !== id));
  return true;
}

/** 移动某标的（fromGroupId 内该 code 的全部交易）到 toGroupId；返回移动条数（memo mt2ttvqd） */
export function moveStock(fromGroupId: string, code: string, toGroupId: string): number {
  let moved = 0;
  for (const id of listEntryIds()) {
    const e = getEntry(id);
    if (e && e.groupId === fromGroupId && e.code === code) {
      updateEntry(id, { groupId: toGroupId });
      moved++;
    }
  }
  return moved;
}
