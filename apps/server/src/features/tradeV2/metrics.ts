// ============================================================
// 数据工程：交易指标计算（纯函数——波动率/夏普/回撤/盈亏比/期望）
// memo mt4hl5g9（收益分析指标）+ mt4hm8hp（数据工程深化：指标纯函数化、可单测）
// ============================================================
import type { TradeV2DailyPoint, TradeV2Deal, TradeV2Metrics } from "@toolbox/shared";

/** 交易日收益率序列（从日市值序列近似：市值变化率；资金进出会引入噪声——个人工具可接受） */
function dailyReturns(daily: TradeV2DailyPoint[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < daily.length; i++) {
    const prev = daily[i - 1]!.marketValue;
    const cur = daily[i]!.marketValue;
    if (prev > 0) rets.push((cur - prev) / prev);
  }
  return rets;
}

/** 年化波动率 %（日收益标准差 × √252 × 100） */
function annualVol(rets: number[]): number | undefined {
  if (rets.length < 2) return undefined;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

/** 夏普比率（无风险利率按 2% 年化；年化收益 = 日收益均值 × 252） */
function sharpe(rets: number[], vol: number | undefined): number | undefined {
  if (!vol || vol <= 0 || rets.length < 2) return undefined;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const ann = mean * 252;
  return (ann - 0.02) / (vol / 100);
}

/** 最大回撤 %（市值序列峰值到谷底的最大跌幅；负数表示跌幅） */
function maxDrawdown(daily: TradeV2DailyPoint[]): number | undefined {
  if (daily.length < 2) return undefined;
  let peak = -Infinity;
  let mdd = 0;
  for (const d of daily) {
    if (d.marketValue > peak) peak = d.marketValue;
    if (peak > 0) mdd = Math.min(mdd, (d.marketValue - peak) / peak);
  }
  return mdd * 100;
}

/** 盈亏比（平均盈利 ÷ 平均亏损绝对值；按已平仓段 pnl） */
function profitFactor(deals: TradeV2Deal[]): number | undefined {
  const closed = deals.filter((d) => d.status === "closed");
  const pnls = closed.map((d) => (d.sellAmount ?? 0) - (d.buyAmount ?? 0) - (d.feeTotal ?? 0));
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  if (wins.length === 0 || losses.length === 0) return undefined;
  const avgWin = wins.reduce((a, b) => a + b, 0) / wins.length;
  const avgLoss = Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length);
  return avgLoss > 0 ? avgWin / avgLoss : undefined;
}

/** 单笔期望（平均每笔段盈亏，含在途按浮盈估算） */
function expectancy(deals: TradeV2Deal[]): number | undefined {
  if (deals.length === 0) return undefined;
  const sum = deals.reduce((a, d) => a + ((d.sellAmount ?? 0) - (d.buyAmount ?? 0) - (d.feeTotal ?? 0)), 0);
  return sum / deals.length;
}

/** 综合交易指标（数据工程纯函数——memo mt4hl5g9） */
export function computeMetrics(daily: TradeV2DailyPoint[], deals: TradeV2Deal[]): TradeV2Metrics {
  const rets = dailyReturns(daily);
  const vol = annualVol(rets);
  return {
    annualVol: vol !== undefined ? Math.round(vol * 100) / 100 : undefined,
    sharpe: (() => { const s = sharpe(rets, vol); return s !== undefined ? Math.round(s * 100) / 100 : undefined; })(),
    maxDrawdown: (() => { const m = maxDrawdown(daily); return m !== undefined ? Math.round(m * 100) / 100 : undefined; })(),
    profitFactor: (() => { const p = profitFactor(deals); return p !== undefined ? Math.round(p * 100) / 100 : undefined; })(),
    expectancy: (() => { const e = expectancy(deals); return e !== undefined ? Math.round(e * 100) / 100 : undefined; })(),
  };
}
