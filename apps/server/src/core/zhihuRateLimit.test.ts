// 知乎爬虫限速/退避模块单测
import { test } from "node:test";
import assert from "node:assert/strict";
import { ZhihuRateLimiter, type BlockSignal } from "./zhihuRateLimit.js";

test("令牌桶：初始有 capacity 个令牌，可立即连续取", async () => {
  const r = new ZhihuRateLimiter(0.5, 2);
  await r.take();
  await r.take();
  assert.ok(r.state().tokens < 2, "取 2 次后令牌减少");
});

test("令牌桶：速率控制（1/s 时取 2 次需要约 1s）", async () => {
  const r = new ZhihuRateLimiter(1, 1);
  const t0 = Date.now();
  await r.take();
  await r.take();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 900, `取 2 次应等待约 1s（实际 ${elapsed}ms）`);
});

test("分级退避：40362 → 长停 30min", () => {
  const r = new ZhihuRateLimiter(1, 2);
  r.recordBlocked("40362");
  const s = r.state();
  assert.equal(s.level, 3);
  assert.ok(s.inBackoff);
  assert.ok(s.backoffUntil - Date.now() >= 29 * 60 * 1000, "应停摆约 30min");
});

test("分级退避：403 → 短停 5min（level≥2）", () => {
  const r = new ZhihuRateLimiter(1, 2);
  r.recordBlocked("403");
  const s = r.state();
  assert.equal(s.level, 2);
  assert.ok(s.backoffUntil - Date.now() >= 4 * 60 * 1000);
});

test("分级退避：429 指数退避（level 递增）", () => {
  const r = new ZhihuRateLimiter(1, 2);
  r.recordBlocked("429");
  const l1 = r.state().level;
  assert.equal(l1, 1);
  r.recordBlocked("429");
  const l2 = r.state().level;
  assert.equal(l2, 2, "再次触发应升级");
});

test("退避期间 take 阻塞到退避结束", async () => {
  const r = new ZhihuRateLimiter(100, 10);
  r.recordBlocked("429"); // 2min 退避
  const t0 = Date.now();
  const p = r.take(); // 不应立即返回
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(Date.now() - t0 < 500, "take 应仍在等待（退避中）");
  // 手动重置（测试用，避免等 2min）
  r.reset();
  await p;
});

test("连续成功降级", () => {
  const r = new ZhihuRateLimiter(100, 10);
  r.recordBlocked("429");
  assert.equal(r.state().level, 1);
  for (let i = 0; i < 5; i++) r.recordSuccess();
  assert.equal(r.state().level, 0, "连续 5 次成功应降级到 0");
});

test("reset 恢复", () => {
  const r = new ZhihuRateLimiter(1, 2);
  r.recordBlocked("40362");
  r.reset();
  const s = r.state();
  assert.equal(s.level, 0);
  assert.equal(s.inBackoff, false);
});
