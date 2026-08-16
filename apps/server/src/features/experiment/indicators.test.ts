// 实验分组指标纯函数单测（ec + BMPI，0-100 标尺）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ecB, ecOmega, ecCvas, ecCcv, ecStatus,
  bmpiR, bmpiSL, bmpiWeights, bmpiComposite, bmpiStatus,
  bmpiS1, bmpiS2, bmpiS3, pctile,
} from "./indicators.js";

test("ecB：汇率变动 − 利差变动", () => {
  assert.equal(ecB(2.5, 0.3), 2.2);
  assert.equal(ecB(-1.2, 0.1), -1.3);
  assert.equal(ecB(0, 0), 0);
});

test("ecOmega：五维加权合成 + 缺失维度归一化", () => {
  const full = ecOmega({ fx: 2, short: 2.5, spread: 1, valuation: 2 }, 0.8);
  assert.ok(full !== null && full > 1.6, `full=${full}`);
  const partial = ecOmega({ fx: 2, short: 2.5 }, null);
  assert.ok(partial !== null && partial > 1.6, `partial=${partial}`);
  assert.equal(ecOmega({}, null), null);
});

test("ecCvas / ecCcv：低波累积 + VIX 异动", () => {
  assert.equal(ecCvas(15, 0), 0.25);
  assert.ok((ecCvas(15, 4) ?? 0) > 0.25);
  assert.equal(ecCvas(null, 0), null);
  assert.equal(ecCcv(25, 18), 7);
  assert.equal(ecCcv(null, 18), null);
});

test("ecStatus：B 负 + Ω 高 → 高危；B 负 → 关注；否则正常", () => {
  assert.equal(ecStatus(-3, 2), "🔴高危");
  assert.equal(ecStatus(-0.5, 1.3), "🟡关注");
  assert.equal(ecStatus(1, 0.5), "🟢正常");
});

test("bmpiR / bmpiSL：0-100 标尺", () => {
  assert.equal(bmpiR(2.3), 43);       // 100 − 57.5 ≈ 42.5 → 43（四舍五入）
  assert.equal(bmpiR(4), 0);
  assert.equal(bmpiR(null), null);
  assert.equal(bmpiSL(6000), 100);
  assert.equal(bmpiSL(0), 50);
  assert.equal(bmpiSL(-4000), 10);
  assert.equal(bmpiSL(null), null);
});

test("bmpiWeights：三段阈值归一化 0.70（框架 §7.1 示例 34.8/35.4/56.5 → 0.14/0.15/0.41）", () => {
  const w = bmpiWeights(34.8, 35.4, 56.5);
  assert.ok(Math.abs(w.w1 - 0.14) < 0.01, `w1=${w.w1}`);
  assert.ok(Math.abs(w.w2 - 0.15) < 0.01, `w2=${w.w2}`);
  assert.ok(Math.abs(w.w3 - 0.41) < 0.01, `w3=${w.w3}`);
  assert.ok(Math.abs(w.w1 + w.w2 + w.w3 - 0.7) < 0.01, `sum=${w.w1 + w.w2 + w.w3}`);
});

test("bmpiComposite：合成公式（示例 41.19）", () => {
  // S1=34.8 S2=35.4 S3=56.5 R=38.5 SL=13.89，w 由三段规则
  const w = bmpiWeights(34.8, 35.4, 56.5);
  const v = bmpiComposite(34.8, 35.4, 56.5, 38.5, 13.89, w);
  assert.ok(Math.abs(v - 41.2) < 1.5, `bmpi=${v}（框架示例 41.19）`);
});

test("bmpiStatus：4 档灯号", () => {
  assert.equal(bmpiStatus(35), "🟢正常");
  assert.equal(bmpiStatus(50), "🟡关注");
  assert.equal(bmpiStatus(70), "🟠预警");
  assert.equal(bmpiStatus(85), "🔴危险");
});

test("pctile：股价修复百分位（0-110 封顶）", () => {
  assert.equal(pctile(5.22, 3.82, 8.5), 29.9); // 安徽建工示例
  assert.equal(pctile(3.53, 1.84, 4.5), 63.5); // 中国能建示例
  assert.equal(pctile(10.97, 8.06, 11.5), 84.6); // 山东高速 10.97 在 8.06-11.5 区间 84.6%
  assert.equal(pctile(3, 5, 10), 0);           // 跌破起点 → 0
});

test("bmpiS1：0.7×股价 + 0.3×宏观（框架示例 S1=34.8）", () => {
  const s = bmpiS1([29.9, 63.5, 12.9, 4.9, 53.0], { progressPct: 60.9, pmi: 41.6, infraYoY: 5.3 });
  assert.ok(s !== null && Math.abs(s - 34.8) < 2, `S1=${s}（框架示例 34.8）`);
});

test("bmpiS2：0.65×股价 + 0.35×宏观（示例 S2=35.4）", () => {
  const s = bmpiS2([0, 33.8, 21, 110, 46.4, 23.7], { spreadBp: 50, loanYoY: 7.4, cpi: 1.2, receivableDays: 72.6 });
  assert.ok(s !== null && Math.abs(s - 35.4) < 3, `S2=${s}（框架示例 35.4）`);
});

test("bmpiS3：0.55×PB + 0.45×宏观 + 利率背离惩罚", () => {
  // 无惩罚（利差充足）
  const s = bmpiS3([40, 50, 60], { housePriceYoY: 3.2, soePb: 1.29, govDebtPct: 19.6 }, 80);
  assert.ok(s !== null && s > 0, `S3=${s}`);
  // 惩罚：S3>50 且利差<60bp → 减分
  const sHigh = bmpiS3([80, 90, 100], { housePriceYoY: 5, soePb: 1.3, govDebtPct: 22 }, 40);
  const sHighNoPenalty = bmpiS3([80, 90, 100], { housePriceYoY: 5, soePb: 1.3, govDebtPct: 22 }, 100);
  assert.ok(sHigh !== null && sHighNoPenalty !== null && sHigh < sHighNoPenalty, `惩罚 ${sHigh} < ${sHighNoPenalty}`);
});
