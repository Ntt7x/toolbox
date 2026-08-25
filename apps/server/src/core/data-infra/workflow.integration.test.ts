// 数据工程集成测试：调度 → 任务 → 派生器 → 消息 → 消费者 全链路
// 覆盖：全链路衍生、派生器 cron 注册调度、missed 补跑、消费者并发、ack 幂等
// 隔离：唯一 id + beforeEach/after 清理（不污染生产 KV）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { registerTask, runTask, listTasks, setTaskNextRun, deleteTask } from "./taskRegistry.js";
import { registerDerivator, getDerivator } from "./derivator.js";
import { registerConsumer, startConsumers, stopConsumers } from "./consumer.js";
import { enqueue, queueStats, dequeue, ack, clearQueue } from "./queue.js";
import { startScheduler, stopScheduler, registerScheduledTask } from "./scheduler.js";
import { kvGet, kvSet, kvDelete } from "../kvStore.js";

const PREFIX = "dataInfra:";
const TASK = "itest-task";
const DERIV = "itest-deriv";

beforeEach(() => {
  for (const id of [TASK, DERIV, "itest-cron", "itest-missed"]) {
    kvDelete(PREFIX + "task:" + id);
    kvDelete(PREFIX + "taskHist:" + id);
    kvDelete(PREFIX + "derivator:" + id);
  }
  for (const q of ["itest:derived", "itest:q"]) clearQueue(q);
  kvDelete("itest:result");
  kvDelete("itest:derived-out");
  stopScheduler();
  stopConsumers();
});

after(() => {
  for (const id of [TASK, DERIV, "itest-cron", "itest-missed"]) {
    kvDelete(PREFIX + "task:" + id);
    kvDelete(PREFIX + "taskHist:" + id);
    kvDelete(PREFIX + "derivator:" + id);
  }
  for (const q of ["itest:derived", "itest:q"]) clearQueue(q);
  kvDelete("itest:result");
  kvDelete("itest:derived-out");
  stopScheduler();
  stopConsumers();
});

test("全链路：任务完成 → 派生器 → 消息 → 消费者 → 衍生数据落库", async () => {
  kvSet("itest:result", { seed: 0 });
  registerTask({ id: TASK, type: "itest", name: "集成任务", handler: async () => { kvSet("itest:result", { seed: 42 }); return { ok: true, message: "ok" }; } });
  registerDerivator({
    id: DERIV,
    when: { taskDone: [TASK] },
    queue: "itest:derived",
    derive: (ctx) => [{ type: "derived", payload: { from: ctx.taskId, seed: kvGet<{ seed?: number }>("itest:result")?.seed } }],
  });
  registerConsumer({
    queue: "itest:derived",
    name: "集成消费者",
    handler: (msg) => { kvSet("itest:derived-out", { got: (msg.payload as any)?.seed }); },  });
  startConsumers();
  const r = await runTask(TASK, { trigger: "manual" });
  assert.equal(r.ok, true);
  await new Promise((res) => setTimeout(res, 300)); // 等消费者循环（50ms 轮询）
  const out = kvGet<{ got?: number }>("itest:derived-out");
  assert.equal(out?.got, 42, "消费者应收到派生消息并落衍生数据");
  assert.equal(queueStats("itest:derived").total, 0, "消费后消息应 ack 移除");
});

test("派生器 cron 注册为调度任务（调度层可见、missed 补跑语义自动获得）", () => {
  registerDerivator({ id: "itest-cron", when: { cron: "0 0 * * *" }, queue: "itest:derived", derive: () => [{ type: "tick", payload: {} }] });
  // 模拟 initDataInfra 的派生器 cron 注册逻辑
  const def = getDerivator("itest-cron");
  assert.ok(def?.when.cron);
  if (def?.when.cron) {
    registerScheduledTask({ id: "itest-cron", type: "derivator", name: "派生器 itest-cron", cron: def.when.cron, handler: async () => ({ ok: true, message: "派生器已触发" }) });
  }
  const t = listTasks().find((x) => x.id === "itest-cron");
  assert.ok(t, "派生器 cron 应作为调度任务可见");
  assert.equal(t?.cron, "0 0 * * *");
  assert.equal(t?.status, "queued");
});

test("调度器 missed 补跑：停机期间错过的任务启动即补跑", async () => {
  let ran = 0;
  registerScheduledTask({
    id: "itest-missed",
    type: "itest",
    name: "missed 测试",
    cron: "0 0 * * *",
    handler: async () => { ran += 1; return { ok: true }; },
  });
  setTaskNextRun("itest-missed", Date.now() - 60 * 1000); // 已过期（模拟停机错过）
  startScheduler();
  await new Promise((res) => setTimeout(res, 600));
  assert.equal(ran, 1, "错过的任务应启动即补跑");
  stopScheduler();
  deleteTask("itest-missed");
});

test("消费者并发：concurrency=2 并行消费多条且无重复投递", async () => {
  let active = 0;
  let maxActive = 0;
  let done = 0;
  registerConsumer({
    queue: "itest:derived",
    name: "并发消费者",
    concurrency: 2,
    handler: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 50));
      active -= 1;
      done += 1;
    },
  });
  startConsumers();
  for (let i = 0; i < 4; i++) enqueue("itest:derived", { i });
  await new Promise((res) => setTimeout(res, 600));
  assert.equal(done, 4, "4 条都应消费");
  assert.equal(maxActive, 2, "并发峰值应为 2");
  assert.equal(queueStats("itest:derived").total, 0);
});

test("ack 重复调用幂等（消息已移除后再次 ack 静默）", () => {
  enqueue("itest:q", { a: 1 });
  const m = dequeue("itest:q");
  assert.ok(m);
  ack("itest:q", m.id, true);
  ack("itest:q", m.id, true); // 重复 ack 不报错
  ack("itest:q", "不存在的id", true);
  assert.equal(queueStats("itest:q").total, 0);
});
