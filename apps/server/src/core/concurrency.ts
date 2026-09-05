// ============================================================
// 下层公共模块：有界并发（core，不依赖业务）
// 场景：批量网络取数（行情快照 / 名称解析 / K 线）。
//   - 无界 Promise.all：上百并发打爆对端限流，失败率与长尾齐升
//   - 纯串行 await：N 次往返串联，冷缓存时 N × RTT（仓位页首屏 15s+ 的根因之一）
// 统一用有界并发替代两者。
//
// 实现：委托 core/effect/concurrency 的 allOrdered（**唯一实现**，不留双轨）。
// 对外的 Promise 签名保持不变，全仓调用方零改动即获得 Effect 的结构化并发：
//   · 失败时**中断**仍在跑的兄弟任务（旧实现会让它跑完再丢弃结果，白打对端）
//   · 失败抛 EffectFailure（message 为可读文案），原错误在 e.failure
// ============================================================

import { Effect } from "effect";
import { allOrdered } from "./effect/concurrency.js";
import { runEffect } from "./effect/runtime.js";

/**
 * 有界并发映射：同时最多 limit 个 fn 在跑，**结果数组与入参顺序一致**。
 * 单个 fn reject 会向外抛出（抛出的是 EffectFailure，message 可直接展示）。
 */
export function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  return runEffect(
    allOrdered(
      items,
      limit,
      // 子任务失败时原样抛出（Effect 会把原始错误放进 EffectFailure.failure）
      (item, index) => Effect.tryPromise({ try: () => fn(item, index), catch: (e) => e }),
    ),
  );
}

/** 默认并发档位：外部行情源友好值（太小拖长尾、太大触发限流） */
export const NET_CONCURRENCY = 8;
