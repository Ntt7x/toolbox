// ============================================================
// 交易网格计划：历史记录数据层（单 KV 文档 gridPlan:history）
// 生成成功后自动保存（含时间戳 + 输入参数 + 完整结果），上限 50 条截断最旧；
// 遵循本地数据治理原则：运行时从 KV 读，用户可在「本地数据管理」页查看/编辑/删除。
// ============================================================

import { kvGet, kvSet, kvDelete } from "../../core/kvStore.js";
import type { GridPlanHistoryEntry, GridPlanRequest, GridPlanResult } from "@toolbox/shared";

/** KV key（数据源注册名） */
export const HISTORY_KEY = "gridPlan:history";

/** 历史记录上限 */
const HISTORY_MAX = 50;

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readAll(): GridPlanHistoryEntry[] {
  const saved = kvGet<{ entries?: unknown[] }>(HISTORY_KEY);
  if (!Array.isArray(saved?.entries)) return [];
  return saved.entries
    .filter((e): e is GridPlanHistoryEntry => !!e && typeof (e as GridPlanHistoryEntry).id === "string")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // 最新在前
}

function writeAll(entries: GridPlanHistoryEntry[]): void {
  kvSet(HISTORY_KEY, { entries });
}

/** 生成摘要（列表展示） */
function summarize(req: GridPlanRequest, result: GridPlanResult): GridPlanHistoryEntry["summary"] | null {
  if (!result.ok) return null;
  const styles = result.styles ?? {};
  // 均衡档（bal）单档买入金额；旧实现取 styles 首键（rad）与契约「均衡档」不符（2026-08 修复）
  const balKey = "bal" as keyof typeof styles;
  return {
    typeName: result.typeName,
    U: result.U,
    M: result.M,
    L: result.L,
    rows: Object.keys(styles).length,
    ...(result.maxAmount !== undefined ? { maxAmount: result.maxAmount } : {}),
    perBuy: styles[balKey]?.amount?.buyAmount,
    ...(req.code ? { code: req.code } : {}),
    ...(req.name ? { name: req.name } : {}),
  };
}

/** 保存一条历史（成功结果才保存）；返回保存后的条目 */
export function saveHistory(req: GridPlanRequest, result: GridPlanResult): GridPlanHistoryEntry | null {
  if (!result.ok) return null;
  const summary = summarize(req, result);
  if (!summary) return null;
  const entry: GridPlanHistoryEntry = {
    id: genId(),
    createdAt: new Date().toISOString(),
    request: {
      type: req.type,
      boll: [...req.boll] as [number, number, number],
      ...(req.maxAmount ? { maxAmount: req.maxAmount } : {}),
      ...(req.code ? { code: req.code } : {}),
      ...(req.name ? { name: req.name } : {}),
    },
    summary,
    result,
  };
  const entries = readAll();
  entries.unshift(entry);
  if (entries.length > HISTORY_MAX) entries.length = HISTORY_MAX;
  writeAll(entries);
  return entry;
}

/** 历史列表（摘要） */
export function listHistory(): GridPlanHistoryEntry[] {
  return readAll();
}

/** 历史详情（无则 null） */
export function getHistory(id: string): GridPlanHistoryEntry | null {
  return readAll().find((e) => e.id === id) ?? null;
}

/** 删除一条历史 */
export function deleteHistory(id: string): boolean {
  const entries = readAll();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx < 0) return false;
  entries.splice(idx, 1);
  writeAll(entries);
  return true;
}
