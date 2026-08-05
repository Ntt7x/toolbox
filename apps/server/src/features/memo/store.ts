// ============================================================
// 改进备忘录：数据层（单 KV 文档 memo:items → { items: MemoItem[] }）
// 遵循本地数据治理原则：运行时从 KV 读，用户可在「本地数据管理」页查看/编辑/删除。
// ============================================================

import { kvGet, kvSet } from "../../core/kvStore.js";
import type { MemoItem, MemoStatus } from "@toolbox/shared";

/** KV key（数据源注册名） */
export const MEMO_KEY = "memo:items";

const STATUSES: MemoStatus[] = ["open", "doing", "done"];

export function isMemoStatus(v: unknown): v is MemoStatus {
  return typeof v === "string" && (STATUSES as string[]).includes(v);
}

/** 生成条目 id */
function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalize(item: Partial<MemoItem>): MemoItem | null {
  if (typeof item.id !== "string" || typeof item.text !== "string") return null;
  return {
    id: item.id,
    text: item.text.trim(),
    status: isMemoStatus(item.status) ? item.status : "open",
    createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
  };
}

function readAll(): MemoItem[] {
  const saved = kvGet<{ items?: unknown[] }>(MEMO_KEY);
  if (!Array.isArray(saved?.items)) return [];
  const items = saved.items
    .map((i) => normalize(i as Partial<MemoItem>))
    .filter((x): x is MemoItem => !!x && x.text !== "");
  // 排序：open → doing → done；同状态按更新时间倒序
  const rank: Record<MemoStatus, number> = { open: 0, doing: 1, done: 2 };
  return items.sort((a, b) => rank[a.status] - rank[b.status] || (a.updatedAt < b.updatedAt ? 1 : -1));
}

function writeAll(items: MemoItem[]): void {
  kvSet(MEMO_KEY, { items });
}

/** 全部条目（已排序） */
export function listItems(): MemoItem[] {
  return readAll();
}

/** 新增条目 */
export function createItem(text: string): MemoItem {
  const now = new Date().toISOString();
  const item: MemoItem = { id: genId(), text: text.trim(), status: "open", createdAt: now, updatedAt: now };
  const items = readAll();
  items.push(item);
  writeAll(items);
  return item;
}

/** 更新条目（文本/状态）；无则 null */
export function updateItem(id: string, patch: { text?: string; status?: MemoStatus }): MemoItem | null {
  const items = readAll();
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return null;
  const next: MemoItem = {
    ...items[idx],
    text: typeof patch.text === "string" && patch.text.trim() ? patch.text.trim() : items[idx].text,
    status: patch.status && isMemoStatus(patch.status) ? patch.status : items[idx].status,
    updatedAt: new Date().toISOString(),
  };
  items[idx] = next;
  writeAll(items);
  return next;
}

/** 删除条目 */
export function deleteItem(id: string): boolean {
  const items = readAll();
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return false;
  items.splice(idx, 1);
  writeAll(items);
  return true;
}
