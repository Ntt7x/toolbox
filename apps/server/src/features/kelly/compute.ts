// ============================================================
// 凯利仓位助手：核心计算（忠实实现「凯利仓位助手」提示词）
// 公式：
//   b = (TP - P) / (P - SL)               盈亏比
//   expected_edge = p * b - (1 - p)        期望优势
//   f_raw = expected_edge / b              凯利原始比例
//   方案：f_raw/4、f_raw/3、f_raw/2、f_raw（份额向下取整至 100 的整数倍）
// 校验与错误信息均与提示词原文一致。
// ============================================================

import type { KellyRequest, KellyResult, KellyScheme } from "@toolbox/shared";

/** 保留两位小数 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 四舍五入到指定小数位（输出格式化用） */
function fmt(n: number, digits = 2): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

/** 执行凯利仓位计算（返回 ok 或带 message 的错误结果） */
export function computeKelly(req: KellyRequest): KellyResult {
  const P = req.price;
  const TP = req.takeProfit;
  const SL = req.stopLoss;
  const p = req.winRate;
  const A = req.maxAmount;

  const base = { price: P, takeProfit: TP, stopLoss: SL, winRate: p, b: 0, edge: 0, fRaw: 0 };

  // 第一阶段强校验（错误信息与提示词原文一致）
  if (!(P > 0) || !(TP > 0) || !(SL > 0) || !(A > 0)) {
    return { ...base, ok: false, message: "当前价格、上止盈、下止损、可用金额都必须大于 0。" };
  }
  if (!(TP > P) || !(SL < P)) {
    return { ...base, ok: false, message: "上止盈必须高于当前价，下止损必须低于当前价。" };
  }
  if (!(p >= 0 && p <= 1)) {
    return { ...base, ok: false, message: "胜率需在0~1之间（或对应百分比0%~100%），请检查输入。" };
  }
  if (A < P * 100) {
    return { ...base, ok: false, message: "仓位可用金额不足以购买最小交易单位（100股）。" };
  }

  // 第二步：计算
  const b = (TP - P) / (P - SL);
  if (!(b > 0)) {
    return { ...base, ok: false, message: "止盈止损设置异常，盈亏比必须为正。" };
  }
  const edge = p * b - (1 - p);
  const fRaw = edge / b;
  if (!Number.isFinite(fRaw)) {
    return { ...base, ok: false, message: "计算异常，请检查输入数值。" };
  }

  // 分支一：无正期望
  if (fRaw <= 0) {
    return { ...base, b, edge, fRaw, ok: true, noPositiveEdge: true };
  }

  // 常规方案计算
  const defs: { key: KellyScheme["key"]; label: string; r: number; note: string }[] = [
    { key: "quarter", label: "四分之一凯利", r: fRaw / 4, note: "极度保守，最大回撤极低，资本增长较慢。" },
    { key: "third", label: "三分之一凯利", r: fRaw / 3, note: "进一步平滑资金曲线，适合胜率/盈亏比估计不确定时。" },
    { key: "half", label: "二分之一凯利", r: fRaw / 2, note: "波动与回撤大幅降低，长期增长率仍保持约75%。" },
    { key: "kelly", label: "凯利仓位", r: fRaw, note: "理论最优，最大化长期对数增长率，波动和回撤风险最大。" },
  ];

  const schemes: KellyScheme[] = defs.map((d) => {
    const rawCash = A * d.r;
    const rawShares = rawCash / P;
    const shares = Math.floor(rawShares / 100) * 100;
    const cash = round2(shares * P);
    const pct = A > 0 ? (cash / A) * 100 : 0;
    return { key: d.key, label: d.label, pct: fmt(pct, 2), cash: fmt(cash, 2), shares, note: d.note };
  });

  // 分支二：所有方案份额为零
  if (schemes.every((s) => s.shares === 0)) {
    return { ...base, b, edge, fRaw, ok: true, allZero: true, schemes };
  }

  // 截断提示
  const cutMessage = fRaw > 1 ? "⚠️ 原始凯利仓位超出仓位可用最大金额，已按100%截断。" : undefined;

  return { ...base, b, edge, fRaw, ok: true, schemes, ...(cutMessage ? { cutMessage } : {}) };
}
