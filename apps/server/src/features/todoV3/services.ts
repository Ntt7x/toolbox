// ============================================================
// 待办清单 v3：Cordis 服务层（@deepseek-ai/cordis 4.x）
// 参照 Cordis 教程（deepseek-harness cordis-tutorial 01/02/03）：
//   - 服务 = 插件提供、其他插件通过 ctx 消费的具名能力（Service 类 + declare module）
//   - TodoStoreService（存储 CRUD）→ TodoSchedulerService（周期）→ TodoResolverService（视图）
// THESIS：分解（parentId 包含树）与依赖（dependencies 前置 DAG）是正交维度——
//   parentId 定义"任务由哪些子任务组成"（聚合完成），dependencies 定义"执行的前置条件"
//   （阻塞语义）。二者共存时规则必须组合而非叠加：
//   ① 组合环检测：Kahn 拓扑把 parentId 边（子→父）与 dependencies 边统一建图
//   ② 级联删除 × 依赖引用自愈合并（删父递归删子孙 + 清空对它们的依赖引用）
//   ③ 父完成 = 全部子完成（勾选父级联子；子全完成父自动完成，向上传播）
//   ④ 周期跨期递归重置（父跨期待做 → 子孙同步待做）
//   ⑤ 孤儿自愈（parentId 悬空提升顶层，读时修复持久化）
// ============================================================
import { Service, type Context } from "@deepseek-ai/cordis";
import { kvGet, kvSet } from "../../core/kvStore.js";
import type { TodoItemV3, TodoItemV3View } from "@toolbox/shared";

export const TODO_V3_KEY = "todoV3:items";
const MAX_ITEMS = 200;

// ---------- 基础工具 ----------

const REPEATS = ["daily", "weekly", "monthly"] as const;
export type Repeat = (typeof REPEATS)[number];

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalize(item: Partial<TodoItemV3>): TodoItemV3 | null {
  if (typeof item.id !== "string" || typeof item.text !== "string") return null;
  return {
    id: item.id,
    text: item.text.trim(),
    done: item.done === true,
    ...(typeof item.parentId === "string" && item.parentId !== item.id ? { parentId: item.parentId } : {}),
    dependencies: Array.isArray(item.dependencies) ? item.dependencies.filter((d): d is string => typeof d === "string" && d !== item.id) : [],
    ...(REPEATS.includes(item.repeat as Repeat) ? { repeat: item.repeat as Repeat } : {}),
    ...(typeof item.lastDoneAt === "string" ? { lastDoneAt: item.lastDoneAt } : {}),
    createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
  };
}

function loadAll(): TodoItemV3[] {
  const raw = kvGet<{ items?: unknown }>(TODO_V3_KEY);
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return items.map((it) => normalize(it as Partial<TodoItemV3>)).filter((x): x is TodoItemV3 => x !== null);
}

/** 周期期首（本期开始时间）：daily=今天 0 点 / weekly=本周一 0 点 / monthly=本月 1 号 0 点 */
function periodStart(repeat: Repeat, now: Date): number {
  if (repeat === "daily") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (repeat === "weekly") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  }
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 周期项在本期是否"已完成"（跨期自动重置为待做） */
function periodResolved(x: TodoItemV3, now: number): boolean {
  if (!x.repeat) return x.done;
  if (!x.done) return false;
  if (!x.lastDoneAt) return x.done;
  const last = Date.parse(x.lastDoneAt);
  return Number.isFinite(last) && last >= periodStart(x.repeat, new Date(now));
}

/** 收集 id 的全部子孙 id（BFS，沿 parentId） */
function descendants(items: TodoItemV3[], id: string): string[] {
  const out: string[] = [];
  let frontier = items.filter((x) => x.parentId === id).map((x) => x.id);
  while (frontier.length > 0) {
    out.push(...frontier);
    const next: string[] = [];
    for (const f of frontier) next.push(...items.filter((x) => x.parentId === f).map((x) => x.id));
    frontier = next;
  }
  return out;
}

/** 孤儿自愈：parentId 指向不存在项（或自身）→ 提升顶层 */
function healOrphans(items: TodoItemV3[]): TodoItemV3[] {
  const ids = new Set(items.map((x) => x.id));
  return items.map((x) => (x.parentId && !ids.has(x.parentId) ? { ...x, parentId: undefined } : x));
}

// ============================================================
// 服务 1：TodoStoreService（存储：CRUD + 树操作 + 组合环检测 + 引用自愈）
// ============================================================

export class TodoStoreService extends Service {
  constructor(ctx: Context) {
    super(ctx, "todoV3Store");
  }

  /** 全部条目（孤儿自愈 + 跨期递归重置 + 未完成在前排序；不做 blocked 计算——由 Resolver 负责） */
  list(): TodoItemV3[] {
    const now = Date.now();
    let items = loadAll();
    // 孤儿自愈（读时修复 + 持久化）：parentId 悬空提升顶层
    const healed = healOrphans(items);
    if (healed.some((x, i) => x.parentId !== items[i]?.parentId)) {
      kvSet(TODO_V3_KEY, { items: healed });
      items = healed;
    }
    // 周期跨期：父跨期 → 递归重置子孙（④）
    const reset = new Set<string>();
    for (const x of items) {
      if (x.repeat && x.done && x.lastDoneAt) {
        const last = Date.parse(x.lastDoneAt);
        if (Number.isFinite(last) && last < periodStart(x.repeat, new Date(now))) reset.add(x.id);
      }
    }
    if (reset.size > 0) {
      // 递归收集子孙（父重置 → 子同步待做）
      let grew = true;
      while (grew) {
        grew = false;
        for (const x of items) if (x.parentId && reset.has(x.parentId) && !reset.has(x.id)) { reset.add(x.id); grew = true; }
      }
      items = items.map((x) => (reset.has(x.id) ? { ...x, done: false } : x));
    }
    return items.sort((a, b) => Number(b.done) - Number(a.done) || b.createdAt.localeCompare(a.createdAt));
  }

  /** 组合环检测（①）：Kahn 拓扑把 parentId 边（子依赖父）与 dependencies 边统一建图。
   *  parent 链 × dependency 链交叉成环（A 是 B 的子 + B 依赖 A）也能检测 */
  hasCycle(items: TodoItemV3[]): boolean {
    const ids = new Set(items.map((x) => x.id));
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const it of items) { inDegree.set(it.id, 0); adj.set(it.id, []); }
    const addEdge = (from: string, to: string) => {
      if (!ids.has(from) || !ids.has(to) || from === to) return;
      adj.get(from)!.push(to);
      inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
    };
    for (const it of items) {
      for (const d of it.dependencies) addEdge(d, it.id);                 // dependencies：d → it（it 依赖 d）
      if (it.parentId) addEdge(it.parentId, it.id);                      // parent：父 → 子（子依赖父完成）
    }
    const queue = [...inDegree.entries()].filter(([, deg]) => deg === 0).map(([id]) => id);
    let count = 0;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      count++;
      for (const next of adj.get(cur) ?? []) {
        const deg = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, deg);
        if (deg === 0) queue.push(next);
      }
    }
    return count !== ids.size;
  }

  /** 引用自愈：删除 id 集后所有依赖它们的任务自动清空引用（不在此 save，调用方统一 save） */
  healDependencies(items: TodoItemV3[], removedIds: Set<string>): TodoItemV3[] {
    return items.map((x) =>
      x.dependencies.some((d) => removedIds.has(d))
        ? { ...x, dependencies: x.dependencies.filter((d) => !removedIds.has(d)) }
        : x
    );
  }

  create(text: string, opts: { dependencies?: string[]; repeat?: Repeat; parentId?: string } = {}): { ok: true; items: TodoItemV3[] } | { ok: false; message: string } {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, message: "内容不能为空" };
    const items = loadAll();
    const ids = new Set(items.map((x) => x.id));
    // parentId 必须存在且不能是自身（悬空 → 忽略）
    const parentId = opts.parentId && ids.has(opts.parentId) && opts.parentId !== "self" ? opts.parentId : undefined;
    // 新建任务的 parentId 也参与环检测（父链与依赖链交叉）
    const deps = [...new Set((opts.dependencies ?? []).filter((d) => ids.has(d)))];
    const now = new Date().toISOString();
    items.push({
      id: genId(), text: trimmed, done: false, dependencies: deps,
      ...(parentId ? { parentId } : {}),
      ...(opts.repeat ? { repeat: opts.repeat } : {}),
      createdAt: now, updatedAt: now,
    });
    if (this.hasCycle(items)) return { ok: false, message: "依赖关系形成环（含父子链交叉），无法创建" };
    if (items.length > MAX_ITEMS) items.splice(0, items.length - MAX_ITEMS);
    kvSet(TODO_V3_KEY, { items });
    return { ok: true, items: this.list() };
  }

  update(
    id: string,
    patch: { done?: boolean; text?: string; dependencies?: string[]; repeat?: Repeat | "none"; parentId?: string | "none" }
  ): { ok: true; items: TodoItemV3[] } | { ok: false; message: string } | null {
    const items = loadAll();
    const it = items.find((x) => x.id === id);
    if (!it) return null;
    // 前置依赖未全部完成 → 禁止完成（阻塞语义；跨树依赖也纳入）
    if (patch.done === true && !it.done) {
      const now = Date.now();
      const doneSet = new Map(items.map((x) => [x.id, periodResolved(x, now)]));
      const blockedBy = it.dependencies.filter((d) => !doneSet.get(d));
      if (blockedBy.length > 0) return { ok: false, message: `前置任务未完成（${blockedBy.length} 个），无法完成` };
    }
    if (typeof patch.done === "boolean") {
      it.done = patch.done;
      if (patch.done && it.repeat) it.lastDoneAt = new Date().toISOString();
      if (patch.done && !it.repeat) {
        // 完成父任务 → 级联子完成（③ 聚合语义）；子全完成 → 父自动完成（向上传播）
        const setTreeDone = (tid: string, done: boolean, touched: Set<string>) => {
          touched.add(tid);
          const t = items.find((x) => x.id === tid);
          if (!t) return;
          t.done = done;
          if (done && t.repeat) t.lastDoneAt = new Date().toISOString();
          for (const child of items.filter((x) => x.parentId === tid)) setTreeDone(child.id, done, touched);
        };
        if (patch.done) {
          const touched = new Set<string>();
          setTreeDone(id, true, touched);
          // 向上传播：父的所有直接子完成 → 父自动完成（递归）
          let cur: TodoItemV3 | undefined = items.find((x) => x.id === id);
          while (cur && cur.parentId) {
            const parent = items.find((x) => x.id === cur!.parentId);
            if (!parent) break;
            const sibs = items.filter((x) => x.parentId === parent.id);
            if (!sibs.every((x) => x.done)) break;
            if (!touched.has(parent.id)) { parent.done = true; if (parent.repeat) parent.lastDoneAt = new Date().toISOString(); }
            cur = parent;
          }
        } else {
          // 取消完成：向上取消父（子未完成 → 父不应保持完成）
          let cur: TodoItemV3 | undefined = items.find((x) => x.id === id);
          while (cur && cur.parentId) {
            const parent = items.find((x) => x.id === cur!.parentId);
            if (!parent) break;
            parent.done = false;
            cur = parent;
          }
        }
      }
    }
    if (typeof patch.text === "string" && patch.text.trim()) it.text = patch.text.trim();
    if (Array.isArray(patch.dependencies)) {
      const ids = new Set(items.map((x) => x.id));
      it.dependencies = [...new Set(patch.dependencies.filter((d) => d !== id && ids.has(d)))];
    }
    if (patch.parentId === "none") delete it.parentId;
    else if (typeof patch.parentId === "string") {
      const ids = new Set(items.map((x) => x.id));
      it.parentId = patch.parentId !== id && ids.has(patch.parentId) ? patch.parentId : undefined;
    }
    if (patch.repeat === "none") delete it.repeat;
    else if (patch.repeat) it.repeat = patch.repeat;
    it.updatedAt = new Date().toISOString();
    if (this.hasCycle(items)) return { ok: false, message: "依赖关系形成环（含父子链交叉），无法保存" };
    kvSet(TODO_V3_KEY, { items });
    return { ok: true, items: this.list() };
  }

  /** 删除（② 级联 + 引用自愈）：删父递归删子孙；其他任务对它们的依赖引用自动清空 */
  remove(id: string): { ok: true; items: TodoItemV3[] } | null {
    const items = loadAll();
    if (!items.some((x) => x.id === id)) return null;
    const rm = new Set([id, ...descendants(items, id)]);
    const kept = healOrphans(
      this.healDependencies(items.filter((x) => !rm.has(x.id)), rm)
    );
    kvSet(TODO_V3_KEY, { items: kept });
    return { ok: true, items: this.list() };
  }

  /** 清空已完成：删 done 项 + 依赖引用清理 + 孤儿自愈（未完成子提升顶层） */
  clearDone(): { ok: true; items: TodoItemV3[] } {
    const items = loadAll();
    const removed = new Set(items.filter((x) => x.done).map((x) => x.id));
    const kept = healOrphans(
      this.healDependencies(items.filter((x) => !removed.has(x.id)), removed)
    );
    kvSet(TODO_V3_KEY, { items: kept });
    return { ok: true, items: this.list() };
  }
}

// ============================================================
// 服务 2：TodoSchedulerService（周期调度：消费 TodoStoreService）
// ============================================================

export class TodoSchedulerService extends Service {
  constructor(ctx: Context) {
    super(ctx, "todoV3Scheduler");
  }

  /** 周期期首（对外暴露，供 resolver 使用） */
  periodStartOf(repeat: Repeat, now: Date): number {
    return periodStart(repeat, now);
  }

  /** 本期是否已完成（跨期自动待做） */
  isDue(item: TodoItemV3, now: number): boolean {
    return periodResolved(item, now);
  }
}

// ============================================================
// 服务 3：TodoResolverService（反应式视图：blocked + children + progress）
// ============================================================

export class TodoResolverService extends Service {
  constructor(ctx: Context) {
    super(ctx, "todoV3Resolver");
  }

  /** 视图计算：blocked（依赖阻塞）+ children（直接子）+ progress（子孙完成率） */
  views(items: TodoItemV3[]): TodoItemV3View[] {
    const now = Date.now();
    const sched = this.ctx.todoV3Scheduler;
    const doneSet = new Map(items.map((x) => [x.id, sched.isDue(x, now)]));
    const byParent = new Map<string, string[]>();
    for (const x of items) {
      if (!x.parentId) continue;
      const arr = byParent.get(x.parentId) ?? [];
      arr.push(x.id);
      byParent.set(x.parentId, arr);
    }
    return items.map((x) => {
      const blockedBy = x.dependencies.filter((d) => !doneSet.get(d));
      const children = byParent.get(x.id) ?? [];
      // 子孙完成率（递归计算所有子孙）
      let progress: { done: number; total: number } | undefined;
      if (children.length > 0) {
        const sub = descendants(items, x.id);
        const doneCount = sub.filter((d) => doneSet.get(d)).length;
        progress = { done: doneCount, total: sub.length };
      }
      return { ...x, blocked: blockedBy.length > 0, blockedBy, children, ...(progress ? { progress } : {}) };
    });
  }

  /** 列表视图（store.list + resolver.views 的组合入口） */
  listView(): TodoItemV3View[] {
    return this.views(this.ctx.todoV3Store.list());
  }
}

// ============================================================
// declare module：把三个服务加入 Context 接口（编译时类型安全；不生成运行时代码）
// ============================================================

declare module "@deepseek-ai/cordis" {
  interface Context {
    todoV3Store: TodoStoreService;
    todoV3Scheduler: TodoSchedulerService;
    todoV3Resolver: TodoResolverService;
  }
}
