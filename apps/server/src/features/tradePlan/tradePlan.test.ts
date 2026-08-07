// 交易规划校验计算单测
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTradePlan } from "./compute.js";
import type { TradePlanConfig } from "@toolbox/shared";

const cfg: TradePlanConfig = {
  totalCapital: 100000,
  dailyAddLimit: 20000,
  stocks: [
    { code: "600519", name: "贵州茅台", maxWeightPct: 40 },
    { code: "300750", name: "宁德时代", maxWeightPct: 30 },
  ],
  initialPositions: [{ code: "600519", shares: 20, cost: 1400 }], // 市值 28000
  updatedAt: "",
};

test("合规计划：加仓在日限内、不超总仓位与标的上限 → ok", () => {
  const r = checkTradePlan(cfg, [{ code: "600519", action: "add", amount: 5000 }]);
  assert.equal(r.ok, true);
  assert.equal(r.totals.addTotal, 5000);
  assert.equal(r.totals.positionPct, 33); // (28000+5000)/100000 = 33%
  const m = r.after.find((p) => p.code === "600519")!;
  assert.equal(m.marketValue, 33000);
  assert.equal(m.addAmount, 5000);
});

test("超单日加仓上限 → error 且非 ok", () => {
  const r = checkTradePlan(cfg, [{ code: "300750", action: "add", amount: 25000 }]);
  assert.equal(r.ok, false);
  assert.ok(r.alerts.some((a) => a.level === "error" && a.message.includes("单日加仓上限")));
});

test("加仓后超单标的上限（40%×10万=4万）→ warn", () => {
  // 茅台 28000 + 15000 = 43000 > 40000
  const r = checkTradePlan(cfg, [{ code: "600519", action: "add", amount: 15000 }]);
  assert.ok(r.alerts.some((a) => a.level === "warn" && a.message.includes("标的上限")));
});

test("非法标的 → error", () => {
  const r = checkTradePlan(cfg, [{ code: "000001", action: "add", amount: 1000 }]);
  assert.equal(r.ok, false);
  assert.ok(r.alerts.some((a) => a.level === "error" && a.message.includes("不在策略标的列表")));
});

test("减仓超过当前持仓 → error 且市值不为负", () => {
  const r = checkTradePlan(cfg, [{ code: "600519", action: "reduce", amount: 99999 }]);
  assert.equal(r.ok, false);
  assert.ok(r.alerts.some((a) => a.level === "error" && a.message.includes("超过")));
  const m = r.after.find((p) => p.code === "600519")!;
  assert.equal(m.marketValue, 0);
});

test("告警按级别排序：error 在前", () => {
  const r = checkTradePlan(cfg, [
    { code: "000001", action: "add", amount: 50000 },
    { code: "600519", action: "add", amount: 10000 },
  ]);
  assert.equal(r.alerts[0].level, "error");
});
