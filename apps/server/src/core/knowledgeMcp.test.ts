// ============================================================
// core/knowledgeMcp 单测：MCP 工具映射（callTool 直测，不触网不 spawn）
// ============================================================
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { callTool } from "./knowledgeMcp.js";
import { kbDelete, kbList } from "./knowledge.js";

const PREFIX = "kb.mcp-test.";
const KEYS = ["kb.mcp-test.fever.treatment", "kb.mcp-test.cold.notes"];

function cleanup(): void {
  for (const k of KEYS) kbDelete(k);
  for (const e of kbList({ prefix: PREFIX, limit: 500 })) kbDelete(e.key);
}

beforeEach(cleanup);
afterEach(cleanup);

test("kb_set + kb_get：写入并可读回", () => {
  const w = callTool("kb_set", { key: KEYS[0], value: "发热可用小柴胡汤", source: "测试" });
  assert.equal(w.isError, false);
  assert.match(w.content[0].text, /已写入 kb\.mcp-test\.fever\.treatment/);
  const r = callTool("kb_get", { key: KEYS[0] });
  assert.equal(r.isError, false);
  assert.match(r.content[0].text, /发热可用小柴胡汤/);
});

test("kb_set 非法 key：返回错误", () => {
  const r = callTool("kb_set", { key: "../escape", value: "x" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /错误/);
});

test("kb_list：实例过滤 + 关键词过滤", () => {
  callTool("kb_set", { key: KEYS[0], value: "发热" });
  callTool("kb_set", { key: KEYS[1], value: "鼻塞" });
  const all = callTool("kb_list", { instance: "kb" });
  assert.equal(all.isError, false);
  assert.match(all.content[0].text, /fever\.treatment/);
  const byQ = callTool("kb_list", { instance: "kb", q: "鼻塞" });
  assert.match(byQ.content[0].text, /cold\.notes/);
  assert.doesNotMatch(byQ.content[0].text, /fever\.treatment/);
});

test("kb_search：命中相关条目", () => {
  callTool("kb_set", { key: KEYS[0], value: "发热恶寒用麻黄汤" });
  callTool("kb_set", { key: KEYS[1], value: "鼻塞流涕用荆防败毒散" });
  const r = callTool("kb_search", { question: "发热恶寒怎么办", instance: "kb" });
  assert.equal(r.isError, false);
  assert.match(r.content[0].text, /麻黄汤/);
  assert.doesNotMatch(r.content[0].text, /荆防败毒散/);
});

test("kb_search 无命中：返回（空）不报错", () => {
  const r = callTool("kb_search", { question: "完全不存在的词汇xyzzy", instance: "kb" });
  assert.equal(r.isError, false);
  assert.match(r.content[0].text, /无匹配/);
});

test("kb_count：实例统计", () => {
  callTool("kb_set", { key: KEYS[0], value: "a" });
  callTool("kb_set", { key: KEYS[1], value: "b" });
  const r = callTool("kb_count", { instance: "kb" });
  assert.match(r.content[0].text, /2 条/);
});

test("kb_delete：删除条目", () => {
  callTool("kb_set", { key: KEYS[0], value: "x" });
  const d = callTool("kb_delete", { key: KEYS[0] });
  assert.match(d.content[0].text, /已删除/);
  assert.equal(kbList({ prefix: KEYS[0], limit: 5 }).length, 0);
});

test("未知工具：返回错误", () => {
  const r = callTool("no_such_tool", {});
  assert.equal(r.isError, true);
});
