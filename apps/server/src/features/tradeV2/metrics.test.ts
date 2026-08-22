// 数据工程：交易指标纯函数单测（memo mt4hm8hp：指标计算数据工程化）
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics } from "./metrics.js";
import type { TradeV2DailyPoint, TradeV2Deal } from "@toolbox/shared";

const daily = (mvs: number[]): TradeV2DailyPoint[] =>
  mvs.map((marketValue, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    buyAmount: 0,
    sellAmount: 0,
    realizedPnl: 0,
    marketValue,
    openCount: 0,
  }));

const deal = (status: "open" | "closed", buy: number, sell: number, fee = 0): TradeV2Deal => ({
  code: "X",
  status,
  entryDate: "2026-08-01",
  ...(status === "closed" ? { exitDate: "2026-08-10" } : {}),
  buyQty: 100,
  qty: 100,
  avgCost: buy / 100,
  buyAmount: buy,
  sellAmount: sell,
  feeTotal: fee,
});

test("空序列/空交易 → 全 undefined", () => {
  const m = computeMetrics([], []);
  assert.equal(m.annualVol, undefined);
  assert.equal(m.sharpe, undefined);
  assert.equal(m.maxDrawdown, undefined);
  assert.equal(m.profitFactor, undefined);
  assert.equal(m.expectancy, undefined);
});

test("单点序列（<2 日）→ 波动/夏普/回撤 undefined", () => {
  const m = computeMetrics(daily([100]), []);
  assert.equal(m.annualVol, undefined);
  assert.equal(m.maxDrawdown, undefined);
});

test("波动率：恒涨序列 → 年化波动≈0（浮点容差 <1）", () => {
  const m = computeMetrics(daily([100, 110, 121, 133]), []);
  assert.ok(m.annualVol! < 1, `annualVol=${m.annualVol}`);
});

test("波动率：涨跌交替 → 年化波动 > 0", () => {
  const m = computeMetrics(daily([100, 105, 98, 106, 99]), []);
  assert.ok(m.annualVol! > 0);
});

test("最大回撤：100→120→90→110 → 回撤 -25%", () => {
  const m = computeMetrics(daily([100, 120, 90, 110]), []);
  assert.equal(m.maxDrawdown, -25);
});

test("盈亏比：一盈一亏（+30 / −10）→ 3", () => {
  const m = computeMetrics([], [deal("closed", 70, 100), deal("closed", 100, 90)]);
  assert.equal(m.profitFactor, 3);
});

test("盈亏比：全盈/全亏 → undefined", () => {
  const m1 = computeMetrics([], [deal("closed", 70, 100)]);
  assert.equal(m1.profitFactor, undefined);
  const m2 = computeMetrics([], [deal("closed", 100, 80)]);
  assert.equal(m2.profitFactor, undefined);
});

test("期望：两笔段（+30 / −10）→ 平均 +10", () => {
  const m = computeMetrics([], [deal("closed", 70, 100), deal("closed", 100, 90)]);
  assert.equal(m.expectancy, 10);
});

test("期望：含在途段（按已发生金额：买入 100 / 卖出回款 130 → +30）", () => {
  const m = computeMetrics([], [deal("closed", 70, 100), deal("open", 100, 130)]);
  assert.equal(m.expectancy, 30);
});
