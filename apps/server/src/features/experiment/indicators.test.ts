// 实验分组指标纯函数单测（ec + BMPI）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ecB, ecOmega, ecCvas, ecCcv, ecStatus,
  bmpiR, bmpiSL, bmpiComposite, bmpiStatus,
} from "./indicators.js";

test("ecB：汇率变动 − 利差变动", () => {
  assert.equal(ecB(2.5, 0.3), 2.2);   // 资金涌入
  assert.equal(ecB(-1.2, 0.1), -1.3); // 资金撤离
  assert.equal(ecB(0, 0), 0);
});

test("ecOmega：五维加权合成 + 缺失维度归一化", () => {
  const full = ecOmega({ fx: 2, short: 2.5, spread: 1, valuation: 2 }, 0.8);
  assert.ok(full !== null && full > 1.6, `full=${full}（高危）`);
  // 部分缺失：不稀释权重
  const partial = ecOmega({ fx: 2, short: 2.5 }, null);
  assert.ok(partial !== null && partial > 1.6, `partial=${partial}`);
  // 全缺失 → null
  assert.equal(ecOmega({}, null), null);
});

test("ecCvas：低 VIX 累积反身性 + 持续因子", () => {
  assert.equal(ecCvas(15, 0), 0.25);       // 1 − 15/20 = 0.25
  assert.ok((ecCvas(15, 4) ?? 0) > 0.25);  // 持续 4 周放大
  assert.equal(ecCvas(null, 0), null);
  assert.equal(ecCvas(40, 0), 0);          // VIX 高 → 无低波累积
});

test("ecCcv：VIX 异动 = 现值 − 前值", () => {
  assert.equal(ecCcv(25, 18), 7);
  assert.equal(ecCcv(18, 25), -7);
  assert.equal(ecCcv(null, 18), null);
});

test("ecStatus：B 负 + Ω 高 → 高危；B 负 → 关注；否则正常", () => {
  assert.equal(ecStatus(-3, 2), "🔴高危");
  assert.equal(ecStatus(-0.5, 1.3), "🟡关注");
  assert.equal(ecStatus(1, 0.5), "🟢正常");
});

test("bmpiR：利率越低 R 越高", () => {
  assert.equal(bmpiR(1.5), 7);
  assert.equal(bmpiR(5), 0);
  assert.equal(bmpiR(null), null);
});

test("bmpiSL：净投放方向映射", () => {
  assert.equal(bmpiSL(6000), 10);
  assert.equal(bmpiSL(0), 5);
  assert.equal(bmpiSL(-4000), 1);
  assert.equal(bmpiSL(null), null);
});

test("bmpiComposite：合成公式 + 权重", () => {
  // S1=5, S2=5, S3=5, R=7, SL=5, w=(.28,.21,.21) → .7*5 + .15*7 + .15*5 = 3.5+1.05+0.75=5.3
  assert.equal(bmpiComposite(5, 5, 5, 7, 5), 5.3);
  // 高分组合
  const hi = bmpiComposite(8, 7, 6, 7, 8);
  assert.ok(hi > 5, `hi=${hi}`);
});

test("bmpiStatus：分档", () => {
  assert.equal(bmpiStatus(35), "🟢正常");
  assert.equal(bmpiStatus(50), "🟡关注");
  assert.equal(bmpiStatus(65), "🔴高危");
});
