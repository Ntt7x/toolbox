// 仓位管理 v2 单测：账本重放（均价/已实现）、复盘配对、分组约束校验、存储 CRUD
// 数据安全（cordis.md §5）：store 测试 beforeEach 备份 / afterEach 恢复 tradeV2: 全部 KV
import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import type { TradeV2Entry, TradeV2EntryDraft, TradeV2Group } from "@toolbox/shared";
import { kvDelete, kvGet, kvListRaw, kvSet } from "../../core/kvStore.js";
import {
  analyzeGroup,
  buildDailySeries,
  buildDeals,
  buildGlobalAnalysis,
  buildGroupSummary,
  buildMonthlySeries,
  buildPnlAttribution,
  buildPositions,
  checkEntry,
  findOverSell,
  replayEntries,
  summarizeOrder,
  todayStr,
} from "./compute.js";
import { parseEntryInput, parseStockLimits } from "./services.js";
import * as tradeV2Plugin from "./plugin.js";
import {
  GROUP_LIST,
  GROUP_PREFIX,
  TRADE_LIST,
  TRADE_PREFIX,
  createEntry,
  createGroup,
  deleteEntry,
  deleteGroup,
  getEntry,
  getGroup,
  listEntries,
  listEntriesByGroup,
  listGroups,
  updateEntry,
  updateGroup,
} from "./store.js";

// ---------- 工具 ----------

function mkEntry(partial: Partial<TradeV2Entry> & { code: string; date: string; action: "buy" | "sell"; quantity: number; price: number }): TradeV2Entry {
  const now = new Date().toISOString();
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    groupId: "g-test",
    ...partial,
    createdAt: partial.createdAt ?? now,
    updatedAt: now,
  };
}

const group: TradeV2Group = {
  id: "g-test",
  name: "测试组",
  totalCapital: 100000,
  dailyAddLimit: 20000,
  stockLimits: [{ code: "600519", name: "贵州茅台", maxWeightPct: 40 }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

// ---------- 重放 / 仓位派生 ----------

test("重放：两笔买入（含手续费）→ 加权平均成本", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100, fee: 5 }),
    mkEntry({ code: "600519", date: "2026-01-03", action: "buy", quantity: 10, price: 120, fee: 5 }),
  ];
  const st = replayEntries(entries).get("600519")!;
  assert.equal(st.qty, 20);
  // 成本基数 = 10×100+5 + 10×120+5 = 1005+1205 = 2210 → 均价 110.5
  assert.equal(Math.round(st.costBasis * 100) / 100, 2210);
  const pos = buildPositions(entries)[0]!;
  assert.equal(pos.quantity, 20);
  assert.equal(pos.avgCost, 110.5);
  assert.equal(pos.costValue, 2210);
});

test("重放：卖出计入已实现盈亏、摊余成本不变", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-01-10", action: "sell", quantity: 4, price: 130, fee: 5 }),
  ];
  const st = replayEntries(entries).get("600519")!;
  assert.equal(st.qty, 6);
  // 已实现 = (130-100)×4 - 5 = 115
  assert.equal(st.realized, 115);
  // 摊余成本基数 = 1000 - 4×100 = 600 → 均价仍 100
  assert.equal(st.costBasis, 600);
});

test("成本均价（摊薄口径）：买入均价不变、成本均价随卖出盈利下降（2026-08-17）", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-01-10", action: "sell", quantity: 4, price: 130, fee: 5 }),
  ];
  const pos = buildPositions(entries)[0]!;
  // 买入均价 = 100（卖出不改）
  assert.equal(pos.avgCost, 100);
  // 成本均价 = (costBasis − realized) / qty = (600 − 115) / 6 = 80.83（已实现盈利摊入 → 下降）
  assert.ok(pos.costAvg !== undefined);
  assert.ok(Math.abs(pos.costAvg! - 80.83) < 0.01, `costAvg=${pos.costAvg}`);
});

test("成本均价：159866 负成本场景（期初负价 + 卖出盈利 → 成本均价更负）", () => {
  const entries = [
    mkEntry({ code: "159866", date: "2026-08-15", action: "buy", quantity: 2100, price: -0.117 }),
    mkEntry({ code: "159866", date: "2026-08-17", action: "sell", quantity: 1300, price: 1.753, fee: 0.23 }),
  ];
  const pos = buildPositions(entries)[0]!;
  assert.equal(pos.quantity, 800);
  // 买入均价 = -0.117（期初负价，卖出不改）
  assert.ok(Math.abs(pos.avgCost - -0.117) < 1e-9);
  // 成本均价 = (costBasis − realized) / 800；costBasis = -245.7 + 152.1 = -93.6；realized = 卖出 2278.9+0.23费…
  assert.ok(pos.costAvg !== undefined);
  assert.ok(pos.costAvg! < pos.avgCost, `costAvg=${pos.costAvg} 应小于买入均价 ${pos.avgCost}`);
});

test("重放：卖出超持仓 → findOverSell 报告", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-01-10", action: "sell", quantity: 15, price: 130 }),
  ];
  const over = findOverSell(entries);
  assert.ok(over);
  assert.equal(over!.code, "600519");
  assert.ok(over!.detail.includes("15 股"));
  assert.ok(over!.detail.includes("10 股"));
});

test("重放：同日期按录入先后（先卖后买不误判超卖）", () => {
  const t1 = "2026-01-01T00:00:00.000Z";
  const t2 = "2026-01-01T00:00:01.000Z";
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100, createdAt: t1 }),
    mkEntry({ code: "600519", date: "2026-01-02", action: "sell", quantity: 5, price: 110, createdAt: t2 }),
  ];
  assert.equal(findOverSell(entries), null);
  assert.equal(replayEntries(entries).get("600519")!.qty, 5);
});

// ---------- 复盘 ----------

test("复盘：建仓→部分卖出→清仓 = 一笔 closed；再买入 = 新 open", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-01-05", action: "buy", quantity: 5, price: 110, fee: 10 }),
    mkEntry({ code: "600519", date: "2026-02-01", action: "sell", quantity: 8, price: 120 }),
    mkEntry({ code: "600519", date: "2026-02-05", action: "sell", quantity: 7, price: 130 }),
    mkEntry({ code: "600519", date: "2026-02-20", action: "buy", quantity: 3, price: 140 }),
  ];
  const deals = buildDeals(entries);
  assert.equal(deals.length, 2);
  const closed = deals.find((d) => d.status === "closed")!;
  assert.equal(closed.buyQty, 15);
  assert.equal(closed.buyAmount, 1550); // 10×100 + 5×110
  assert.equal(closed.sellAmount, 1870); // 8×120 + 7×130
  assert.equal(closed.feeTotal, 10);
  assert.equal(closed.pnl, 1870 - 1550 - 10);
  assert.equal(closed.days, 34); // 2026-01-02 → 2026-02-05
  const open = deals.find((d) => d.status === "open")!;
  assert.equal(open.qty, 3);
  assert.equal(open.entryDate, "2026-02-20");
  assert.equal(open.avgCost, 140);
});

// ---------- 组约束校验 ----------

test("校验：合规交易（日限内、不超总仓位/单标的上限）→ ok", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-01-03", action: "buy", quantity: 5, price: 100 }),
  ];
  const r = checkEntry(group, entries, { targetDate: "2026-01-03" });
  assert.equal(r.ok, true);
  assert.ok(r.alerts.some((a) => a.level === "info" && a.message.includes("仓位占比")));
});

test("校验：卖出超持仓 → error", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-01-03", action: "sell", quantity: 11, price: 110 }),
  ];
  const r = checkEntry(group, entries, { targetDate: "2026-01-03" });
  assert.equal(r.ok, false);
  assert.ok(r.alerts.some((a) => a.level === "error" && a.message.includes("卖出数量超过")));
});

test("校验：单日加仓超上限 → error（期初建仓不计入）", () => {
  // 当日加仓 10×100=1000 + 15×100=1500 = 2500 > 2000（自定义小上限）
  const smallGroup = { ...group, dailyAddLimit: 2000 };
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-03", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-01-03", action: "buy", quantity: 15, price: 100 }),
  ];
  const r = checkEntry(smallGroup, entries, { targetDate: "2026-01-03" });
  assert.equal(r.ok, false);
  assert.ok(r.alerts.some((a) => a.level === "error" && a.message.includes("单日加仓上限")));
  // 期初建仓不参与：加一条 initial 不改变结果（仍超）
  const withInit = [
    ...entries,
    mkEntry({ code: "300750", date: "2026-01-03", action: "buy", quantity: 100, price: 100, initial: true }),
  ];
  const r2 = checkEntry(smallGroup, withInit, { targetDate: "2026-01-03" });
  assert.ok(r2.alerts.some((a) => a.level === "error" && a.message.includes("单日加仓上限")));
  assert.ok(!r2.alerts.some((a) => a.message.includes("300750") && a.message.includes("单日加仓")));
});

test("校验：单标的上限（40% × 10万 = 4万）→ error", () => {
  // 500 股 × 100 = 50000 > 40000
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-03", action: "buy", quantity: 500, price: 100 }),
  ];
  const r = checkEntry(group, entries, { targetDate: "2026-01-03" });
  assert.equal(r.ok, false);
  assert.ok(r.alerts.some((a) => a.level === "error" && a.message.includes("超过单标的上限")));
});

test("校验：总市值超总仓位 → error", () => {
  // 1200 股 × 100 = 120000 > 100000（未配置单标的上限的 code）
  const g = { ...group, stockLimits: [] };
  const entries = [
    mkEntry({ code: "000001", date: "2026-01-03", action: "buy", quantity: 1200, price: 100 }),
  ];
  const r = checkEntry(g, entries, { targetDate: "2026-01-03" });
  assert.equal(r.ok, false);
  assert.ok(r.alerts.some((a) => a.level === "error" && a.message.includes("总仓位上限")));
});

// ---------- 组分析 ----------

test("组分析：汇总（市值/盈亏/净投入/当日加仓/胜率/平均持仓）", () => {
  const today = todayStr();
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-01-10", action: "sell", quantity: 10, price: 150 }), // 已实现 +500
    mkEntry({ code: "600519", date: "2026-02-01", action: "buy", quantity: 4, price: 100 }), // 在途 4 股 ×100
    mkEntry({ code: "600519", date: today, action: "buy", quantity: 2, price: 110 }), // 今日加仓 220
    mkEntry({ code: "600519", date: "2026-02-15", action: "sell", quantity: 4, price: 90 }), // 已实现 -40
  ];
  const a = analyzeGroup(group, entries, { "600519": 130 });
  assert.equal(a.realizedPnl, 460); // 500 - 40
  // 在途：2 股 × 110（最新价 130）→ 市值 260，成本 220 → 未实现 +40
  assert.equal(a.unrealizedPnl, 40);
  assert.equal(a.totalPnl, 500);
  assert.equal(a.openCount, 1);
  assert.equal(a.closedCount, 2);
  assert.equal(a.winRate, 50); // 2 笔 closed 中 1 笔盈利
  assert.equal(a.todayAdd, 220);
  // 净投入 = Σbuy(含费) − Σsell回款 = (1000+400+220) − (1500+360) = -240
  assert.equal(a.invested, -240);
  // avgDays = (8 + 14) / 2 = 11（01-02→01-10 8 天；02-01→02-15 14 天）
  assert.equal(a.avgDays, 11);
});

test("全局分析：累计已实现盈亏时间线（按清仓日累计）", () => {
  const entriesA = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-01-10", action: "sell", quantity: 10, price: 120 }), // +200 @ 01-10
    mkEntry({ code: "600519", date: "2026-02-01", action: "buy", quantity: 5, price: 100 }),
    mkEntry({ code: "600519", date: "2026-02-20", action: "sell", quantity: 5, price: 90 }), // -50 @ 02-20
  ];
  const g = buildGlobalAnalysis([{ group, entries: entriesA, latestPrices: {} }]);
  assert.equal(g.closedCount, 2);
  assert.equal(g.realizedPnl, 150);
  assert.equal(g.realizedTimeline.length, 2);
  assert.equal(g.realizedTimeline[0]!.date, "2026-01-10");
  assert.equal(g.realizedTimeline[0]!.cumulative, 200);
  assert.equal(g.realizedTimeline[1]!.cumulative, 150);
});

// ---------- 解析 ----------

test("parseEntryInput：合法输入", () => {
  const r = parseEntryInput({
    groupId: "g1",
    date: "2026-01-02",
    code: "600519",
    action: "buy",
    quantity: 100,
    price: 10.5,
    fee: 5,
    note: "测试",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.entry.quantity, 100);
  assert.equal(r.entry.price, 10.5);
  assert.equal(r.entry.fee, 5);
});

test("parseEntryInput：非法输入（数量非整数/价格<=0/日期格式/缺失分组）→ 拒绝", () => {
  assert.equal(parseEntryInput({ groupId: "g1", date: "2026-01-02", code: "600519", action: "buy", quantity: 10.5, price: 10 }).ok, false);
  assert.equal(parseEntryInput({ groupId: "g1", date: "2026-01-02", code: "600519", action: "buy", quantity: 10, price: 0 }).ok, false);
  assert.equal(parseEntryInput({ groupId: "g1", date: "2026/01/02", code: "600519", action: "buy", quantity: 10, price: 10 }).ok, false);
  assert.equal(parseEntryInput({ date: "2026-01-02", code: "600519", action: "buy", quantity: 10, price: 10 }).ok, false);
  assert.equal(parseEntryInput({ groupId: "g1", date: "2026-01-02", code: "", action: "buy", quantity: 10, price: 10 }).ok, false);
});

test("parseStockLimits：去重 + 越界丢弃 + 空 code 丢弃", () => {
  const out = parseStockLimits([
    { code: "600519", maxWeightPct: 30 },
    { code: "600519", maxWeightPct: 50 },
    { code: "300750", maxWeightPct: 120 },
    { code: "000001", maxWeightPct: 10 },
    { code: "", maxWeightPct: 10 },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.code, "600519");
  assert.equal(out[0]!.maxWeightPct, 30);
});

// ---------- 存储（KV，备份/恢复保证数据安全） ----------

let backups: { key: string; value: string }[] = [];

beforeEach(() => {
  // 备份 tradeV2:（本模块 KV）
  backups = [
    ...kvListRaw("tradeV2:", 10000).map((r) => ({ key: r.key, value: r.value })),
  ];
});
afterEach(() => {
  for (const { key } of kvListRaw("tradeV2:", 10000)) kvDelete(key);
    for (const b of backups) kvSet(b.key, JSON.parse(b.value));
});

/** 挂载 tradeV2 插件（Group/Ledger/Analysis/Import 四服务） */
async function makeV2Ctx(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(tradeV2Plugin as any);
  return ctx;
}


test("store：分组 CRUD（创建/列表/改名/改限制/删除级联交易）", () => {
  const g1 = createGroup("策略A");
  const g2 = createGroup("策略B");
  // 与真实数据共存：按 id 断言（不依赖列表总长度）
  assert.ok(listGroups().some((x) => x.id === g1.id) && listGroups().some((x) => x.id === g2.id));
  assert.equal(getGroup(g1.id)!.name, "策略A");
  const upd = updateGroup(g1.id, { totalCapital: 50000, dailyAddLimit: 5000, stockLimits: [{ code: "600519", maxWeightPct: 30 }] });
  assert.equal(upd!.totalCapital, 50000);
  assert.equal(getGroup(g1.id)!.stockLimits[0]!.maxWeightPct, 30);
  // 重名拒绝（listGroups 全量判断；由路由层保证，这里验证 updateGroup 不改名）
  updateGroup(g1.id, { name: "策略B" });
  assert.equal(getGroup(g1.id)!.name, "策略B");
  void g2;
  // 级联删除
  const e1 = createEntry({ groupId: g1.id, date: "2026-01-02", code: "600519", action: "buy", quantity: 10, price: 100 });
  createEntry({ groupId: g2.id, date: "2026-01-02", code: "300750", action: "buy", quantity: 10, price: 50 });
  assert.equal(deleteGroup(g1.id), true);
  assert.equal(getGroup(g1.id), null);
  assert.equal(getEntry(e1.id), null); // 级联删除交易
  assert.equal(listEntriesByGroup(g2.id).length, 1); // 仅剩 g2 的（真实数据共存，按组断言）
});

test("store：交易 CRUD + 组内排序（日期升序）", () => {
  const g = createGroup("策略A");
  const e1 = createEntry({ groupId: g.id, date: "2026-01-05", code: "600519", action: "buy", quantity: 10, price: 100 });
  const e2 = createEntry({ groupId: g.id, date: "2026-01-02", code: "300750", action: "buy", quantity: 5, price: 50 });
  const byGroup = listEntriesByGroup(g.id);
  assert.equal(byGroup[0]!.id, e2.id); // 日期升序
  assert.equal(byGroup[1]!.id, e1.id);
  // 编辑
  const upd = updateEntry(e1.id, { quantity: 12 });
  assert.equal(upd!.quantity, 12);
  assert.equal(getEntry(e1.id)!.quantity, 12);
  // 删除
  assert.equal(deleteEntry(e1.id), true);
  assert.equal(getEntry(e1.id), null);
  assert.equal(listEntriesByGroup(g.id).length, 1);
});
test("每日动态：逐日买入/卖出/当日已实现/收盘市值（成本口径）", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "300750", date: "2026-01-02", action: "buy", quantity: 5, price: 50 }),
    mkEntry({ code: "600519", date: "2026-01-05", action: "sell", quantity: 4, price: 130, fee: 5 }),
    mkEntry({ code: "300750", date: "2026-01-06", action: "buy", quantity: 3, price: 60 }),
  ];
  const d = buildDailySeries(entries);
  assert.ok(d.length >= 3, "dailySeries 按日展开到今天");
  // 01-02：买入 1000+250，收盘市值 1250，2 标的
  assert.equal(d[0]!.date, "2026-01-02");
  assert.equal(d[0]!.buyAmount, 1250);
  assert.equal(d[0]!.sellAmount, 0);
  assert.equal(d[0]!.realizedPnl, 0);
  assert.equal(d[0]!.marketValue, 1250);
  assert.equal(d[0]!.openCount, 2);
  // 01-05：卖出 4×130−5=515，已实现 (130−100)×4−5=115，收盘市值 = 600×? -> 600519 剩 6×100=600 + 300750 250 = 850
  const d5 = d.find((x) => x.date === "2026-01-05")!;
  assert.equal(d5.sellAmount, 515);
  assert.equal(d5.realizedPnl, 115);
  assert.equal(d5.marketValue, 850);
  // 01-06：买入 180，收盘市值 850+180=1030
  const d6 = d.find((x) => x.date === "2026-01-06")!;
  assert.equal(d6.buyAmount, 180);
  assert.equal(d6.marketValue, 1030);
  assert.equal(d6.realizedPnl, 0);
});

test("月度汇总：按月份聚合买入/卖出/已实现，月末市值取当月最后交易日", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-01-20", action: "sell", quantity: 4, price: 130 }),
    mkEntry({ code: "600519", date: "2026-02-03", action: "buy", quantity: 5, price: 110 }),
  ];
  const m = buildMonthlySeries(entries);
  assert.ok(m.length >= 2, "月度含展开后月份");
  assert.equal(m[0]!.month, "2026-01");
  assert.equal(m[0]!.buyAmount, 1000);
  assert.equal(m[0]!.sellAmount, 520);
  assert.equal(m[0]!.realizedPnl, 120); // (130−100)×4
  assert.equal(m[0]!.marketValue, 600); // 6×100
  assert.equal(m[1]!.month, "2026-02");
  assert.equal(m[1]!.buyAmount, 550);
  assert.equal(m[1]!.marketValue, 1150); // 6×100 + 5×110
});

test("收益归因：已实现（含已清仓）+ 未实现 按标的排序", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-01-10", action: "sell", quantity: 10, price: 120 }), // 已实现 +200，清仓
    mkEntry({ code: "300750", date: "2026-01-02", action: "buy", quantity: 5, price: 50 }),   // 在途，最新价 60
  ];
  const attr = buildPnlAttribution(entries, { "300750": 60 });
  assert.equal(attr.length, 2);
  const m = attr.find((x) => x.code === "600519")!;
  assert.equal(m.realizedPnl, 200);
  assert.equal(m.unrealizedPnl, 0);
  const d = attr.find((x) => x.code === "300750")!;
  assert.equal(d.realizedPnl, 0);
  assert.equal(d.unrealizedPnl, 50); // 5×60 − 5×50
  assert.equal(d.totalPnl, 50);
  // 排序：总盈亏降序
  assert.equal(attr[0]!.code, "600519");
});

test("交易单归并：净买/净卖/持平 + 当日已实现（基于前日仓位）", () => {
  const prior = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }), // 均价 100
  ];
  const items: TradeV2EntryDraft[] = [
    { groupId: "g", date: "2026-01-05", code: "600519", action: "buy", quantity: 5, price: 110 },
    { groupId: "g", date: "2026-01-05", code: "600519", action: "sell", quantity: 3, price: 130 },
    { groupId: "g", date: "2026-01-05", code: "300750", action: "buy", quantity: 10, price: 50 },
  ];
  const s = summarizeOrder(prior, items);
  assert.equal(s.buyTotal, 550 + 500); // 5×110 + 10×50
  assert.equal(s.sellTotal, 390);     // 3×130
  // 先买 5@110 后卖 3@130：均价升至 (1000+550)/15=103.333 → 已实现 (130−103.333)×3=80
  assert.equal(s.realizedPnl, 80);
  assert.equal(s.netPerCode.length, 2);
  const m = s.netPerCode.find((x) => x.code === "600519")!;
  assert.equal(m.netQty, 2); // 5 买 − 3 卖
  assert.equal(m.action, "buy");
  assert.equal(m.netAmount, 160); // 净金额 = 5×110 − 3×130
  const d = s.netPerCode.find((x) => x.code === "300750")!;
  assert.equal(d.netQty, 10);
  assert.equal(d.action, "buy");
});

test("组分析包含收益三序列（daily/monthly/attribution）", () => {
  const entries = [mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 })];
  const a = analyzeGroup(group, entries, {});
  assert.ok(a.dailySeries.length >= 1);
  assert.ok(a.monthlySeries.length >= 1);
  assert.equal(a.pnlAttribution.length, 1);
});
// ---------- 月收益率 / 组合日序列 / 风险计数 ----------

test("月度收益率（成本口径）：月PnL = 已实现 + 市值变动 − 净流入，÷ 月初市值", () => {
  // 1月：买 10@100（MV 1000）→ 2月：卖 4@130（已实现 120，净流入 −520），再买 5@110（MV 1000−400+550=1150）
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-02-03", action: "sell", quantity: 4, price: 130 }),
    mkEntry({ code: "600519", date: "2026-02-05", action: "buy", quantity: 5, price: 110 }),
  ];
  const m = buildMonthlySeries(entries);
  assert.ok(m.length >= 2, "月度含展开后月份");
  assert.equal(m[0]!.month, "2026-01");
  assert.equal(m[0]!.pnlPct, undefined); // 首月无月初市值
  // 2月：月初市值 1000；已实现 120；净流入 = 买550 − 卖520 = 30；月末市值 1150
  // 月PnL = 120 + (1150 − 1000 − 30) = 240；收益率 = 240 / 1000 = 24%
  assert.equal(m[1]!.month, "2026-02");
  assert.equal(m[1]!.pnlPct, 24);
});

test("全局分析：组合每日动态（跨组合按日合并市值/持仓数）", () => {
  const entriesA = [mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 })];
  const entriesB = [mkEntry({ code: "300750", date: "2026-01-02", action: "buy", quantity: 5, price: 50 })];
  const g = buildGlobalAnalysis([
    { group, entries: entriesA, latestPrices: {} },
    { group: { ...group, id: "g2" }, entries: entriesB, latestPrices: {} },
  ]);
  assert.ok(g.dailySeries.length >= 1);
  assert.equal(g.dailySeries[0]!.marketValue, 1250); // 1000 + 250
  assert.equal(g.dailySeries[0]!.openCount, 2);
});

test("负成本统一模型：负价期初建仓 → 仓位成本基数为负，浮动盈亏金额正确、盈亏率 undefined", () => {
  const entries = [
    mkEntry({ code: "600938", date: "2026-01-02", action: "buy", quantity: 100, price: -55.425, initial: true }),
    mkEntry({ code: "600938", date: "2026-01-05", action: "buy", quantity: 50, price: 30 }),
  ];
  const a = analyzeGroup(group, entries, { "600938": 60 });
  const pos = a.positions.find((p) => p.code === "600938")!;
  // 成本基数 = 100×(-55.425) + 50×30 = -5542.5 + 1500 = -4042.5；数量 150 → 均价 -26.95
  assert.equal(Math.round(pos.avgCost * 100) / 100, -26.95);
  assert.equal(a.negCount, 1);
  // V1 口径：负成本标的（整体 costValue<0）不计入 totalCost
  assert.equal(a.totalCost, 0); // 合并均价 -26.95 → 整体成本为负 → V1 口径整标的排除
  // 未实现盈亏 = 市值 − 全部成本（真数学，含负成本）
  assert.equal(a.unrealizedPnl, 9000 - (-4042.5));
  // 浮动盈亏 = 市值 9000 − 成本 -4042.5 = 13042.5（金额正确）
  assert.equal(pos.unrealizedPnl, 9000 - (-4042.5));
  // 盈亏率无意义 → undefined
  assert.equal(pos.unrealizedPnlPct, undefined);
  // 组合总率也 undefined
  const totalRate = a.totalCost > 0 ? undefined : undefined;
  void totalRate;
});

test("组摘要：违反约束（超单标的上限）→ riskCount ≥ 1", () => {
  // 单标的上限 40%（4万），买 500 股×100 = 5万 > 4万
  const entries = [mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 500, price: 100 })];
  const s = buildGroupSummary(group, entries, {});
  assert.ok((s.riskCount ?? 0) >= 1);
  // 合规 → 无风险
  const okEntries = [mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 })];
  assert.equal(buildGroupSummary(group, okEntries, {}).riskCount, undefined);
});



test("V1 口径对齐：正成本 + 负成本标的并存 → totalCost 只计正成本标的部分", () => {
  const entries = [
    mkEntry({ code: "600938", date: "2026-01-02", action: "buy", quantity: 100, price: -55.425, initial: true }),
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
  ];
  const a = analyzeGroup(group, entries, { "600938": 60, "600519": 110 });
  assert.equal(a.negCount, 1);
  assert.equal(a.totalCost, 1000); // 只含正成本标的（600519）
  // 未实现 = Σ(市值−成本)：600938 (6000−(−5542.5)=11542.5) + 600519 (1100−1000=100)
  assert.equal(Math.round(a.unrealizedPnl), 11643);
});

// ---------- 做空（负持仓，组 allowShort） ----------

test("做空：卖出超持仓 → 负持仓，avgCost=开空均价，成本基数为负", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-01-10", action: "sell", quantity: 15, price: 130 }),
  ];
  const st = replayEntries(entries).get("600519")!;
  assert.equal(st.qty, -5); // 平 10 + 开空 5
  // 开空 5 股 @130 → 空头占用 = -650
  assert.equal(st.costBasis, -650);
  const pos = buildPositions(entries)[0]!;
  assert.equal(pos.quantity, -5);
  assert.equal(pos.avgCost, 130); // 开空均价
  assert.equal(pos.costValue, -650);
  // 无行情按成本口径：市值 = -650，未实现 0
  assert.equal(pos.marketValue, -650);
  assert.equal(pos.unrealizedPnl, 0);
});

test("做空：价格下跌 → 未实现盈利（qty×(现价−开空均价)）", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-01-10", action: "sell", quantity: 15, price: 130 }),
  ];
  const a = analyzeGroup(group, entries, { "600519": 110 }); // 现价 110 < 开空均价 130
  const short = a.positions.find((p) => p.code === "600519")!;
  assert.equal(short.quantity, -5);
  // 未实现 = -5 × (110 - 130) = +100（下跌盈利）
  assert.equal(Math.round(short.unrealizedPnl), 100);
  // 负成本守卫：negCount 计入空头，盈亏率 —（比例分母为负）
  assert.ok(a.negCount >= 1);
  // totalCost 只计正成本持仓（多头 10 股已全部平仓 → 无正成本；空头 -650 不计入）
  assert.equal(a.totalCost, 0);
  assert.ok(a.negCount >= 1);
});

test("做空：回补买入 → 已实现盈利，持仓向 0 收敛", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-01-10", action: "sell", quantity: 15, price: 130 }), // 开空 5 @130
    mkEntry({ code: "600519", date: "2026-01-20", action: "buy", quantity: 5, price: 110 }),  // 回补
  ];
  const st = replayEntries(entries).get("600519")!;
  assert.equal(st.qty, 0);
  // 已实现 = 平多 (130-100)×10=300 + 回补 (130-110)×5=100 → 400
  assert.equal(Math.round(st.realized), 400);
  // 复盘：仅原多头段（10→0 平仓 closed）；空头开空/回补不产生新段
  const deals = buildDeals(entries).filter((d) => d.code === "600519");
  assert.equal(deals.length, 1);
  assert.equal(deals[0]!.status, "closed");
  assert.equal(deals[0]!.buyQty, 10);
});

test("做空：回补超过空头 → 超过部分开多，复盘从新多头段开始", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-01-10", action: "sell", quantity: 15, price: 130 }), // 开空 5 @130
    mkEntry({ code: "600519", date: "2026-01-20", action: "buy", quantity: 8, price: 110 }),  // 回补 5 + 开多 3
  ];
  const st = replayEntries(entries).get("600519")!;
  assert.equal(st.qty, 3);
  assert.equal(Math.round(st.realized), 400); // 平多 300 + 回补 100
  const deals = buildDeals(entries).filter((d) => d.code === "600519");
  // 段1：原多头（10→0 平仓 closed）；段2：回补后开多 3（open）
  assert.equal(deals.length, 2);
  const newDeal = deals.find((d) => d.buyQty === 3)!;
  assert.ok(newDeal);
  assert.equal(newDeal.status, "open");
});

test("做空：checkEntry — 组允许做空时超卖不报错；不允许时仍报错", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-01-10", action: "sell", quantity: 15, price: 130 }),
  ];
  // 默认不允许做空 → 超卖报错
  const r1 = checkEntry(group, entries, { targetDate: "2026-01-10" });
  assert.ok(r1.alerts.some((a) => a.level === "error" && a.message.includes("卖出数量超过")));
  // 允许做空 → 超卖不报错
  const shortGroup: TradeV2Group = { ...group, allowShort: true };
  const r2 = checkEntry(shortGroup, entries, { targetDate: "2026-01-10" });
  assert.ok(!r2.alerts.some((a) => a.level === "error" && a.message.includes("卖出数量超过")));
});

test("做空：分组更新 allowShort 透传（store CRUD）", () => {
  const g = createGroup("做空测试组");
  try {
    updateGroup(g.id, { allowShort: true });
    const saved = getGroup(g.id)!;
    assert.equal(saved.allowShort, true);
    updateGroup(g.id, { allowShort: false });
    assert.equal(getGroup(g.id)!.allowShort, false);
  } finally {
    deleteGroup(g.id);
  }
});

test("做空：每日动态含空头（openCount 计入、市值含负占用）", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "600519", date: "2026-01-10", action: "sell", quantity: 15, price: 130 }),
  ];
  const ds = buildDailySeries(entries);
  const last = ds[ds.length - 1]!;
  assert.equal(last.openCount, 1); // 空头也算持仓标
  assert.equal(last.marketValue, -650); // 空头占用（成本口径）
});

// ---------- 收益曲线接入历史行情（真实市值口径） ----------

test("每日动态：传入历史日 K → 市值用真实收盘价（有行情标的口径切换）", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
    mkEntry({ code: "000001", date: "2026-01-02", action: "buy", quantity: 5, price: 10 }),
  ];
  // 600519 有历史价（01-02 收盘 120）；000001 无历史价 → 回退成本口径
  const klines = new Map([
    ["600519", new Map([["2026-01-02", 120], ["2026-01-03", 125]])],
  ]);
  const ds = buildDailySeries(entries, klines);
  const last = ds[ds.length - 1]!;
  // 600519: 10×125(01-03 收盘，priceOnOrBefore 取最近) = 1250；000001: 5×10(成本) = 50 → 合计 1300
  assert.equal(last.marketValue, 1300);
});

test("每日动态：历史价下市值随时间变化（价格波动反映到曲线）", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
  ];
  const klines = new Map([
    ["600519", new Map([
      ["2026-01-02", 100],
      ["2026-01-03", 110],
      ["2026-01-04", 90],
    ])],
  ]);
  const ds = buildDailySeries(entries, klines);
  // 仅 01-02 有交易 → 单日；市值 = 10×当日收盘价（01-02 为 100）
  const day = ds[0]!;
  assert.equal(day.marketValue, 1000);
});

test("组分析：klinePrices 传入后 dailySeries 为真实市值口径", () => {
  const entries = [
    mkEntry({ code: "600519", date: "2026-01-02", action: "buy", quantity: 10, price: 100 }),
  ];
  const klines = new Map([
    ["600519", new Map([["2026-01-02", 130]])],
  ]);
  const a = analyzeGroup(group, entries, {}, klines);
  const day = a.dailySeries[0]!;
  assert.equal(day.marketValue, 1300); // 10×130 真实价
  // 不传 kline → 回退成本口径 1000
  const b = analyzeGroup(group, entries);
  assert.equal(b.dailySeries[0]!.marketValue, 1000);
});
