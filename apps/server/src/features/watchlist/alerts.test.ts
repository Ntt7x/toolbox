// 自选股·提醒规则纯函数单测（校验 / 判定 / 去重 / once 停用）
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyOnceFired,
  evaluateRule,
  evaluateRules,
  mergeHits,
  rulePeriod,
  sanitizeRule,
  validateRule,
  type AlertContext,
} from "./alerts.js";

const known = new Set(["sh600519", "hk00700"]);

const baseRule = {
  id: "r1",
  code: "sh600519",
  name: "贵州茅台",
  kind: "price" as const,
  threshold: 1800,
  dir: "up" as const,
  enabled: true,
  repeat: "once" as const,
  createdAt: "2026-09-01T00:00:00.000Z",
};

const ctx: AlertContext = {
  code: "sh600519",
  name: "贵州茅台",
  date: "2026-09-01",
  last: 1800,
  dayPct: 3.2,
  weekPct: 5.1,
  monthPct: -8.4,
  amplitude: 4.6,
};

test("sanitizeRule：字段整形与默认值", () => {
  const r = sanitizeRule({ code: " sh600519 ", kind: "price", threshold: "1800", dir: "down", repeat: "always" });
  assert.ok(r);
  assert.equal(r!.code, "sh600519");
  assert.equal(r!.threshold, 1800);
  assert.equal(r!.dir, "down");
  assert.equal(r!.repeat, "always");
  assert.equal(r!.enabled, true); // 缺省启用
  assert.ok(r!.id.length > 0);
});

test("sanitizeRule：非法输入返回 null（缺代码 / 非法类型 / 阈值非数）", () => {
  assert.equal(sanitizeRule({ kind: "price", threshold: 1 }), null);
  assert.equal(sanitizeRule({ code: "sh600519", kind: "unknown", threshold: 1 }), null);
  assert.equal(sanitizeRule({ code: "sh600519", kind: "price", threshold: "abc" }), null);
  assert.equal(sanitizeRule(null), null);
});

test("validateRule：标的不在分组内 / 阈值非正 / 百分比超 100 均被拒", () => {
  assert.equal(validateRule(baseRule, known), null);
  assert.match(validateRule({ ...baseRule, code: "sz000001" }, known)!, /不在该分组/);
  assert.match(validateRule({ ...baseRule, threshold: 0 }, known)!, /必须为正数/);
  assert.match(validateRule({ ...baseRule, threshold: -5 }, known)!, /必须为正数/);
  assert.match(validateRule({ ...baseRule, kind: "dayPct", threshold: 150 }, known)!, /不得大于 100/);
  assert.match(validateRule({ ...baseRule, kind: "price", threshold: 2_000_000 }, known)!, /合理范围/);
  assert.match(validateRule({ ...baseRule, kind: "bogus" as never }, known)!, /类型无效/);
});

test("evaluateRule：价格上破——阈值相等即命中（券商惯例）", () => {
  const hit = evaluateRule(baseRule, ctx);
  assert.ok(hit);
  assert.equal(hit!.value, 1800);
  assert.match(hit!.text, /上破 1800/);
  assert.equal(hit!.date, "2026-09-01");
});

test("evaluateRule：价格上破未达阈值 / 下破逻辑", () => {
  assert.equal(evaluateRule(baseRule, { ...ctx, last: 1799.9 }), null);
  const down = evaluateRule({ ...baseRule, dir: "down", threshold: 1700 }, { ...ctx, last: 1699 });
  assert.ok(down);
  assert.match(down!.text, /下破 1700/);
  assert.equal(evaluateRule({ ...baseRule, dir: "down", threshold: 1700 }, { ...ctx, last: 1750 }), null);
});

test("evaluateRule：停用的规则不判定", () => {
  assert.equal(evaluateRule({ ...baseRule, enabled: false }, ctx), null);
});

test("evaluateRule：日/周/月涨跌幅方向判定（跌破用负阈值比较）", () => {
  assert.ok(evaluateRule({ ...baseRule, kind: "dayPct", threshold: 3, dir: "up" }, ctx)); // +3.2 ≥ 3
  assert.equal(evaluateRule({ ...baseRule, kind: "dayPct", threshold: 4, dir: "up" }, ctx), null);
  // 下跌方向：+3.2% 未跌破 -2% → 不命中；-2% 触及阈值 → 命中（相等即命中）
  assert.equal(evaluateRule({ ...baseRule, kind: "dayPct", threshold: 2, dir: "down" }, ctx), null);
  assert.ok(evaluateRule({ ...baseRule, kind: "dayPct", threshold: 2, dir: "down" }, { ...ctx, dayPct: -2 }));
  assert.ok(evaluateRule({ ...baseRule, kind: "dayPct", threshold: 2, dir: "down" }, { ...ctx, dayPct: -3 }));
});

test("evaluateRule：周期涨跌幅按 rule.period 取数（缺省 week）", () => {
  assert.equal(rulePeriod({ period: undefined }), "week");
  assert.ok(evaluateRule({ ...baseRule, kind: "periodPct", period: "week", threshold: 5, dir: "up" }, ctx)); // +5.1
  assert.equal(evaluateRule({ ...baseRule, kind: "periodPct", period: "week", threshold: 6, dir: "up" }, ctx), null);
  assert.ok(evaluateRule({ ...baseRule, kind: "periodPct", period: "month", threshold: 8, dir: "down" }, ctx)); // -8.4 ≤ -8
});

test("evaluateRule：振幅只比大小（无方向）", () => {
  assert.ok(evaluateRule({ ...baseRule, kind: "amplitude", threshold: 4, dir: "up" }, ctx));
  assert.equal(evaluateRule({ ...baseRule, kind: "amplitude", threshold: 5, dir: "up" }, ctx), null);
});

test("evaluateRule：数据缺失 → 返回 null（不可判定就不瞎报）", () => {
  const noData: AlertContext = { code: "sh600519", date: "2026-09-01" };
  assert.equal(evaluateRule(baseRule, noData), null);
  assert.equal(evaluateRule({ ...baseRule, kind: "dayPct" }, noData), null);
  assert.equal(evaluateRule({ ...baseRule, kind: "amplitude" }, noData), null);
});

test("evaluateRules：按 code 匹配上下文，多规则独立判定", () => {
  const rules = [baseRule, { ...baseRule, id: "r2", code: "hk00700", threshold: 700 }];
  const hits = evaluateRules(rules, [ctx, { code: "hk00700", date: "2026-09-01", last: 710 }]);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.ruleId).sort(), ["r1", "r2"]);
});

test("mergeHits：按 ruleId+日期去重、时间降序、limit 截断", () => {
  const old = { ruleId: "r1", code: "sh600519", date: "2026-08-29", value: 1, text: "old", at: "2026-08-29T10:00:00.000Z" };
  const newer = { ruleId: "r1", code: "sh600519", date: "2026-09-01", value: 2, text: "new", at: "2026-09-01T10:00:00.000Z" };
  const merged = mergeHits([old], [newer]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].date, "2026-09-01"); // 时间降序
  // 同 ruleId + 同日期：后者覆盖
  const dup = mergeHits([{ ...newer, text: "v1" }], [{ ...newer, text: "v2", at: "2026-09-01T12:00:00.000Z" }]);
  assert.equal(dup.length, 1);
  assert.equal(dup[0].text, "v2");
  // limit 生效
  assert.equal(mergeHits([old, newer], [], 1).length, 1);
});

test("applyOnceFired：once 规则命中后自动停用，always 规则保持启用", () => {
  const rules = [
    { ...baseRule, id: "once", repeat: "once" as const },
    { ...baseRule, id: "always", repeat: "always" as const },
    { ...baseRule, id: "unhit", repeat: "once" as const },
  ];
  const hits = [{ ruleId: "once", code: "sh600519", date: "2026-09-01", value: 1, text: "t", at: "x" }];
  const next = applyOnceFired(rules, hits);
  assert.equal(next[0].enabled, false);
  assert.equal(next[1].enabled, true);
  assert.equal(next[2].enabled, true); // 未命中不受影响
});
