// 自选股·周期聚合纯函数单测（数据管道加工层：日 K → 周/月周期指标）
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  amplitudeOf,
  bucketize,
  bucketToStat,
  equalWeightSeries,
  monthKey,
  pctOf,
  periodKey,
  periodSeries,
  weekStart,
  type DailyBar,
} from "./periodStats.js";

/**
 * 构造 3 个自然周的日 K（周一 2026-03-02 起，每周 5 个交易日，跳过周末）。
 * 收盘价 100→114 单调递增：周 1 收 104、周 2 收 109、周 3 收 114。
 */
function bars(): DailyBar[] {
  const dates = [
    "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06",
    "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13",
    "2026-03-16", "2026-03-17", "2026-03-18", "2026-03-19", "2026-03-20",
  ];
  return dates.map((date, i) => ({ date, open: 100 + i, close: 100 + i, high: 101 + i, low: 99 + i }));
}

test("weekStart：周一为周起点，周日归属上一周", () => {
  assert.equal(weekStart("2026-03-02"), "2026-03-02"); // 周一
  assert.equal(weekStart("2026-03-08"), "2026-03-02"); // 周日 → 归上一周
  assert.equal(weekStart("2026-03-09"), "2026-03-09");
});

test("monthKey：取 YYYY-MM", () => {
  assert.equal(monthKey("2026-03-31"), "2026-03");
  assert.equal(monthKey("2026-04-01"), "2026-04");
});

test("periodKey：day 用交易日、week 用周一、month 用 YYYY-MM", () => {
  assert.equal(periodKey("2026-03-04", "day"), "2026-03-04");
  assert.equal(periodKey("2026-03-04", "week"), "2026-03-02");
  assert.equal(periodKey("2026-03-04", "month"), "2026-03");
});

test("bucketize：日度每根一个桶（prevClose 为上一交易日收盘）", () => {
  const b = bucketize(bars(), "day");
  assert.equal(b.length, 15);
  assert.ok(Number.isNaN(b[0].prevClose)); // 首根无前值（NaN，涨跌幅不可算）
  assert.equal(b[1].prevClose, 100);
  assert.equal(b[1].sessions, 1);
});

test("bucketize：周度按自然周聚合（周内 OHLC 归约 + 交易日计数）", () => {
  const b = bucketize(bars(), "week");
  assert.equal(b.length, 3);
  assert.equal(b[0].from, "2026-03-02");
  assert.equal(b[0].to, "2026-03-06");
  assert.equal(b[0].open, 100);
  assert.equal(b[0].close, 104);
  assert.equal(b[0].high, 105);
  assert.equal(b[0].low, 99);
  assert.equal(b[0].sessions, 5);
  assert.ok(Number.isNaN(b[0].prevClose)); // 首周期无前收盘
  assert.equal(b[1].prevClose, 104); // 上周收盘
});

test("bucketize：月度按自然月聚合（同月合并为一个桶）", () => {
  const b = bucketize(bars(), "month");
  assert.equal(b.length, 1); // 03-02 ~ 03-20 全在 3 月
  assert.equal(b[0].sessions, 15);
  assert.equal(b[0].close, 114);
});

test("bucketize：空序列 / 非法数据被忽略", () => {
  assert.deepEqual(bucketize([], "week"), []);
  const dirty = [
    { date: "bad", open: 1, close: Number.NaN, high: 1, low: 1 },
    { date: "2026-03-02", open: 10, close: 11, high: 12, low: 9 },
  ] as DailyBar[];
  const b = bucketize(dirty, "day");
  assert.equal(b.length, 1);
  assert.equal(b[0].close, 11);
});

test("pctOf：基准无效返回 undefined（不静默置 0）", () => {
  assert.equal(pctOf(110, 100), 10);
  assert.equal(pctOf(90, 100), -10);
  assert.equal(pctOf(110, Number.NaN), undefined);
  assert.equal(pctOf(110, 0), undefined);
});

test("amplitudeOf：以上周期收盘为基准；基准无效返回 undefined", () => {
  const b = bucketize(bars(), "week")[1]; // 第 2 周：high=110 low=104 prevClose=104
  assert.equal(amplitudeOf(b), Math.round(((110 - 104) / 104) * 100 * 10000) / 10000);
  const first = bucketize(bars(), "week")[0];
  assert.equal(amplitudeOf(first), undefined);
});

test("bucketToStat：首周期无前收盘 → 涨跌幅缺省且标注 caveat", () => {
  const first = bucketToStat(bucketize(bars(), "week")[0], "sh600519", { name: "贵州茅台" });
  assert.equal(first.code, "sh600519");
  assert.equal(first.name, "贵州茅台");
  assert.equal(first.pct, undefined);
  assert.equal(first.amplitude, undefined);
  assert.ok(first.caveat?.includes("涨跌幅不可计算"));

  const second = bucketToStat(bucketize(bars(), "week")[1], "sh600519");
  assert.ok(typeof second.pct === "number");
  assert.ok(typeof second.amplitude === "number");
});

test("periodSeries：取最近 N 个周期，升序返回", () => {
  const s = periodSeries(bars(), "week", 2, "sh600519");
  assert.equal(s.length, 2);
  // 升序：第 2 周在前，第 3 周在后
  assert.equal(s[0].from, "2026-03-09");
  assert.equal(s[1].from, "2026-03-16");
  // 第 3 周收盘 114，上周收盘 109 → +4.5872%
  assert.equal(s[1].pct, Math.round(((114 - 109) / 109) * 100 * 10000) / 10000);
});

test("periodSeries：无有效 K 线返回空数组", () => {
  assert.deepEqual(periodSeries([], "month", 12, "sh600519"), []);
});

test("equalWeightSeries：多标的按周期对齐取等权平均；不可算涨跌幅的周期被剔除", () => {
  const a = periodSeries(bars(), "week", 3, "A");
  const b = periodSeries(bars(), "week", 3, "B");
  const g = equalWeightSeries([{ stats: a }, { stats: b }], 10);
  // 首周期两标的均无 pct（无上一周期收盘）→ 剔除，避免被误读为零涨幅
  assert.equal(g.length, 2);
  assert.equal(g[0].from, "2026-03-09");
  assert.equal(g[1].from, "2026-03-16");
  // 两标的序列同值 → 平均等于单值，count=2
  assert.equal(g[0].count, 2);
  assert.equal(g[0].pct, Math.round(((109 - 104) / 104) * 100 * 10000) / 10000);
  assert.equal(g[1].count, 2);
});

test("equalWeightSeries：不同标的的平均值（一个 +10% 一个 +0% → +5%）", () => {
  const up = [{ stats: [{ code: "A", from: "2026-03-09", to: "2026-03-13", sessions: 5, close: 110, pct: 10 }] }];
  const flat = [{ stats: [{ code: "B", from: "2026-03-09", to: "2026-03-13", sessions: 5, close: 100, pct: 0 }] }];
  const g = equalWeightSeries([...up, ...flat], 10);
  assert.equal(g.length, 1);
  assert.equal(g[0].pct, 5);
  assert.equal(g[0].count, 2);
});

test("equalWeightSeries：全部周期不可算 → 空数组", () => {
  const s = periodSeries(bars().slice(0, 5), "week", 3, "A"); // 仅一周，pct 不可算
  assert.deepEqual(equalWeightSeries([{ stats: s }], 10), []);
});

test("equalWeightSeries：按周期时间升序、limit 截断", () => {
  const a = periodSeries(bars(), "week", 3, "A");
  const g = equalWeightSeries([{ stats: a }], 2);
  assert.equal(g.length, 2);
  assert.ok(g[0].from < g[1].from);
});
