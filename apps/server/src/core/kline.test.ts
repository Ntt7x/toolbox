// K 线数据流管理单测：纯函数（mergeBars 去重排序 / priceOnOrBefore 三级映射回退）
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeBars, priceOnOrBefore } from "./kline.js";

test("mergeBars：新旧合并按日期去重、升序", () => {
  const merged = mergeBars(
    [{ date: "2026-08-13", close: 100 }, { date: "2026-08-14", close: 101 }],
    [{ date: "2026-08-14", close: 102 }, { date: "2026-08-15", close: 103 }],
  );
  assert.deepEqual(merged, [
    { date: "2026-08-13", close: 100 },
    { date: "2026-08-14", close: 102 }, // 新值覆盖旧值
    { date: "2026-08-15", close: 103 },
  ]);
});

test("mergeBars：无缓存时直接取新数据", () => {
  const merged = mergeBars(undefined, [{ date: "2026-08-15", close: 55 }]);
  assert.deepEqual(merged, [{ date: "2026-08-15", close: 55 }]);
});

// priceOnOrBefore(klines, code, date)：三级映射（code → 日期→收盘价）
const klines = new Map([
  ["600519", new Map([["2026-08-13", 100], ["2026-08-14", 101], ["2026-08-15", 102]])],
  ["000001", new Map([["2026-08-13", 10]])],
]);

test("priceOnOrBefore：当日精确命中", () => {
  assert.equal(priceOnOrBefore(klines, "600519", "2026-08-15"), 102);
});

test("priceOnOrBefore：无当日 → 回退最近<=日期收盘价（停牌/非交易日）", () => {
  assert.equal(priceOnOrBefore(klines, "600519", "2026-08-16"), 102); // 08-16 无数据 → 用 08-15
  assert.equal(priceOnOrBefore(klines, "000001", "2026-08-14"), 10);
});

test("priceOnOrBefore：无代码 / 空映射 / 无<=日期 → undefined", () => {
  assert.equal(priceOnOrBefore(klines, "999999", "2026-08-15"), undefined);
  assert.equal(priceOnOrBefore(new Map(), "600519", "2026-08-15"), undefined);
  const late = new Map([["600519", new Map([["2026-08-16", 105]])]]);
  assert.equal(priceOnOrBefore(late, "600519", "2026-08-15"), undefined); // 全在日期之后
});
