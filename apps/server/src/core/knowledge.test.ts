// ============================================================
// core/knowledge 单测：KB CRUD + 实例隔离 + key 校验
// 不触网（不调 LLM）；纯 SQLite KV（无文件视图层）
// ============================================================
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { kbSet, kbGet, kbDelete, kbList, kbSetMany, assertValidKey, instanceNameOf, instanceCount, listInstances, instanceStats, clearInstance } from "./knowledge.js";

const TEST_KEYS = ["kb.test.one", "kb.test.two"];
/** 测试全部专用前缀（beforeEach/afterEach 清理，防污染真实知识库） */
const TEST_PREFIXES = ["kb.test.", "kb.quota.", "other.", "solo", "fromagent2"];

function cleanupTestData(): void {
  for (const k of TEST_KEYS) {
    kbDelete(k);
  }
  for (const p of TEST_PREFIXES) {
    for (const e of kbList({ prefix: p, limit: 5000 })) kbDelete(e.key);
  }
}

beforeEach(() => {
  cleanupTestData();
});

afterEach(() => {
  cleanupTestData();
});

test("key 校验：合法通过，非法抛错", () => {
  assertValidKey("project.module.attribute");
  assertValidKey("含中文.知识条目"); // Unicode 中文 key 合法（zhihu 导入中文标题等场景）
  assert.throws(() => assertValidKey(""), /知识 key/);
  assert.throws(() => assertValidKey("a/b"), /知识 key/);
  assert.throws(() => assertValidKey("a b"), /知识 key/);
  assert.throws(() => assertValidKey("..bad..name"), /知识 key/); // 连续点
  assert.throws(() => assertValidKey(".leading"), /知识 key/); // 边界点
  assert.throws(() => assertValidKey("trailing."), /知识 key/); // 边界点
});

test("CRUD：set/get/覆盖/delete/list", () => {
  kbSet("kb.test.one", "值A", "来源X");
  const e = kbGet("kb.test.one")!;
  assert.equal(e.value, "值A");
  assert.equal(e.source, "来源X");
  assert.ok(e.updatedAt);
  // 覆盖
  kbSet("kb.test.one", "值B");
  assert.equal(kbGet("kb.test.one")!.value, "值B");
  // list + 搜索
  assert.ok(kbList({ q: "值B" }).some((x) => x.key === "kb.test.one"));
  // delete
  assert.equal(kbDelete("kb.test.one"), true);
  assert.equal(kbDelete("kb.test.one"), false);
  assert.equal(kbGet("kb.test.one"), null);
});

test("kbSetMany：批量写入 + 非法 key 跳过", () => {
  const n = kbSetMany([
    { key: "kb.test.one", value: "v1" },
    { key: "bad key", value: "v2" }, // 非法，跳过
  ]);
  assert.equal(n, 1);
  assert.equal(kbGet("kb.test.one")!.value, "v1");
  assert.equal(kbGet("bad key"), null);
});

// ---------- 实例隔离 ----------

test("实例模型：首段为实例名；root 实例为单段 key", () => {
  assert.equal(instanceNameOf("cbRate.rate.fed"), "cbRate");
  assert.equal(instanceNameOf("watchlist.notes.600519"), "watchlist");
  assert.equal(instanceNameOf("abc"), "");
  assert.equal(instanceNameOf("abc.def"), "abc");
});

test("实例管理：listInstances / instanceStats / clearInstance 隔离", () => {
  kbSet("kb.test.one", "v1");
  kbSet("other.test.two", "v2");
  kbSet("solo", "root单段"); // root 实例
  const insts = listInstances();
  const kb = insts.find((i) => i.name === "kb");
  assert.ok(kb, "应有 kb 实例");
  assert.equal(kb!.count, 1);
  const stats = instanceStats("kb");
  assert.equal(stats.count, 1);
  assert.ok(stats.bytes > 0);
  // clearInstance 只清本实例
  const n = clearInstance("kb");
  assert.equal(n, 1);
  assert.equal(kbGet("kb.test.one"), null);
  assert.equal(kbGet("other.test.two")!.value, "v2"); // 其他实例不受影响
  assert.equal(kbGet("solo")!.value, "root单段");
});

test("kbList prefix 过滤：实例内列举不串扰", () => {
  kbSet("kb.test.one", "v1");
  kbSet("kb.test.two", "v2");
  kbSet("other.test.x", "v3");
  const kbOnly = kbList({ prefix: "kb." });
  assert.equal(kbOnly.length, 2);
  assert.ok(kbOnly.every((e) => e.key.startsWith("kb.")));
});

test("实例配额：超限拒绝新增（覆盖不拒绝）", async () => {
  const { INSTANCE_LIMIT: _orig, setInstanceLimit } = await import("./knowledge.js");
  // 临时调小上限验证配额逻辑（恢复在 finally）
  setInstanceLimit(3);
  try {
    kbSet("kb.quota.a", "1");
    kbSet("kb.quota.b", "2");
    kbSet("kb.quota.c", "3"); // 满 3
    let rejected = false;
    try {
      kbSet("kb.quota.d", "4");
    } catch {
      rejected = true;
    }
    assert.equal(rejected, true, "超限后新增应抛错");
    // 覆盖已存在 key 不触发配额
    kbSet("kb.quota.a", "覆盖");
    assert.equal(kbGet("kb.quota.a")!.value, "覆盖");
    // 其他实例不受配额影响
    kbSet("other.quota.x", "1");
  } finally {
    setInstanceLimit(500);
    for (const e of kbList({ prefix: "kb.quota." })) kbDelete(e.key);
    for (const e of kbList({ prefix: "other.quota." })) kbDelete(e.key);
  }
});
