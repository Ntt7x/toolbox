// ============================================================
// 仓位管理 v2：纯计算（features/tradeV2/compute.ts）
// 单一数据源：仓位明细/交易复盘/汇总 全部由 TradeV2Entry[] 按
//   （date, createdAt）升序重放派生——加权平均成本法，手续费摊入成本/回款。
// 改/删任一笔交易 → 全部派生结果自动重算（无 v1 基线/重放一致性问题）。
// 校验规则见 checkEntry（服务端权威，路由层 400 拒绝 + rejectReason）。
// ============================================================
import type {
  TradeV2Alert,
  TradeV2CheckResult,
  TradeV2DailyPoint,
  TradeV2DayOrderSummary,
  TradeV2Deal,
  TradeV2Entry,
  TradeV2GlobalAnalysis,
  TradeV2Group,
  TradeV2GroupAnalysis,
  TradeV2GroupSummary,
  TradeV2MonthlyPoint,
  TradeV2OrderNet,
  TradeV2PnlAttribution,
  TradeV2Position,
} from "@toolbox/shared";

/** 交易单条目 = shared TradeV2EntryDraft（下单输入，服务端内部用） */
export type TradeV2OrderItem = import("@toolbox/shared").TradeV2EntryDraft;

/** 重放状态（单标的） */
export interface ReplayState {
  qty: number;
  /** 含手续费的成本基数 */
  costBasis: number;
  /** 累计已实现盈亏（卖出 − 摊余成本 − 卖出手续费） */
  realized: number;
}

/** 组内交易按（date, createdAt）升序排序（同日期按录入先后） */
export function sortEntries(entries: TradeV2Entry[]): TradeV2Entry[] {
  return [...entries].sort((a, b) =>
    a.date === b.date ? a.createdAt.localeCompare(b.createdAt) : a.date < b.date ? -1 : 1,
  );
}

/** 重放一组交易 → 逐标的持仓状态。
 * 多头（qty>0）：加权平均成本；卖出结算已实现盈亏。
 * 空头（qty<0，组 allowShort 下卖出超持仓）：成本基数为负（= 空头占用），
 *   未实现盈亏 = qty×(现价 − avgCost)，价格下跌为正盈利；买入回补向 0 收敛。 */
/** 应用一笔交易到单标的持仓状态（做空感知；供 replayEntries / buildDailySeries 复用） */
export function applyEntry(st: ReplayState, e: TradeV2Entry): void {
  const fee = typeof e.fee === "number" && e.fee > 0 ? e.fee : 0;
  const q = e.quantity;
  if (e.action === "buy") {
    if (st.qty >= 0) {
      // 开多 / 加仓
      st.qty += q;
      st.costBasis += q * e.price + fee;
    } else {
      // 空头回补：先按开空均价结算，再向 0 收敛
      const cover = Math.min(q, -st.qty);
      const shortAvg = st.costBasis / st.qty; // 负/负 = 开空均价（正）
      st.realized += (shortAvg - e.price) * cover - fee;
      st.costBasis -= shortAvg * cover; // costBasis 向 0（st.costBasis 为负，减去正 = 更接近 0）
      st.qty += cover;
      const rest = q - cover;
      if (rest > 0) {
        st.qty += rest;
        st.costBasis += rest * e.price;
      }
    }
  } else {
    if (st.qty > 0) {
      // 平多 / 卖出：先按多头摊余成本结算
      const avg = st.costBasis / st.qty;
      const sellQty = Math.min(q, st.qty);
      st.realized += (e.price - avg) * sellQty - fee;
      st.costBasis -= avg * sellQty;
      st.qty -= sellQty;
      const rest = q - sellQty;
      if (rest > 0) {
        // 超卖 → 开空（组 allowShort）
        st.qty -= rest;
        st.costBasis -= rest * e.price; // 空头占用 = 卖出金额（负）
      }
    } else {
      // 空头加仓 / 直接开空
      st.qty -= q;
      st.costBasis -= q * e.price;
      st.realized -= fee; // 卖出费用计入已实现
    }
  }
}

export function replayEntries(entries: TradeV2Entry[]): Map<string, ReplayState> {
  const out = new Map<string, ReplayState>();
  for (const e of sortEntries(entries)) {
    const st = out.get(e.code) ?? { qty: 0, costBasis: 0, realized: 0 };
    applyEntry(st, e);
    out.set(e.code, st);
  }
  return out;
}

/** 重放是否出现「卖出超持仓」（数据异常检测；返回首个违规条目）。
 * 注意：组 allowShort=true 时超卖=做空属合法，调用方（checkEntry）须按组配置决定是否报告。 */
export function findOverSell(entries: TradeV2Entry[]): { code: string; date: string; detail: string } | null {
  const qtyMap = new Map<string, number>();
  for (const e of sortEntries(entries)) {
    const cur = qtyMap.get(e.code) ?? 0;
    if (e.action === "buy") {
      qtyMap.set(e.code, cur + e.quantity);
    } else {
      if (e.quantity > cur) {
        return { code: e.code, date: e.date, detail: `${e.date} ${e.code} 卖出 ${e.quantity} 股，但当前持仓仅 ${cur} 股` };
      }
      qtyMap.set(e.code, cur - e.quantity);
    }
  }
  return null;
}

/** 账本内 code → 名称映射（首个带名称的条目） */
export function nameOfEntries(entries: TradeV2Entry[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of sortEntries(entries)) {
    if (e.name && !m.has(e.code)) m.set(e.code, e.name);
  }
  return m;
}

/** 仓位明细（存量；基础派生，行情/占比由 analyzeGroup 补全；名称取自账本）。
 * 空头（quantity<0，组 allowShort）：avgCost = 开空均价（正），costValue/marketValue 为负。 */
export function buildPositions(entries: TradeV2Entry[]): TradeV2Position[] {
  const states = replayEntries(entries);
  const nameOf = nameOfEntries(entries);
  const out: TradeV2Position[] = [];
  for (const [code, st] of states) {
    if (st.qty === 0) continue;
    const avgCost = st.qty !== 0 ? st.costBasis / st.qty : 0;
    // 成本均价（摊薄口径，2026-08-17）：把已实现盈亏摊入剩余持仓
    // = (总成本基数 − 已实现盈亏) / 数量 ≡ (累计买入含费 − 累计卖出回款含费) / 剩余数量
    // 与「买入均价 avgCost」区分：卖出盈利后成本均价下降（接近券商「摊薄成本」显示）
    const costAvg = st.qty !== 0 ? (st.costBasis - st.realized) / st.qty : 0;
    out.push({
      code,
      ...(nameOf.has(code) ? { name: nameOf.get(code) } : {}),
      quantity: st.qty,
      avgCost,
      costAvg,
      costValue: st.qty * avgCost,
      marketValue: st.qty * avgCost,
      unrealizedPnl: 0,
      realizedPnl: st.realized,
    });
  }
  // 多空混合时按占用绝对值排序（空头也算占用）
  return out.sort((a, b) => Math.abs(b.costValue) - Math.abs(a.costValue));
}

/**
 * 交易复盘：逐 code 按「买入→清仓」配对成完整交易段（仅覆盖多头）。
 * 段 = 从零持仓建仓（qty 0→>0）到数量归零（>0→0）；在途 = 当前仍持有。
 * 做空（组 allowShort）：开空/加空不建段；回补买入向 0 收敛，超过部分才开多建段。
 * 盈亏按平均成本法归因到段内：closed pnl = sellAmount − buyAmount − feeTotal。
 */
export function buildDeals(entries: TradeV2Entry[]): TradeV2Deal[] {
  const byCode = new Map<string, TradeV2Entry[]>();
  for (const e of sortEntries(entries)) {
    const arr = byCode.get(e.code) ?? [];
    arr.push(e);
    byCode.set(e.code, arr);
  }
  const deals: TradeV2Deal[] = [];
  const nameOf = nameOfEntries(entries);
  for (const [code, list] of byCode) {
    let deal: TradeV2Deal | null = null;
    const pushDeal = (d: TradeV2Deal) => {
      if (d.buyQty <= 0) return; // 只有卖出无买入的异常段忽略
      deals.push(d);
    };
    let position = 0; // 当前持仓（含空头；做空感知，避免回补买入误建多头段）
    for (const e of list) {
      const fee = typeof e.fee === "number" && e.fee > 0 ? e.fee : 0;
      const newDeal = () => ({
        code,
        ...(nameOf.has(code) ? { name: nameOf.get(code) } : {}),
        status: "open" as const,
        entryDate: e.date,
        buyQty: 0,
        buyAmount: 0,
        sellAmount: 0,
        feeTotal: 0,
        qty: 0,
        avgCost: 0,
      });
      if (e.action === "buy") {
        if (position < 0) {
          // 空头回补：先向 0 收敛，超过部分才开多建段
          const cover = Math.min(e.quantity, -position);
          position += cover;
          const rest = e.quantity - cover;
          if (rest > 0) {
            if (!deal) deal = newDeal();
            deal.buyQty += rest;
            deal.buyAmount += rest * e.price;
            deal.feeTotal += fee;
            deal.qty += rest;
            position += rest;
          }
        } else {
          if (!deal) deal = newDeal();
          deal.buyQty += e.quantity;
          deal.buyAmount += e.quantity * e.price;
          deal.feeTotal += fee;
          deal.qty += e.quantity;
          position += e.quantity;
        }
      } else {
        if (position <= 0) {
          // 空头加仓 / 直接开空：不产生多头复盘段
          position -= e.quantity;
          continue;
        }
        if (!deal) continue; // 无持仓的卖出（异常数据）忽略
        const sellQty = Math.min(e.quantity, deal.qty);
        deal.sellAmount += sellQty * e.price;
        deal.feeTotal += fee;
        deal.qty -= sellQty;
        position -= sellQty;
        if (deal.qty <= 0) {
          deal.status = "closed";
          deal.exitDate = e.date;
          deal.days = dayDiff(deal.entryDate, deal.exitDate);
          deal.pnl = deal.sellAmount - deal.buyAmount - deal.feeTotal;
          pushDeal(deal);
          deal = null;
        }
        if (e.quantity > sellQty) position -= e.quantity - sellQty; // 超卖 → 空头
      }
    }
    if (deal) {
      deal.days = dayDiff(deal.entryDate, todayStr());
      deal.avgCost = deal.buyQty > 0 ? deal.buyAmount / deal.buyQty : 0;
      pushDeal(deal);
    }
  }
  return deals;
}

function dayDiff(from: string, to: string): number {
  const a = new Date(from + "T00:00:00").getTime();
  const b = new Date(to + "T00:00:00").getTime();
  return Math.max(0, Math.round((b - a) / 86400000));
}

export function todayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

/**
 * 组分析：仓位明细（附行情/占比）+ 复盘 + 汇总。
 * @param latestPrices 最新价映射（行情缓存可得时传入；缺省按成本口径估算）
 */
import { computeMetrics } from "./metrics.js";

export function analyzeGroup(
  group: TradeV2Group,
  entries: TradeV2Entry[],
  latestPrices: Record<string, number> = {},
  klinePrices?: Map<string, Map<string, number>>,
): TradeV2GroupAnalysis {
  const positions = buildPositions(entries);
  const deals = buildDeals(entries);
  let totalCost = 0;   // 展示口径：正成本之和（V1 对齐——负成本已回本不计入占用成本）
  let trueCost = 0;    // 真数学口径：全部成本之和（供未实现盈亏金额）
  let totalMv = 0;
  let realizedPnl = 0;
  let invested = 0;
  let todayAdd = 0;
  const today = todayStr();
  // 买卖量统计（memo mt72jjg7）
  let buyQty = 0; let sellQty = 0;
  for (const e of entries) {
    const q = Math.abs(e.quantity);
    if (e.action === "buy") buyQty += q; else sellQty += q;
  }

  // 已实现盈亏：从重放状态累计（含已清仓标的——positions 只含 qty>0，会漏掉清仓标的历史已实现）
  const states = replayEntries(entries);
  for (const st of states.values()) realizedPnl += st.realized;

  const weighted = positions.map((p) => {
    const latest = latestPrices[p.code];
    const px = typeof latest === "number" && latest > 0 ? latest : p.avgCost;
    const mv = p.quantity * px;
    const unreal = mv - p.costValue;
    trueCost += p.costValue;
    if (p.costValue > 0) totalCost += p.costValue;
    totalMv += mv;
    return {
      ...p,
      ...(typeof latest === "number" && latest > 0 ? { latestPrice: latest } : {}),
      marketValue: mv,
      unrealizedPnl: unreal,
      // 负成本：盈亏率无意义（比例分母为负）；仅正成本显示 %（V1 惯例）
      ...(p.costValue > 0 ? { unrealizedPnlPct: (unreal / p.costValue) * 100 } : {}),
      ...(group.totalCapital > 0 ? { weightPct: Math.round((mv / group.totalCapital) * 1000) / 10 } : {}),
    };
  });

  for (const e of entries) {
    const fee = typeof e.fee === "number" && e.fee > 0 ? e.fee : 0;
    const amount = e.quantity * e.price;
    if (e.action === "buy") {
      invested += amount + fee;
      if (!e.initial && e.date === today) todayAdd += amount + fee;
    } else {
      invested -= amount - fee;
    }
  }

  const closed = deals.filter((d) => d.status === "closed");
  const winCount = closed.filter((d) => (d.pnl ?? 0) > 0).length;
  const avgDays =
    closed.length > 0 ? closed.reduce((a, d) => a + (d.days ?? 0), 0) / closed.length : undefined;
  // 负成本（已回本/做空记账）标的数——存在时组合盈亏率无意义（比例分母为负/零）
  const negCount = weighted.filter((p) => p.costValue < 0).length;

  return {
    groupId: group.id,
    name: group.name,
    totalCapital: group.totalCapital,
    dailyAddLimit: group.dailyAddLimit,
    positions: weighted,
    deals,
    totalCost,
    totalMv,
    unrealizedPnl: totalMv - trueCost,
    realizedPnl,
    totalPnl: realizedPnl + (totalMv - totalCost),
    invested,
    ...(group.totalCapital > 0 ? { positionPct: Math.round((totalMv / group.totalCapital) * 1000) / 10 } : {}),
    remaining: group.totalCapital - totalMv,
    todayAdd,
    buyQty,
    sellQty,
    openCount: positions.length,
    negCount,
    closedCount: closed.length,
    ...(closed.length > 0 ? { winRate: Math.round((winCount / closed.length) * 1000) / 10 } : {}),
    ...(avgDays !== undefined ? { avgDays: Math.round(avgDays * 10) / 10 } : {}),
    // 收益·时间性 / 空间（由账本派生；传入历史日 K 时为真实市值口径，否则成本口径）
    dailySeries: buildDailySeries(entries, klinePrices),
    monthlySeries: buildMonthlySeries(entries),
    pnlAttribution: buildPnlAttribution(entries, latestPrices),
    metrics: computeMetrics(buildDailySeries(entries, klinePrices), deals),
  };
}

// ============================================================
// 收益时间性/空间/每日动态（纯派生）
// ============================================================

/**
 * 每日动态：逐日 买入金额/卖出回款/当日已实现/收盘持仓市值/持仓标数。
 * 市值口径：传入 klinePrices（历史日 K）时用「当日真实收盘价 × 持仓数」= 市值口径；
 *   无历史价标的回退成本口径（Σ qty×avgCost 含费基数）——向后兼容。
 */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n); // 本地日期运算（避免 toISOString 的 UTC 偏移导致死循环）
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

export function buildDailySeries(
  entries: TradeV2Entry[],
  klinePrices?: Map<string, Map<string, number>>,
): TradeV2DailyPoint[] {
  const sorted = sortEntries(entries);
  if (sorted.length === 0) return [];
  interface DailyRow {
    date: string;
    buyAmount: number;
    sellAmount: number;
    buyQty: number;
    sellQty: number;
    cumRealized: number;
    marketValue: number;
    openCount: number;
  }
  const state = new Map<string, ReplayState>();
  const rows: DailyRow[] = [];
  // 收盘口径重算（市值/持仓数/累计已实现）——每日行复用；市值=持仓×当日收盘（无行情回退成本基数）
  const calcRow = (date: string): Pick<DailyRow, "cumRealized" | "marketValue" | "openCount"> => {
    let mv = 0;
    let oc = 0;
    let cum = 0;
    for (const [code, st] of state) {
      if (st.qty !== 0) {
        const hist = klinePrices?.get(code);
        const px = hist && hist.size > 0 ? priceOnOrBefore(hist, date) : undefined;
        mv += typeof px === "number" && px > 0 ? st.qty * px : st.costBasis;
        oc++;
      }
      cum += st.realized;
    }
    return { cumRealized: cum, marketValue: mv, openCount: oc };
  };
  // 补一个"无交易延续行"：持仓延续、买卖 0、市值按当日行情重估（净值曲线按日延伸的核心）
  const pushCarryRow = (date: string) => {
    const prev = rows[rows.length - 1] ?? null;
    rows.push({
      date,
      buyAmount: 0,
      sellAmount: 0,
      buyQty: 0,
      sellQty: 0,
      cumRealized: prev?.cumRealized ?? 0,
      marketValue: prev?.marketValue ?? 0,
      openCount: prev?.openCount ?? 0,
    });
    const c = calcRow(date);
    const r = rows[rows.length - 1]!;
    r.cumRealized = c.cumRealized;
    r.marketValue = c.marketValue;
    r.openCount = c.openCount;
  };
  for (const e of sorted) {
    // 展开：补 上一行日期+1 .. e.date-1 的自然日（无交易日期延续，市值按当日行情重估）
    if (rows.length > 0) {
      let d = addDays(rows[rows.length - 1]!.date, 1);
      while (d < e.date) { pushCarryRow(d); d = addDays(d, 1); }
    }
    const isNewDay = rows.length === 0 || rows[rows.length - 1]!.date !== e.date;
    if (isNewDay) {
      const prev = rows.length > 0 ? rows[rows.length - 1]! : null;
      rows.push({
        date: e.date,
        buyAmount: 0,
        sellAmount: 0,
        buyQty: 0,
        sellQty: 0,
        cumRealized: prev?.cumRealized ?? 0,
        marketValue: prev?.marketValue ?? 0,
        openCount: prev?.openCount ?? 0,
      });
    }
    const row = rows[rows.length - 1]!;
    const st = state.get(e.code) ?? { qty: 0, costBasis: 0, realized: 0 };
    const fee = typeof e.fee === "number" && e.fee > 0 ? e.fee : 0;
    const amount = e.quantity * e.price;
    // 做空感知重放（与 replayEntries 同一数学）；卖出超持仓=开空（组 allowShort 才合法）
    applyEntry(st, e);
    if (e.action === "buy") { row.buyAmount += amount + fee; row.buyQty += e.quantity; }
    else { row.sellAmount += amount - fee; row.sellQty += Math.abs(e.quantity); }
    state.set(e.code, st);
    // 该日收盘口径重算
    const c = calcRow(e.date);
    row.cumRealized = c.cumRealized;
    row.marketValue = c.marketValue;
    row.openCount = c.openCount;
  }
  // 末尾展开：最后交易日之后到今天（自然日；净值曲线持续到"今天"）
  if (rows.length > 0) {
    const today = todayStr();
    let d = addDays(rows[rows.length - 1]!.date, 1);
    while (d <= today) { pushCarryRow(d); d = addDays(d, 1); }
  }
  // 累计已实现 → 每日增量（realizedPnl）
  let prevCum = 0;
  return rows.map((r) => {
    const realizedPnl = Math.round((r.cumRealized - prevCum) * 100) / 100;
    prevCum = r.cumRealized;
    return {
      date: r.date,
      buyAmount: Math.round(r.buyAmount * 100) / 100,
      sellAmount: Math.round(r.sellAmount * 100) / 100,
      buyQty: r.buyQty,
      sellQty: r.sellQty,
      realizedPnl,
      marketValue: Math.round(r.marketValue * 100) / 100,
      openCount: r.openCount,
    };
  });
}

/** 取某标的历史日 K 中 <= 目标日期最近收盘价（无则 undefined）；供 buildDailySeries 用 */
function priceOnOrBefore(hist: Map<string, number>, date: string): number | undefined {
  const direct = hist.get(date);
  if (direct !== undefined) return direct;
  let best: number | undefined;
  let bestDate = "";
  for (const [d, close] of hist) {
    if (d <= date && d > bestDate) {
      bestDate = d;
      best = close;
    }
  }
  return best;
}

/** 月度汇总（由每日动态聚合；月末市值 = 该月最后交易日的收盘市值）。
 * 月收益率（成本口径）：月PnL = 当月已实现 + (月末市值 − 月初市值 − 当月净流入)；
 * 收益率 = 月PnL / 月初市值（首月无月初市值缺省）。 */
export function buildMonthlySeries(entries: TradeV2Entry[]): TradeV2MonthlyPoint[] {
  const byMonth = new Map<string, TradeV2MonthlyPoint>();
  for (const d of buildDailySeries(entries)) {
    const m = d.date.slice(0, 7);
    let row = byMonth.get(m);
    if (!row) {
      row = { month: m, buyAmount: 0, sellAmount: 0, realizedPnl: 0, marketValue: 0 };
      byMonth.set(m, row);
    }
    row.buyAmount = Math.round((row.buyAmount + d.buyAmount) * 100) / 100;
    row.sellAmount = Math.round((row.sellAmount + d.sellAmount) * 100) / 100;
    row.realizedPnl = Math.round((row.realizedPnl + d.realizedPnl) * 100) / 100;
    row.marketValue = d.marketValue;
  }
  const months = [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
  let prevMv = 0;
  for (const m of months) {
    const flow = m.buyAmount - m.sellAmount;
    const pnl = m.realizedPnl + (m.marketValue - prevMv - flow);
    if (prevMv > 0) m.pnlPct = Math.round((pnl / prevMv) * 1000) / 10;
    prevMv = m.marketValue;
  }
  return months;
}

/** 收益归因（按标的：已实现 + 未实现 贡献，含已清仓标的的已实现） */
export function buildPnlAttribution(entries: TradeV2Entry[], latestPrices: Record<string, number> = {}): TradeV2PnlAttribution[] {
  const states = replayEntries(entries);
  const positions = buildPositions(entries);
  const nameOf = nameOfEntries(entries);
  const byCode = new Map<string, { realized: number; unrealized: number }>();
  for (const [code, st] of states) {
    byCode.set(code, { realized: st.realized, unrealized: 0 });
  }
  for (const p of positions) {
    const latest = latestPrices[p.code];
    const px = typeof latest === "number" && latest > 0 ? latest : p.avgCost;
    const entry = byCode.get(p.code) ?? { realized: 0, unrealized: 0 };
    entry.unrealized = p.quantity * px - p.costValue;
    byCode.set(p.code, entry);
  }
  const abs = [...byCode.values()].reduce((a, v) => a + Math.abs(v.realized + v.unrealized), 0);
  return [...byCode.entries()]
    .map(([code, v]) => ({
      code,
      ...(nameOf.has(code) ? { name: nameOf.get(code) } : {}),
      realizedPnl: Math.round(v.realized * 100) / 100,
      unrealizedPnl: Math.round(v.unrealized * 100) / 100,
      totalPnl: Math.round((v.realized + v.unrealized) * 100) / 100,
      ...(abs > 0 ? { sharePct: Math.round((Math.abs(v.realized + v.unrealized) / abs) * 1000) / 10 } : {}),
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

/**
 * 交易单当日归并汇总（服务端权威）：
 * 在「当日之前的仓位」基础上逐笔应用订单行，计算当日买入合计/卖出回款/已实现盈亏，
 * 并按标的归并净效果（净买/净卖/持平）。
 */
export function summarizeOrder(priorEntries: TradeV2Entry[], items: TradeV2OrderItem[]): TradeV2DayOrderSummary {
  const state = replayEntries(priorEntries);
  const byCode = new Map<string, { name?: string; netQty: number; netAmount: number }>();
  let buyTotal = 0;
  let sellTotal = 0;
  let realized = 0;
  for (const it of items) {
    const st = state.get(it.code) ?? { qty: 0, costBasis: 0, realized: 0 };
    const fee = typeof it.fee === "number" && it.fee > 0 ? it.fee : 0;
    const amount = it.quantity * it.price;
    if (it.action === "buy") {
      st.qty += it.quantity;
      st.costBasis += amount + fee;
      buyTotal += amount + fee;
    } else {
      const avg = st.qty > 0 ? st.costBasis / st.qty : it.price;
      const sellQty = Math.min(it.quantity, st.qty);
      realized += (it.price - avg) * sellQty - fee;
      st.costBasis -= avg * sellQty;
      st.qty -= sellQty;
      sellTotal += amount - fee;
    }
    state.set(it.code, st);
    const net = byCode.get(it.code) ?? { name: it.name, netQty: 0, netAmount: 0 };
    net.netQty += it.action === "buy" ? it.quantity : -it.quantity;
    net.netAmount += it.action === "buy" ? amount + fee : -(amount - fee);
    byCode.set(it.code, net);
  }
  const netPerCode: TradeV2OrderNet[] = [...byCode.entries()].map(([code, n]) => ({
    code,
    ...(n.name ? { name: n.name } : {}),
    netQty: n.netQty,
    action: n.netQty > 0 ? "buy" : n.netQty < 0 ? "sell" : "flat",
    netAmount: Math.round(n.netAmount * 100) / 100,
  }));
  return {
    buyTotal: Math.round(buyTotal * 100) / 100,
    sellTotal: Math.round(sellTotal * 100) / 100,
    realizedPnl: Math.round(realized * 100) / 100,
    netPerCode,
  };
}

/**
 * 组约束权威校验（保存/编辑/删除交易前调用；allEntries 须含目标条目的最终形态）。
 * 规则（error 阻断保存，info 提示现状）：
 *  1. 卖出超持仓 → error
 *  2. 单日加仓合计 > dailyAddLimit（>0 时）→ error
 *  3. 单标的上限：市值估算（最新价 ?? 均价）占总仓位 > maxWeightPct → error
 *  4. 总市值 > totalCapital（>0 时）→ error
 */
export function checkEntry(
  group: TradeV2Group,
  allEntries: TradeV2Entry[],
  opts: { targetDate?: string; latestPrices?: Record<string, number> } = {},
): TradeV2CheckResult {
  const alerts: TradeV2Alert[] = [];
  const latestPrices = opts.latestPrices ?? {};

  // 1. 卖出超持仓（组 allowShort=false 时视为异常；允许做空的组超卖=开空，跳过）
  if (!group.allowShort) {
    const over = findOverSell(allEntries);
    if (over) {
      alerts.push({ level: "error", message: "卖出数量超过当前持仓", code: over.code, detail: over.detail });
    }
  }

  // 2. 单日加仓上限（按目标条目所在日；期初建仓不计入）
  const targetDate = opts.targetDate ?? todayStr();
  if (group.dailyAddLimit > 0) {
    const dayAdds = allEntries
      .filter((e) => e.date === targetDate && e.action === "buy" && !e.initial)
      .reduce((a, e) => a + e.quantity * e.price + (typeof e.fee === "number" && e.fee > 0 ? e.fee : 0), 0);
    if (dayAdds > group.dailyAddLimit) {
      alerts.push({
        level: "error",
        message: "超过单日加仓上限",
        detail: `${targetDate} 加仓合计 ¥${Math.round(dayAdds).toLocaleString()}，上限 ¥${Math.round(group.dailyAddLimit).toLocaleString()}，超出 ¥${Math.round(dayAdds - group.dailyAddLimit).toLocaleString()}`,
      });
    }
  }

  // 3+4. 仓位限制（重放后的最终形态；期初建仓同样计入持仓）
  const positions = buildPositions(allEntries);
  const limitByCode = new Map(group.stockLimits.map((s) => [s.code, s.maxWeightPct]));
  let totalMvEst = 0;
  for (const p of positions) {
    const latest = latestPrices[p.code];
    // 负成本标的无行情时按 0 计市值（成本口径为负会虚低）；有行情用最新价
    const px = typeof latest === "number" && latest > 0 ? latest : p.avgCost > 0 ? p.avgCost : 0;
    totalMvEst += p.quantity * px;
  }
  if (group.totalCapital > 0 && totalMvEst > group.totalCapital) {
    alerts.push({
      level: "error",
      message: "超过总仓位上限",
      detail: `持仓市值 ¥${Math.round(totalMvEst).toLocaleString()} > 总仓位 ¥${Math.round(group.totalCapital).toLocaleString()}，超出 ¥${Math.round(totalMvEst - group.totalCapital).toLocaleString()}`,
    });
  }
  for (const p of positions) {
    const maxW = limitByCode.get(p.code);
    if (maxW === undefined || group.totalCapital <= 0) continue;
    const latest = latestPrices[p.code];
    const px = typeof latest === "number" && latest > 0 ? latest : p.avgCost > 0 ? p.avgCost : 0;
    const mv = p.quantity * px;
    const weight = (mv / group.totalCapital) * 100;
    if (weight > maxW) {
      alerts.push({
        level: "error",
        message: `${p.name ? p.name + " " : ""}${p.code} 超过单标的上限`,
        code: p.code,
        detail: `市值 ¥${Math.round(mv).toLocaleString()} 占 ${weight.toFixed(1)}%，上限 ${maxW}%`,
      });
    }
  }

  // 5. 提示信息（当日加仓现状 / 仓位占比现状）
  if (group.dailyAddLimit > 0) {
    const dayAdds = allEntries
      .filter((e) => e.date === targetDate && e.action === "buy" && !e.initial)
      .reduce((a, e) => a + e.quantity * e.price + (typeof e.fee === "number" && e.fee > 0 ? e.fee : 0), 0);
    if (dayAdds > 0 && dayAdds <= group.dailyAddLimit) {
      alerts.push({
        level: "info",
        message: `当日加仓 ¥${Math.round(dayAdds).toLocaleString()}，剩余额度 ¥${Math.round(group.dailyAddLimit - dayAdds).toLocaleString()}`,
      });
    }
  }
  if (group.totalCapital > 0) {
    const pct = (totalMvEst / group.totalCapital) * 100;
    alerts.push({ level: "info", message: `该组仓位占比 ${pct.toFixed(1)}%（${positions.length} 只标的）` });
  }

  // 去重 + error 优先排序（稳定输出）
  const unique: TradeV2Alert[] = [];
  const seen = new Set<string>();
  for (const a of alerts) {
    const key = a.level + ":" + a.message;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(a);
  }
  unique.sort((a, b) => levelRank(a.level) - levelRank(b.level));
  return { ok: !unique.some((a) => a.level === "error"), alerts: unique };
}

function levelRank(l: TradeV2Alert["level"]): number {
  return l === "error" ? 0 : l === "warn" ? 1 : 2;
}

/** 组摘要（列表接口用；含行情口径盈亏汇总 + 约束风险计数 riskCount） */
export function buildGroupSummary(
  group: TradeV2Group,
  entries: TradeV2Entry[],
  latestPrices: Record<string, number> = {},
): TradeV2GroupSummary {
  const a = analyzeGroup(group, entries, latestPrices);
  // 风险计数：服务端权威校验当前状态的 error 级告警（超总仓位/超单标的上限/超日限/卖出超持仓）
  const riskCount = checkEntry(group, entries, { latestPrices }).alerts.filter((x) => x.level === "error").length;
  return {
    id: group.id,
    name: group.name,
    totalCapital: group.totalCapital,
    dailyAddLimit: group.dailyAddLimit,
    stockLimitCount: group.stockLimits.length,
    infoType: group.infoType,
    ...(group.isPaper ? { isPaper: true } : {}),
    entryCount: entries.length,
    openCount: a.openCount,
    totalMv: a.totalMv,
    unrealizedPnl: a.unrealizedPnl,
    realizedPnl: a.realizedPnl,
    totalPnl: a.totalPnl,
    ...(a.positionPct !== undefined ? { positionPct: a.positionPct } : {}),
    ...(riskCount > 0 ? { riskCount } : {}),
    updatedAt: group.updatedAt,
  };
}

/** 全局分析：跨组汇总 + 累计已实现盈亏时间线（closed 交易按清仓日累计） */
export function buildGlobalAnalysis(
  groups: { group: TradeV2Group; entries: TradeV2Entry[]; latestPrices: Record<string, number>; klines?: Map<string, Map<string, number>> }[],
): TradeV2GlobalAnalysis {
  const summaries: TradeV2GroupSummary[] = [];
  let totalMv = 0;
  let totalCost = 0;
  let unrealizedPnl = 0;
  let realizedPnl = 0;
  let invested = 0;
  let openCount = 0;
  let negCount = 0;
  let closedCount = 0;
  let winTotal = 0;
  let daysTotal = 0;
  const timeline: { date: string; amount: number }[] = [];
  /** 组合分析数据（跨组合聚合——memo mt52hjgp：全部组合复用一般组合的收益分析能力） */
  const allEntries: TradeV2Entry[] = [];
  const allLatest: Record<string, number> = {};
  const allDeals: TradeV2Deal[] = [];
  /** 跨组合按 code 合并持仓（成本摊薄口径，服务端权威——memo mt1zg3xk） */
  const posMap = new Map<string, TradeV2Position>();

  for (const { group, entries, latestPrices, klines } of groups) {
    const a = analyzeGroup(group, entries, latestPrices, klines);
    summaries.push(buildGroupSummary(group, entries, latestPrices));
    for (const p of a.positions) {
      const cur = posMap.get(p.code);
      if (!cur) { posMap.set(p.code, { ...p }); continue; }
      const q1 = cur.quantity, q2 = p.quantity;
      const tq = Math.abs(q1) + Math.abs(q2);
      const costVal = (cur.costValue ?? 0) + (p.costValue ?? 0);
      const realized = (cur.realizedPnl ?? 0) + (p.realizedPnl ?? 0);
      const unreal = (cur.unrealizedPnl ?? 0) + (p.unrealizedPnl ?? 0);
      posMap.set(p.code, {
        ...cur,
        name: cur.name ?? p.name,
        quantity: q1 + q2,
        avgCost: q1 + q2 !== 0 ? (cur.avgCost * q1 + p.avgCost * q2) / (q1 + q2) : 0,
        costValue: costVal,
        marketValue: (cur.marketValue ?? 0) + (p.marketValue ?? 0),
        realizedPnl: realized,
        unrealizedPnl: unreal,
        costAvg: tq > 0 ? (costVal - realized) / tq : undefined,
        unrealizedPnlPct: costVal > 0 ? (unreal / costVal) * 100 : undefined,
        latestPrice: cur.latestPrice ?? p.latestPrice,
        weightPct: undefined, // 前端按市值占比重算
      });
    }
    totalMv += a.totalMv;
    totalCost += a.totalCost;
    unrealizedPnl += a.unrealizedPnl;
    realizedPnl += a.realizedPnl;
    invested += a.invested;
    openCount += a.openCount;
    negCount += a.negCount;
    closedCount += a.closedCount;
    if (a.winRate !== undefined) {
      winTotal += Math.round((a.winRate / 100) * a.closedCount);
    }
    daysTotal += (a.avgDays ?? 0) * a.closedCount;
    allEntries.push(...entries);
    Object.assign(allLatest, latestPrices);
    allDeals.push(...a.deals);
    for (const d of a.deals) {
      if (d.status === "closed" && d.exitDate && d.pnl !== undefined) {
        timeline.push({ date: d.exitDate, amount: d.pnl });
      }
    }
  }

  timeline.sort((a, b) => (a.date < b.date ? -1 : 1));
  let cum = 0;
  const realizedTimeline = timeline.map((t) => {
    cum += t.amount;
    return { date: t.date, cumulative: Math.round(cum * 100) / 100 };
  });

  // 组合每日动态：跨组合按日合并（市值/买入/卖出/已实现/持仓数，成本口径）
  const dailyByDate = new Map<string, TradeV2DailyPoint>();
  for (const { entries, klines } of groups) {
    for (const d of buildDailySeries(entries, klines)) {
      const row = dailyByDate.get(d.date) ?? { date: d.date, buyAmount: 0, sellAmount: 0, buyQty: 0, sellQty: 0, realizedPnl: 0, marketValue: 0, openCount: 0 };
      row.buyAmount = Math.round((row.buyAmount + d.buyAmount) * 100) / 100;
      row.sellAmount = Math.round((row.sellAmount + d.sellAmount) * 100) / 100;
      row.buyQty += d.buyQty;
      row.sellQty += d.sellQty;
      row.realizedPnl = Math.round((row.realizedPnl + d.realizedPnl) * 100) / 100;
      row.marketValue = Math.round((row.marketValue + d.marketValue) * 100) / 100;
      row.openCount += d.openCount;
      dailyByDate.set(d.date, row);
    }
  }
  const dailySeries = [...dailyByDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    groups: summaries,
    positions: [...posMap.values()].sort((x, y) => Math.abs(y.costValue ?? 0) - Math.abs(x.costValue ?? 0)),
    totalMv,
    totalCost,
    unrealizedPnl,
    realizedPnl,
    totalPnl: realizedPnl + unrealizedPnl,
    invested,
    openCount,
    negCount,
    closedCount,
    // 组合分析（收益分析能力对齐一般分组——mt52hjgp）
    buyQty: dailySeries.reduce((t, d) => t + d.buyQty, 0),
    sellQty: dailySeries.reduce((t, d) => t + d.sellQty, 0),
    monthlySeries: buildMonthlySeries(allEntries),
    pnlAttribution: buildPnlAttribution(allEntries, allLatest),
    metrics: computeMetrics(dailySeries, allDeals),
    deals: allDeals,
    ...(closedCount > 0 ? { winRate: Math.round((winTotal / closedCount) * 1000) / 10 } : {}),
    ...(closedCount > 0 ? { avgDays: Math.round((daysTotal / closedCount) * 10) / 10 } : {}),
    realizedTimeline,
    dailySeries,
  };
}
