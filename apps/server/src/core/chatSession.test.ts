// ============================================================
// core/chatSession 单测（mock chat，不触网）
// 覆盖：CRUD / 追加 / 失败不污染 / 参数透传 / 压缩 / 两级生命周期 / 恢复 / 过期清理
// ============================================================
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { kvGet, kvSet } from "./kvStore.js";
import {
  createChatSession,
  chatSessionAsk,
  deleteChatSession,
  listChatSessions,
  compactSession,
  restoreArchivedSession,
  SESSION_PREFIX,
  __setChatImplForTest,
  __resetChatImplForTest,
  type ChatSession,
} from "./chatSession.js";
import type { LlmChatMessage, LlmChatResult } from "@toolbox/shared";

const DAY = 24 * 60 * 60 * 1000;
const created: string[] = [];

/** 记录最后一次 chat 收到的 messages/opts */
let seenMessages: LlmChatMessage[] | null = null;
let seenOpts: Record<string, unknown> | null = null;
let failNext = false;
let replyLen = 30;

function installMock() {
  __setChatImplForTest(async (messages, opts) => {
    seenMessages = structuredClone(messages);
    seenOpts = opts ? { ...opts } : {};
    if (failNext) return { ok: false as const, message: "mock 失败" };
    return { ok: true as const, content: "答".repeat(replyLen), model: "mock" };
  });
}

beforeEach(() => {
  seenMessages = null;
  seenOpts = null;
  failNext = false;
  replyLen = 30;
  installMock();
});

afterEach(() => {
  for (const id of created) deleteChatSession(id);
  created.length = 0;
  __resetChatImplForTest();
});

function make(module = "test.chat", system = "你是测试助手。", extra: Record<string, unknown> = {}) {
  const s = createChatSession({ module, system, ...extra });
  created.push(s.id);
  return s;
}

function raw(id: string): ChatSession {
  return kvGet<ChatSession>(SESSION_PREFIX + id)!;
}

test("create + list：基础字段与 active 状态", () => {
  const s = make();
  assert.equal(s.module, "test.chat");
  assert.equal(s.history.length, 0);
  assert.equal(s.droppedTurns, 0);
  const l = listChatSessions().find((x) => x.id === s.id);
  assert.ok(l);
  assert.equal(l.status, "active");
  assert.equal(l.turns, 0);
});

test("ask 成功：messages=[system,user]，history 追加，turns=1", async () => {
  const s = make();
  const r = await chatSessionAsk(s.id, "第一问");
  assert.equal(r.ok, true);
  assert.equal(seenMessages!.length, 2);
  assert.equal(seenMessages![0].role, "system");
  assert.equal(seenMessages![1].content, "第一问");
  assert.equal(raw(s.id).history.length, 2);
  assert.equal(raw(s.id).history[1].content, "答".repeat(replyLen));
  assert.equal(listChatSessions().find((x) => x.id === s.id)!.turns, 1);
});

test("ask 连续轮：前缀 = system + 全部历史 + 新 user（append-only）", async () => {
  const s = make();
  await chatSessionAsk(s.id, "问A");
  await chatSessionAsk(s.id, "问B");
  const msgs = seenMessages!;
  assert.equal(msgs.length, 4);
  assert.deepEqual(
    msgs.map((m) => m.content),
    ["你是测试助手。", "问A", "答".repeat(replyLen), "问B"],
  );
});

test("ask 失败：history 不污染、turns 不变", async () => {
  const s = make();
  await chatSessionAsk(s.id, "第一问");
  const before = raw(s.id).history.length;
  failNext = true;
  const r = await chatSessionAsk(s.id, "会失败");
  assert.equal(r.ok, false);
  assert.equal(raw(s.id).history.length, before);
});

test("参数透传：json/model/search 传给 chat", async () => {
  const s = make("test.chat", "sys", { json: true, model: "deepseek-chat", search: true });
  await chatSessionAsk(s.id, "问");
  assert.equal(seenOpts!.json, true);
  assert.equal(seenOpts!.model, "deepseek-chat");
  assert.equal(seenOpts!.search, true);
  assert.equal(seenOpts!.module, "test.chat");
});

test("压缩：超预算后保留 verbatim tail + 折叠标记 + droppedTurns 累计", async () => {
  replyLen = 6000; // 每轮 user+assistant ≈ 6001 字符 ≈ 1501 tokens；3 轮不触发，4 轮超 6000
  const s = make();
  for (let i = 0; i < 4; i++) await chatSessionAsk(s.id, "问" + i);
  const after = raw(s.id);
  // 4 轮共 8 条 → 仅第 4 轮后触发一次：保留尾部（budget≥4000 且 ≥2 轮）+ 折叠标记
  assert.equal(after.history[0].content, "[compacted 早期历史]");
  assert.ok(after.history.length >= 5, `期望 ≥1 标记 + 4 尾条，实际 ${after.history.length}`);
  assert.equal(after.history[after.history.length - 1].content, "答".repeat(replyLen)); // 最后一条保留 verbatim
  assert.ok(after.droppedTurns >= 2);
});

test("压缩：未达阈值不折叠", async () => {
  const s = make();
  for (let i = 0; i < 2; i++) await chatSessionAsk(s.id, "短问" + i);
  const after = raw(s.id);
  assert.equal(after.history.length, 4);
  assert.notEqual(after.history[0].content, "[compacted 早期历史]");
});

test("两级生命周期：31 天后 list 显示 archived（历史折叠为摘要）", async () => {
  const s = make();
  for (let i = 0; i < 3; i++) await chatSessionAsk(s.id, "第" + i + "问"); // 3 轮（<6000t 不触发压缩）
  const v = raw(s.id);
  kvSetRaw(s.id, { ...v, lastAt: Date.now() - 31 * DAY });
  const l = listChatSessions().find((x) => x.id === s.id);
  assert.equal(l!.status, "archived");
  const archived = raw(s.id);
  assert.equal(archived.archived, true);
  assert.ok(archived.summary!.includes("[compacted 早期历史]")); // 早期轮次折叠标记
  assert.ok(archived.summary!.includes("第2问")); // 最近轮次保留在摘要
  assert.equal(archived.history.length, 0);
});

test("归档恢复：ask 自动注入 [历史摘要] 并重新进入活跃期", async () => {
  const s = make();
  await chatSessionAsk(s.id, "第一问");
  kvSetRaw(s.id, { ...raw(s.id), lastAt: Date.now() - 31 * DAY });
  assert.equal(restoreArchivedSession(s.id)!.archived, false); // 手动恢复一次后再归档（验证幂等恢复）
  kvSetRaw(s.id, { ...raw(s.id), lastAt: Date.now() - 31 * DAY });
  const r = await chatSessionAsk(s.id, "续问");
  assert.equal(r.ok, true);
  assert.ok(seenMessages!.some((m) => m.role === "user" && m.content.startsWith("[历史摘要]")));
  assert.equal(raw(s.id).archived, false);
  assert.equal(listChatSessions().find((x) => x.id === s.id)!.status, "active");
});

test("过期（>360 天）：ask 返回会话不存在，KV 清理", async () => {
  const s = make();
  kvSetRaw(s.id, { ...raw(s.id), lastAt: Date.now() - 400 * DAY });
  const r = await chatSessionAsk(s.id, "还在吗");
  assert.equal(r.ok, false);
  assert.match(r.message, /不存在或已过期/);
  assert.equal(kvGet(SESSION_PREFIX + s.id), null); // kvGet 删除后返回 null
});

test("delete：存在删除 true，不存在 false", () => {
  const s = make();
  assert.equal(deleteChatSession(s.id), true);
  assert.equal(deleteChatSession(s.id), false);
});

test("业务确定性 id：幂等复用（system 相同保留历史）；system 变更重建", async () => {
  deleteChatSession("biz-demo-2026-08"); // 自洁：清除可能残留的固定 id 会话
  const s1 = createChatSession({ id: "biz-demo-2026-08", module: "test.chat", system: "系统A" });
  await chatSessionAsk(s1.id, "问1");
  // 相同 system → 复用（历史保留）
  const s2 = createChatSession({ id: "biz-demo-2026-08", module: "test.chat", system: "系统A" });
  assert.equal(s2.id, s1.id);
  assert.equal(raw(s2.id).history.length, 2);
  // system 变更 → 重建（历史作废）
  const s3 = createChatSession({ id: "biz-demo-2026-08", module: "test.chat", system: "系统B" });
  assert.equal(s3.id, s1.id);
  assert.equal(raw(s3.id).history.length, 0);
  deleteChatSession("biz-demo-2026-08");
});

test("业务确定性 id：非法 id 抛错", () => {
  assert.throws(() => createChatSession({ id: "bad id/../", module: "test.chat", system: "s" }), /非法业务会话 id/);
});

test("temperature 透传：创建时指定则传给 chat", async () => {
  const s = make("test.chat", "sys", { temperature: 0.2 });
  await chatSessionAsk(s.id, "问");
  assert.equal(seenOpts!.temperature, 0.2);
});

test("signal 透传：askOpts.signal 传给 chat", async () => {
  const s = make();
  const ac = new AbortController();
  await chatSessionAsk(s.id, "问", { signal: ac.signal });
  assert.equal(seenOpts!.signal, ac.signal);
});

test("compactSession 手动触发：直接压缩并落盘", async () => {
  replyLen = 6000;
  const s = make();
  for (let i = 0; i < 2; i++) await chatSessionAsk(s.id, "问" + i); // 2 轮 ≈ 3002 tokens，未达阈值
  const before = raw(s.id);
  assert.equal(before.droppedTurns, 0);
  // 伪造超大历史后再手动压缩
  const big = [...Array(12)].map(() => ({ role: "user" as const, content: "大".repeat(3000) }));
  kvSetRaw(s.id, { ...before, history: big });
  compactSession(s.id);
  const after = raw(s.id);
  assert.ok(after.droppedTurns > 0);
  assert.equal(after.history[0].content, "[compacted 早期历史]");
});

// 测试内 KV 直写（模拟时间流逝）
function kvSetRaw(id: string, v: ChatSession) {
  kvSet(SESSION_PREFIX + id, v);
}
