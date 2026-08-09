// 交易规划校验计算单测（v3：日度计划按数量（股）操作）
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyItems, checkTradePlan } from "./compute.js";
import { rebasePositions } from "./store.js";
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

test("合规计划：加仓股数×成本价在日限内、不超总仓位与标的上限 → ok", () => {
  // 加仓 2 股 × 1400 = 2800 元
  const r = checkTradePlan(cfg, [{ code: "600519", action: "add", amount: 2 }]);
  assert.equal(r.ok, true);
  assert.equal(r.totals.addTotal, 2800); // 金额 = 2×1400
  assert.ok(Math.abs(r.totals.positionPct - 30.8) < 0.5); // (28000+2800)/100000 ≈ 30.8%
  const m = r.after.find((p) => p.code === "600519")!;
  assert.equal(m.shares, 22);
  assert.equal(m.addAmount, 2800);
});

test("超单日加仓上限（按金额）→ error 且非 ok", () => {
  // 宁德无持仓无成本价 → 该操作报"未设置成本价"；用茅台 15 股 × 1400 = 21000 > 20000
  const r = checkTradePlan(cfg, [{ code: "600519", action: "add", amount: 15 }]);
  assert.equal(r.ok, false);
  assert.ok(r.alerts.some((a) => a.level === "error" && a.message.includes("单日加仓上限")));
});

test("加仓后超单标的上限（40%×10万=4万）→ warn", () => {
  // 茅台 28000 + 9股×1400=12600 → 40600 > 40000
  const r = checkTradePlan(cfg, [{ code: "600519", action: "add", amount: 9 }]);
  assert.ok(r.alerts.some((a) => a.level === "warn" && a.message.includes("标的上限")));
});

test("非法标的 → error", () => {
  const r = checkTradePlan(cfg, [{ code: "000001", action: "add", amount: 10 }]);
  assert.equal(r.ok, false);
  assert.ok(r.alerts.some((a) => a.level === "error" && a.message.includes("不在策略标的列表")));
});

test("减仓数量超过当前持仓 → error 且市值不为负", () => {
  const r = checkTradePlan(cfg, [{ code: "600519", action: "reduce", amount: 999 }]);
  assert.equal(r.ok, false);
  assert.ok(r.alerts.some((a) => a.level === "error" && a.message.includes("减仓数量超过")));
  const m = r.after.find((p) => p.code === "600519")!;
  assert.equal(m.marketValue, 0);
});

test("未设置成本价的标的 → error（金额无法换算）", () => {
  const r = checkTradePlan(cfg, [{ code: "300750", action: "add", amount: 100 }]);
  assert.equal(r.ok, false);
  assert.ok(r.alerts.some((a) => a.level === "error" && a.message.includes("未设置成本价")));
});

test("同一标的多个操作 → error（一标的一天一个操作）", () => {
  const r = checkTradePlan(cfg, [
    { code: "600519", action: "add", amount: 2 },
    { code: "600519", action: "add", amount: 3 },
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.alerts.some((x) => x.level === "error" && x.message.includes("合并为一个交易操作")));
  assert.equal(r.totals.addTotal, 7000); // 5 股 × 1400
});

test("告警按级别排序：error 在前", () => {
  const r = checkTradePlan(cfg, [
    { code: "000001", action: "add", amount: 50 },
    { code: "600519", action: "add", amount: 5 },
  ]);
  assert.equal(r.alerts[0].level, "error");
});

test("applyItems：加仓直接加数量、均价不变", () => {
  const after = applyItems(cfg.positions, [{ code: "600519", action: "add", amount: 4 }]);
  const m = after.find((p) => p.code === "600519")!;
  assert.equal(m.quantity, 24);
  assert.equal(m.avgCost, 1400);
});

test("applyItems：减仓只减数量", () => {
  const after = applyItems([{ code: "600519", quantity: 100, avgCost: 1200 }], [{ code: "600519", action: "reduce", amount: 10 }]);
  const m = after.find((p) => p.code === "600519")!;
  assert.equal(m.quantity, 90);
  assert.equal(m.avgCost, 1200);
});

test("applyItems：加仓用本次 cost 重算均价", () => {
  const after = applyItems(cfg.positions, [{ code: "600519", action: "add", amount: 10, cost: 2000 }]);
  const m = after.find((p) => p.code === "600519")!;
  assert.equal(m.quantity, 30); // 20 + 10
  assert.equal(m.avgCost, 1600); // (20×1400 + 10×2000)/30
});

test("checkTradePlan：加仓金额用本次 cost", () => {
  const r = checkTradePlan(cfg, [{ code: "600519", action: "add", amount: 5, cost: 2000 }]);
  assert.equal(r.totals.addTotal, 10000); // 5 × 2000
  const m = r.after.find((p) => p.code === "600519")!;
  assert.equal(m.addAmount, 10000);
});

test("checkTradePlan：cost 缺省用当前均价", () => {
  const r = checkTradePlan(cfg, [{ code: "600519", action: "add", amount: 5 }]);
  assert.equal(r.totals.addTotal, 7000); // 5 × 1400
});

test("rebasePositions：手动固化只计入调整量，不双重计入已应用计划", () => {
  const oldBase = [
    { code: "A", quantity: 100, avgCost: 10 },
    { code: "B", quantity: 50, avgCost: 20 },
  ];
  // 已应用计划：A +100、B -20 → 全量重放 = A:200 B:30
  const replayed = [
    { code: "A", quantity: 200, avgCost: 10 },
    { code: "B", quantity: 30, avgCost: 20 },
  ];
  // 用户手动编辑当前仓位：A:250（比重放多 50）、B:30（未改）
  const submitted = [
    { code: "A", quantity: 250, avgCost: 10 },
    { code: "B", quantity: 30, avgCost: 20 },
  ];
  const nb = rebasePositions(oldBase, replayed, submitted);
  // 新 base：A = 100 + (250-200) = 150；B = 50 + (30-30) = 50
  assert.equal(nb.find((x) => x.code === "A")?.quantity, 150);
  assert.equal(nb.find((x) => x.code === "B")?.quantity, 50);
  // 验证：新 base 重放已应用计划（A 增量 +100）= 提交值 250
  const aBase = nb.find((x) => x.code === "A")?.quantity ?? 0; // 150
  assert.equal(aBase + 100, 250);
});

test("rebasePositions：提交等于重放 → 基线不变（幂等）", () => {
  const oldBase = [{ code: "A", quantity: 100, avgCost: 10 }];
  const replayed = [{ code: "A", quantity: 200, avgCost: 10 }];
  const nb = rebasePositions(oldBase, replayed, [{ code: "A", quantity: 200, avgCost: 10 }]);
  assert.equal(nb.find((x) => x.code === "A")?.quantity, 100);
});

test("rebasePositions：新增 code 直接加入基线", () => {
  const oldBase = [{ code: "A", quantity: 100, avgCost: 10 }];
  const replayed = [{ code: "A", quantity: 100, avgCost: 10 }];
  const nb = rebasePositions(oldBase, replayed, [
    { code: "A", quantity: 100, avgCost: 10 },
    { code: "C", quantity: 10, avgCost: 5 },
  ]);
  assert.equal(nb.find((x) => x.code === "C")?.quantity, 10);
});

test("applyItems：负数成本合法（融资/做空场景）", () => {
  // 初始 0 股；加仓 100 股成本 -1.5 → 均价 -1.5
  const pos = applyItems([], [{ code: "A", action: "add", amount: 100, cost: -1.5 }]);
  assert.equal(pos.find((x) => x.code === "A")?.quantity, 100);
  assert.equal(pos.find((x) => x.code === "A")?.avgCost, -1.5);
});

test("checkTradePlan：负成本参与金额换算（单日上限按 数量×成本 计算）", () => {
  const cfg = {
    id: "t", name: "t", totalCapital: 100000, dailyAddLimit: 10000,
    stocks: [{ code: "A", maxWeightPct: 100 }],
    positions: [{ code: "A", quantity: 100, avgCost: -1.5 }],
  };
  const r = checkTradePlan(cfg, [{ code: "A", action: "add", amount: 100, cost: -2 }]);
  // 加仓金额 = 100 × (-2) = -200（负成本 → 负金额，不超上限）
  assert.ok(r.totals.addTotal === -200, `addTotal 应 -200，实际 ${r.totals.addTotal}`);
  assert.equal(r.ok, true); // 无 error（负数成本合法）
});
