// 数据工程：标的市场波动率流水线（纯函数）单测
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initVolState, pushClose, pushBar, annualVolOf, parkVolOf, ewmaNext, initEwma, diffVolState,
  VOL_WINDOW, HIST_LEN, EWMA_LAMBDA,
} from "./volatility.js";
import { persistVolDerived, VOL_HIST_PREFIX, VOL_EVENT_PREFIX, VOL_PREFIX } from "./volatilityStore.js";
import { kvGet, kvDelete } from "./kvStore.js";

/** 生成平稳收盘序列：围绕 100 小幅波动（日 ±0.5% 随机但确定性） */
function flatSeries(n: number): number[] {
  const out: number[] = [100];
  for (let i = 1; i < n; i++) {
    const r = (i % 3 === 0 ? -1 : 1) * 0.004 + (i % 5 === 0 ? 0.002 : 0);
    out.push(out[i - 1]! * (1 + r));
  }
  return out;
}

/** 把收盘序列转为 bars（high/low = close ± 0.5%，模拟日内波动） */
function toBars(closes: number[]): { close: number; high: number; low: number }[] {
  return closes.map((c) => ({ close: c, high: c * 1.005, low: c * 0.995 }));
}

function initWithCloses(closes: number[], date?: string) {
  return initVolState(closes.map((c) => ({ close: c })), date);
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
  const st = initWithCloses(closes, "2026-08-20");
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
  const st = initWithCloses(closes.slice(0, VOL_WINDOW), "2026-08-20");
  const st2 = closes.slice(VOL_WINDOW).reduce((acc, c, i) => pushClose(acc, c, "d" + i), st);
  const expect = closes.slice(-VOL_WINDOW);
  assert.deepEqual(st2.closes, expect);
});

test("高波分段：波动抬升后 level 为 high 或 extreme（z>1σ）", () => {
  // 前 200 日平稳，后 60 日剧烈波动
  const stable = flatSeries(200);
  const volatile = stable.slice(-60).map((v, i) => v * (1 + (i % 2 === 0 ? 0.03 : -0.03)));
  const st = initWithCloses(stable, "d1");
  const final = volatile.reduce((acc, c, i) => pushClose(acc, c, "d" + i), st);
  // 剧烈波动应显著高于历史平稳波动 → z > 1 → high 或 extreme
  assert.ok(final.level === "high" || final.level === "extreme", `level=${final.level}`);
  assert.ok(final.zScore! > 1, `z=${final.zScore}`);
});

test("极波分段：剧烈抬升 → level extreme（z>1.5σ）", () => {
  const stable = flatSeries(200);
  const volatile = stable.slice(-60).map((v, i) => v * (1 + (i % 2 === 0 ? 0.05 : -0.05)));
  const st = initWithCloses(stable, "d1");
  const final = volatile.reduce((acc, c, i) => pushClose(acc, c, "d" + i), st);
  assert.equal(final.level, "extreme");
  assert.ok(final.zScore! > 1.5, `z=${final.zScore}`);
});

test("低波分段：波动回落 → level low（z<0）", () => {
  // 前 200 日剧烈，后 60 日平稳
  const stable = flatSeries(200);
  const volatile = stable.slice(-60).map((v, i) => v * (1 + (i % 2 === 0 ? 0.03 : -0.03)));
  const st = initWithCloses(volatile, "d1");
  const final = stable.slice(-60).reduce((acc, c, i) => pushClose(acc, c, "d" + i), st);
  assert.equal(final.level, "low");
  assert.ok(final.zScore! < 0, `z=${final.zScore}`);
});

test("同日同价幂等：不重复入列", () => {
  const closes = flatSeries(70);
  const st = initWithCloses(closes.slice(0, VOL_WINDOW), "2026-08-20");
  const a = pushClose(st, closes[VOL_WINDOW]!, "2026-08-21");
  const b = pushClose(a, closes[VOL_WINDOW]!, "2026-08-21");
  assert.equal(b.closes.length, a.closes.length);
  assert.equal(b.sum, a.sum);
});

// ---------- EWMA ----------

test("ewmaNext：RiskMetrics 递推（λ=0.94，方差向 r² 收敛）", () => {
  const v0 = 0.0001;
  const v1 = ewmaNext(v0, 0.01, EWMA_LAMBDA);
  const expect = EWMA_LAMBDA * v0 + (1 - EWMA_LAMBDA) * 0.01 * 0.01;
  assert.ok(Math.abs(v1 - expect) < 1e-12);
});

test("initEwma：平稳序列 → 正 seed；恒价 → 0", () => {
  assert.ok(initEwma(flatSeries(60)) > 0);
  assert.equal(initEwma(Array(60).fill(100)), 0);
});

test("pushBar：EWMA 增量后 ewmaVol 为正且有界", () => {
  const bars = toBars(flatSeries(70));
  const st = initVolState(bars, "d0");
  assert.ok(st.ewmaVol !== undefined && st.ewmaVol > 0);
  const final = bars.slice(60).reduce((acc, b) => pushBar(acc, b, "d"), st);
  assert.ok(final.ewmaVol !== undefined && final.ewmaVol > 0);
  // 恒价续推 → EWMA 波动收敛到接近 0
  const flat = Array(60).fill({ close: 100, high: 100, low: 100 });
  const st0 = initVolState(flat, "d0");
  assert.ok(st0.ewmaVol! < 0.5);
});

// ---------- Parkinson ----------

test("parkVolOf：恒价高低 → 0；正高低 → 正波动", () => {
  assert.equal(parkVolOf([100, 100, 100], [100, 100, 100]), 0);
  const v = parkVolOf([101, 102, 100], [99, 100, 98]);
  assert.ok(v !== undefined && v > 0 && v < 200);
});

test("parkVolOf：输入不合法 → undefined（长度不等 / h<l / 非正）", () => {
  assert.equal(parkVolOf([100], [100, 101]), undefined);
  assert.equal(parkVolOf([100, 100, 100], [101, 100, 100]), undefined);
  assert.equal(parkVolOf([0, 0, 0], [0, 0, 0]), undefined);
});

test("pushBar：Parkinson 派生与全量一致（窗口内高低同步滑动）", () => {
  const closes = flatSeries(70);
  const bars = toBars(closes);
  const st = initVolState(bars.slice(0, VOL_WINDOW), "d0");
  const final = bars.slice(VOL_WINDOW).reduce((acc, b, i) => pushBar(acc, b, "d" + (i + 1)), st);
  const expect = bars.slice(-VOL_WINDOW);
  assert.deepEqual(final.highs, expect.map((b) => b.high));
  assert.deepEqual(final.lows, expect.map((b) => b.low));
  const direct = parkVolOf(final.highs, final.lows);
  assert.ok(direct !== undefined && Math.abs(direct - final.parkVol!) < 1e-9);
});

test("三口径并存：HV/EWMA/Parkinson 同时派生且主口径 currentVol = HV", () => {
  const bars = toBars(flatSeries(200));
  const st = initVolState(bars, "d0");
  assert.ok(st.currentVol !== undefined, "HV 主口径");
  assert.ok(st.ewmaVol !== undefined && st.ewmaVol > 0, "EWMA");
  assert.ok(st.parkVol !== undefined && st.parkVol > 0, "Parkinson");
  assert.equal(st.currentVol, annualVolOf(st.closes));
});

// ---------- 同日替换（懒/调度双路径） ----------

test("同日不同价：替换最后一根而非追加（不污染窗口、不重复计 EWMA）", () => {
  const closes = flatSeries(70);
  const st = initWithCloses(closes.slice(0, VOL_WINDOW), "2026-08-25");
  const ewmaBefore = st.ewmaVar;
  const a = pushBar(st, { close: 101.5, high: 102, low: 101 }, "2026-08-26");
  const b = pushBar(a, { close: 102.8, high: 103.5, low: 101.2 }, "2026-08-26"); // 同日不同价
  assert.equal(b.closes.length, a.closes.length, "同日替换不追加");
  assert.equal(b.closes[b.closes.length - 1], 102.8);
  assert.equal(b.ewmaVar, a.ewmaVar, "同日替换不重复计 EWMA");
  // sum/sumsq 与全量一致（把替换后的窗口视为直接构造）
  const expectCloses = [...a.closes.slice(0, -1), 102.8];
  const sum = expectCloses.reduce((x, y) => x + y, 0);
  const sumsq = expectCloses.reduce((x, y) => x + y * y, 0);
  assert.ok(Math.abs(b.sum - sum) < 1e-6);
  assert.ok(Math.abs(b.sumsq - sumsq) < 1e-6);
});

// ---------- 增量感知（diffVolState） ----------

test("diffVolState：首次有值 → new；无变化 → null", () => {
  const st = initWithCloses(flatSeries(60), "d");
  assert.equal(diffVolState(undefined, st)?.kind, "new");
  assert.equal(diffVolState(st, st), null);
});

test("diffVolState：level 跃升 → level-up（含前后级别）", () => {
  const stable = flatSeries(200);
  const st = initWithCloses(stable, "d1");
  const volatile = stable.slice(-60).map((v, i) => v * (1 + (i % 2 === 0 ? 0.05 : -0.05)));
  const final = volatile.reduce((acc, c, i) => pushClose(acc, c, "d" + i), st);
  const evt = diffVolState(st, final);
  assert.ok(evt);
  assert.equal(evt!.kind, "level-up");
  assert.equal(evt!.prevLevel, st.level);
  assert.equal(evt!.nextLevel, final.level);
});

test("diffVolState：波动突变（>30%）但级别未变 → surge", () => {
  const closes = flatSeries(60);
  const st = initWithCloses(closes, "d");
  // 同级别内单日波动大幅抬升（构造 prev 与 next 的 vol 差 >30%）
  const next = { ...st, currentVol: st.currentVol! * 1.5, level: st.level, lastDate: "d2" } as any;
  const evt = diffVolState(st, next);
  assert.equal(evt?.kind, "surge");
});

test("persistVolDerived：感知落库（vhist 每日序列 + vevent 首次 new 事件）", () => {
  const code = "diag-600519";
  const bars = toBars(flatSeries(80)).map((b, i) => ({ ...b, date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}` }));
  const st = initVolState(bars, bars[bars.length - 1]!.date);
  persistVolDerived(code, undefined, st);
  const hist = kvGet<unknown[]>(VOL_HIST_PREFIX + code);
  const evt = kvGet<unknown[]>(VOL_EVENT_PREFIX + code);
  assert.ok(hist && hist.length > 0, "vhist 应写入每日序列");
  assert.ok(evt && evt.length > 0, "vevent 应写入 new 事件");
  assert.equal((evt as any[])[0]!.kind, "new");
  // 清理
  kvDelete(VOL_PREFIX + code); kvDelete(VOL_HIST_PREFIX + code); kvDelete(VOL_EVENT_PREFIX + code);
});
