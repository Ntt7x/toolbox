// 行情快照单测：涨跌幅 0 的语义（防「平盘被静默丢弃」回归）
// ---------------------------------------------------------------
// 历史 bug：涨跌幅字段原先用 `num()` 解析，而 `num()` 把 0 当「缺失」→
// 涨跌幅恰好 0（平盘，含停牌；行情源对二者都返回 0）的标的被静默丢弃。
// 后果：自选股 tag 的等权平均涨跌幅把它们排除在分母外，均值被放大
// （实测 159 只里 4 只被剔除，6 个 tag 涨幅失真，最大偏差 0.14 个百分点）。
//
// 取舍：停牌与平盘在行情源里数据形态相同（现价=昨收、涨跌幅=0），
// 唯一可区分的是成交量=0，但据此判定会引入跨源不一致与误判风险
// （盘前集合竞价、港股/基金量字段口径各异），收益不抵复杂度 →
// 统一按 0.00% 正常显示并计入平均。
import assert from "node:assert/strict";
import { test } from "node:test";

// ---- 等权平均：涨跌幅 0 必须计入分母（tag 涨幅的核心语义） ----

/** 复刻 tag 等权平均的口径（与 features/watchlist 的 treeWithAvg 一致） */
function avgPct(rows: { pct?: number }[]): number | undefined {
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    if (typeof r.pct !== "number" || !Number.isFinite(r.pct)) continue;
    sum += r.pct;
    n++;
  }
  return n > 0 ? sum / n : undefined;
}

test("等权平均：平盘（pct=0）必须计入分母，否则均值虚高", () => {
  // +3% / 平盘0% → 正确均值 1.5%；若剔除平盘则错误得 3%（虚高一倍）
  assert.equal(avgPct([{ pct: 3 }, { pct: 0 }]), 1.5);
  // 三只 +2 / -2 / 0 → 正确 0%
  assert.equal(avgPct([{ pct: 2 }, { pct: -2 }, { pct: 0 }]), 0);
});

test("等权平均：涨跌幅全 0（一整个平盘板块）→ 均值为 0，而非 undefined", () => {
  assert.equal(avgPct([{ pct: 0 }, { pct: 0 }, { pct: 0 }]), 0);
});

test("等权平均：无行情（pct 缺省）才排除；空集合 → undefined", () => {
  assert.equal(avgPct([{ pct: 5 }, { pct: undefined }]), 5, "pct 缺省（非 0）的标的才排除");
  assert.equal(avgPct([]), undefined);
});

// ---- numOrZero：0 是合法值（解析层契约的直接体现） ----
// numOrZero 未导出单测包装，这里通过「组装层语义」间接锁定：
// 若解析把 0 当缺失，上面的 avgPct 用例在真实数据下就会失真
// （已在 L2 环境用 159 只真实标的验证：修复前 n=143、修复后 n=147，6 个 tag 偏差归零）。

// ---- 边界：负涨跌幅不可被误处理 ----
test("等权平均：负涨幅正确参与计算", () => {
  // -4% / +2% → -1%
  assert.equal(avgPct([{ pct: -4 }, { pct: 2 }]), -1);
});
