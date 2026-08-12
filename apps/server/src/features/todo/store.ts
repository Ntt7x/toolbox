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
    createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
  };
}

function load(): TodoItem[] {
  const raw = kvGet<{ items?: unknown }>(TODO_KEY);
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return items.map((it) => normalize(it as Partial<TodoItem>)).filter((x): x is TodoItem => x !== null);
}

function save(items: TodoItem[]) {
  kvSet(TODO_KEY, { items });
}

/** 全部条目（未完成在前，其次按创建时间倒序） */
export function listTodos(): TodoItem[] {
  const items = load();
  return items.sort((a, b) => Number(b.done) - Number(a.done) || b.createdAt.localeCompare(a.createdAt));
}

export function addTodo(text: string, parentId?: string): TodoItem[] {
  const trimmed = text.trim();
  if (!trimmed) return load();
  const items = load();
  // 父任务必须存在（树状依赖；防悬空引用）
  if (parentId && !items.some((x) => x.id === parentId)) parentId = undefined;
  const now = new Date().toISOString();
  items.push({ id: genId(), text: trimmed, done: false, ...(parentId ? { parentId } : {}), createdAt: now, updatedAt: now });
  if (items.length > MAX_ITEMS) items.splice(0, items.length - MAX_ITEMS);
  save(items);
  return items;
}

/** 更新：切换完成 / 改文本 / 改周期；返回 null 表示条目不存在 */
export function updateTodo(id: string, patch: { done?: boolean; text?: string; repeat?: "daily" | "weekly" | "monthly" | "none" }): TodoItem[] | null {
  const items = load();
  const it = items.find((x) => x.id === id);
  if (!it) return null;
  if (typeof patch.done === "boolean") it.done = patch.done;
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

/** 清空已完成 */
export function clearDone(): TodoItem[] {
  const items = load().filter((x) => !x.done);
  save(items);
  return items;
}
