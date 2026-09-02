// ============================================================
// 自选股：数据层（KV 持久化，Key-结构化 Value）
// ------------------------------------------------------------
// 存储约定（2026-09-02 二次重构，弃用「分组 / 聚合分组」）：
//   watchlist:tag:<id>        → WatchTag（多级筛选标签；「全部」为预置根）
//   watchlist:item:<code>     → WatchItem（标的是一等公民，tags 为其归属）
//   watchlist:alert:<code>    → WatchAlertRule[]（挂标的，跨 tag 复用）
//   watchlist:alertHit:<code> → WatchAlertHit[]（按 ruleId+date 去重）
//   watchlist:logic:<code>    → WatchLogicReview[]（标的时间序列复核历史）
//   watchlist:migrated        → 历史「分组」数据升级标记（幂等）
// KV 前缀沿用 `watchlist:`——旧分组键（watchlist:<groupId>）**保留不删**，
// 首次访问时幂等升级为「tag 树 + 标的」（见 ensureMigrated）。
// 遵循本地数据治理：运行时从 KV 读，代码无硬编码业务数据；用户可在「本地数据管理」页查看/编辑/删除。
// ============================================================

import { kvGet, kvListRaw, kvSet, kvDelete } from "../../core/kvStore.js";
import { WATCH_ROOT_TAG } from "@toolbox/shared";
import type {
  WatchAlertHit,
  WatchAlertRule,
  WatchItem,
  WatchLogicReview,
  WatchTag,
  WatchTagNode,
} from "@toolbox/shared";
import { enqueueVolUpdate } from "../../core/volatilityStore.js";

/** KV key 前缀（数据源注册名） */
export const PREFIX = "watchlist:";
/** tag 前缀 */
export const TAG_PREFIX = "watchlist:tag:";
/** 标的前缀 */
export const ITEM_PREFIX = "watchlist:item:";
/** 提醒规则前缀 */
export const ALERT_PREFIX = "watchlist:alert:";
/** 提醒命中前缀 */
export const ALERT_HIT_PREFIX = "watchlist:alertHit:";
/** 逻辑复核历史前缀 */
export const LOGIC_PREFIX = "watchlist:logic:";
/** Chat 导入预览（用后即焚） */
export const PREVIEW_PREFIX = "watchlist:importPreview:";
/** 历史分组数据升级标记 */
export const MIGRATED_KEY = "watchlist:migrated";

/** 旧分组键（2026-09-01 模型：watchlist:<groupId>） */
const GROUP_KEY_RE = /^watchlist:[A-Za-z0-9-]+$/;

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

/** 生成 id（时间戳 + 随机段，可作 KV key 段） */
export function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================
// 一、tag 树
// ============================================================

function numOrUndef(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function normalizeItem(s: WatchItem, fallbackAt?: string): WatchItem {
  const raw = s as WatchItem & { addedAt?: string; tags?: unknown };
  const tags = Array.isArray(raw?.tags)
    ? Array.from(new Set(raw.tags.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim())))
    : [];
  return {
    code: typeof s?.code === "string" ? s.code.trim() : "",
    ...(typeof s?.name === "string" && s.name.trim() ? { name: s.name.trim() } : {}),
    ...(s?.kind === "fund" ? { kind: "fund" as const } : {}),
    reason: typeof s?.reason === "string" ? s.reason.trim() : "",
    ...(typeof s?.expectation === "string" && s.expectation.trim() ? { expectation: s.expectation.trim() } : {}),
    ...(numOrUndef(s?.targetPrice) !== undefined ? { targetPrice: numOrUndef(s.targetPrice) } : {}),
    addedAt: typeof raw?.addedAt === "string" && raw.addedAt ? raw.addedAt : fallbackAt ?? new Date().toISOString(),
    tags,
  };
}

function normalizeTag(raw: unknown): WatchTag | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string") return null;
  return {
    id: r.id,
    name: r.name,
    parentId: typeof r.parentId === "string" && r.parentId ? r.parentId : null,
    sort: Number.isFinite(Number(r.sort)) ? Number(r.sort) : 0,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date(0).toISOString(),
  };
}

/** 全部 tag（扁平，未排序） */
export function listTags(): WatchTag[] {
  const out: WatchTag[] = [];
  for (const r of kvListRaw(TAG_PREFIX, 2000)) {
    const t = normalizeTag(parseRow(r.value));
    if (t) out.push(t);
  }
  return out;
}

export function getTag(id: string): WatchTag | null {
  return normalizeTag(kvGet(`${TAG_PREFIX}${id}`));
}

function tagKey(id: string): string {
  return `${TAG_PREFIX}${id}`;
}

/** 确保根 tag「全部」存在（预置，不可删除/移动） */
export function ensureRootTag(): WatchTag {
  const exist = getTag(WATCH_ROOT_TAG);
  if (exist) return exist;
  const root: WatchTag = {
    id: WATCH_ROOT_TAG,
    name: "全部",
    parentId: null,
    sort: 0,
    createdAt: new Date().toISOString(),
  };
  kvSet(tagKey(root.id), root);
  return root;
}

/** tag 的全部后代 id（含自身） */
export function descendantIds(id: string): string[] {
  const all = listTags();
  const childrenOf = new Map<string | null, string[]>();
  for (const t of all) {
    const k = t.parentId;
    childrenOf.set(k, [...(childrenOf.get(k) ?? []), t.id]);
  }
  const out: string[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop() as string;
    out.push(cur);
    for (const c of childrenOf.get(cur) ?? []) stack.push(c);
  }
  return out;
}

/**
 * 构建 tag 树（含统计）。
 * 根为「全部」；itemCount = 直接挂在该 tag 的标的数，totalCount = 含后代去重总数。
 */
export function tagTree(items?: WatchItem[]): WatchTagNode[] {
  const all = listTags();
  const list = items ?? listItems();
  const direct = new Map<string, number>();
  for (const it of list) {
    for (const t of it.tags) direct.set(t, (direct.get(t) ?? 0) + 1);
  }
  const byId = new Map(all.map((t) => [t.id, t]));
  const childrenOf = new Map<string | null, WatchTag[]>();
  for (const t of all) {
    const k = t.parentId;
    childrenOf.set(k, [...(childrenOf.get(k) ?? []), t]);
  }
  for (const arr of childrenOf.values()) arr.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));

  const build = (t: WatchTag): WatchTagNode => {
    const kids = (childrenOf.get(t.id) ?? []).map(build);
    const ids = descendantIds(t.id);
    const codes = new Set<string>();
    for (const it of list) if (it.tags.some((x) => ids.includes(x))) codes.add(it.code);
    return {
      id: t.id,
      name: t.name,
      parentId: t.parentId,
      sort: t.sort,
      itemCount: direct.get(t.id) ?? 0,
      totalCount: codes.size,
      ...(t.id === WATCH_ROOT_TAG ? { preset: true } : {}),
      children: kids,
    };
  };

  const roots = childrenOf.get(null) ?? [];
  const rootTag = byId.get(WATCH_ROOT_TAG);
  if (rootTag) return [build(rootTag)];
  // 根缺失（理论上不会，ensureRootTag 兜底）→ 把所有无父 tag 作为根
  return roots.map(build);
}

export function createTag(name: string, parentId?: string | null): WatchTag | null {
  ensureRootTag();
  const pid = parentId && getTag(parentId) ? parentId : WATCH_ROOT_TAG;
  const siblings = listTags().filter((t) => t.parentId === pid);
  const tag: WatchTag = {
    id: genId(),
    name: name.trim().slice(0, 20) || "新标签",
    parentId: pid,
    sort: siblings.length,
    createdAt: new Date().toISOString(),
  };
  kvSet(tagKey(tag.id), tag);
  return tag;
}

/** 是否自己的后代（用于移动校验，防环） */
function isDescendant(candidate: string, ofId: string): boolean {
  if (candidate === ofId) return true;
  return descendantIds(ofId).slice(1).includes(candidate);
}

/**
 * 更新 tag：改名 / 移动 / 排序。
 * 移动禁止到自身后代下（会成环）；禁止移动根 tag。
 */
export function updateTag(
  id: string,
  patch: { name?: string; parentId?: string | null; sort?: number },
): WatchTag | null {
  const t = getTag(id);
  if (!t) return null;
  if (id === WATCH_ROOT_TAG && patch.parentId !== undefined && patch.parentId !== null) return null;

  if (patch.name !== undefined) t.name = patch.name.trim().slice(0, 20) || t.name;

  let parentChanged = false;
  if (patch.parentId !== undefined) {
    const pid = patch.parentId && getTag(patch.parentId) ? patch.parentId : WATCH_ROOT_TAG;
    if (pid !== id && !isDescendant(pid, id)) {
      if (t.parentId !== pid) parentChanged = true;
      t.parentId = pid;
    }
  }
  if (patch.sort !== undefined) {
    t.sort = Number(patch.sort);
  } else if (parentChanged) {
    const siblings = listTags().filter((x) => x.parentId === t.parentId && x.id !== id);
    t.sort = siblings.length;
  }
  kvSet(tagKey(id), t);
  return t;
}

/**
 * 删除 tag。
 * - promote（默认）：子 tag 提升到父级，标的改挂父级——**不删任何标的**
 * - cascade：连同子 tag 一起删，标的摘除这些 tag（标的本身保留）
 * 根 tag 不可删。
 */
export function deleteTag(id: string, mode: "promote" | "cascade" = "promote"): { deletedTags: number; affectedItems: number } | null {
  const t = getTag(id);
  if (!t || id === WATCH_ROOT_TAG) return null;
  const parent = t.parentId ?? WATCH_ROOT_TAG;
  const all = listTags();
  const toDelete = mode === "cascade" ? new Set(descendantIds(id)) : new Set([id]);
  const affected = new Set<string>();

  for (const tid of toDelete) {
    const cur = getTag(tid);
    if (!cur) continue;
    for (const child of all.filter((x) => x.parentId === tid)) {
      if (toDelete.has(child.id)) continue;
      // 子 tag 提升到被删 tag 的父级（cascade 下已是父级的子级集合，仍逐个提）
      updateTag(child.id, { parentId: parent });
    }
    for (const it of listItems()) {
      if (!it.tags.includes(tid)) continue;
      affected.add(it.code);
      const nextTags = mode === "cascade" ? it.tags.filter((x) => x !== tid) : it.tags.map((x) => (x === tid ? parent : x));
      const dedup = Array.from(new Set(nextTags.filter((x) => x && getTag(x))));
      saveItem({ ...it, tags: dedup });
    }
    kvDelete(tagKey(tid));
  }
  return { deletedTags: toDelete.size, affectedItems: affected.size };
}

// ============================================================
// 二、标的（核心实体）
// ============================================================

function itemKey(code: string): string {
  return `${ITEM_PREFIX}${code}`;
}

/** 全部标的（按 code 升序） */
export function listItems(): WatchItem[] {
  const out: WatchItem[] = [];
  for (const r of kvListRaw(ITEM_PREFIX, 5000)) {
    const it = normalizeItem(parseRow<WatchItem>(r.value) as WatchItem);
    if (it.code) out.push(it);
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

export function getItem(code: string): WatchItem | null {
  // 注意：kvGet 内部已 JSON.parse（返回对象），**不能**再套 parseRow（只接受字符串，会恒返回 null
  // → getAll 类读路径正常、单条读路径全部「标的不存在」）。kvListRaw 才需要 parseRow。
  const raw = kvGet<WatchItem | null>(itemKey(code));
  if (!raw || typeof raw !== "object") return null;
  const it = normalizeItem(raw);
  return it.code ? it : null;
}

export function saveItem(item: WatchItem): WatchItem {
  const next = normalizeItem(item);
  kvSet(itemKey(next.code), next);
  return next;
}

/** 新增标的（已存在则视为更新，返回实际对象） */
export function createItem(input: {
  code: string;
  name?: string;
  kind?: "stock" | "fund";
  reason?: string;
  expectation?: string;
  targetPrice?: number;
  tags?: string[];
}): WatchItem {
  const code = (input.code ?? "").trim();
  const now = new Date().toISOString();
  ensureRootTag();
  const exist = getItem(code);
  const tags = Array.from(
    new Set((input.tags ?? exist?.tags ?? []).filter((t) => typeof t === "string" && getTag(t))),
  );
  const next: WatchItem = {
    code,
    ...(input.name?.trim() || exist?.name ? { name: (input.name ?? exist?.name ?? "").trim() } : {}),
    ...(input.kind === "fund" ? { kind: "fund" as const } : {}),
    reason: input.reason?.trim() ?? exist?.reason ?? "",
    ...(input.expectation?.trim() ? { expectation: input.expectation.trim() } : {}),
    ...(numOrUndef(input.targetPrice) !== undefined ? { targetPrice: numOrUndef(input.targetPrice) as number } : {}),
    addedAt: exist?.addedAt ?? now,
    tags,
    updatedAt: now,
  };
  if (!exist) enqueueVolUpdate(code); // 新增标的感知：入队波动率初始化（幂等）
  kvSet(itemKey(code), next);
  return next;
}

export interface UpdateItemPatch {
  name?: string;
  kind?: "stock" | "fund";
  reason?: string;
  expectation?: string;
  targetPrice?: number | null;
  tags?: string[];
  addedAt?: string;
}

/** 更新标的（理由/预期/目标价/tag 归属）；不存在返回 null */
export function updateItem(code: string, patch: UpdateItemPatch): WatchItem | null {
  const it = getItem(code);
  if (!it) return null;
  const next: WatchItem = { ...it };

  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (n) next.name = n;
    else delete next.name;
  }
  if (patch.kind !== undefined) {
    if (patch.kind === "fund") next.kind = "fund";
    else delete next.kind;
  }
  if (patch.reason !== undefined) next.reason = patch.reason.trim();
  if (patch.expectation !== undefined) {
    const e = patch.expectation.trim();
    if (e) next.expectation = e;
    else delete next.expectation;
  }
  if (patch.targetPrice !== undefined) {
    if (patch.targetPrice === null || !Number.isFinite(patch.targetPrice)) delete next.targetPrice;
    else next.targetPrice = Number(patch.targetPrice);
  }
  if (patch.tags !== undefined) {
    // tag 归属：过滤不存在的 tag，去重；空 = 仅在「全部」
    next.tags = Array.from(new Set(patch.tags.filter((t) => typeof t === "string" && !!getTag(t))));
  }
  if (patch.addedAt !== undefined && patch.addedAt) next.addedAt = patch.addedAt;
  next.updatedAt = new Date().toISOString();
  return saveItem(next);
}

/** 删除标的：连同其提醒规则/命中/复核历史一并清理（避免孤儿数据） */
export function deleteItem(code: string): boolean {
  if (!getItem(code)) return false;
  kvDelete(itemKey(code));
  kvDelete(`${ALERT_PREFIX}${code}`);
  kvDelete(`${ALERT_HIT_PREFIX}${code}`);
  kvDelete(`${LOGIC_PREFIX}${code}`);
  return true;
}

/** 按 tag 筛选标的：tag 为空/null/「全部」→ 全量；否则取该 tag 及全部后代 */
export function filterItemsByTag(tagId?: string | null): WatchItem[] {
  const all = listItems();
  if (!tagId || tagId === WATCH_ROOT_TAG) return all;
  const ids = new Set(descendantIds(tagId));
  return all.filter((it) => it.tags.some((t) => ids.has(t)));
}

// ============================================================
// 三、提醒规则 / 命中 / 复核历史（均挂「标的」）
// ============================================================

export function getAlertRules(code: string): WatchAlertRule[] {
  const v = kvGet<WatchAlertRule[]>(`${ALERT_PREFIX}${code}`);
  return Array.isArray(v) ? v : [];
}

export function saveAlertRules(code: string, rules: WatchAlertRule[]): WatchAlertRule[] {
  kvSet(`${ALERT_PREFIX}${code}`, rules);
  return rules;
}

export function getAlertHits(code: string): WatchAlertHit[] {
  const v = kvGet<WatchAlertHit[]>(`${ALERT_HIT_PREFIX}${code}`);
  return Array.isArray(v) ? v : [];
}

export function saveAlertHits(code: string, hits: WatchAlertHit[]): WatchAlertHit[] {
  kvSet(`${ALERT_HIT_PREFIX}${code}`, hits);
  return hits;
}

/** 单个标的的复核历史（按时间升序：体现「随时间是否成立」） */
export function getReviews(code: string): WatchLogicReview[] {
  const v = kvGet<WatchLogicReview[]>(`${LOGIC_PREFIX}${code}`);
  return Array.isArray(v) ? v.filter((r) => r && typeof r.at === "string") : [];
}

/** 追加一次复核（保留最近 50 条；返回完整历史） */
export function appendReview(code: string, review: WatchLogicReview): WatchLogicReview[] {
  const list = [...getReviews(code), review].slice(-50);
  kvSet(`${LOGIC_PREFIX}${code}`, list);
  return list;
}

// ============================================================
// 四、历史「分组」数据升级（幂等，原键保留不删）
// ------------------------------------------------------------
// 旧模型（2026-09-01）：watchlist:<groupId> → { name, items[], legacyGroup?, aggSources? }
// 升级映射：
//   · 根 tag「全部」（预置）
//   · 旧分组                    → 一个 tag（有 legacyGroup 的挂到同名父 tag 下）
//   · 旧聚合分组（aggSources）  → 父 tag，源分组 tag 迁为其子（重叠分类 = 多 tag 的上游形态）
//   · 所有分组的 items          → 按 code 合并为独立标的，tags = 所有包含它的 tag id
//   · 旧提醒/命中/复核          → 按 code 重新挂载
// 只读旧键、只写新键，旧分组数据完整保留（可回退）。
// ============================================================

interface LegacyItem {
  code?: string;
  name?: string;
  kind?: string;
  reason?: string;
  expectation?: string;
  targetPrice?: number;
  addedAt?: string;
}

interface LegacyGroup {
  id: string;
  name: string;
  description?: string;
  items?: LegacyItem[];
  stocks?: LegacyItem[];
  group?: string;
  legacyGroup?: string;
  aggSources?: string[];
  createdAt?: string;
}

function readLegacyGroups(): LegacyGroup[] {
  const out: LegacyGroup[] = [];
  for (const r of kvListRaw(PREFIX, 5000)) {
    if (!GROUP_KEY_RE.test(r.key)) continue; // 过滤 tag:/item:/alert:/alertHit:/logic:/importPreview:
    const g = parseRow<LegacyGroup>(r.value);
    if (g && typeof g.id === "string" && typeof g.name === "string") out.push(g);
  }
  return out;
}

/**
 * 清理旧「分组」模型残留键（迁移完成后调用；升级后若因历史原因残留也调用）。
 * 只删 readLegacyGroups 实际读到的那些（避免误删其它 watchlist: 前缀数据），
 * 留着不删会变成「未标记数据源」违反数据治理原则。
 */
function cleanupLegacyGroupKeys(groups: LegacyGroup[]): void {
  for (const g of groups) {
    kvDelete(`${PREFIX}${g.id}`); // 旧 watchlist:<groupId>（分组本体）
    kvDelete(`${ALERT_PREFIX}${g.id}`);
    kvDelete(`${ALERT_HIT_PREFIX}${g.id}`);
    for (const row of kvListRaw(`${LOGIC_PREFIX}${g.id}:`, 2000)) kvDelete(row.key);
  }
  // 顺手清理本次升级产生的临时键（legacyGroup 已并入 tag 名，不再需要）
  kvDelete(`${PREFIX}hotnews`);
}

/**
 * 历史数据升级（幂等；已升级则跳过重建，但残留旧键仍清理）。
 * 返回本次升级的统计（未升级返回 null）。
 */
export function migrateLegacyGroups(): { tags: number; items: number; alerts: number } | null {
  const alreadyMigrated = !!kvGet(MIGRATED_KEY);
  const groups = readLegacyGroups();
  // 已升级过 → 不再重建 tag/标的（避免重复），但仍清理可能残留的旧分组键
  if (alreadyMigrated) {
    if (groups.length > 0) cleanupLegacyGroupKeys(groups);
    return null;
  }
  ensureRootTag();

  // 1) 为每个旧分组建 tag：有 legacyGroup（旧专题分组名）的挂到同名父 tag 下
  const legacyParentTag = new Map<string, string>();
  const groupTagId = new Map<string, string>();

  const ensureNamedTag = (name: string, parentId: string): string => {
    const trimmed = name.trim();
    if (!trimmed) return parentId;
    const exist = listTags().find((t) => t.parentId === parentId && t.name === trimmed);
    if (exist) return exist.id;
    const created = createTag(trimmed, parentId);
    return created ? created.id : parentId;
  };

  for (const g of groups) {
    const legacyName = (g.legacyGroup ?? g.group ?? "").trim();
    let parentId = WATCH_ROOT_TAG;
    if (legacyName) {
      let pid = legacyParentTag.get(legacyName);
      if (!pid) {
        pid = ensureNamedTag(legacyName, WATCH_ROOT_TAG);
        legacyParentTag.set(legacyName, pid);
      }
      parentId = pid;
    }
    const tid = ensureNamedTag(g.name, parentId);
    groupTagId.set(g.id, tid);
  }

  // 2) 聚合分组：源分组 tag 迁为聚合 tag 的子级
  for (const g of groups) {
    const sources = Array.isArray(g.aggSources) ? g.aggSources : [];
    if (sources.length === 0) continue;
    const aggTagId = groupTagId.get(g.id);
    if (!aggTagId) continue;
    for (const srcId of sources) {
      const srcTagId = groupTagId.get(srcId);
      if (!srcTagId || srcTagId === aggTagId) continue;
      if (isDescendant(aggTagId, srcTagId)) continue; // 防环
      updateTag(srcTagId, { parentId: aggTagId });
    }
  }

  // 3) 标的：按 code 合并，tags = 所有包含它的 tag id
  const merged = new Map<string, WatchItem>();
  for (const g of groups) {
    const tid = groupTagId.get(g.id);
    const rawItems = Array.isArray(g.items) ? g.items : Array.isArray(g.stocks) ? g.stocks : [];
    for (const raw of rawItems) {
      const code = (raw?.code ?? "").trim();
      if (!code) continue;
      const base = normalizeItem(raw as WatchItem, g.createdAt);
      const exist = merged.get(code);
      if (exist) {
        if (tid && !exist.tags.includes(tid)) exist.tags.push(tid);
        // 保留更完整的字段（先出现的优先，后续只补空）
        if (!exist.reason && base.reason) exist.reason = base.reason;
        if (!exist.expectation && base.expectation) exist.expectation = base.expectation;
        if (exist.targetPrice === undefined && base.targetPrice !== undefined) exist.targetPrice = base.targetPrice;
        if (!exist.name && base.name) exist.name = base.name;
        if (base.addedAt < exist.addedAt) exist.addedAt = base.addedAt; // 最早入选时间为基线
      } else {
        merged.set(code, {
          ...base,
          reason: base.reason || (g.description ?? "").trim(), // 无理由时用分组介绍兜底（不丢信息）
          tags: tid ? [tid] : [],
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }
  for (const it of merged.values()) {
    saveItem(it);
    enqueueVolUpdate(it.code);
  }

  // 4) 旧提醒规则/命中/复核历史按 code 重新挂载
  let alerts = 0;
  for (const g of groups) {
    const oldRules = kvGet<WatchAlertRule[]>(`${ALERT_PREFIX}${g.id}`);
    if (Array.isArray(oldRules) && oldRules.length > 0) {
      for (const rule of oldRules) {
        if (!rule || typeof rule.code !== "string" || !rule.code) continue;
        const cur = getAlertRules(rule.code);
        if (cur.some((r) => r.id === rule.id)) continue;
        saveAlertRules(rule.code, [...cur, rule]);
        alerts++;
      }
    }
    const oldHits = kvGet<WatchAlertHit[]>(`${ALERT_HIT_PREFIX}${g.id}`);
    if (Array.isArray(oldHits) && oldHits.length > 0) {
      for (const hit of oldHits) {
        if (!hit || typeof hit.code !== "string" || !hit.code) continue;
        const cur = getAlertHits(hit.code);
        if (cur.some((h) => h.ruleId === hit.ruleId && h.date === hit.date)) continue;
        saveAlertHits(hit.code, [...cur, hit].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 50));
      }
    }
    for (const row of kvListRaw(`${LOGIC_PREFIX}${g.id}:`, 2000)) {
      const code = row.key.slice(`${LOGIC_PREFIX}${g.id}:`.length);
      const reviews = parseRow<WatchLogicReview[]>(row.value);
      if (!code || !Array.isArray(reviews)) continue;
      const cur = getReviews(code);
      const byAt = new Map(cur.map((r) => [r.at, r]));
      for (const r of reviews) if (r && typeof r.at === "string") byAt.set(r.at, r);
      const next = [...byAt.values()].sort((a, b) => (a.at < b.at ? -1 : 1)).slice(-50);
      kvSet(`${LOGIC_PREFIX}${code}`, next);
    }
  }

  // 5) 清理旧分组键（升级后已无引用，留着会变成「未标记数据源」违反治理）
  cleanupLegacyGroupKeys(groups);

  kvSet(MIGRATED_KEY, {
    at: new Date().toISOString(),
    groups: groups.length,
    tags: listTags().length,
    items: merged.size,
    alerts,
  });
  return { tags: listTags().length, items: merged.size, alerts };
}

/** 任意读路径前调用：保证根 tag 存在 + 历史数据已升级 */
export function ensureReady(): void {
  ensureRootTag();
  migrateLegacyGroups();
}
