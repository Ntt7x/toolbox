// ============================================================
// 自选股·行情跟踪（features/watchlist/track）
// ------------------------------------------------------------
// 本文件在重构后只剩两件事：
//   ① `loadTrack` —— pipeline/track 的 **Promise 门面**（给非 Effect 调用方用）
//   ② `toAlertContexts` —— 跟踪结果 → 提醒判定上下文（纯函数，保留在此便于单测）
//
// 采集实现已整体迁到 pipeline/track.ts（Effect 版）：
//   快照与日 K 并行、血缘由 Lineage 统一累加。此处**不保留第二份实现**。
// ============================================================

import type { FundSnapshot, QuoteSnapshot, WatchItem, WatchPeriod } from "@toolbox/shared";
import { runEffect } from "../../core/effect/runtime.js";
import { trackEffect, type TrackBundle } from "./pipeline/track.js";
import type { AlertContext } from "./alerts.js";

export { PERIOD_LIMIT, PERIOD_NOTE, trackEffect } from "./pipeline/track.js";
export type { TrackBundle, TrackItem } from "./pipeline/track.js";

/** 采集 + 加工（Promise 门面）：给定标的集合的周期行情 */
export async function loadTrack(
  items: WatchItem[],
  period: WatchPeriod,
  opts: { force?: boolean } = {},
): Promise<TrackBundle> {
  return runEffect(trackEffect(items, period, opts));
}

/**
 * 提醒判定上下文：把周期统计 + 快照组装成 alerts.ts 的输入。
 * 日期取「最新交易日」：日 K 最后一根优先 → 快照时间 → 今天（保证去重键稳定）。
 */
export function toAlertContexts(bundle: TrackBundle): AlertContext[] {
  const today = new Date().toISOString().slice(0, 10);
  return bundle.items.map((it) => {
    const q = bundle.quotes.get(it.code);
    const price = q?.ok ? ((q as QuoteSnapshot).price ?? (q as FundSnapshot).nav) : undefined;
    return {
      code: it.code,
      ...(it.name ? { name: it.name } : {}),
      date: it.lastBarDate || (q?.ts ? q.ts.slice(0, 10) : today),
      ...(typeof price === "number" ? { last: price } : {}),
      ...(typeof q?.pct === "number" ? { dayPct: q.pct } : typeof it.latestPct.day === "number" ? { dayPct: it.latestPct.day } : {}),
      ...(typeof it.latestPct.week === "number" ? { weekPct: it.latestPct.week } : {}),
      ...(typeof it.latestPct.month === "number" ? { monthPct: it.latestPct.month } : {}),
      ...(typeof it.amplitude === "number" ? { amplitude: it.amplitude } : {}),
    };
  });
}
