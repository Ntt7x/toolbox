// core/cache + core/datasource 单测（统一数据工程层）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { kvSet, kvDelete } from "./kvStore.js";
import { cachedFetch, TTL } from "./cache.js";
import { registerDataSource, fetchWithMeta, listDataSources, userSupplement } from "./datasource.js";

const KEYS = ["__t_cache_a", "__t_cache_b", "__t_ds_a", "__t_user_a"];
before(() => { for (const k of KEYS) kvDelete(k); });
after(() => { for (const k of KEYS) kvDelete(k); });

test("TTL 分级常量有序（秒级 < 分钟级 < 日频 < 周频 < 分析 < 静态）", () => {
  assert.ok(TTL.REALTIME < TTL.MARKET);
  assert.ok(TTL.MARKET < TTL.DAILY);
  assert.ok(TTL.DAILY < TTL.WEEKLY);
  assert.ok(TTL.WEEKLY < TTL.ANALYSIS);
  assert.ok(TTL.ANALYSIS <= TTL.STATIC);
});

test("cachedFetch：首取写缓存，二次命中，force 旁路", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return { n: calls }; };
  const r1 = await cachedFetch("__t_cache_a", TTL.DAILY, fetcher);
  assert.equal(r1.fromCache, false);
  assert.equal(r1.data.n, 1);
  const r2 = await cachedFetch("__t_cache_a", TTL.DAILY, fetcher);
  assert.equal(r2.fromCache, true);
  assert.equal(r2.data.n, 1);
  assert.equal(calls, 1);
  const r3 = await cachedFetch("__t_cache_a", TTL.DAILY, fetcher, { force: true });
  assert.equal(r3.fromCache, false);
  assert.equal(r3.data.n, 2);
  assert.equal(calls, 2);
});

test("cachedFetch：stale-if-error 降级返回旧缓存并标注 degraded", async () => {
  // 直接写入"已过期"缓存（cachedAt 是昨天）
  kvSet("__t_cache_b", { value: { v: "ok" }, cachedAt: new Date(Date.now() - 2 * 24 * 3600_000).toISOString() });
  const bad = async (): Promise<{ v: string }> => { throw new Error("外部源挂了"); };
  const r = await cachedFetch<{ v: string }>("__t_cache_b", TTL.DAILY, bad, { staleIfError: true });
  assert.equal(r.degraded, true);
  assert.equal(r.data.v, "ok");
  // 不启用 staleIfError 时应抛错
  await assert.rejects(() => cachedFetch("__t_cache_b", TTL.DAILY, bad));
});

test("datasource：注册 + fetchWithMeta 血缘 meta + fallback 降级", async () => {
  registerDataSource({
    id: "__t_ds_a",
    kind: "api",
    name: "测试数据源",
    ttlMs: TTL.DAILY,
    fetch: async () => ({ v: 42 }),
    fallback: async () => ({ v: 0 }),
  });
  const r = await fetchWithMeta<{ v: number }>("__t_ds_a", { code: "600519" });
  assert.equal(r.data.v, 42);
  assert.equal(r.meta.source, "__t_ds_a");
  assert.equal(r.meta.kind, "api");
  assert.ok(r.meta.fetchedAt);
  assert.equal(r.meta.name, "测试数据源");
  // 列表含注册项
  const ids = listDataSources().map((d) => d.id);
  assert.ok(ids.includes("__t_ds_a"));
});

test("userSupplement：读用户补全 KV（kind=user 血缘）", async () => {
  kvSet("__t_user_a", { y10: 2.3, updatedAt: "2026-08-16T00:00:00Z" });
  const r = userSupplement<{ y10: number }>("__t_user_a");
  assert.equal(r.data.y10, 2.3);
  assert.equal(r.meta.kind, "user");
  assert.equal(r.meta.name, "用户补全");
  // 不存在返回 null
  const none = userSupplement("__t_user_a_none");
  assert.equal(none.data, null);
});
