// ============================================================
// 手续费自动计算（memo msww20u5）——纯函数，独立模块供单测与复用
// 规则：A 股 ETF 佣金 万1 最低 0.1 元；个股 万1.154 最低 5 元
// ============================================================

/** A 股 ETF 特征代码：沪 5xxxxx（510/511/512/513/515/516/518/588…）或深 1xxxxx（159/16…）；其余按个股 */
export const isEtfCode = (code: string): boolean => {
  const c = (code || "").trim().replace(/^(sh|sz|SH|SZ)/, "");
  return /^5\d{5}$/.test(c) || /^1[56]\d{4}$/.test(c);
};

/** 佣金费率与最低值（按标的类型） */
export const feeRule = (code: string): { rate: number; min: number } =>
  isEtfCode(code) ? { rate: 0.0001, min: 0.1 } : { rate: 0.0001154, min: 5 };

/** 计算手续费（元，两位小数）：max(金额×费率, 最低)。金额<=0 或代码空 → 0 */
export const calcFee = (code: string, qty: number, price: number): number => {
  const amount = qty * price;
  if (amount <= 0 || !code) return 0;
  const { rate, min } = feeRule(code);
  return Math.round(Math.max(amount * rate, min) * 100) / 100;
};
