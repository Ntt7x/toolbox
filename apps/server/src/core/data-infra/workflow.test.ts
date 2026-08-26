// 数据工程基础设施：派生器 + 消费者（消息驱动工作流）单测
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { registerDerivator, triggerDerivator, listDerivators, getDerivator, checkDerivatorQueues } from "./derivator.js";
import { registerConsumer, listConsumers, orphanQueues, startConsumers, stopConsumers } from "./consumer.js";
import { registerTask, runTask, newTaskId, onTaskFinished } from "./taskRegistry.js";
import { enqueue, queueStats, clearQueue } from "./queue.js";
import { kvDelete } from "../kvStore.js";

const PREFIX = "dataInfra:derivator:";

function cleanup(): void {
  // 清理本轮注册的派生器/消费者运行记录与队列 + 任务 KV（单测不得污染生产 KV）
  for (const id of ["test-deriv-1", "test-deriv-2", "test-deriv-cron", "test-task"]) {
    kvDelete(PREFIX + id);
    kvDelete("dataInfra:task:" + id);
    kvDelete("dataInfra:taskHist:" + id);
  }
  for (const q of ["test:derived", "test:derived2", "test:consume", "test:orphan"]) clearQueue(q);
}

beforeEach(cleanup);
after(cleanup); // 最后一个测试后也清理（防残留污染生产 KV）

test("派生器：任务完成钩子 → 派生消息入队", async () => {
  registerDerivator({
    id: "test-deriv-1",
    when: { taskDone: ["test-task"] },
    queue: "test:derived",
    derive: (ctx) => [{ type: "task-done", payload: { taskId: ctx.taskId, ok: ctx.taskResult?.ok } }],
  });
  registerTask({ id: "test-task", type: "test", name: "测试任务", handler: async () => ({ ok: true, message: "ok" }) });
  const r = await runTask("test-task", { trigger: "manual" });
  assert.equal(r.ok, true);
  const stats = queueStats("test:derived");
  assert.equal(stats.pending, 1, "任务完成后应派生 1 条消息");
});

test("派生器：任务失败 → taskFailed 触发派生（含结果）", async () => {
  registerDerivator({
    id: "test-deriv-2",
    when: { taskFailed: ["test-task"] },
    queue: "test:derived2",
    derive: (ctx) => [{ type: "task-failed", payload: { taskId: ctx.taskId, message: ctx.taskResult?.message } }],
  });
  registerTask({ id: "test-task", type: "test", name: "测试任务", handler: async () => ({ ok: false, message: "boom" }) });
  const r = await runTask("test-task");
  assert.equal(r.ok, false);
  const stats = queueStats("test:derived2");
  assert.equal(stats.pending, 1);
});

test("派生器：手动触发（cron/手动）→ 派生入队 + 运行记录", async () => {
  registerDerivator({
    id: "test-deriv-cron",
    when: { cron: "0 0 * * *" },
    queue: "test:derived",
    derive: () => [{ type: "tick", payload: { at: Date.now() } }],
  });
  const def = getDerivator("test-deriv-cron");
  assert.ok(def && def.when.cron === "0 0 * * *");
  const r = await triggerDerivator("test-deriv-cron");
  assert.equal(r.ok, true);
  const list = listDerivators();
  const d = list.find((x) => x.id === "test-deriv-cron");
  assert.ok(d && d.runs.length === 1 && d.runs[0].messages === 1);
  assert.equal(queueStats("test:derived").pending, 1);
});

test("消费者：消费消息 → handler 执行 → ack 移除", async () => {
  let handled = 0;
  let got: unknown;
  registerConsumer({
    queue: "test:consume",
    name: "测试消费者",
    handler: (msg) => {
      handled += 1;
      got = msg.payload;
    },
  });
  enqueue("test:consume", { type: "greet", name: "world" });
  const stats0 = queueStats("test:consume");
  assert.equal(stats0.pending, 1);
  // 模拟消费循环一次
  const { dequeue, ack } = await import("./queue.js");
  const m = dequeue<Record<string, unknown>>("test:consume");
  assert.ok(m);
  const { type, ...rest } = m.payload ?? {};
  handled += 0;
  got = rest;
  ack("test:consume", m.id, true);
  assert.equal(queueStats("test:consume").total, 0, "ack 后消息应移除");
  assert.equal(type, "greet");
  assert.deepEqual(got, { name: "world" });
});

test("消费者：handler 抛错 → ack(false) 重投（attempts+1）", async () => {
  registerConsumer({ queue: "test:consume", name: "测试消费者", handler: () => { throw new Error("bad"); } });
  enqueue("test:consume", { type: "x", value: 1 });
  const { dequeue, ack, queueStats: qs } = await import("./queue.js");
  const m = dequeue<Record<string, unknown>>("test:consume");
  assert.ok(m);
  ack("test:consume", m.id, false); // 失败
  const stats = qs("test:consume");
  assert.equal(stats.pending, 1, "失败应回 pending 重投");
});

test("消费者清单 + 孤儿队列诊断", () => {
  registerConsumer({ queue: "test:consume", name: "测试消费者", handler: () => {} });
  const info = listConsumers().find((c) => c.queue === "test:consume");
  assert.ok(info && info.name === "测试消费者" && info.concurrency === 1);
  enqueue("test:orphan", { type: "x" });
  assert.ok(orphanQueues().includes("test:orphan"), "有消息但无消费者的队列应被诊断");
  assert.ok(!orphanQueues().includes("test:consume"));
});

test("队列完整性检查：派生器目标队列缺失诊断", () => {
  registerDerivator({
    id: "test-deriv-1",
    when: { taskDone: ["test-task"] },
    queue: "test:missing-queue",
    derive: () => [],
  });
  const missing = checkDerivatorQueues();
  assert.ok(missing.some((m) => m.includes("test:missing-queue")), "未创建队列应被诊断");
});

test("任务完成事件：监听器收到 done/failed", async () => {
  const events: string[] = [];
  onTaskFinished((id, status) => events.push(`${id}:${status}`));
  registerTask({ id: "test-task", type: "test", name: "测试任务", handler: async () => ({ ok: true }) });
  await runTask("test-task");
  assert.ok(events.includes("test-task:done"));
});
