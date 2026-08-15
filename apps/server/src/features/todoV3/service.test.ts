// ============================================================
// 待办清单 v3 单测（Cordis 框架：Context + 服务注册 + 业务规则）
// 运行：node scripts/dev-utils/test.mjs todoV3
// ⚠️ 数据安全（2026-08-14 教训）：单测不得清空生产 KV！beforeEach 备份
// todoV3:items、afterEach 恢复——测试污染后回到测试前状态，不丢用户数据。
// ============================================================
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { kvGet, kvSet } from "../../core/kvStore.js";
import { TODO_V3_KEY, TodoStoreService, TodoSchedulerService, TodoResolverService } from "./services.js";

/** 测试前后备份/恢复 todoV3:items（防止单测清空生产数据） */
let backup: unknown = null;
beforeEach(() => {
  backup = kvGet(TODO_V3_KEY) ?? { items: [] };
});
afterEach(() => {
  kvSet(TODO_V3_KEY, backup ?? { items: [] });
});

/** 创建挂载好三个服务的 Cordis Context（对应 context.ts 的单例逻辑） */
async function makeCtx(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(TodoStoreService as any);
  await ctx.plugin(TodoSchedulerService as any);
  await ctx.plugin(TodoResolverService as any);
  return ctx;
}

test("Cordis 服务注册：ctx.todoV3Store/Scheduler/Resolver 可访问", async () => {
  const ctx = await makeCtx();
  assert.ok(ctx.todoV3Store instanceof TodoStoreService, "store 服务已注册");
  assert.ok(ctx.todoV3Scheduler instanceof TodoSchedulerService, "scheduler 服务已注册");
  assert.ok(ctx.todoV3Resolver instanceof TodoResolverService, "resolver 服务已注册");
  // 服务间依赖：resolver 消费 store + scheduler
  const items = ctx.todoV3Resolver.listView();
  assert.ok(Array.isArray(items));
});

test("Cordis 业务：DAG blocked / 解锁 / 环拒绝 / 引用自愈 / 周期", async () => {
  const ctx = await makeCtx();
  const store = ctx.todoV3Store;
  // 1. A、B（B 依赖 A）→ B blocked
  const r1 = store.create("前置");
  assert.ok(r1.ok);
  const a = r1.items.find((x) => x.text === "前置")!;
  const r2 = store.create("后置", { dependencies: [a.id] });
  assert.ok(r2.ok);
  const b = r2.items.find((x) => x.text === "后置")!;
  const view = () => ctx.todoV3Resolver.views(store.list());
  let bv = view().find((x) => x.id === b.id)!;
  assert.equal(bv.blocked, true);
  assert.deepEqual(bv.blockedBy, [a.id]);
  // 2. blocked 禁止完成
  const r3 = store.update(b.id, { done: true });
  assert.equal(r3 && "ok" in r3 && r3.ok, false);
  // 3. 完成 A → B 解锁
  store.update(a.id, { done: true });
  bv = view().find((x) => x.id === b.id)!;
  assert.equal(bv.blocked, false);
  // 4. 环拒绝
  const r4 = store.create("环C", { dependencies: [b.id] });
  assert.ok(r4.ok);
  const c = r4.items.find((x) => x.text === "环C")!;
  const r5 = store.update(b.id, { dependencies: [c.id] });
  assert.equal(r5 && "ok" in r5 && r5.ok, false);
  // 5. 周期跨期
  store.update(a.id, { repeat: "daily", done: true });
  const raw = kvGet<{ items: { id: string; lastDoneAt?: string }[] }>(TODO_V3_KEY)!;
  const t = raw.items.find((x) => x.id === a.id)!;
  t.lastDoneAt = new Date(Date.now() - 86_400_000).toISOString();
  kvSet(TODO_V3_KEY, raw);
  assert.equal(store.list().find((x) => x.id === a.id)?.done, false);   // 跨期待做
  // 6. 删除 C → B 的 C 引用自愈（仍保留对 A 的依赖）；A 已跨期待做 → B 仍被 A 阻塞
  store.remove(c.id);
  bv = view().find((x) => x.id === b.id)!;
  assert.deepEqual(bv.dependencies, [a.id]);
  assert.equal(bv.blocked, true);
});

test("分解树：children/progress + 级联完成 + 向上传播 + 组合环 + 级联删除 + 孤儿自愈", async () => {
  const ctx = await makeCtx();
  const store = ctx.todoV3Store;
  const resolver = ctx.todoV3Resolver;
  // 1. 父 + 两个子 → children/progress
  const r1 = store.create("父任务");
  assert.ok(r1.ok);
  const p = r1.items.find((x) => x.text === "父任务")!;
  store.create("子A", { parentId: p.id });
  store.create("子B", { parentId: p.id });
  let views = resolver.views(store.list());
  let pv = views.find((x) => x.id === p.id)!;
  assert.equal(pv.children.length, 2);
  assert.deepEqual(pv.progress, { done: 0, total: 2 });
  // 2. 完成父 → 子级联完成（聚合语义）
  store.update(p.id, { done: true });
  views = resolver.views(store.list());
  const kids = views.filter((x) => x.parentId === p.id);
  assert.ok(kids.every((k) => k.done), "子任务级联完成");
  assert.deepEqual(views.find((x) => x.id === p.id)!.progress, { done: 2, total: 2 });
  // 3. 取消父 → 父取消（不级联子）
  store.update(p.id, { done: false });
  views = resolver.views(store.list());
  assert.equal(views.find((x) => x.id === p.id)!.done, false);
  // 4. 子全完成 → 父自动完成（向上传播）
  const ids = views.filter((x) => x.parentId === p.id).map((x) => x.id);
  for (const cid of ids) store.update(cid, { done: true });
  views = resolver.views(store.list());
  assert.equal(views.find((x) => x.id === p.id)!.done, true, "子全完成父自动完成");
  // 5. 组合环：X 是 Y 的父 + X 依赖 Y → 拒绝
  const r2 = store.create("顶层X");
  assert.ok(r2.ok);
  const x = r2.items.find((x) => x.text === "顶层X")!;
  const r3 = store.create("环Y", { parentId: x.id });
  assert.ok(r3.ok);
  const y = r3.items.find((x) => x.text === "环Y")!;
  const r4 = store.update(x.id, { dependencies: [y.id] });   // X 依赖 Y（Y 是 X 的子）→ 组合环
  assert.equal(r4 && "ok" in r4 && r4.ok, false);
  // 6. 级联删除：删父 → 子也删；依赖引用清理
  store.update(x.id, { dependencies: [] });
  const r5 = store.create("孤叶", { dependencies: [y.id] });
  assert.ok(r5.ok);
  const leaf = r5.items.find((x) => x.text === "孤叶")!;
  store.remove(x.id);                                          // 删 X → Y 级联删 → 孤叶的 Y 引用清理
  views = resolver.views(store.list());
  const leaf2 = views.find((x) => x.id === leaf.id)!;
  assert.deepEqual(leaf2.dependencies, []);
  assert.equal(views.some((x) => x.id === y.id || x.text === "顶层X"), false);
  // 7. 孤儿自愈：手工造 parentId 悬空 → list 提升顶层
  const raw = kvGet<{ items: { id: string; parentId?: string; text: string }[] }>(TODO_V3_KEY)!;
  const t = raw.items.find((x) => x.text === "孤叶")!;
  t.parentId = "not-exist";
  kvSet(TODO_V3_KEY, raw);
  assert.equal(store.list().find((x) => x.id === leaf.id)?.parentId, undefined, "孤儿提升顶层");
});

test("scheduler 服务：isDue 跨期判定（消费 store）", async () => {
  const ctx = await makeCtx();
  const r = ctx.todoV3Store.create("每日", { repeat: "daily" });
  assert.ok(r.ok);
  const a = r.items.find((x) => x.text === "每日")!;
  ctx.todoV3Store.update(a.id, { done: true });
  const now = Date.now();
  assert.equal(ctx.todoV3Scheduler.isDue(ctx.todoV3Store.list().find((x) => x.id === a.id)!, now), true);   // 本期完成
  const raw = kvGet<{ items: { id: string; lastDoneAt?: string }[] }>(TODO_V3_KEY)!;
  raw.items.find((x) => x.id === a.id)!.lastDoneAt = new Date(now - 86_400_000).toISOString();
  kvSet(TODO_V3_KEY, raw);
  assert.equal(ctx.todoV3Scheduler.isDue(ctx.todoV3Store.list().find((x) => x.id === a.id)!, now), false);  // 跨期待做
});

// ---------- closed todo 归档（手动 + 到期自动） ----------

test("归档：仅已完成可手动归档 + 恢复 + 归档区列表", async () => {
  const ctx = await makeCtx();
  const store = ctx.todoV3Store;
  const r1 = store.create("做完了的事");
  assert.ok(r1.ok);
  const a = r1.items.find((x) => x.text === "做完了的事")!;
  // 未完成不可归档
  const bad = store.archive(a.id);
  assert.equal(bad && "ok" in bad && bad.ok, false);
  // 完成 → 归档
  store.update(a.id, { done: true });
  const r2 = store.archive(a.id);
  assert.ok(r2 && "ok" in r2 && r2.ok);
  assert.ok(!store.list().some((x) => x.id === a.id), "主列表隐藏");
  assert.ok(store.listArchived().some((x) => x.id === a.id), "归档区可见");
  // 恢复
  const r3 = store.restore(a.id);
  assert.ok(r3 && r3.ok);
  assert.ok(store.list().some((x) => x.id === a.id), "恢复回主列表");
  assert.ok(!store.listArchived().some((x) => x.id === a.id), "归档区移除");
});

test("自动归档：非周期已完成超 3 天保留期 → 读时自动归档（幂等）；周期项不自动归档", async () => {
  const ctx = await makeCtx();
  const store = ctx.todoV3Store;
  const r1 = store.create("三天前完成的事");
  assert.ok(r1.ok);
  const a = r1.items.find((x) => x.text === "三天前完成的事")!;
  store.update(a.id, { done: true });
  // 把 done 时间改成 4 天前（非周期项 lastDoneAt 无，用 updatedAt——直接把 KV 里该条 updatedAt 改旧）
  const raw = kvGet<{ items: { id: string; updatedAt?: string; repeat?: string }[] }>(TODO_V3_KEY)!;
  const it = raw.items.find((x) => x.id === a.id)!;
  it.updatedAt = new Date(Date.now() - 4 * 86_400_000).toISOString();
  kvSet(TODO_V3_KEY, raw);
  // 读 → 自动归档
  assert.ok(!store.list().some((x) => x.id === a.id), "已自动归档出主列表");
  assert.ok(store.listArchived().some((x) => x.id === a.id), "进入归档区");
  // 幂等：再读一次不重复归档
  store.list();
  assert.equal(store.listArchived().filter((x) => x.id === a.id).length, 1);
  // 周期项不受自动归档影响
  const r2 = store.create("每日任务", { repeat: "daily" });
  assert.ok(r2.ok);
  const b = r2.items.find((x) => x.text === "每日任务")!;
  store.update(b.id, { done: true });
  const raw2 = kvGet<{ items: { id: string; updatedAt?: string; repeat?: string }[] }>(TODO_V3_KEY)!;
  const bit = raw2.items.find((x) => x.id === b.id)!;
  bit.updatedAt = new Date(Date.now() - 4 * 86_400_000).toISOString();
  kvSet(TODO_V3_KEY, raw2);
  assert.ok(store.list().some((x) => x.id === b.id), "周期项保留在主列表（不自动归档）");
});

test("清空已完成：已归档的保留在归档区", async () => {
  const ctx = await makeCtx();
  const store = ctx.todoV3Store;
  const r1 = store.create("归档的事");
  assert.ok(r1.ok);
  const a = r1.items.find((x) => x.text === "归档的事")!;
  store.update(a.id, { done: true });
  store.archive(a.id);
  const r2 = store.create("直接清的事");
  assert.ok(r2.ok);
  const b = r2.items.find((x) => x.text === "直接清的事")!;
  store.update(b.id, { done: true });
  store.clearDone();
  assert.ok(!store.list().some((x) => x.id === b.id), "未归档已完成被清掉");
  assert.ok(store.listArchived().some((x) => x.id === a.id), "已归档保留");
});

