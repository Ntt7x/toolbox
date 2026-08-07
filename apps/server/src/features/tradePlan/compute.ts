// ============================================================
// 交易规划：校验计算（纯函数，无 LLM、无 IO）
// 校验日度交易计划是否符合策略配置与仓位控制：
//  1. 标的必须在策略标的列表内
//  2. 当日加仓合计 ≤ 单日加仓上限
//  3. 加仓后单标的市场值 ≤ 标的上限（maxWeightPct × 总仓位，若配置）
//  4. 加仓后总市值 ≤ 总仓位
//  5. 减仓金额 ≤ 该标的当前持仓市值
//  6. 输出执行后各标的仓位预览（市值/权重/成本）
// ============================================================
import {
  type TradePlanAlert,
  type TradePlanAfterPosition,
  type TradePlanCheckResult,
  type TradePlanConfig,
  type TradePlanItem,
} from "@toolbox/shared";

const CNY = (v: number) => `¥${Math.round(v).toLocaleString("zh-CN")}`;

/** 计算某标的当前持仓市值（优先标的行内联 initShares×initCost；兼容旧 initialPositions） */
function currentValue(config: TradePlanConfig, code: string): number {
  const st = config.stocks.find((x) => x.code === code);
  if (st && st.initShares && st.initCost) return st.initShares * st.initCost;
  const p = config.initialPositions.find((x) => x.code === code);
  if (!p) return 0;
  return p.shares * p.cost;
}

export function checkTradePlan(config: TradePlanConfig, items: TradePlanItem[]): TradePlanCheckResult {
  const alerts: TradePlanAlert[] = [];
  const totalCapital = config.totalCapital || 0;
  const dailyAddLimit = config.dailyAddLimit || 0;

  // 汇总每标的变动
  const byCode = new Map<string, { add: number; reduce: number }>();
  for (const it of items) {
    const acc = byCode.get(it.code) ?? { add: 0, reduce: 0 };
    if (it.action === "add") acc.add += it.amount;
    else acc.reduce += it.amount;
    byCode.set(it.code, acc);
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

  // 执行后仓位计算
  const after: TradePlanAfterPosition[] = [];
  for (const stock of config.stocks) {
    const code = stock.code;
    const v = byCode.get(code) ?? { add: 0, reduce: 0 };
    const cur = currentValue(config, code);
    if (cur === 0 && v.add === 0 && v.reduce === 0) continue; // 未持仓且本次无操作 → 不展示
    let marketValue = cur + v.add - v.reduce;

    // 5. 减仓超持仓校验
    if (v.reduce > cur) {
      alerts.push({
        level: "error",
        code,
        message: `减仓金额超过 ${code} 当前持仓`,
        detail: `当前持仓市值 ${CNY(cur)}，减仓 ${CNY(v.reduce)}，超出 ${CNY(v.reduce - cur)}`,
      });
      marketValue = Math.max(0, marketValue);
    }

    const weightPct = totalCapital > 0 ? (marketValue / totalCapital) * 100 : 0;

    // 3. 单标的上限
    if (stock.maxWeightPct !== undefined && totalCapital > 0) {
      const limit = (stock.maxWeightPct / 100) * totalCapital;
      if (marketValue > limit) {
        alerts.push({
          level: "warn",
          code,
          message: `${stock.name || code} 执行后市值超过标的上限`,
          detail: `执行后市值 ${CNY(marketValue)} > 标的上限 ${CNY(limit)}（总仓位的 ${stock.maxWeightPct}%），超出 ${CNY(marketValue - limit)}`,
        });
      }
    }

    // 成本：优先标的行内联（initShares×initCost），兼容旧 initialPositions
    const st0 = config.stocks.find((x) => x.code === code);
    const pos = config.initialPositions.find((x) => x.code === code);
    const avgCost = st0?.initCost || pos?.cost || 0;
    const shares = avgCost > 0 ? Math.round(marketValue / avgCost) : 0;

    after.push({ code, name: stock.name, shares, avgCost, marketValue, weightPct, addAmount: v.add });
  }

  // 未在配置列表但计划中出现的标的（前面已告警，此处也补展示）
  for (const [code, v] of byCode) {
    if (!config.stocks.some((s) => s.code === code)) {
      const cur = currentValue(config, code);
      const marketValue = Math.max(0, cur + v.add - v.reduce);
      const weightPct = totalCapital > 0 ? (marketValue / totalCapital) * 100 : 0;
      after.push({ code, name: undefined, shares: 0, avgCost: 0, marketValue, weightPct, addAmount: v.add });
    }
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
      detail: `执行后总市值 ${CNY(totalMarketValue)} > 总仓位 ${CNY(totalCapital)}，超出 ${CNY(totalMarketValue - totalCapital)}`,
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
