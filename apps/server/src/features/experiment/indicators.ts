// ============================================================
// 实验分组 · 指标纯函数（ec 泡沫预警 + BMPI 化债牛市）
// 公式基于分享对话框架原理推导（对话为方法论提示词，非精确公式）——
// 确定性计算固化为程序（可测、稳定、省 LLM）；参数集中可调，后续可校准。
// ============================================================

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

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
  // 归一化到完整权重（缺失维度不稀释）
  const totalW = parts.length === 5 ? 1 : parts.length === 4 ? 0.85 : parts.length === 3 ? 0.65 : parts.length === 2 ? 0.4 : 0.25;
  return Math.round((parts.reduce((s, v) => s + v, 0) / totalW) * 100) / 100;
}

/** CVAS 累积波动率自强化指数：长期低波环境 → 反身性风险累积。
 *  近似：VIX 越低/越久低位 → 风险累积越高。clamp(1 − vix/20, 0, 1) × 持续因子。 */
export function ecCvas(vix: number | null, lowVolWeeks = 0): number | null {
  if (vix === null || vix === undefined) return null;
  const base = clamp(1 - vix / 20, 0, 1);       // VIX 20 以下开始累积
  const persist = clamp(1 + lowVolWeeks * 0.03, 1, 1.5); // 每低波一周 +3%，上限 1.5
  return Math.round(base * persist * 100) / 100;
}

/** CCV 条件性危机波动率指数：短期波动率极端异动（VIX 单日升幅）。负值=异动回落，大正值=危机波动。 */
export function ecCcv(vixNow: number | null, vixPrev: number | null): number | null {
  if (vixNow === null || vixPrev === null || vixPrev <= 0) return null;
  return Math.round((vixNow - vixPrev) * 100) / 100;
}

/** ec 综合预警状态：B 连续为负 + Ω 阈值 → 高危（框架铁律简化版，单点状态） */
export function ecStatus(b: number | null, omega: number | null): "🔴高危" | "🟡关注" | "🟢正常" {
  const danger = (b !== null && b < 0 && omega !== null && omega > 1.6) || (b !== null && b < -2);
  const watch = (b !== null && b < 0) || (omega !== null && omega > 1.2);
  return danger ? "🔴高危" : watch ? "🟡关注" : "🟢正常";
}

// ---------- BMPI 化债牛市进度指数 ----------

/** R 利率环境（0-10）：利率越低越支持化债。近似 R = clamp(10 − 10Y收益率% × 2, 0, 10)（10Y≈1.5%→7 分，5%→0 分） */
export function bmpiR(y10Pct: number | null): number | null {
  if (y10Pct === null || y10Pct === undefined) return null;
  return Math.round(clamp(10 - y10Pct * 2, 0, 10) * 10) / 10;
}

/** S_L 流动性（0-10）：央行净投放方向与规模。近似按周度净投放（亿元）：>5000→10，0→5，<-3000→1，线性插值 */
export function bmpiSL(netInjectionYi: number | null): number | null {
  if (netInjectionYi === null || netInjectionYi === undefined) return null;
  if (netInjectionYi >= 5000) return 10;
  if (netInjectionYi <= -3000) return 1;
  return Math.round(clamp(5 + (netInjectionYi / 1000) * 1.0, 1, 10) * 10) / 10;
}

/** BMPI 合成 = w1*S1 + w2*S2 + w3*S3 + 0.15*R + 0.15*S_L（w1+w2+w3=0.70 由调用方传入；默认 S1 略重） */
export function bmpiComposite(
  s1: number, s2: number, s3: number, r: number, sl: number,
  weights: { w1: number; w2: number; w3: number } = { w1: 0.28, w2: 0.21, w3: 0.21 },
): number {
  return Math.round((weights.w1 * s1 + weights.w2 * s2 + weights.w3 * s3 + 0.15 * r + 0.15 * sl) * 100) / 100;
}

/** BMPI 读数分档（框架：<40 正常早期，40-60 关注中期，>60 高危末期） */
export function bmpiStatus(bmpi: number): "🟢正常" | "🟡关注" | "🔴高危" {
  return bmpi > 60 ? "🔴高危" : bmpi >= 40 ? "🟡关注" : "🟢正常";
}
