// 数据工程基础设施单测（queue / taskRegistry / scheduler 解析）
import { test } from "node:test";
import assert from "node:assert/strict";
import { CronExpressionParser } from "cron-parser";
import { enqueue, dequeue, ack, queueStats, clearQueue, clearQueueAudit, listQueues, queueAudit, requeueStale } from "./queue.js";
import { registerTask, runTask, listTasks, listTaskHistory, setTaskStatus, deleteTask } from "./taskRegistry.js";

const Q = "test-q-" + Date.now();

test("队列：入队→取出（processing）→确认完成（移除）", () => {
  clearQueue(Q);
  const id = enqueue(Q, { a: 1 });
  assert.ok(id);
  const got = dequeue<{ a: number }>(Q);
  assert.equal(got?.id, id);
  assert.equal(got?.payload.a, 1);
  assert.equal(queueStats(Q).processing, 1);
  ack(Q, id, true);
  assert.equal(queueStats(Q).total, 0);
  clearQueue(Q);
});

test("队列：失败重投（attempts+1）→ 超最大尝试丢弃", () => {
  clearQueue(Q);
  const id = enqueue(Q, { x: 1 });
  for (let i = 1; i <= 5; i++) {
    const got = dequeue(Q);
    assert.equal(got?.id, id);
    ack(Q, id, false);
  }
  // 5 次失败后 attempts>=5 → 状态 failed（不再投递）
  assert.equal(dequeue(Q), null);
  assert.equal(queueStats(Q).failed, 1);
  clearQueue(Q);
});

test("队列：TTL 过期消息不投递", async () => {
  clearQueue(Q);
  enqueue(Q, { old: 1 }, { ttlMs: 1 }); // 1ms 后过期
  enqueue(Q, { fresh: 2 });
  await new Promise((r) => setTimeout(r, 10)); // 等第一个过期
  const got = dequeue<{ fresh: number }>(Q);
  assert.equal(got?.payload.fresh, 2);
  clearQueue(Q);
});

test("队列：requeueStale 恢复处理超时的 processing 消息", async () => {
  clearQueue(Q);
  enqueue(Q, { a: 1 });
  const got = dequeue(Q); // 标记 processing（processedAt = now）
  assert.ok(got);
  // 未超时（ageMs 很大）→ 不恢复
  assert.equal(requeueStale(Q, 60 * 1000), 0);
  // 超时（ageMs=0 → 立即过期）→ 恢复 pending
  assert.equal(requeueStale(Q, 0), 1);
  const again = dequeue(Q); // 恢复后可再次投递
  assert.ok(again);
  ack(Q, again.id, true);
  clearQueue(Q);
});

test("队列：ack 记录消费审计（done/failed + type + 时间）", () => {
  clearQueue(Q);
  clearQueueAudit(Q);
  enqueue(Q, { type: "test-event", v: 1 });
  const m = dequeue(Q);
  assert.ok(m);
  ack(Q, m.id, true);
  const entries = queueAudit(Q);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "done");
  assert.equal(entries[0].type, "test-event");
  assert.ok(entries[0].at > 0);
  // 失败 ack 也记录（failed）
  enqueue(Q, { type: "bad-event", v: 2 });
  const m2 = dequeue(Q);
  assert.ok(m2);
  ack(Q, m2.id, false);
  const entries2 = queueAudit(Q);
  assert.equal(entries2.length, 2);
  assert.equal(entries2[1].status, "failed");
  clearQueueAudit(Q);
  clearQueue(Q);
});

test("队列：listQueues 汇总", () => {
  clearQueue(Q);
  enqueue(Q, { a: 1 });
  const names = listQueues();
  assert.ok(names.includes(Q));
  clearQueue(Q);
});

test("任务：注册→执行（done）→历史归档", async () => {
  const id = "test-task-" + Date.now();
  registerTask({ id, type: "test", name: "测试任务", handler: async () => ({ ok: true, message: "完成" }) });
  const r = await runTask(id, { trigger: "manual" });
  assert.equal(r.ok, true);
  const t = listTasks().find((x) => x.id === id);
  assert.equal(t?.status, "done");
  assert.equal(t?.lastResult, "完成");
  const hist = listTaskHistory(id);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].trigger, "manual");
  deleteTask(id);
});

test("任务：失败→failed 状态 + 历史", async () => {
  const id = "test-fail-" + Date.now();
  registerTask({ id, type: "test", name: "失败任务", handler: async () => ({ ok: false, message: "出错了" }) });
  const r = await runTask(id);
  assert.equal(r.ok, false);
  const t = listTasks().find((x) => x.id === id);
  assert.equal(t?.status, "failed");
  assert.equal(listTaskHistory(id)[0]?.message, "出错了");
  deleteTask(id);
});

test("任务：暂停后拒绝执行 / 恢复可执行", async () => {
  const id = "test-pause-" + Date.now();
  registerTask({ id, type: "test", name: "暂停任务", handler: async () => ({ ok: true }) });
  setTaskStatus(id, "paused");
  const r1 = await runTask(id);
  assert.equal(r1.ok, false);
  assert.match(r1.message ?? "", /暂停/);
  setTaskStatus(id, "queued");
  const r2 = await runTask(id);
  assert.equal(r2.ok, true);
  deleteTask(id);
});

test("任务：失败重试（maxRetries=2 成功）→ 历史含重试记录", async () => {
  const id = "test-retry-" + Date.now();
  let calls = 0;
  registerTask({ id, type: "test", name: "重试任务", handler: async () => {
    calls += 1;
    return calls >= 3 ? { ok: true, message: "第三次成功" } : { ok: false, message: `第 ${calls} 次失败` };
  } });
  const r = await runTask(id, { maxRetries: 2 });
  assert.equal(r.ok, true);
  assert.equal(calls, 3, "失败 2 次后第 3 次成功");
  const hist = listTaskHistory(id);
  assert.ok(hist.some((h) => h.status === "failed"), "历史应含重试失败记录");
  assert.equal(listTasks().find((x) => x.id === id)?.status, "done");
  deleteTask(id);
});

test("任务：重试仍失败 → failed（历史含全部尝试）", async () => {
  const id = "test-retryfail-" + Date.now();
  let calls = 0;
  registerTask({ id, type: "test", name: "重试失败任务", handler: async () => {
    calls += 1;
    return { ok: false, message: `第 ${calls} 次失败` };
  } });
  const r = await runTask(id, { maxRetries: 2 });
  assert.equal(r.ok, false);
  assert.equal(calls, 3, "失败 + 2 次重试");
  const hist = listTaskHistory(id);
  assert.equal(hist.filter((h) => h.status === "failed").length, 3, "3 次尝试均应记录");
  deleteTask(id);
});

test("任务：并发防重（running 中拒绝第二次）", async () => {
  const id = "test-conc-" + Date.now();
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  registerTask({ id, type: "test", name: "并发任务", handler: async () => { await gate; return { ok: true }; } });
  const p1 = runTask(id);
  await new Promise((r) => setTimeout(r, 20)); // 确保进入 running
  const r2 = await runTask(id);
  assert.equal(r2.ok, false);
  assert.match(r2.message ?? "", /并发/);
  release();
  await p1;
  deleteTask(id);
});

test("调度：cron-parser 解析下一触发点", () => {
  const it = CronExpressionParser.parse("0 30 16 * * *", { currentDate: new Date("2026-08-24T10:00:00") });
  const next = it.next().toDate();
  assert.equal(next.getHours(), 16);
  assert.equal(next.getMinutes(), 30);
  // 次日（今天 16:30 已过）
  const it2 = CronExpressionParser.parse("0 30 16 * * *", { currentDate: new Date("2026-08-24T17:00:00") });
  const next2 = it2.next().toDate();
  assert.equal(next2.getDate(), 25);
});
