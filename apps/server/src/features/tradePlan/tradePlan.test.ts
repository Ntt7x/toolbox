// 交易规划校验计算单测（v2：positions 语义 + applyItems 应用/回滚）
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyItems, checkTradePlan } from "./compute.js";
import type { TradePlanCheckConfig } from "./compute.js";

const cfg: TradePlanCheckConfig = {
  totalCapital: 100000,
  dailyAddLimit: 20000,
  stocks: [
    { code: "600519", name: "贵州茅台", maxWeightPct: 40 },
    { code: "300750", name: "宁德时代", maxWeightPct: 30 },
  ],
  positions: [{ code: "600519", name: "贵州茅台", quantity: 20, avgCost: 1400 }], // 市值 28000
};

test("合规计划：加仓在日限内、不超总仓位与标的上限 → ok", () => {
  const r = checkTradePlan(cfg, [{ code: "600519", action: "add", amount: 5000 }]);
  assert.equal(r.ok, true);
  assert.equal(r.totals.addTotal, 5000);
  assert.ok(Math.abs(r.totals.positionPct - 33) < 0.5); // (28000+5000)/100000 ≈ 33%（股数四舍五入允许微小误差）
  const m = r.after.find((p) => p.code === "600519")!;
  assert.ok(Math.abs(m.marketValue - 33000) < 10); // 股数四舍五入允许微小误差
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

test("同一标的多个操作 → error（一标的一天一个操作）", () => {
  const r = checkTradePlan(cfg, [
    { code: "600519", action: "add", amount: 3000 },
    { code: "600519", action: "add", amount: 2000 },
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.alerts.some((x) => x.level === "error" && x.message.includes("合并为一个交易操作")));
  assert.equal(r.totals.addTotal, 5000); // 重复金额合并统计
});

test("告警按级别排序：error 在前", () => {
  const r = checkTradePlan(cfg, [
    { code: "000001", action: "add", amount: 50000 },
    { code: "600519", action: "add", amount: 10000 },
  ]);
  assert.equal(r.alerts[0].level, "error");
});

test("applyItems：加仓重算均价、减仓只减数量成本不变", () => {
  const after = applyItems(cfg.positions, [
    { code: "600519", action: "add", amount: 5600 }, // 20×1400=28000 → +5600=33600，数量=24，均价=33600/24=1400
    { code: "300750", action: "reduce", amount: 1000 }, // 无持仓减仓 → 保持
  ]);
  const m = after.find((p) => p.code === "600519")!;
  assert.equal(m.quantity, 24);
  assert.equal(m.avgCost, 1400);
});

test("applyItems：加仓改变均价（非整数股数）", () => {
  const after = applyItems([{ code: "600519", quantity: 10, avgCost: 1000 }], [{ code: "600519", action: "add", amount: 1000 }]);
  const m = after.find((p) => p.code === "600519")!;
  // 数量 10 → 11，均价 = (10×1000+1000)/11 = 11000/11 = 1000
  assert.equal(m.quantity, 11);
  assert.equal(m.avgCost, 1000);
});

test("applyItems：减仓不改变均价", () => {
  const after = applyItems([{ code: "600519", quantity: 100, avgCost: 1200 }], [{ code: "600519", action: "reduce", amount: 12000 }]);
  const m = after.find((p) => p.code === "600519")!;
  assert.equal(m.quantity, 90); // 减 10 股
  assert.equal(m.avgCost, 1200);
});
