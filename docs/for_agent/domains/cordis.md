# Cordis 框架实践（@deepseek-ai/cordis 4.x）

> 待办事项 v3 使用 Cordis 框架（DeepSeek Harness 底层插件框架）的完整实践沉淀。
> 参考资料：https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/

## 1. 核心概念（照教程 01/02/03）

- **Context（ctx）**：共享上下文。所有能力（工具/LLM/服务）都是挂载到 ctx 的插件。
- **Service 服务**：插件提供、其他插件通过 ctx 消费的具名能力。三要素：
  1. `class X extends Service` + `constructor(ctx) { super(ctx, "服务名") }`
  2. `declare module "@deepseek-ai/cordis" { interface Context { 服务名: X } }`（编译时类型，不生成代码）
  3. `ctx.plugin(X)` 挂载（服务注册属于 effect，卸载自动移除）
- **Plugin 插件**：函数/类/`{apply}` 对象；`ctx.plugin(plugin)` 挂载，返回 fiber。
- **Fiber 生命周期**：PENDING→LOADING→ACTIVE→UNLOADING→DISPOSED；`await fiber` 等待启动。
- **ctx.effect(fn)**：包装 Cordis 不管理的资源（定时器/连接），返回 disposer。

## 2. 服务间依赖

```ts
class TodoSchedulerService extends Service {
  constructor(ctx) { super(ctx, "todoV3Scheduler"); }
  isDue(item) { return periodResolved(item, Date.now()); }
}
class TodoResolverService extends Service {
  constructor(ctx) { super(ctx, "todoV3Resolver"); }
  views(items) {
    const sched = this.ctx.todoV3Scheduler;   // 通过 ctx 消费其他服务（类型安全）
    ...
  }
}
```
服务名扁平命名空间，自有服务加辨识度前缀（`todoV3*`）。

## 3. 与 Hono 集成（关键坑）

**`ctx.plugin()` 是异步的**（fiber 启动 PENDING→ACTIVE）——同步返回 ctx 时服务可能未注册（undefined）：
```ts
// context.ts：Promise 缓存 + 幂等
let ctxPromise: Promise<Context> | null = null;
export function getTodoV3Ctx(): Promise<Context> {
  if (!ctxPromise) {
    ctxPromise = (async () => {
      const c = new Context();
      await c.plugin(todoV3Plugin);   // 等待 fiber ACTIVE（服务注册完成）
      return c;
    })();
  }
  return ctxPromise;
}
// 路由：每个 handler await getTodoV3Ctx()
app.get("/api/tools/todo-v3", async (c) => {
  const ctx = await getTodoV3Ctx();
  return c.json({ ok: true, items: ctx.todoV3Resolver.listView() });
});
```

## 4. 踩坑记录

1. **Service 类必须写显式 constructor**：缺省继承 `Service(ctx, name)`，挂载时 config 被当 name（注册名空 → 服务 undefined）。
2. **`ctx.plugin()` 异步**：同步访问服务 = undefined；必须 await fiber。
3. **npm 4.0.1 签名 `plugin(plugin, config)`** 与教程（vendor 版 1 参）不同——服务类挂载 `ctx.plugin(X as any)` 兼容（config 无需）。
4. **`ctx.dispose()` 不存在**（4.0.1）——测试清理用 fiber.dispose 或不管（进程退出）。
5. **嵌套挂载**：`ctx.plugin({apply})` 里再 `ctx.plugin(子服务)`——子服务随父 fiber 生命周期，卸载级联。

## 5. 数据安全（2026-08-14 重大教训）

**单测不得清空生产 KV**！todoV3 单测曾用 `finally { kvSet(KEY, {items:[]}) }` 清空——跑全量单测时**清掉了迁移进来的用户真实数据**（v1 17 条全部丢失，仅从对话历史重建 13 条）。

**正确模式（beforeEach 备份 / afterEach 恢复）**：
```ts
import { test, beforeEach, afterEach } from "node:test";
let backup: unknown = null;
beforeEach(() => { backup = kvGet(TODO_V3_KEY) ?? { items: [] }; });
afterEach(() => { kvSet(TODO_V3_KEY, backup ?? { items: [] }); });
```
**所有操作真实 KV 的单测必须遵守**：测试污染后回到测试前状态，不丢用户数据。

## 6. 本次业务实践：分解树 × 依赖 DAG 正交合并

Thesis：**分解（parentId 包含树）与依赖（dependencies 前置 DAG）是正交维度**——parentId 定义"任务由哪些子任务组成"（聚合完成），dependencies 定义"执行的前置条件"（阻塞语义）。共存时规则必须组合：
1. **组合环检测**：Kahn 拓扑把 parentId 边（子→父）与 dependencies 边统一建图——父链 × 依赖链交叉成环也能检测
2. **级联删除 × 依赖引用自愈**：删父递归删子孙 + 清空其他任务对它们的依赖引用
3. **父完成 = 全部子完成**：勾选父级联子；子全完成父自动完成（向上传播）；取消子向上取消父
4. **周期跨期递归重置**：父跨期待做 → 子孙同步待做
5. **孤儿自愈**：parentId 悬空提升顶层（读时修复 + 持久化）
6. **视图**：children（直接子）+ progress（子孙完成率递归计算）
