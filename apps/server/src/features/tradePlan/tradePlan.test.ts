// 交易规划校验计算单测（v3：日度计划按数量（股）操作）
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyItems, buildDeals, checkTradePlan } from "./compute.js";
import { itemsPriceError, parseItems } from "./index.js";
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

test("未设置成本的标的 → error（金额无法换算）", () => {
  const r = checkTradePlan(cfg, [{ code: "300750", action: "add", amount: 100 }]);
  assert.equal(r.ok, false);
  assert.ok(r.alerts.some((a) => a.level === "error" && a.message.includes("无法换算金额")));
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

test("checkTradePlan：无成本价但有行情 fallback → warn 估算且 ok", () => {
  const r = checkTradePlan(cfg, [{ code: "300750", action: "add", amount: 5 }], { priceFallback: { "300750": 1500 } });
  assert.equal(r.ok, true); // 无 error
  const w = r.alerts.find((a) => a.level === "warn");
  assert.ok(w && w.message.includes("按最新价 ¥1500 估算"), "应有按最新价估算 warn");
  assert.equal(r.totals.addTotal, 7500); // 5 × 1500（fallback 参与金额换算）
});

test("checkTradePlan：三源都无成本 → 仍 error", () => {
  const r = checkTradePlan(cfg, [{ code: "300750", action: "add", amount: 5 }], { priceFallback: {} });
  assert.equal(r.ok, false);
  const e = r.alerts.find((a) => a.level === "error");
  assert.ok(e && e.message.includes("无法换算金额"));
});

// ---------- 价格必填（v6：加仓=买入价、减仓=卖出价，路由层权威校验） ----------

test("parseItems：合法条目解析（含价格）", () => {
  const items = parseItems([
    { code: "600519", action: "add", amount: 10, cost: 1500 },
    { code: "300750", action: "reduce", amount: 5, cost: 1600 },
  ]);
  assert.ok(items);
  assert.equal(items!.length, 2);
  assert.equal(items![0].cost, 1500);
});

test("parseItems：缺代码/数量<=0/空 → null", () => {
  assert.equal(parseItems(null), null);
  assert.equal(parseItems([]), null);
  assert.equal(parseItems([{ action: "add", amount: 10 }]), null); // 无 code → 过滤为空
  assert.equal(parseItems([{ code: "600519", action: "add", amount: 0 }]), null); // 数量 <=0
});

test("itemsPriceError：全部有价格 → null", () => {
  const items = parseItems([
    { code: "600519", action: "add", amount: 10, cost: 1500 },
    { code: "300750", action: "reduce", amount: 5, cost: 1600 },
  ]);
  assert.ok(items);
  assert.equal(itemsPriceError(items!), null);
});

test("itemsPriceError：加仓缺买入价 → 报错含「买入价」", () => {
  const items = parseItems([{ code: "600519", action: "add", amount: 10 }]);
  assert.ok(items);
  const err = itemsPriceError(items!);
  assert.ok(err && err.includes("600519") && err.includes("买入价"), err ?? "");
});

test("itemsPriceError：减仓缺卖出价 → 报错含「卖出价」", () => {
  const items = parseItems([{ code: "300750", action: "reduce", amount: 5 }]);
  assert.ok(items);
  const err = itemsPriceError(items!);
  assert.ok(err && err.includes("卖出价"), err ?? "");
});

test("itemsPriceError：价格 <=0 → 报错（真实成交价须 >0）", () => {
  const items = parseItems([{ code: "600519", action: "add", amount: 10, cost: 0 }]);
  assert.ok(items);
  assert.ok(itemsPriceError(items!) !== null); // cost 0 不入 parseItems → 视为缺价
});

test("checkTradePlan：减仓计算已实现盈亏（卖出价−均价）×数量", () => {
  const r = checkTradePlan(cfg, [{ code: "600519", action: "reduce", amount: 10, cost: 1500 }]);
  assert.equal(r.ok, true);
  const m = r.after.find((p) => p.code === "600519")!;
  assert.equal(m.realizedPnl, (1500 - 1400) * 10); // 卖出价 1500 vs 均价 1400 × 10 股 = 1000
  assert.equal(m.shares, 10); // 20 - 10
  assert.equal(m.avgCost, 1400); // 减仓不改变均价
});

test("checkTradePlan：减仓亏损时 realizedPnl 为负", () => {
  const r = checkTradePlan(cfg, [{ code: "600519", action: "reduce", amount: 5, cost: 1300 }]);
  const m = r.after.find((p) => p.code === "600519")!;
  assert.equal(m.realizedPnl, (1300 - 1400) * 5); // -500
});

test("checkTradePlan：加仓不产生 realizedPnl", () => {
  const r = checkTradePlan(cfg, [{ code: "600519", action: "add", amount: 10, cost: 1500 }]);
  const m = r.after.find((p) => p.code === "600519")!;
  assert.equal(m.realizedPnl, undefined);
});

test("parseItems：数量非整数（0.5 股）→ 整批 null（不再静默丢条目）", () => {
  assert.equal(parseItems([{ code: "600519", action: "add", amount: 100.5, cost: 1500 }]), null);
  // 2 条中 1 条非法 → 整批拒绝（用户能看到 400 而非少条计划）
  assert.equal(parseItems([
    { code: "600519", action: "add", amount: 100, cost: 1500 },
    { code: "300750", action: "add", amount: 0.5, cost: 100 },
  ]), null);
});

test("checkTradePlan：totals 含当日减仓回款 reduceTotal（卖出价×数量）", () => {
  const r = checkTradePlan(cfg, [{ code: "600519", action: "reduce", amount: 10, cost: 1500 }]);
  assert.equal(r.totals.reduceTotal, 15000);
});

// ---------- 交易复盘（Deal：加仓→清仓按笔配对，平均成本法） ----------

const day = (date: string, items: { code: string; action: "add" | "reduce"; amount: number; cost?: number }[]) => ({ date, applied: true as const, items });

test("buildDeals：建仓→加仓→清仓 → 1 笔 closed，pnl/持仓天数/胜率正确", () => {
  const s = buildDeals([
    day("2026-08-01", [{ code: "A", action: "add", amount: 100, cost: 10 }]),
    day("2026-08-03", [{ code: "A", action: "add", amount: 100, cost: 12 }]),
    day("2026-08-05", [{ code: "A", action: "reduce", amount: 200, cost: 15 }]),
  ]);
  assert.equal(s.closedCount, 1);
  assert.equal(s.openCount, 0);
  const d = s.deals.find((x) => x.code === "A")!;
  assert.equal(d.status, "closed");
  assert.equal(d.buyQty, 200);
  assert.equal(d.buyAmount, 100 * 10 + 100 * 12); // 2200
  assert.equal(d.sellAmount, 200 * 15); // 3000
  assert.equal(d.pnl, 800);
  assert.equal(d.days, 4); // 08-01 → 08-05
  assert.equal(d.avgCost, 11); // 2200/200
  assert.equal(s.winRate, 100);
  assert.equal(s.realizedPnl, 800);
  assert.equal(s.avgDays, 4);
});

test("buildDeals：在途 deal（未清仓）status=open，不结算 pnl", () => {
  const s = buildDeals([day("2026-08-10", [{ code: "A", action: "add", amount: 100, cost: 10 }])]);
  assert.equal(s.closedCount, 0);
  assert.equal(s.openCount, 1);
  const d = s.deals.find((x) => x.code === "A")!;
  assert.equal(d.status, "open");
  assert.equal(d.qty, 100);
  assert.equal(d.pnl, undefined);
  assert.equal(s.winRate, undefined);
  assert.equal(s.realizedPnl, 0);
});

test("buildDeals：部分减仓再清仓 = 1 笔；两段买卖 = 2 笔，胜率/已实现盈亏正确", () => {
  const s = buildDeals([
    day("2026-08-01", [{ code: "A", action: "add", amount: 100, cost: 10 }]),
    day("2026-08-04", [{ code: "A", action: "reduce", amount: 40, cost: 11 }]),
    day("2026-08-06", [{ code: "A", action: "reduce", amount: 60, cost: 13 }]),
    day("2026-08-08", [{ code: "B", action: "add", amount: 50, cost: 20 }]),
    day("2026-08-09", [{ code: "B", action: "reduce", amount: 50, cost: 18 }]),
  ]);
  assert.equal(s.closedCount, 2);
  assert.equal(s.openCount, 0);
  const a = s.deals.find((x) => x.code === "A")!;
  assert.equal(a.pnl, 40 * 11 + 60 * 13 - 100 * 10); // 1220 − 1000 = 220
  const b = s.deals.find((x) => x.code === "B")!;
  assert.equal(b.pnl, 50 * 18 - 50 * 20); // −100
  assert.equal(s.winRate, 50); // A 盈 B 亏
  assert.equal(s.realizedPnl, 120); // 220 − 100
  assert.equal(s.totalProfit, 220);
  assert.equal(s.totalLoss, 100);
});

test("buildDeals：未应用计划不计入交易复盘", () => {
  const s = buildDeals([
    day("2026-08-01", [{ code: "A", action: "add", amount: 100, cost: 10 }]),
    { date: "2026-08-03", applied: false, items: [{ code: "A", action: "reduce", amount: 100, cost: 15 }] },
  ]);
  assert.equal(s.openCount, 1); // 减仓未应用 → 仍是 open
  assert.equal(s.closedCount, 0);
});

test("rebasePositions：提交中删除的标的 → 从基线移除（防重放复活已删标的）", () => {
  const oldBase = [
    { code: "A", quantity: 100, avgCost: 10 },
    { code: "B", quantity: 50, avgCost: 20 },
  ];
  const replayed = [
    { code: "A", quantity: 200, avgCost: 10 },
    { code: "B", quantity: 30, avgCost: 20 },
  ];
  // 用户删除 B（提交中无 B）
  const submitted = [{ code: "A", quantity: 250, avgCost: 10 }];
  const nb = rebasePositions(oldBase, replayed, submitted);
  assert.equal(nb.some((x) => x.code === "B"), false); // B 从基线移除
  assert.equal(nb.find((x) => x.code === "A")?.quantity, 150); // A: 100 + (250−200)
});
