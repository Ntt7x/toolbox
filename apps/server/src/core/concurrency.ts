// ============================================================
// 下层公共模块：有界并发（core，不依赖业务）
// 场景：批量网络取数（行情快照 / 名称解析 / K 线）。
//   - 无界 Promise.all：上百并发打爆对端限流，失败率与长尾齐升
//   - 纯串行 await：N 次往返串联，冷缓存时 N × RTT（仓位页首屏 15s+ 的根因之一）
// 统一用有界并发 mapLimit 替代两者。
// ============================================================

/**
 * 有界并发映射：同时最多 limit 个 fn 在跑，**结果数组与入参顺序一致**。
 * 单个 fn reject 会向外抛出（调用方自行决定容错粒度）。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, n));
  const out = new Array<R>(n);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= n) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

/** 默认并发档位：外部行情源友好值（太小拖长尾、太大触发限流） */
export const NET_CONCURRENCY = 8;
