// 交易单批量解析纯函数单测（memo msvvn2v4）
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBatchText, numInput } from "./tradeV2Parse.ts";

let key = 0;
const nk = () => ++key;

test("parseBatchText：空格分隔买/卖 + 手续费/备注", () => {
  key = 0;
  const rows = parseBatchText("买 600519 100 1500\n卖 00700 200 380 5 减仓", nk);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { code: rows[0]!.code, action: rows[0]!.action, quantity: rows[0]!.quantity, price: rows[0]!.price },
    { code: "600519", action: "buy", quantity: 100, price: 1500 }
  );
  assert.deepEqual(
    { code: rows[1]!.code, action: rows[1]!.action, fee: rows[1]!.fee, note: rows[1]!.note },
    { code: "00700", action: "sell", fee: 5, note: "减仓" }
  );
  assert.ok(rows[0]!.key !== rows[1]!.key, "key 自增");
});

test("parseBatchText：逗号分隔 + 默认买 + 无效行跳过", () => {
  key = 0;
  const rows = parseBatchText("000831,300,12.5\n\n# 注释行\n600519 100", nk);
  assert.equal(rows.length, 2);
  assert.deepEqual({ code: rows[0]!.code, action: rows[0]!.action }, { code: "000831", action: "buy" });
  assert.equal(rows[1]!.code, "600519");
});

test("parseBatchText：英文买/卖前缀 + tab 分隔", () => {
  key = 0;
  const rows = parseBatchText("buy\t600519\t100\t1500\ns 00700 50 380", nk);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.action, "buy");
  assert.equal(rows[1]!.action, "sell");
});

test("parseBatchText：空文本 / 纯注释 → 空数组", () => {
  key = 0;
  assert.equal(parseBatchText("", nk).length, 0);
  assert.equal(parseBatchText("# 只有注释", nk).length, 0);
});

test("numInput：千分位/空格剥离，非法 → 0", () => {
  assert.equal(numInput("1,234.5"), 1234.5);
  assert.equal(numInput("1 000"), 1000);
  assert.equal(numInput("abc"), 0);
  assert.equal(numInput(""), 0);
});
