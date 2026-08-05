// ============================================================
// core/llm 用量聚合单测（纯 KV 聚合，不触网）
// 覆盖：记录/汇总/命中率/按模块中文label/按天分组
// ============================================================
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { kvSet, kvGet, kvDelete } from "./kvStore.js";
import { recordLlmUsage, getLlmUsageSummary } from "./llm.js";

const USAGE_KEY = "llmUsage:log";

let backup: unknown = undefined;

beforeEach(() => {
  backup = kvGet(USAGE_KEY); // 备份真实日志，测试后恢复
  kvSet(USAGE_KEY, { entries: [] });
});

afterEach(() => {
  if (backup !== undefined && backup !== null) kvSet(USAGE_KEY, backup);
  else kvDelete(USAGE_KEY);
});

test("空日志：0 调用，cacheRate=0", () => {
  const s = getLlmUsageSummary();
  assert.equal(s.total.calls, 0);
  assert.equal(s.total.cacheRate, 0);
});

test("记录 + 汇总：命中率按 hit/(hit+miss) 计算", () => {
  recordLlmUsage("cb-rate", "deepseek-chat", { promptTokens: 100, completionTokens: 20, cacheHitTokens: 90, cacheMissTokens: 10 });
  const s = getLlmUsageSummary();
  assert.equal(s.total.calls, 1);
  assert.equal(s.total.promptTokens, 100);
  assert.equal(s.total.completionTokens, 20);
  assert.equal(s.total.cacheHitTokens, 90);
  assert.equal(s.total.cacheMissTokens, 10);
  assert.ok(Math.abs(s.total.cacheRate - 0.9) < 1e-9);
});

test("多模块聚合 + 中文 label + 按天分组", () => {
  const today = new Date();
  const iso = today.toISOString();
  // 同一天两条不同模块
  recordLlmUsage("cb-rate", "deepseek-chat", { promptTokens: 100, completionTokens: 10, cacheHitTokens: 50, cacheMissTokens: 50 });
  recordLlmUsage("reverse-repo.daily", "deepseek-chat", { promptTokens: 200, completionTokens: 30, cacheHitTokens: 180, cacheMissTokens: 20 });
  const s = getLlmUsageSummary();
  assert.equal(s.total.calls, 2);
  assert.equal(s.total.cacheHitTokens, 230);
  assert.equal(s.total.cacheMissTokens, 70);
  // 按模块
  const cb = s.byModule.find((m) => m.module === "cb-rate");
  assert.ok(cb);
  assert.equal(cb!.label, "央行利率分析");
  assert.ok(Math.abs(cb!.cacheRate - 0.5) < 1e-9);
  const rr = s.byModule.find((m) => m.module === "reverse-repo.daily");
  assert.ok(rr);
  assert.ok(Math.abs(rr!.cacheRate - 0.9) < 1e-9);
  // 按天（本地时区）
  const day = s.byDay.find((d) => d.calls === 2);
  assert.ok(day, "两条同日本地日期应聚合为一天");
  assert.equal(day!.byModule.length, 2);
});

test("坏数据防御：非数组 entries 视为空", () => {
  kvSet(USAGE_KEY, { entries: "oops" });
  const s = getLlmUsageSummary();
  assert.equal(s.total.calls, 0);
});
