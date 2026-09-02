// ============================================================
// 自选股：分组数据层（KV 持久化，Key-结构化 Value）
// ------------------------------------------------------------
// 存储约定（2026-09-01 重构，原「专题」）：
//   watchlist:<id>            → WatchGroup（基础分组 items 为自有标的；聚合分组 items 空，靠 aggSources 展开）
//   watchlist:alert:<id>      → WatchAlertRule[]（分组提醒规则）
//   watchlist:alertHit:<id>   → WatchAlertHit[]（提醒命中，按 ruleId+date 去重）
//   watchlist:logic:<id>:<code> → WatchLogicReview[]（标的时间序列复核历史）
// KV 前缀沿用 `watchlist:`——保留历史数据，读取时按 normalizeGroup 就地升级（零迁移脚本）。
// 遵循本地数据治理：运行时从 KV 读，代码无硬编码业务数据；用户可在「本地数据管理」页查看/编辑/删除。
// ============================================================

import { kvGet, kvListRaw, kvSet, kvDelete } from "../../core/kvStore.js";
import type { WatchAlertHit, WatchAlertRule, WatchGroup, WatchGroupSummary, WatchItem, WatchLogicReview } from "@toolbox/shared";
import { enqueueVolUpdate } from "../../core/volatilityStore.js";

/** KV key 前缀（数据源注册名） */
export const PREFIX = "watchlist:";
/** 提醒规则前缀 */
export const ALERT_PREFIX = "watchlist:alert:";
/** 提醒命中前缀 */
export const ALERT_HIT_PREFIX = "watchlist:alertHit:";
/** 逻辑复核历史前缀（watchlist:logic:<groupId>:<code>） */
export const LOGIC_PREFIX = "watchlist:logic:";
/** Chat 导入预览（用后即焚） */
export const PREVIEW_PREFIX = "watchlist:importPreview:";

const KEY_RE = /^watchlist:[A-Za-z0-9-]+$/;

function keyOf(id: string): string {
  return `${PREFIX}${id}`;
}

/**
 * 解析 KV 行值（kvListRaw 返回的是原始 JSON 字符串，须自行 parse；
 * 与 kvGet 不同——这是 2026-09-01 重构时踩到的坑：直接把字符串交给 normalize* 会静默全空）。
 */
function parseRow<T = unknown>(raw: string | null | undefined): T | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 生成分组 id（时间戳 + 随机段，可作 KV key 段） */
export function genGroupId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- 规范化 / 历史数据升级 ----------

function numOrUndef(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function normalizeItem(s: WatchItem, fallbackAt?: string): WatchItem {
  const raw = s as WatchItem & { addedAt?: string };
  return {
    code: typeof s?.code === "string" ? s.code.trim() : "",
    ...(typeof s?.name === "string" && s.name.trim() ? { name: s.name.trim() } : {}),
    ...(s?.kind === "fund" ? { kind: "fund" as const } : {}),
    reason: typeof s?.reason === "string" ? s.reason.trim() : "",
    ...(typeof s?.expectation === "string" && s.expectation.trim() ? { expectation: s.expectation.trim() } : {}),
    ...(numOrUndef(s?.targetPrice) !== undefined ? { targetPrice: numOrUndef(s.targetPrice) } : {}),
    addedAt: typeof raw?.addedAt === "string" && raw.addedAt ? raw.addedAt : fallbackAt ?? new Date().toISOString(),
  };
}

/**
 * 读取时升级（兼容旧「专题」文档：stocks → items，group → legacyGroup）。
 * 幂等：新结构再跑一次不变；升级结果不自动回写（避免读路径写库），
 * 下次任何写操作（updateGroup）会自然落为新结构。
 */
export function normalizeGroup(raw: unknown): WatchGroup | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string") return null;
  const createdAt = typeof r.createdAt === "string" ? r.createdAt : new Date(0).toISOString();
  const updatedAt = typeof r.updatedAt === "string" ? r.updatedAt : createdAt;
  // 旧字段 stocks（专题内的个股）→ items
  const rawItems = Array.isArray(r.items) ? r.items : Array.isArray(r.stocks) ? r.stocks : [];
  const items = (rawItems as WatchItem[])
    .map((s) => normalizeItem(s, createdAt))
    .filter((s) => !!s.code);
  const aggSources = Array.isArray(r.aggSources)
    ? (r.aggSources.filter((x): x is string => typeof x === "string" && !!x.trim()))
    : undefined;
  return {
    id: r.id,
    name: r.name,
    ...(typeof r.description === "string" && r.description ? { description: r.description } : {}),
    ...(aggSources && aggSources.length > 0 ? { aggSources } : {}),
    createdAt,
    updatedAt,
    items,
    ...(typeof r.group === "string" && r.group.trim() ? { legacyGroup: r.group.trim() } : {}),
  };
}

// ---------- 分组 CRUD ----------

/** 全部分组（原始文档，含聚合分组的空 items） */
function readAll(): WatchGroup[] {
  const rows = kvListRaw(PREFIX, 5000);
  const out: WatchGroup[] = [];
  for (const r of rows) {
    if (!KEY_RE.test(r.key)) continue; // 过滤 alert:/alertHit:/logic:/importPreview: 等同前缀缓存键
    const g = normalizeGroup(parseRow(r.value));
    if (g) out.push(g);
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function listGroups(): WatchGroup[] {
  return readAll();
}

/** 分组详情（无则 null） */
export function getGroup(id: string): WatchGroup | null {
  const g = kvGet<unknown>(keyOf(id));
  const n = normalizeGroup(g);
  return n && typeof n.id === "string" ? n : null;
}

/** 是否聚合分组 */
export function isAggGroup(g: Pick<WatchGroup, "aggSources">): boolean {
  return Array.isArray(g.aggSources) && g.aggSources.length > 0;
}

/**
 * 展开标的集合：基础分组 = 自有 items；聚合分组 = 各源分组 items 并集（按 code 去重，保持 aggSources 顺序）。
 * 聚合分组不落库存储并集——单一数据源原则（增删源分组即实时反映）。
 */
export function resolveItems(group: WatchGroup): WatchItem[] {
  if (!isAggGroup(group)) return group.items;
  const out: WatchItem[] = [];
  const seen = new Set<string>();
  for (const srcId of group.aggSources ?? []) {
    const src = getGroup(srcId);
    if (!src) continue;
    for (const it of resolveItems(src)) {
      if (seen.has(it.code)) continue;
      seen.add(it.code);
      out.push(it);
    }
  }
  return out;
}

export function createGroup(name: string, description?: string, aggSources?: string[]): WatchGroup {
  const now = new Date().toISOString();
  const sources = (aggSources ?? []).map((s) => s.trim()).filter(Boolean);
  const group: WatchGroup = {
    id: genGroupId(),
    name: name.trim().slice(0, 30),
    ...(description && description.trim() ? { description: description.trim() } : {}),
    ...(sources.length > 0 ? { aggSources: sources } : {}),
    createdAt: now,
    updatedAt: now,
    items: [],
  };
  kvSet(keyOf(group.id), group);
  return group;
}

export interface UpdateGroupPatch {
  name?: string;
  description?: string;
  aggSources?: string[] | null;
  addItems?: WatchItem[];
  updateItems?: WatchItem[];
  removeCodes?: string[];
  reorderCodes?: string[];
}

/**
 * 更新分组（原子提交）：改名 / 改介绍 / 改聚合来源 / 增删改标的 / 重排。
 * 聚合分组不接受标的级改动（标的 = 源分组并集，改标的应去源分组）——由路由层拦截并返回 400。
 */
export function updateGroup(id: string, patch: UpdateGroupPatch): WatchGroup | null {
  const t = getGroup(id);
  if (!t) return null;

  if (patch.name !== undefined) t.name = patch.name.trim().slice(0, 30) || t.name;
  if (patch.description !== undefined) {
    const d = patch.description.trim();
    if (d) t.description = d;
    else delete t.description;
  }
  if (patch.aggSources !== undefined) {
    const s = (patch.aggSources ?? []).map((x) => x.trim()).filter(Boolean);
    if (s.length > 0) t.aggSources = s;
    else delete t.aggSources;
  }

  const items = t.items.slice();

  if (Array.isArray(patch.addItems)) {
    for (const raw of patch.addItems) {
      const ns = normalizeItem(raw);
      if (!ns.code) continue;
      const idx = items.findIndex((x) => x.code === ns.code);
      if (idx >= 0) items[idx] = ns; // 同代码覆盖（理由/预期/目标价更新）
      else {
        items.push(ns);
        // 新增标的感知：立即入队波动率初始化（幂等，见 volatilityStore）
        enqueueVolUpdate(ns.code);
      }
    }
  }

  if (Array.isArray(patch.updateItems)) {
    for (const raw of patch.updateItems) {
      const ns = normalizeItem(raw);
      if (!ns.code) continue;
      const idx = items.findIndex((x) => x.code === ns.code);
      if (idx < 0) continue; // 更新只作用于已存在标的（新增请用 addItems）
      const prev = items[idx];
      items[idx] = {
        ...ns,
        // 入选时间不可被覆盖（逻辑确认的时间基线必须稳定）
        addedAt: prev.addedAt ?? ns.addedAt,
        ...(ns.name ? {} : prev.name ? { name: prev.name } : {}),
      };
    }
  }

  if (Array.isArray(patch.removeCodes)) {
    const rm = new Set(patch.removeCodes.map((c) => c.trim()).filter(Boolean));
    for (let i = items.length - 1; i >= 0; i--) if (rm.has(items[i].code)) items.splice(i, 1);
  }

  // 重排：按 reorderCodes 顺序（未列出的代码保持相对顺序补在末尾；顺序 = 优先级）
  if (Array.isArray(patch.reorderCodes) && patch.reorderCodes.length > 0) {
    const order = patch.reorderCodes.map((c) => c.trim()).filter(Boolean);
    const byCode = new Map(items.map((s) => [s.code, s]));
    const reordered: WatchItem[] = [];
    for (const code of order) {
      const s = byCode.get(code);
      if (s) {
        reordered.push(s);
        byCode.delete(code);
      }
    }
    for (const s of byCode.values()) reordered.push(s);
    items.splice(0, items.length, ...reordered);
  }

  const next: WatchGroup = {
    ...t,
    items,
    updatedAt: new Date().toISOString(),
  };
  kvSet(keyOf(id), next);
  return next;
}

/**
 * 删除分组：连同其提醒规则/命中/复核历史一并清理，并从其它聚合分组的 aggSources 中摘除
 * （避免留下指向已删分组的悬空引用——数据完整性由服务端保证）。
 */
export function deleteGroup(id: string): boolean {
  if (!getGroup(id)) return false;
  kvDelete(keyOf(id));
  kvDelete(`${ALERT_PREFIX}${id}`);
  kvDelete(`${ALERT_HIT_PREFIX}${id}`);
  for (const row of kvListRaw(`${LOGIC_PREFIX}${id}:`, 2000)) kvDelete(row.key);
  for (const g of readAll()) {
    if (!isAggGroup(g) || !(g.aggSources ?? []).includes(id)) continue;
    const rest = (g.aggSources ?? []).filter((x) => x !== id);
    updateGroup(g.id, { aggSources: rest.length > 0 ? rest : null });
  }
  return true;
}

// ---------- 提醒规则 / 命中 ----------

export function getAlertRules(groupId: string): WatchAlertRule[] {
  const v = kvGet<WatchAlertRule[]>(`${ALERT_PREFIX}${groupId}`);
  return Array.isArray(v) ? v : [];
}

export function saveAlertRules(groupId: string, rules: WatchAlertRule[]): WatchAlertRule[] {
  kvSet(`${ALERT_PREFIX}${groupId}`, rules);
  return rules;
}

export function getAlertHits(groupId: string): WatchAlertHit[] {
  const v = kvGet<WatchAlertHit[]>(`${ALERT_HIT_PREFIX}${groupId}`);
  return Array.isArray(v) ? v : [];
}

export function saveAlertHits(groupId: string, hits: WatchAlertHit[]): WatchAlertHit[] {
  kvSet(`${ALERT_HIT_PREFIX}${groupId}`, hits);
  return hits;
}

// ---------- 逻辑复核历史 ----------

/** 单个标的的复核历史（按时间升序：体现「随时间是否成立」） */
export function getReviews(groupId: string, code: string): WatchLogicReview[] {
  const v = kvGet<WatchLogicReview[]>(`${LOGIC_PREFIX}${groupId}:${code}`);
  return Array.isArray(v) ? v.filter((r) => r && typeof r.at === "string") : [];
}

/** 追加一次复核（保留最近 50 条；返回完整历史） */
export function appendReview(groupId: string, code: string, review: WatchLogicReview): WatchLogicReview[] {
  const list = [...getReviews(groupId, code), review].slice(-50);
  kvSet(`${LOGIC_PREFIX}${groupId}:${code}`, list);
  return list;
}

// ---------- 列表摘要（供列表接口装配统计） ----------

/** 摘要骨架（统计字段由路由层按行情/提醒/复核结果填充） */
export function toSummary(g: WatchGroup): WatchGroupSummary {
  return {
    id: g.id,
    name: g.name,
    ...(g.description ? { description: g.description } : {}),
    ...(isAggGroup(g) ? { aggSources: g.aggSources } : {}),
    itemCount: resolveItems(g).length,
    updatedAt: g.updatedAt,
  };
}
