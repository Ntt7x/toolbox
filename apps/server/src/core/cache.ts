// ============================================================
// 统一缓存抽象（数据工程核心，2026-08-16）
// 调研依据：RFC 5861（max-age 新鲜期 + stale-while-revalidate + stale-if-error）
// 统一：TTL 分级 / cachedAt 新鲜度判定 / force 旁路 / 降级兜底
// 替换各 feature 手写缓存逻辑（cbRate/treasuryFx/experiment 的 kvGet+Date.now 模式）
// ============================================================
import { kvGet, kvSet } from "./kvStore.js";

/** TTL 分级（数据时效性分类）——新数据源必须选用合适档位，禁止随意魔数 */
export const TTL = {
  /** 行情实时（秒级，如外汇即时报） */
  REALTIME: 60_000,
  /** 行情快照（分钟级，如 A/H 股价/PB） */
  MARKET: 5 * 60_000,
  /** 日频数据（24h，如新闻/日 K） */
  DAILY: 24 * 60 * 60_000,
  /** 周频数据（7d，如宏观周度） */
  WEEKLY: 7 * 24 * 60 * 60_000,
  /** 分析类（月/季频或静态知识，手动失效为主） */
  ANALYSIS: 365 * 24 * 60 * 60_000,
  /** 静态知识（几乎不变，仅手动/版本失效） */
  STATIC: 730 * 24 * 60 * 60_000,
} as const;

/** KV 缓存值结构：value + cachedAt（写入时刻，新鲜度唯一依据；不信任外部时间戳） */
export interface CachedValue<T> {
  value: T;
  cachedAt: string;
}

export interface CachedResult<T> {
  data: T;
  fromCache: boolean;
  cachedAt?: string;
  /** stale-if-error 降级：fetcher 失败返回旧缓存时置 true */
  degraded?: boolean;
}

/**
 * 统一缓存读取：新鲜则返回缓存；否则执行 fetcher 并写回。
 * - force：显式旁路缓存（必然重取并写回）
 * - staleIfError：fetcher 失败时若存在旧缓存则降级返回（RFC 5861 stale-if-error），并标注 degraded
 */
export async function cachedFetch<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  opts: { force?: boolean; staleIfError?: boolean } = {},
): Promise<CachedResult<T>> {
  const cached = kvGet<CachedValue<T>>(key);
  const cachedAtMs = cached && typeof cached === "object" && typeof cached.cachedAt === "string" ? Date.parse(cached.cachedAt) : NaN;
  const fresh = cached && Number.isFinite(cachedAtMs) && Date.now() - cachedAtMs < ttlMs;
  if (!opts.force && fresh) {
    return { data: cached.value, fromCache: true, cachedAt: cached.cachedAt };
  }
  try {
    const value = await fetcher();
    kvSet(key, { value, cachedAt: new Date().toISOString() } satisfies CachedValue<T>);
    return { data: value, fromCache: false };
  } catch (e) {
    // stale-if-error：有旧缓存则降级返回
    if (opts.staleIfError && cached && Number.isFinite(cachedAtMs)) {
      return { data: cached.value, fromCache: true, cachedAt: cached.cachedAt, degraded: true };
    }
    throw e;
  }
}

/**
 * 只读窥探缓存（不触发 fetcher）：取当前缓存值与写入时间。
 * 用于「读已缓存的分析结果做二次加工」等场景（如自选股根据财报分析优化理由），
 * 避免为读缓存而走一遍可能触发取数与计费的路径。
 */
export function peekCache<T>(key: string): { data: T; cachedAt?: string } | null {
  const cached = kvGet<CachedValue<T>>(key);
  if (!cached || typeof cached !== "object" || !("value" in cached)) return null;
  return { data: cached.value, ...(typeof cached.cachedAt === "string" ? { cachedAt: cached.cachedAt } : {}) };
}

/** 计算缓存新鲜度（供诊断/展示：剩余毫秒，负数=已过期） */
export function cacheFreshnessMs(key: string): number {
  const cached = kvGet<CachedValue<unknown>>(key);
  if (!cached || typeof cached !== "object" || typeof cached.cachedAt !== "string") return -Infinity;
  const at = Date.parse(cached.cachedAt);
  return Number.isFinite(at) ? Date.now() - at : -Infinity;
}
