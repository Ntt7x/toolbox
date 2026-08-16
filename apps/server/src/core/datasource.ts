// ============================================================
// 统一数据源抽象（数据工程核心，2026-08-16）
// 调研依据：Airbyte source 抽象（声明式连接 + 统一 record 流 + emitted_at）、
//           Dagster asset 模型（AssetKey + upstream deps）
// 最小集：{ id, kind, name, fetch, normalize?, fallback?, ttlMs? }
// 统一返回 Result{ data, meta:{ source, kind, fetchedAt, ttlMs, degraded? } }——血缘/质量标注落到每条数据
// 红线：不抄 catalog/sync-mode/多租户连接管理全套；一个接口 + 每源一个文件即可
// ============================================================
import { kvGet, kvSet } from "./kvStore.js";
import { TTL } from "./cache.js";

export type DataSourceKind = "api" | "llm" | "user" | "kv";

/** 数据血缘/质量元数据（随数据一起流动） */
export interface DataSourceMeta {
  /** 数据源 id（如 tencent.quote / llm.search / user.supplement） */
  source: string;
  /** 数据源类别：api=外部接口 / llm=联网搜索 / user=用户补全 / kv=本地存量 */
  kind: DataSourceKind;
  /** 数据源中文名（展示/血缘） */
  name: string;
  /** 采集时刻 */
  fetchedAt: string;
  /** 建议 TTL（毫秒） */
  ttlMs?: number;
  /** 降级标记（fallback 源 / stale-if-error） */
  degraded?: boolean;
}

export interface DataSourceResult<T> {
  data: T;
  meta: DataSourceMeta;
}

/** 统一数据源接口（最小集） */
export interface DataSource<T = unknown, P = Record<string, unknown>> {
  id: string;
  kind: DataSourceKind;
  name: string;
  /** 默认 TTL（未指定则走 fetchWithMeta 的 ttlMs 参数） */
  ttlMs?: number;
  /** 主取数 */
  fetch: (params: P, signal?: AbortSignal) => Promise<T>;
  /** 原始数据规范化（可选：raw → 统一结构） */
  normalize?: (raw: unknown, params: P) => T;
  /** 降级源（failover：主源失败时按优先级链降级） */
  fallback?: (params: P, signal?: AbortSignal) => Promise<T>;
}

const registry = new Map<string, DataSource<unknown, Record<string, unknown>>>();

/** 注册数据源（血缘/目录：id 全局唯一） */
export function registerDataSource(ds: DataSource): void {
  if (registry.has(ds.id)) throw new Error(`数据源重复注册: ${ds.id}`);
  registry.set(ds.id, ds as DataSource<unknown, Record<string, unknown>>);
}

export function getDataSource(id: string): DataSource | null {
  return registry.get(id) ?? null;
}

export function listDataSources(): { id: string; kind: DataSourceKind; name: string; ttlMs?: number }[] {
  return [...registry.values()].map((d) => ({ id: d.id, kind: d.kind, name: d.name, ttlMs: d.ttlMs }));
}

/**
 * 统一取数（带血缘 meta + 可选缓存）：
 * - useCache：走 core/cache.cachedFetch（TTL 分级 + force + stale-if-error）
 * - 主源失败 → fallback 降级链（meta.degraded=true 标注）
 */
export async function fetchWithMeta<T>(
  id: string,
  params: Record<string, unknown> = {},
  opts: { useCache?: boolean; ttlMs?: number; force?: boolean; signal?: AbortSignal } = {},
): Promise<DataSourceResult<T>> {
  const ds = registry.get(id) as DataSource<T> | undefined;
  if (!ds) throw new Error(`未知数据源: ${id}`);

  const doFetch = async (): Promise<T> => {
    try {
      return await ds.fetch(params, opts.signal);
    } catch (e) {
      if (ds.fallback) {
        try {
          const fb = await ds.fallback(params, opts.signal);
          return fb;
        } catch { /* 降级也失败则抛主源错误 */ }
      }
      throw e;
    }
  };

  const ttl = opts.ttlMs ?? ds.ttlMs;
  if (opts.useCache && ttl !== undefined) {
    // 缓存 key：数据源 id + 规范化参数段
    const paramKey = Object.keys(params).sort().map((k) => `${k}=${String(params[k])}`).join("&");
    const key = `ds:${id}${paramKey ? `:${paramKey}` : ""}`;
    const { cachedFetch } = await import("./cache.js");
    const r = await cachedFetch<T>(key, ttl, doFetch, { force: opts.force, staleIfError: true });
    return {
      data: r.data,
      meta: {
        source: id,
        kind: ds.kind,
        name: ds.name,
        fetchedAt: r.cachedAt ?? new Date().toISOString(),
        ttlMs: ttl,
        degraded: r.degraded,
      },
    };
  }

  const data = await doFetch();
  return {
    data,
    meta: {
      source: id,
      kind: ds.kind,
      name: ds.name,
      fetchedAt: new Date().toISOString(),
      ttlMs: ttl,
    },
  };
}

/** 用户补全数据源：读取本地 KV（kind=user，血缘标注"用户补全"），无则返回 null */
export function userSupplement<T>(key: string): { data: T; meta: DataSourceMeta } {
  const v = kvGet<T>(key);
  return {
    data: (v ?? null) as T,
    meta: {
      source: "user.supplement",
      kind: "user",
      name: "用户补全",
      fetchedAt: (kvGet<{ updatedAt?: string }>(key) as { updatedAt?: string } | null)?.updatedAt ?? new Date().toISOString(),
    },
  };
}
