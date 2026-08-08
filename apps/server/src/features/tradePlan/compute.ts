// ============================================================
// 交易规划：校验计算（纯函数，无 LLM、无 IO）
// 校验日度交易计划是否符合策略配置与仓位控制：
//  1. 标的必须在策略标的列表内
//  2. 当日加仓合计 ≤ 单日加仓上限
//  3. 加仓后单标的市场值 ≤ 标的上限（maxWeightPct × 总仓位，若配置）
//  4. 加仓后总市值 ≤ 总仓位
//  5. 减仓金额 ≤ 该标的当前持仓市值
//  6. 同 code 同日多操作 → 合并为一个交易操作
// 当前仓位来自 strategy.positions（拆分自配置），应用计划后由 applyItems 自动更新。
// ============================================================
import {
  type TradePlanAlert,
  type TradePlanAfterPosition,
  type TradePlanCheckResult,
  type TradePlanItem,
  type TradePlanPosition,
} from "@toolbox/shared";

const CNY = (v: number) => `¥${Math.round(v).toLocaleString("zh-CN")}`;

export interface TradePlanCheckConfig {
  totalCapital: number;
  dailyAddLimit: number;
  /** 交易标的列表 */
  stocks: { code: string; name?: string; maxWeightPct?: number }[];
  /** 当前仓位（数量 × 成本价） */
  positions: TradePlanPosition[];
}

/** 某标的当前持仓市值（数量 × 成本价） */
function currentValue(config: TradePlanCheckConfig, code: string): number {
  const p = config.positions.find((x) => x.code === code);
  if (!p) return 0;
  return (p.quantity || 0) * (p.avgCost || 0);
}

/** 应用日度计划 → 更新后的仓位（纯函数；加仓重算均价，减仓只减数量成本不变） */
export function applyItems(positions: TradePlanPosition[], items: TradePlanItem[]): TradePlanPosition[] {
  const out = positions.map((p) => ({ ...p, quantity: p.quantity || 0, avgCost: p.avgCost || 0 }));
  const byCode = new Map(items.map((it) => [it.code, it]));
  for (const [code, it] of byCode) {
    const pos = out.find((p) => p.code === code);
    if (!pos) {
      if (it.action === "add" && it.amount > 0) {
        out.push({ code, quantity: 0, avgCost: 0 }); // 成本未知 → 数量无法换算，保持 0
      }
      continue;
    }
    if (it.action === "add" && pos.avgCost > 0) {
      const qty = pos.quantity + it.amount / pos.avgCost;
      pos.avgCost = (pos.quantity * pos.avgCost + it.amount) / qty;
      pos.quantity = Math.round(qty * 100) / 100;
    } else if (it.action === "add") {
      pos.quantity += it.amount; // 无成本（avgCost=0）时按金额累加数量，保持近似
    } else if (it.action === "reduce" && pos.avgCost > 0) {
      pos.quantity = Math.max(0, Math.round((pos.quantity - it.amount / pos.avgCost) * 100) / 100);
    } else if (it.action === "reduce") {
      pos.quantity = Math.max(0, pos.quantity - it.amount);
    }
  }
  return out;
}

export function checkTradePlan(config: TradePlanCheckConfig, items: TradePlanItem[]): TradePlanCheckResult {
  const alerts: TradePlanAlert[] = [];
  const totalCapital = config.totalCapital || 0;
  const dailyAddLimit = config.dailyAddLimit || 0;

  // 汇总每标的变动
  const byCode = new Map<string, { add: number; reduce: number; count: number }>();
  for (const it of items) {
    const acc = byCode.get(it.code) ?? { add: 0, reduce: 0, count: 0 };
    if (it.action === "add") acc.add += it.amount;
    else acc.reduce += it.amount;
    acc.count += 1;
    byCode.set(it.code, acc);
  }

  // 6. 一个标的一天只能一个操作（重复 code 报错）
  for (const [code, acc] of byCode) {
    if (acc.count > 1) {
      const stock = config.stocks.find((s) => s.code === code);
      alerts.push({
        level: "error",
        code,
        message: `标的 ${stock?.name || code} 在日度计划中出现 ${acc.count} 次，请合并为一个交易操作`,
        detail: "同一标的一天只能完成一个加仓或减仓操作",
      });
    }
  }

  // 1. 标的合法性
  for (const code of byCode.keys()) {
    const inCfg = config.stocks.some((s) => s.code === code);
    if (!inCfg) {
      alerts.push({ level: "error", code, message: `标的 ${code} 不在策略标的列表中`, detail: `请先在配置区把 ${code} 加入交易标的` });
    }
  }

  // 2. 单日加仓上限
  const addTotal = [...byCode.values()].reduce((a, v) => a + v.add, 0);
  if (dailyAddLimit > 0 && addTotal > dailyAddLimit) {
    alerts.push({
      level: "error",
      message: "当日加仓合计超过单日加仓上限",
      detail: `当日加仓 ${CNY(addTotal)} > 单日上限 ${CNY(dailyAddLimit)}，超出 ${CNY(addTotal - dailyAddLimit)}`,
    });
  } else if (dailyAddLimit > 0 && addTotal > 0) {
    alerts.push({
      level: "info",
      message: `当日加仓合计 ${CNY(addTotal)}，占单日上限 ${dailyAddLimit > 0 ? `${((addTotal / dailyAddLimit) * 100).toFixed(0)}%` : "—"}`,
    });
  }

  // 执行后仓位计算（用 applyItems 得到一致的 after 表）
  const afterPositions = applyItems(config.positions, items);
  const after: TradePlanAfterPosition[] = [];
  const seenCodes = new Set<string>();
  for (const pos of afterPositions) {
    const stock = config.stocks.find((s) => s.code === pos.code);
    const v = byCode.get(pos.code) ?? { add: 0, reduce: 0 };
    const cur = currentValue(config, pos.code);
    const marketValue = (pos.quantity || 0) * (pos.avgCost || 0);

    // 5. 减仓超持仓校验
    if (v.reduce > cur) {
      alerts.push({
        level: "error",
        code: pos.code,
        message: `减仓金额超过 ${pos.code} 当前持仓`,
        detail: `当前持仓市值 ${CNY(cur)}，减仓 ${CNY(v.reduce)}，超出 ${CNY(v.reduce - cur)}；建议减仓不超过 ${CNY(cur)}`,
      });
    }

    const weightPct = totalCapital > 0 ? (marketValue / totalCapital) * 100 : 0;

    // 3. 单标的上限
    if (stock?.maxWeightPct !== undefined && totalCapital > 0) {
      const limit = (stock.maxWeightPct / 100) * totalCapital;
      if (marketValue > limit) {
        alerts.push({
          level: "warn",
          code: pos.code,
          message: `${stock.name || pos.code} 执行后市值超过标的上限`,
          detail: `执行后市值 ${CNY(marketValue)} > 标的上限 ${CNY(limit)}（总仓位的 ${stock.maxWeightPct}%），超出 ${CNY(marketValue - limit)}`,
        });
      }
    }

    seenCodes.add(pos.code);
    if (cur === 0 && v.add === 0 && v.reduce === 0 && marketValue === 0) continue; // 未持仓且本次无操作 → 不展示
    after.push({ code: pos.code, name: stock?.name, shares: pos.quantity, avgCost: pos.avgCost, marketValue, weightPct, addAmount: v.add });
  }

  // 计划中出现但无仓位记录的标的（applyItems 已补空仓位；非法标的另行告警）
  for (const [code, v] of byCode) {
    if (seenCodes.has(code)) continue;
    const marketValue = Math.max(0, currentValue(config, code) + v.add - v.reduce);
    const weightPct = totalCapital > 0 ? (marketValue / totalCapital) * 100 : 0;
    after.push({ code, name: undefined, shares: 0, avgCost: 0, marketValue, weightPct, addAmount: v.add });
  }
  after.sort((a, b) => b.marketValue - a.marketValue);

  // 4. 总仓位
  const totalMarketValue = after.reduce((a, x) => a + x.marketValue, 0);
  const positionPct = totalCapital > 0 ? (totalMarketValue / totalCapital) * 100 : 0;
  const remaining = totalCapital - totalMarketValue;
  if (totalCapital > 0 && totalMarketValue > totalCapital) {
    alerts.push({
      level: "error",
      message: "执行后总市值超过总仓位",
      detail: `执行后总市值 ${CNY(totalMarketValue)} > 总仓位 ${CNY(totalCapital)}，超出 ${CNY(totalMarketValue - totalCapital)}；建议减少加仓金额 ${CNY(totalMarketValue - totalCapital)} 或调整标的配置`,
    });
  } else if (totalCapital > 0 && addTotal > 0) {
    alerts.push({
      level: "info",
      message: `执行后总仓位 ${positionPct.toFixed(1)}%，剩余可用 ${CNY(Math.max(0, remaining))}`,
    });
  }

  // 无任何告警 → 放行提示
  if (alerts.filter((a) => a.level === "error").length === 0 && alerts.filter((a) => a.level === "warn").length === 0) {
    alerts.unshift({
      level: "info",
      message: "✅ 计划符合策略配置与仓位控制，可以执行",
      detail: `执行后总市值 ${CNY(totalMarketValue)}，占总仓位 ${positionPct.toFixed(1)}%`,
    });
  }

  // 告警按级别排序（error → warn → info），最严重的置顶
  alerts.sort((a, b) => {
    const w = { error: 0, warn: 1, info: 2 } as const;
    return w[a.level] - w[b.level];
  });

  const ok = alerts.filter((a) => a.level === "error").length === 0;
  return { ok, alerts, after, totals: { addTotal, totalMarketValue, positionPct, remaining } };
}
