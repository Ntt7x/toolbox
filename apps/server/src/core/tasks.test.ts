// ============================================================
// 通用异步任务管理器单测（core/tasks）
// 重点：超时/取消终态不可被迟到的结果覆盖（"卡死"修复回归）
// 运行：node <tsx> --test apps/server/src/core/tasks.test.ts
// ============================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelTask, createTask, getTask } from "./tasks.js";
import type { AsyncTaskResult } from "@toolbox/shared";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** getTask 总是返回 ok:true（任务存在），此辅助做类型收窄 */
function task<T>(id: string): Extract<AsyncTaskResult<T>, { ok: true }> {
  const t = getTask<T>(id);
  assert.ok(t && t.ok, `任务 ${id} 应存在`);
  return t as Extract<AsyncTaskResult<T>, { ok: true }>;
}

/** 轮询等待任务进入指定终态 */
async function waitFor(id: string, states: string[], maxMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const t = getTask(id);
    if (t && t.ok && states.includes(t.status)) return;
    await sleep(50);
  }
}

test("任务正常完成 → done", async () => {
  const { taskId } = createTask<number>(async () => 42, { timeoutMs: 5000 });
  await waitFor(taskId, ["done"]);
  const t = task<number>(taskId);
  assert.equal(t.status, "done");
  assert.equal(t.result, 42);
});

test("超时自动终止（fn 挂起不返回）→ error", async () => {
  const { taskId } = createTask<number>(
    () => new Promise<number>(() => {}), // 永不 resolve
    { timeoutMs: 300 },
  );
  await waitFor(taskId, ["error"]);
  const t = task(taskId);
  assert.equal(t.status, "error");
  assert.match(t.message ?? "", /超时/);
});

test("超时后 fn 迟到返回 → 终态保持 error 不被覆盖（卡死修复回归）", async () => {
  const { taskId } = createTask<number>(async () => {
    await sleep(800); // 比超时长，超时后仍正常返回
    return 999;
  }, { timeoutMs: 200 });
  await waitFor(taskId, ["error"]);
  await sleep(900); // 等迟到结果返回
  const t = task(taskId);
  assert.equal(t.status, "error", "迟到结果不得覆盖超时 error 终态");
  assert.equal(t.result, undefined, "迟到结果不得写入");
});

test("取消 → cancelled 且 fn 收到 abort 信号", async () => {
  let aborted = false;
  const { taskId } = createTask<number>(
    (signal) =>
      new Promise<number>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve(0);
        });
      }),
    { timeoutMs: 10000 },
  );
  assert.ok(cancelTask(taskId));
  await waitFor(taskId, ["cancelled"]);
  const t = task(taskId);
  assert.equal(t.status, "cancelled");
  assert.ok(aborted);
});

test("取消后 fn 迟到返回 → 终态保持 cancelled", async () => {
  const { taskId } = createTask<number>(async () => {
    await sleep(500);
    return 7;
  }, { timeoutMs: 10000 });
  assert.ok(cancelTask(taskId));
  await sleep(700);
  const t = task(taskId);
  assert.equal(t.status, "cancelled");
  assert.equal(t.result, undefined);
});

test("取消不存在的任务 → false", () => {
  assert.equal(cancelTask("no-such-task"), false);
});
