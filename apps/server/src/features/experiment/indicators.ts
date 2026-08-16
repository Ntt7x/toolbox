// ============================================================
// 实验分组 · 指标纯函数（ec 泡沫预警 + BMPI 化债牛市）
// 基于分享对话框架的精确公式（0-100 标尺）；成分股公式（S1/S2/S3）用 quote 真实行情
// + 用户补全宏观；确定性计算全部固化，可单测。
// ============================================================

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
/** 股价/PB 修复百分位（0-110 封顶，框架公式） */
const pctile = (cur: number, start: number, end: number) => {
  if (end <= start) return 100;
  return clamp(Math.round(((cur - start) / (end - start)) * 1000) / 10, 0, 110);
};

// ---------- ec 欧元/日元泡沫预警 ----------

/** B(t) 加速度计：已实现汇率变动 − 利差变动（%），正=资金涌入，负=资金撤离 */
export function ecB(fxChangePct: number, spreadChangePct: number): number {
  return Math.round((fxChangePct - spreadChangePct) * 100) / 100;
}

/** Ω 综合泡沫指数：五维度加权合成（汇率极端 z / 空头拥挤 z / 利差 / 反身性累积 / 估值 z）
 *  z 分数缺失维度按中性 0 处理；全部缺失 → null。Ω>1.6 视为高危（框架阈值）。 */
export function ecOmega(zooms: { fx?: number; short?: number; spread?: number; valuation?: number }, cvas: number | null): number | null {
  const parts: number[] = [];
  if (typeof zooms.fx === "number") parts.push(zooms.fx * 0.25);
  if (typeof zooms.short === "number") parts.push(zooms.short * 0.25);
  if (typeof zooms.spread === "number") parts.push(zooms.spread * 0.15);
  if (typeof cvas === "number") parts.push(cvas * 0.2);
  if (typeof zooms.valuation === "number") parts.push(zooms.valuation * 0.15);
  if (parts.length === 0) return null;
  const totalW = parts.length === 5 ? 1 : parts.length === 4 ? 0.85 : parts.length === 3 ? 0.65 : parts.length === 2 ? 0.4 : 0.25;
  return Math.round((parts.reduce((s, v) => s + v, 0) / totalW) * 100) / 100;
}

/** CVAS 累积波动率自强化指数：clamp(1 − vix/20, 0, 1) × 持续因子（低波周数） */
export function ecCvas(vix: number | null, lowVolWeeks = 0): number | null {
  if (vix === null || vix === undefined) return null;
  const base = clamp(1 - vix / 20, 0, 1);
  const persist = clamp(1 + lowVolWeeks * 0.03, 1, 1.5);
  return Math.round(base * persist * 100) / 100;
}

/** CCV 条件性危机波动率指数：VIX 单日升幅 */
export function ecCcv(vixNow: number | null, vixPrev: number | null): number | null {
  if (vixNow === null || vixPrev === null || vixPrev <= 0) return null;
  return Math.round((vixNow - vixPrev) * 100) / 100;
}

/** ec 综合预警状态：B 连续为负 + Ω 阈值 → 高危（简化版，单点状态） */
export function ecStatus(b: number | null, omega: number | null): "🔴高危" | "🟡关注" | "🟢正常" {
  const danger = (b !== null && b < 0 && omega !== null && omega > 1.6) || (b !== null && b < -2);
  const watch = (b !== null && b < 0) || (omega !== null && omega > 1.2);
  return danger ? "🔴高危" : watch ? "🟡关注" : "🟢正常";
}

// ---------- BMPI 化债牛市进度指数（0-100 标尺，框架公式） ----------

/** R 利率环境（0-100）：近似 R = clamp(100 − 10Y收益率%×25, 0, 100)（10Y=2.3%→42.5 接近框架 38.5 量级；参数可校准） */
export function bmpiR(y10Pct: number | null): number | null {
  if (y10Pct === null || y10Pct === undefined) return null;
  return Math.round(clamp(100 - y10Pct * 25, 0, 100));
}

/** S_L 流动性（0-100）：净投放方向与规模。周度净投放（亿元）：≥5000→100，0→50，≤-3000→10，线性 */
export function bmpiSL(netInjectionYi: number | null): number | null {
  if (netInjectionYi === null || netInjectionYi === undefined) return null;
  if (netInjectionYi >= 5000) return 100;
  if (netInjectionYi <= -3000) return 10;
  return Math.round(clamp(50 + (netInjectionYi / 1000) * 10, 10, 100));
}

/** 三段阈值权重：w_raw = 5(S<30)；5+30(S−30)/40(30≤S<70)；35(S≥70)；归一化到 0.70（框架 §7.1） */
export function bmpiWeights(s1: number, s2: number, s3: number): { w1: number; w2: number; w3: number } {
  const wRaw = (s: number) => (s < 30 ? 5 : s < 70 ? 5 + (30 * (s - 30)) / 40 : 35);
  const r1 = wRaw(s1), r2 = wRaw(s2), r3 = wRaw(s3);
  const sum = r1 + r2 + r3 || 1;
  return {
    w1: Math.round((r1 / sum) * 0.7 * 1000) / 1000,
    w2: Math.round((r2 / sum) * 0.7 * 1000) / 1000,
    w3: Math.round((r3 / sum) * 0.7 * 1000) / 1000,
  };
}

/** BMPI 合成 = w1*S1 + w2*S2 + w3*S3 + 0.15*R + 0.15*S_L（0-100 标尺） */
export function bmpiComposite(
  s1: number, s2: number, s3: number, r: number, sl: number,
  weights: { w1: number; w2: number; w3: number } = bmpiWeights(s1, s2, s3),
): number {
  return Math.round((weights.w1 * s1 + weights.w2 * s2 + weights.w3 * s3 + 0.15 * r + 0.15 * sl) * 100) / 100;
}

/** BMPI 灯号（框架 §7.1）：<40 🟢 正常；40-60 🟡 关注；60-80 🟠 预警；>80 🔴 危险 */
export function bmpiStatus(bmpi: number): "🟢正常" | "🟡关注" | "🟠预警" | "🔴危险" {
  return bmpi > 80 ? "🔴危险" : bmpi > 60 ? "🟠预警" : bmpi >= 40 ? "🟡关注" : "🟢正常";
}

// ---------- S₁/S₂/S₃ 成分股公式（quote 真实行情 + 用户补全宏观；0-100 标尺） ----------

/** S₁ 信用修复（框架 §4）：S₁ = 0.70×股价百分位 + 0.30×事实分（发行进度/PMI/基建） */
export function bmpiS1(
  stockPct: number[],            // 五只建筑股股价修复百分位（0-110）
  fact: { progressPct: number | null; pmi: number | null; infraYoY: number | null },
): number | null {
  const factVals: number[] = [];
  if (fact.progressPct !== null) factVals.push(clamp(fact.progressPct, 0, 100));
  if (fact.pmi !== null) factVals.push(clamp(((fact.pmi - 39.5) / (55 - 39.5)) * 100, 0, 100));
  if (fact.infraYoY !== null) factVals.push(clamp(((fact.infraYoY - 4.1) / (8 - 4.1)) * 100, 0, 100));
  if (stockPct.length === 0 && factVals.length === 0) return null;
  const pricePart = stockPct.length > 0 ? stockPct.reduce((s, v) => s + v, 0) / stockPct.length : 0;
  const factPart = factVals.length > 0 ? factVals.reduce((s, v) => s + v, 0) / factVals.length : 0;
  // 缺股价则权重平移给事实；缺事实同理
  const wPrice = stockPct.length > 0 ? 0.7 : 0;
  const wFact = factVals.length > 0 ? 0.3 : 0;
  const w = wPrice + wFact || 1;
  return Math.round(((wPrice * pricePart + wFact * factPart) / w) * 10) / 10;
}

/** S₂ 信用边际（框架 §5）：S₂ = 0.65×股价百分位 + 0.35×事实分（城投利差/贷款/CPI/回收期）；有效收盘 <4 只 → 股价权重 50% */
export function bmpiS2(
  stockPct: number[],
  fact: { spreadBp: number | null; loanYoY: number | null; cpi: number | null; receivableDays: number | null },
): number | null {
  const factVals: number[] = [];
  if (fact.spreadBp !== null) factVals.push(clamp(((87 - fact.spreadBp) / (87 - 35)) * 100, 0, 100));
  if (fact.loanYoY !== null) factVals.push(clamp(((fact.loanYoY - 10.2) / (12 - 10.2)) * 100, 0, 100));
  if (fact.cpi !== null) factVals.push(clamp(((fact.cpi - 0.1) / (1.8 - 0.1)) * 100, 0, 100));
  if (fact.receivableDays !== null) factVals.push(clamp(((66.3 - fact.receivableDays) / (66.3 - 58)) * 100, 0, 100));
  if (stockPct.length === 0 && factVals.length === 0) return null;
  const pricePart = stockPct.length > 0 ? stockPct.reduce((s, v) => s + v, 0) / stockPct.length : 0;
  const factPart = factVals.length > 0 ? factVals.reduce((s, v) => s + v, 0) / factVals.length : 0;
  const wPrice = stockPct.length > 0 ? (stockPct.length < 4 ? 0.5 : 0.65) : 0;
  const wFact = factVals.length > 0 ? 0.35 : 0;
  const w = wPrice + wFact || 1;
  return Math.round(((wPrice * pricePart + wFact * factPart) / w) * 10) / 10;
}

/** S₃ 信用扩张（框架 §6）：S₃ = 0.55×PB 百分位 + 0.45×事实分（房价/国企PB/政府债）；利率背离惩罚（10Y−1Y<60bp 时减分） */
export function bmpiS3(
  pbPct: number[],
  fact: { housePriceYoY: number | null; soePb: number | null; govDebtPct: number | null },
  rateSpreadBp: number | null,   // 10Y−1Y 利差（bp）；null 不惩罚
): number | null {
  const factVals: number[] = [];
  if (fact.housePriceYoY !== null) factVals.push(clamp(((fact.housePriceYoY + 4.5) / (10 + 4.5)) * 100, 0, 100));
  if (fact.soePb !== null) factVals.push(clamp(((fact.soePb - 1.05) / (1.35 - 1.05)) * 100, 0, 100));
  if (fact.govDebtPct !== null) factVals.push(clamp(((fact.govDebtPct - 19.1) / (25 - 19.1)) * 100, 0, 100));
  if (pbPct.length === 0 && factVals.length === 0) return null;
  const pricePart = pbPct.length > 0 ? pbPct.reduce((s, v) => s + v, 0) / pbPct.length : 0;
  const factPart = factVals.length > 0 ? factVals.reduce((s, v) => s + v, 0) / factVals.length : 0;
  const wPrice = pbPct.length > 0 ? 0.55 : 0;
  const wFact = factVals.length > 0 ? 0.45 : 0;
  const w = wPrice + wFact || 1;
  let s3 = Math.round(((wPrice * pricePart + wFact * factPart) / w) * 10) / 10;
  // 利率背离惩罚：S₃>50 且利差<60bp → 减 min(10, (S₃−50)×(60−利差)/60)
  if (s3 > 50 && rateSpreadBp !== null && rateSpreadBp < 60) {
    s3 = Math.round((s3 - Math.min(10, ((s3 - 50) * (60 - rateSpreadBp)) / 60)) * 10) / 10;
  }
  return s3;
}

/** 股价修复百分位（0-110）：当前价 vs 起点/终点 */
export { pctile };
