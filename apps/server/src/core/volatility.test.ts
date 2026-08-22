// 数据工程：标的市场波动率流水线（纯函数）单测
import { test } from "node:test";
import assert from "node:assert/strict";
import { initVolState, pushClose, annualVolOf, VOL_WINDOW, HIST_LEN } from "./volatility.js";

/** 生成平稳收盘序列：围绕 100 小幅波动（日 ±0.5% 随机但确定性） */
function flatSeries(n: number): number[] {
  const out: number[] = [100];
  for (let i = 1; i < n; i++) {
    const r = (i % 3 === 0 ? -1 : 1) * 0.004 + (i % 5 === 0 ? 0.002 : 0);
    out.push(out[i - 1]! * (1 + r));
  }
  return out;
}

test("annualVolOf：<3 项 → undefined；平稳序列 → 正波动", () => {
  assert.equal(annualVolOf([100]), undefined);
  assert.equal(annualVolOf([100, 101]), undefined);
  const v = annualVolOf(flatSeries(60));
  assert.ok(v !== undefined && v > 0 && v < 50, `vol=${v}`);
});

test("恒价序列 → 波动≈0", () => {
  const v = annualVolOf(Array(60).fill(100));
  assert.ok(v !== undefined && v < 0.01);
});

test("initVolState：窗口截断 + sum/sumsq 正确", () => {
  const closes = flatSeries(200);
  const st = initVolState(closes, "2026-08-20");
  assert.ok(st.closes.length <= VOL_WINDOW);
  assert.equal(st.closes.length, VOL_WINDOW);
  const sum = st.closes.reduce((a, b) => a + b, 0);
  const sumsq = st.closes.reduce((a, b) => a + b * b, 0);
  assert.ok(Math.abs(st.sum - sum) < 1e-6);
  assert.ok(Math.abs(st.sumsq - sumsq) < 1e-6);
  assert.ok(st.currentVol !== undefined);
  // 历史波动序列长度（200 - 20 个窗口）
  assert.ok(st.histVols.length > 0 && st.histVols.length <= HIST_LEN);
});

test("pushClose：增量后 closes/sum/sumsq 与全量一致", () => {
  const closes = flatSeries(70); // 超过窗口
  const st = initVolState(closes.slice(0, VOL_WINDOW), "2026-08-20");
  for (let i = VOL_WINDOW; i < closes.length; i++) {
    // 模拟推进 10 天
    pushClose(st, closes[i]!, `2026-08-${String(21 + i - VOL_WINDOW).padStart(2, "0")}`);
  }
  // 推进多天后，closes 应滚动到最新窗口
  const last10 = closes.slice(-10);
  const st2 = last10.reduce((acc, c) => pushClose(acc, c, "x"), st);
  const expect = closes.slice(-VOL_WINDOW);
  assert.deepEqual(st2.closes, expect);
});

test("高波分段：波动抬升后 level 为 high 或 extreme（z>1σ）", () => {
  // 前 200 日平稳，后 60 日剧烈波动
  const stable = flatSeries(200);
  const volatile = stable.slice(-60).map((v, i) => v * (1 + (i % 2 === 0 ? 0.03 : -0.03)));
  const st = initVolState(stable, "d1");
  const final = volatile.reduce((acc, c) => pushClose(acc, c, "d"), st);
  // 剧烈波动应显著高于历史平稳波动 → z > 1 → high 或 extreme
  assert.ok(final.level === "high" || final.level === "extreme", `level=${final.level}`);
  assert.ok(final.zScore! > 1, `z=${final.zScore}`);
});

test("极波分段：剧烈抬升 → level extreme（z>1.5σ）", () => {
  const stable = flatSeries(200);
  const volatile = stable.slice(-60).map((v, i) => v * (1 + (i % 2 === 0 ? 0.05 : -0.05)));
  const st = initVolState(stable, "d1");
  const final = volatile.reduce((acc, c) => pushClose(acc, c, "d"), st);
  assert.equal(final.level, "extreme");
  assert.ok(final.zScore! > 1.5, `z=${final.zScore}`);
});

test("低波分段：波动回落 → level low（z<0）", () => {
  // 前 200 日剧烈，后 60 日平稳
  const stable = flatSeries(200);
  const volatile = stable.slice(-60).map((v, i) => v * (1 + (i % 2 === 0 ? 0.03 : -0.03)));
  const st = initVolState(volatile, "d1");
  const final = stable.slice(-60).reduce((acc, c) => pushClose(acc, c, "d"), st);
  assert.equal(final.level, "low");
  assert.ok(final.zScore! < 0, `z=${final.zScore}`);
});

test("同日同价幂等：不重复入列", () => {
  const closes = flatSeries(70);
  const st = initVolState(closes.slice(0, VOL_WINDOW), "2026-08-20");
  const a = pushClose(st, closes[VOL_WINDOW]!, "2026-08-21");
  const b = pushClose(a, closes[VOL_WINDOW]!, "2026-08-21");
  assert.equal(b.closes.length, a.closes.length);
  assert.equal(b.sum, a.sum);
});
