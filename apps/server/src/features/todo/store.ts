// ============================================================
// 待办清单：数据层（单 KV 文档 todo:items → { items: TodoItem[] }）
// 遵循本地数据治理原则：运行时从 KV 读，用户可在「本地数据」页查看/编辑/删除。
// 区别于改进备忘录（memo:items，开发者驱动）：todo 是用户日常个人任务。
// ============================================================

import { kvGet, kvSet } from "../../core/kvStore.js";
import type { TodoItem } from "@toolbox/shared";

/** KV key（数据源注册名） */
export const TODO_KEY = "todo:items";

/** 单文档上限（防无限膨胀；超出时丢弃最旧条目） */
const MAX_ITEMS = 200;

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalize(item: Partial<TodoItem>): TodoItem | null {
  if (typeof item.id !== "string" || typeof item.text !== "string") return null;
  return {
    id: item.id,
    text: item.text.trim(),
    done: item.done === true,
    ...(typeof item.parentId === "string" ? { parentId: item.parentId } : {}),
    ...(item.repeat === "daily" || item.repeat === "weekly" || item.repeat === "monthly" ? { repeat: item.repeat } : {}),
    ...(typeof item.lastDoneAt === "string" ? { lastDoneAt: item.lastDoneAt } : {}),
    createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
  };
}

/** 周期期首（本期开始时间）：daily=今天 0 点 / weekly=本周一 0 点 / monthly=本月 1 号 0 点 */
function periodStart(repeat: "daily" | "weekly" | "monthly", now: Date): number {
  if (repeat === "daily") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (repeat === "weekly") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));   // 周一为一周起点
    return d.getTime();
  }
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 孤儿自愈：parentId 指向不存在项的条目提升为顶层（防"删父留子"后子任务不显示） */
function healOrphans(items: TodoItem[]): TodoItem[] {
  const ids = new Set(items.map((x) => x.id));
  return items.map((x) => (x.parentId && !ids.has(x.parentId) ? { ...x, parentId: undefined } : x));
}

function load(): TodoItem[] {
  const raw = kvGet<{ items?: unknown }>(TODO_KEY);
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const norm = items.map((it) => normalize(it as Partial<TodoItem>)).filter((x): x is TodoItem => x !== null);
  const healed = healOrphans(norm);
  // 若发生自愈则持久化（读时修复，任何路径产生的孤儿都收敛）
  if (healed.some((x, i) => x.parentId !== norm[i]?.parentId)) save(healed);
  return healed;
}

function save(items: TodoItem[]) {
  kvSet(TODO_KEY, { items });
}

/** 全部条目（未完成在前，其次按创建时间倒序）；周期项过期（lastDoneAt 早于本期）视为待做 */
export function listTodos(): TodoItem[] {
  const now = Date.now();
  const items = load().map((x) => {
    // 周期项：上次完成在本期之外 → 跨期重置（done=false；不持久化，勾选时才更新）
    if (x.repeat && x.done && x.lastDoneAt) {
      const last = Date.parse(x.lastDoneAt);
      if (Number.isFinite(last) && last < periodStart(x.repeat, new Date(now))) {
        return { ...x, done: false };
      }
    }
    return x;
  });
  return items.sort((a, b) => Number(b.done) - Number(a.done) || b.createdAt.localeCompare(a.createdAt));
}

export function addTodo(text: string, parentId?: string): TodoItem[] {
  const trimmed = text.trim();
  if (!trimmed) return load();
  let items = load();
  // 父任务必须存在（树状依赖；防悬空引用）
  if (parentId && !items.some((x) => x.id === parentId)) parentId = undefined;
  const now = new Date().toISOString();
  items.push({ id: genId(), text: trimmed, done: false, ...(parentId ? { parentId } : {}), createdAt: now, updatedAt: now });
  if (items.length > MAX_ITEMS) {
    items.splice(0, items.length - MAX_ITEMS);
    items = healOrphans(items);   // 截断后孤儿自愈
  }
  save(items);
  return items;
}

/** 收集 id 的全部子孙 id（BFS） */
function descendants(items: TodoItem[], id: string): string[] {
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

/** 更新：切换完成 / 改文本 / 改周期；返回 null 表示条目不存在 */
export function updateTodo(id: string, patch: { done?: boolean; text?: string; repeat?: "daily" | "weekly" | "monthly" | "none" }): TodoItem[] | null {
  const items = load();
  const it = items.find((x) => x.id === id);
  if (!it) return null;
  if (typeof patch.done === "boolean" && it.done !== patch.done) {
    if (patch.done) {
      // 完成：周期项记录 lastDoneAt；级联子孙完成；向上传播（所有直接子完成 → 父完成）
      if (it.repeat) it.lastDoneAt = new Date().toISOString();
      it.done = true;
      for (const d of descendants(items, id)) {
        const t = items.find((x) => x.id === d);
        if (t) t.done = true;
      }
      // 向上传播：若父的所有直接子完成 → 父自动完成（递归向上）
      let cur: TodoItem | undefined = it;
      while (cur && cur.parentId) {
        const parent = items.find((x) => x.id === cur!.parentId);
        if (!parent) break;
        const sibs = items.filter((x) => x.parentId === parent.id);
        if (!sibs.every((x) => x.done)) break;
        parent.done = true;
        cur = parent;
      }
    } else {
      // 取消完成：向上取消父（子未完成 → 父不应保持完成）
      it.done = false;
      let cur: TodoItem | undefined = it;
      while (cur && cur.parentId) {
        const parent = items.find((x) => x.id === cur!.parentId);
        if (!parent) break;
        parent.done = false;
        cur = parent;
      }
    }
  } else if (typeof patch.done === "boolean") {
    it.done = patch.done;
    if (patch.done && it.repeat) it.lastDoneAt = new Date().toISOString();   // 重复点已完成（前端幂等）
  }
  if (typeof patch.text === "string" && patch.text.trim()) it.text = patch.text.trim();
  if (patch.repeat === "none") delete it.repeat;
  else if (patch.repeat === "daily" || patch.repeat === "weekly" || patch.repeat === "monthly") it.repeat = patch.repeat;
  it.updatedAt = new Date().toISOString();
  save(items);
  return items;
}

/** 删除（树状依赖：删除父任务时级联删除其全部子孙任务）；返回 null 表示条目不存在 */
export function deleteTodo(id: string): TodoItem[] | null {
  const items = load();
  const idx = items.findIndex((x) => x.id === id);
  if (idx < 0) return null;
  // 级联：收集 id 的全部子孙（BFS）
  const rm = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const it of items) if (!rm.has(it.id) && it.parentId && rm.has(it.parentId)) { rm.add(it.id); grew = true; }
  }
  const kept = items.filter((x) => !rm.has(x.id));
  save(kept);
  return kept;
}

/** 清空已完成（删 done 项；未完成子任务立即提升顶层，不丢失） */
export function clearDone(): TodoItem[] {
  const kept = healOrphans(load().filter((x) => !x.done));   // 先删 done，再孤儿自愈（子任务提升顶层）
  save(kept);
  return kept;
}
