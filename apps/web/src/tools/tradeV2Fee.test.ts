// 手续费自动计算单测（tradeV2Fee：ETF 万1 最低0.1 / 个股 万1.154 最低5）
import { test } from "node:test";
import assert from "node:assert/strict";
import { isEtfCode, calcFee, feeRule } from "./tradeV2Fee.ts";

test("isEtfCode：沪 5xxxxx / 深 1xxxxx 为 ETF，其余个股", () => {
  assert.equal(isEtfCode("510300"), true);    // 沪深300ETF
  assert.equal(isEtfCode("512880"), true);    // 证券ETF
  assert.equal(isEtfCode("159915"), true);    // 创业板ETF
  assert.equal(isEtfCode("588000"), true);    // 科创50ETF
  assert.equal(isEtfCode("600519"), false);   // 贵州茅台
  assert.equal(isEtfCode("000001"), false);   // 平安银行
  assert.equal(isEtfCode("sh600519"), false); // 带前缀
  assert.equal(isEtfCode("sz159915"), true);  // 带前缀 ETF
});

test("calcFee：个股万1.154 最低 5（小额按最低）", () => {
  // 金额 1000 → 1000×0.0001154=0.1154 < 5 → 5
  assert.equal(calcFee("600519", 100, 10), 5);
  // 大额按比例：金额 1_000_000 → 115.4
  assert.equal(calcFee("600519", 10000, 100), 115.4);
});

test("calcFee：ETF 万1 最低 0.1（小额按最低）", () => {
  // 金额 1000 → 1000×0.0001=0.1 → 0.1（刚好最低）
  assert.equal(calcFee("510300", 100, 10), 0.1);
  // 更小金额 → 0.1
  assert.equal(calcFee("510300", 10, 10), 0.1);
  // 大额按比例：金额 1_000_000 → 100
  assert.equal(calcFee("510300", 10000, 100), 100);
});

test("calcFee：边界（无代码/零金额 → 0）", () => {
  assert.equal(calcFee("", 100, 10), 0);
  assert.equal(calcFee("600519", 0, 10), 0);
  assert.equal(calcFee("600519", 100, 0), 0);
});

test("feeRule：返回费率与最低值", () => {
  assert.deepEqual(feeRule("510300"), { rate: 0.0001, min: 0.1 });
  assert.deepEqual(feeRule("600519"), { rate: 0.0001154, min: 5 });
});
