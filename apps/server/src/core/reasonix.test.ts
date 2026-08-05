// ============================================================
// core/reasonix 单测（注册表生命周期；不依赖真实 ACP 会话）
// 覆盖：过期清理 / 归档 close 静默 / 损坏数据防御 / rpc 二进制缺失兜底
// ============================================================
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { kvSet, kvGet, kvListRaw, kvDelete } from "./kvStore.js";
import { listReasonixSessions, createReasonixSession, reasonixAsk, shutdownReasonix, ACTIVE_MS, ARCHIVE_MS, type ReasonixSessionReg } from "./reasonix.js";
import { setSetting, deleteSetting } from "./settingsStore.js";

const DAY = 24 * 60 * 60 * 1000;
const REG_PREFIX = "reasonixSession:";

beforeEach(() => {
  // 强制二进制解析失败（坏路径）：单测不真实 spawn ACP，覆盖 rpc 兜底路径
  setSetting("llm.reasonixBin", "C:\\__no_such_reasonix__\\reasonix.exe");
});

afterEach(() => {
  deleteSetting("llm.reasonixBin");
  shutdownReasonix(); // 确保测试不残留 ACP 子进程（否则 test runner 挂起）
  // 清理本测试写入的注册表
  for (const r of kvListRaw(REG_PREFIX, 200)) {
    const v = JSON.parse(r.value);
    if (v.__test) kvDelete(r.key);
  }
});

function requireKV() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("./kvStore.js") as typeof import("./kvStore.js");
}

function makeReg(over: Partial<ReasonixSessionReg> = {}): ReasonixSessionReg {
  const now = Date.now();
  return {
    id: "rx-test-" + Math.random().toString(36).slice(2, 8),
    reasonixSessionId: "sess-" + Math.random().toString(36).slice(2, 8),
    cwd: process.cwd(),
    module: "test.reasonix",
    createdAt: now,
    lastAt: now,
    ttlMs: ACTIVE_MS,
    __test: true, // 测试标记
    ...over,
  } as ReasonixSessionReg & { __test?: boolean };
}

function seedReg(reg: ReasonixSessionReg) {
  kvSet(REG_PREFIX + reg.id, reg);
}

test("注册表过期（>360 天）：list 清理并删除 KV", () => {
  const reg = makeReg({ lastAt: Date.now() - 400 * DAY });
  seedReg(reg);
  const l = listReasonixSessions();
  assert.ok(!l.some((x) => x.id === reg.id));
  assert.equal(kvGet(REG_PREFIX + reg.id), null);
});

test("注册表归档（31 天）：list 保留注册表（close 静默，不崩）", () => {
  const reg = makeReg({ lastAt: Date.now() - 31 * DAY });
  seedReg(reg);
  const l = listReasonixSessions(); // 归档态触发 rpc close：二进制存在/缺失都不应崩
  assert.ok(l.some((x) => x.id === reg.id));
});

test("损坏的注册表 JSON：list 跳过不崩", () => {
  kvSet(REG_PREFIX + "rx-bad-json", "{not valid json");
  const l = listReasonixSessions();
  assert.ok(Array.isArray(l));
});

test("createReasonixSession：二进制缺失时返回 ok:false 不抛", async () => {
  const r = await createReasonixSession({ module: "test.reasonix" });
  assert.equal(r.ok, false); // 坏路径配置 → rpc 兜底 error，不 spawn 不抛
  assert.match(r.message!, /reasonix/);
});

test("reasonixAsk：不存在的会话返回 ok:false（归档期文案）", async () => {
  const r = await reasonixAsk("rx-no-such-session", "你好");
  assert.equal(r.ok, false);
  assert.match(r.message!, /不存在或已过期/);
});

test("生命周期常量：活跃 30 天 / 归档 360 天", () => {
  assert.equal(ACTIVE_MS, 30 * DAY);
  assert.equal(ARCHIVE_MS, 360 * DAY);
});
