// ============================================================
// 凯利仓位助手：历史记录数据层（单 KV 文档 kelly:history）
// 计算成功自动保存（时间戳 + 输入参数 + 完整结果），上限 50 条截断最旧；
// 遵循本地数据治理原则：运行时从 KV 读，用户可在「本地数据管理」页查看/编辑/删除。
// ============================================================

import { kvGet, kvSet } from "../../core/kvStore.js";
import type { KellyHistoryEntry, KellyRequest, KellyResult } from "@toolbox/shared";

/** KV key（数据源注册名） */
export const HISTORY_KEY = "kelly:history";

/** 历史记录上限 */
const HISTORY_MAX = 50;

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readAll(): KellyHistoryEntry[] {
  const saved = kvGet<{ entries?: unknown[] }>(HISTORY_KEY);
  if (!Array.isArray(saved?.entries)) return [];
  return saved.entries
    .filter((e): e is KellyHistoryEntry => !!e && typeof (e as KellyHistoryEntry).id === "string")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // 最新在前
}

function writeAll(entries: KellyHistoryEntry[]): void {
  kvSet(HISTORY_KEY, { entries });
}

/** 生成摘要（列表展示） */
function summarize(req: KellyRequest, result: KellyResult): KellyHistoryEntry["summary"] {
  const kelly = result.schemes?.find((s) => s.key === "kelly");
  return {
    price: req.price,
    takeProfit: req.takeProfit,
    stopLoss: req.stopLoss,
    winRate: req.winRate,
    maxAmount: req.maxAmount,
    b: result.b,
    fRaw: result.fRaw,
    kellyCash: kelly?.cash ?? 0,
    kellyPct: kelly?.pct ?? 0,
    ...(req.code ? { code: req.code } : {}),
    ...(req.name ? { name: req.name } : {}),
  };
}

/** 保存一条历史（计算成功才保存）；返回保存后的条目 */
export function saveHistory(req: KellyRequest, result: KellyResult): KellyHistoryEntry | null {
  if (!result.ok) return null;
  const entry: KellyHistoryEntry = {
    id: genId(),
    createdAt: new Date().toISOString(),
    request: {
      price: req.price,
      takeProfit: req.takeProfit,
      stopLoss: req.stopLoss,
      winRate: req.winRate,
      maxAmount: req.maxAmount,
      ...(req.code ? { code: req.code } : {}),
      ...(req.name ? { name: req.name } : {}),
    },
    summary: summarize(req, result),
    result,
  };
  const entries = readAll();
  entries.unshift(entry);
  if (entries.length > HISTORY_MAX) entries.length = HISTORY_MAX;
  writeAll(entries);
  return entry;
}

/** 历史列表（摘要） */
export function listHistory(): KellyHistoryEntry[] {
  return readAll();
}

/** 历史详情（无则 null） */
export function getHistory(id: string): KellyHistoryEntry | null {
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
