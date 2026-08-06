// ============================================================
// core/knowledge 单测：KB CRUD + 目录同步（.file/k）+ key 校验
// 不触网（不调 LLM）
// ============================================================
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { kbSet, kbGet, kbDelete, kbList, kbSetMany, kbSyncToDir, kbSyncFromDir, KB_ROOT_DIR, assertValidKey } from "./knowledge.js";

const TEST_KEYS = ["kb.test.one", "kb.test.two"];

beforeEach(() => {
  for (const k of TEST_KEYS) {
    try {
      kbDelete(k);
      unlinkSync(join(KB_ROOT_DIR, k));
    } catch {
      // 忽略
    }
  }
});

afterEach(() => {
  for (const k of TEST_KEYS) {
    try {
      kbDelete(k);
      unlinkSync(join(KB_ROOT_DIR, k));
    } catch {
      // 忽略
    }
  }
});

test("key 校验：合法通过，非法抛错", () => {
  assertValidKey("project.module.attribute");
  assert.throws(() => assertValidKey(""), /知识 key/);
  assert.throws(() => assertValidKey("含中文"), /知识 key/);
  assert.throws(() => assertValidKey("a/b"), /知识 key/);
  assert.throws(() => assertValidKey("a b"), /知识 key/);
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

test("目录同步：KV → .file/k 物化；Agent 写文件 → 同步回 KV", () => {
  // 物化（读路径）
  kbSet("kb.test.one", "知识内容");
  kbSyncToDir();
  const f = join(KB_ROOT_DIR, "kb.test.one");
  assert.ok(existsSync(f), "应物化为 .file/k/kb.test.one");
  assert.equal(readFileSync(f, "utf8"), "知识内容");
  // 写回（Agent 写文件 → watcher/kbSyncFromDir 同步回 KV）
  mkdirSync(KB_ROOT_DIR, { recursive: true });
  writeFileSync(f, "Agent 更新内容", "utf8");
  const changed = kbSyncFromDir();
  assert.ok(changed >= 1);
  assert.equal(kbGet("kb.test.one")!.value, "Agent 更新内容");
  assert.equal(kbGet("kb.test.one")!.source, "agent-write");
});

test("目录同步：Agent 删除文件 → 知识库同步删除", () => {
  kbSet("kb.test.one", "内容");
  kbSyncToDir();
  unlinkSync(join(KB_ROOT_DIR, "kb.test.one"));
  const changed = kbSyncFromDir();
  assert.ok(changed >= 1);
  assert.equal(kbGet("kb.test.one"), null);
});

test("目录同步：非法文件名不写入 KV（防穿越）", () => {
  mkdirSync(KB_ROOT_DIR, { recursive: true });
  writeFileSync(join(KB_ROOT_DIR, "..bad..name"), "x", "utf8"); // 含非法字符
  const before = kbList({}).length;
  kbSyncFromDir();
  assert.equal(kbList({}).length, before, "非法文件名应被跳过");
  unlinkSync(join(KB_ROOT_DIR, "..bad..name"));
});

test("KB_ROOT_DIR 位于 .file 下（git 隔离）", () => {
  assert.ok(KB_ROOT_DIR.includes(".file"), `KB_ROOT_DIR 应在 .file 下：${KB_ROOT_DIR}`);
});
