// ============================================================
// 专题自选股：数据层（Key-结构化 Value 持久化）
// 每个专题一个 KV 文档：watchlist:<id> → { id, name, createdAt, updatedAt, stocks }
// 遵循本地数据治理原则：运行时从 KV 读，代码无硬编码业务数据；
// 用户可在「本地数据管理」页查看/编辑/删除。
// ============================================================

import { kvGet, kvListRaw, kvSet, kvDelete } from "../../core/kvStore.js";
import type { WatchlistStock, WatchlistSummary, WatchlistTopic } from "@toolbox/shared";
import { enqueueVolUpdate } from "../../core/volatilityStore.js";

/** KV key 前缀（数据源注册名） */
export const PREFIX = "watchlist:";

const KEY_RE = /^watchlist:[A-Za-z0-9-]+$/;

function keyOf(id: string): string {
  return `${PREFIX}${id}`;
}

/** 生成专题 id（时间戳 + 随机段，可作 KV key 段） */
export function genTopicId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStock(s: WatchlistStock): WatchlistStock {
  return {
    code: typeof s.code === "string" ? s.code.trim() : "",
    ...(typeof s.name === "string" && s.name.trim() ? { name: s.name.trim() } : {}),
    reason: typeof s.reason === "string" ? s.reason.trim() : "",
    ...(s.kind === "fund" ? { kind: "fund" as const } : {}),
  };
}

/** 全部专题摘要（轻量列表） */
export function listTopics(): WatchlistSummary[] {
  const rows = kvListRaw(PREFIX, 5000); // 2026-08 修复：上限不足时缓存键（extend/fundamental）按字典序占满前 500，专题被静默挤出列表
  const out: WatchlistSummary[] = [];
  for (const r of rows) {
    if (!KEY_RE.test(r.key)) continue;
    const t = r.value ? (JSON.parse(r.value) as WatchlistTopic) : null;
    if (!t || typeof t.name !== "string") continue;
    out.push({
      id: t.id,
      name: t.name,
      ...(typeof t.description === "string" && t.description ? { description: t.description } : {}),
      ...(typeof t.group === "string" && t.group ? { group: t.group } : {}),
      stockCount: Array.isArray(t.stocks) ? t.stocks.length : 0,
      updatedAt: t.updatedAt,
    });
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** 专题详情（无则 null） */
export function getTopic(id: string): WatchlistTopic | null {
  const t = kvGet<WatchlistTopic>(keyOf(id));
  return t && typeof t.id === "string" ? t : null;
}

/** 新建专题（同名允许，用 id 区分；description 可选） */
export function createTopic(name: string, description?: string, group?: string): WatchlistTopic {
  const now = new Date().toISOString();
  const topic: WatchlistTopic = {
    id: genTopicId(),
    name: name.trim(),
    ...(description && description.trim() ? { description: description.trim() } : {}),
    ...(group && group.trim() ? { group: group.trim().slice(0, 20) } : {}),
    createdAt: now,
    updatedAt: now,
    stocks: [],
  };
  kvSet(keyOf(topic.id), topic);
  return topic;
}

/** 更新专题（原子提交：改名 / 改介绍 / 增删个股 / 重排）；返回更新后专题，无则 null */
export function updateTopic(
  id: string,
  patch: {
    name?: string;
    description?: string;
    group?: string;
    addStocks?: WatchlistStock[];
    removeCodes?: string[];
    reorderCodes?: string[];
  },
): WatchlistTopic | null {
  const t = getTopic(id);
  if (!t) return null;
  const stocks = t.stocks.slice();
  if (patch.name !== undefined) t.name = patch.name.trim().slice(0, 30) || t.name;
  if (patch.description !== undefined) { const d = patch.description.trim(); if (d) t.description = d; else delete t.description; }
  if (patch.group !== undefined) { const g = patch.group.trim().slice(0, 20); if (g) t.group = g; else delete t.group; }
  if (Array.isArray(patch.addStocks)) {
    for (const s of patch.addStocks) {
      const ns = normalizeStock(s);
      if (!ns.code) continue;
      const idx = stocks.findIndex((x) => x.code === ns.code);
      if (idx >= 0) stocks[idx] = ns; // 同代码更新（理由/名称覆盖）
      else {
        stocks.push(ns);
        // 新增标的感知：专题加个股 → 立即入队波动率初始化（幂等）
        enqueueVolUpdate(ns.code);
      }
    }
  }
  if (Array.isArray(patch.removeCodes)) {
    const rm = new Set(patch.removeCodes.map((c) => c.trim()).filter(Boolean));
    for (let i = stocks.length - 1; i >= 0; i--) if (rm.has(stocks[i].code)) stocks.splice(i, 1);
  }
  // 重排：按 reorderCodes 顺序（未列出的代码保持相对顺序补在末尾；顺序 = 优先级）
  if (Array.isArray(patch.reorderCodes) && patch.reorderCodes.length > 0) {
    const order = patch.reorderCodes.map((c) => c.trim()).filter(Boolean);
    const byCode = new Map(stocks.map((s) => [s.code, s]));
    const reordered: WatchlistStock[] = [];
    for (const code of order) {
      const s = byCode.get(code);
      if (s) {
        reordered.push(s);
        byCode.delete(code);
      }
    }
    for (const s of byCode.values()) reordered.push(s);
    stocks.splice(0, stocks.length, ...reordered);
  }
  const next: WatchlistTopic = {
    ...t,
    name: typeof patch.name === "string" && patch.name.trim() ? patch.name.trim() : t.name,
    // description 显式传值（含空串清空）才更新
    ...(typeof patch.description === "string"
      ? { description: patch.description.trim() ? patch.description.trim() : undefined }
      : {}),
    updatedAt: new Date().toISOString(),
    stocks,
  };
  kvSet(keyOf(id), next);
  return next;
}

/** 删除专题 */
export function deleteTopic(id: string): boolean {
  if (!getTopic(id)) return false;
  kvDelete(keyOf(id));
  return true;
}
