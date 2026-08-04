// ============================================================
// 央行利率分析 service 单测（node:test）
// 覆盖：normalizeBanks 透明化 / missingBanks / robustJsonParse 容错
//       extractOuterJson / fixJsonQuotes / isValidMonth / cbRateCacheKey
// 运行：node --import tsx --test apps/server/src/features/cbRate/cbRate.test.ts
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { fixJsonQuotes, extractOuterJson, robustJsonParse } from "../../core/jsonParse.js";
import { isValidMonth, missingBanks, normalizeBanks } from "./service.js";
import { cbRateCacheKey } from "./index.js";

const ALL = ["fed", "ecb", "boj", "boe", "boc", "rba", "rbnz", "snb", "norges"];

// ---------- normalizeBanks ----------

test("normalizeBanks: 过滤未知 id 与重复项", () => {
  const out = normalizeBanks(
    [
      { id: "fed", name: "美联储", latestRate: "3.50%–3.75%", action: "hold", actionDesc: "x" },
      { id: "fed", name: "重复", action: "hike", actionDesc: "y" },
      { id: "bogus", name: "虚构央行", action: "hike", actionDesc: "z" },
      { id: "ecb", name: "欧央行", latestRate: "2.25%", action: "cut", actionDesc: "w" },
    ],
    ALL,
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "fed");
  assert.equal(out[1].id, "ecb");
  assert.equal(out[0].action, "hold");
});

test("normalizeBanks: 非法 action 不静默篡改，标记 flags", () => {
  const out = normalizeBanks(
    [{ id: "boj", name: "日本央行", action: "Hike", actionDesc: "x" }],
    ALL,
  );
  assert.equal(out[0].action, "hold"); // 降级展示
  assert.ok(out[0].flags && out[0].flags.length === 1); // 但明确标记
  assert.match(out[0].flags![0], /Hike/);
});

test("normalizeBanks: 非数组/空返回 []", () => {
  assert.deepEqual(normalizeBanks(null, ALL), []);
  assert.deepEqual(normalizeBanks("nope", ALL), []);
  assert.deepEqual(normalizeBanks([], ALL), []);
});

test("normalizeBanks: name 缺失时按白名单补齐", () => {
  const out = normalizeBanks([{ id: "snb", action: "hold", actionDesc: "x" }], ALL);
  assert.equal(out[0].name, "瑞士央行");
});

// ---------- missingBanks ----------

test("missingBanks: 检测 LLM 漏掉的央行", () => {
  const returned = normalizeBanks(
    [
      { id: "fed", action: "hold", actionDesc: "x" },
      { id: "boj", action: "hike", actionDesc: "y" },
    ],
    ALL,
  );
  const missing = missingBanks(returned, ALL);
  assert.deepEqual(missing, ["ecb", "boe", "boc", "rba", "rbnz", "snb", "norges"]);
});

test("missingBanks: 全部覆盖时为空", () => {
  const returned = normalizeBanks(ALL.map((id) => ({ id, action: "hold", actionDesc: "x" })), ALL);
  assert.deepEqual(missingBanks(returned, ALL), []);
});

// ---------- robustJsonParse ----------

test("robustJsonParse: 直接解析", () => {
  const v = robustJsonParse('{"asOf":"2026-08-05","summary":"ok"}');
  assert.ok(v);
  assert.equal(v!.summary, "ok");
});

test("robustJsonParse: 容忍前后杂质/代码块", () => {
  const v = robustJsonParse('```json\n{"a":1}\n```');
  assert.ok(v);
  assert.equal(v!.a, 1);
});

test("robustJsonParse: 修复字符串值内裸引号（含重叠闭合）", () => {
  // "高"} 中引号兼作字符串结束（重叠闭合）→ 值合法，信息保留（尾引号让位给字符串结束）
  const raw = '{"summary":"美联储"维持不变"并称"通胀仍高"}';
  const v = robustJsonParse(raw);
  assert.ok(v, "应能修复裸引号");
  assert.equal(v!.summary, '美联储"维持不变"并称"通胀仍高');
});

test("robustJsonParse: 非 JSON 返回 null", () => {
  assert.equal(robustJsonParse("not json at all"), null);
  assert.equal(robustJsonParse(""), null);
});

test("extractOuterJson: 嵌套花括号与字符串内花括号", () => {
  const s = '前缀 {"a":"含{花括号}","b":{"c":1}} 后缀';
  assert.equal(extractOuterJson(s), '{"a":"含{花括号}","b":{"c":1}}');
});

test("fixJsonQuotes: 内容引号成对 + 结束重叠", () => {
  // 最后 1 个裸引号兼作字符串结束（重叠闭合），其余转义 → 结果合法
  const fixed = fixJsonQuotes('{"s":"他说"好的"然后"离开",  "n":1}');
  const v = JSON.parse(fixed);
  assert.equal(v.s, '他说"好的"然后"离开');
});

// ---------- isValidMonth ----------

test("isValidMonth: 格式与范围校验", () => {
  assert.ok(isValidMonth("2026-08"));
  assert.ok(isValidMonth("2025-01"));
  assert.equal(isValidMonth("2026-13"), false);
  assert.equal(isValidMonth("2026-8"), false); // 必须两位
  assert.equal(isValidMonth("abcd-ef"), false);
  const now = new Date();
  const tooOld = `${now.getFullYear() - 2}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  assert.equal(isValidMonth(tooOld), false, "超过 24 个月应拒绝");
});

// ---------- cbRateCacheKey ----------

test("cbRateCacheKey: 参数归一化（banks 排序、search 区分）", () => {
  const a = cbRateCacheKey({ period: "month", banks: ["boj", "fed"], search: true });
  const b = cbRateCacheKey({ period: "month", banks: ["fed", "boj"], search: true });
  assert.equal(a, b, "banks 顺序无关");
  const c = cbRateCacheKey({ period: "month", banks: ["boj", "fed"], search: false });
  assert.notEqual(a, c, "search 开关必须区分缓存");
  const d = cbRateCacheKey({ period: "month" });
  assert.match(d, /^cbRate:v2:month::/);
  // schema 版本隔离：v1 旧缓存 key 不再命中
  const old = cbRateCacheKey({ period: "month" }).replace(":v2:", ":");
  assert.notEqual(old, d, "版本号必须参与缓存 key");
});
