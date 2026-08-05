// ============================================================
// 康复笔记：数据层（单 KV 文档 rehab:<id>）
// 遵循本地数据治理原则：运行时从 KV 读；种子数据（工厂默认值）
// 幂等 seed（KV 无才写入，不覆盖用户编辑）；用户可在页面/本地数据管理编辑。
// ============================================================

import { kvGet, kvSet } from "../../core/kvStore.js";
import type { RehabNote, RehabNoteSection } from "@toolbox/shared";
import { REHAB_SEEDS } from "./seeds.js";

/** KV key 前缀（数据源注册名） */
export const PREFIX = "rehab:";

const KNOWN_IDS = Object.keys(REHAB_SEEDS);

/** 校验并规整分区数据 */
function normalizeSections(sections: unknown): RehabNoteSection[] | null {
  if (!Array.isArray(sections)) return null;
  const out: RehabNoteSection[] = [];
  for (const s of sections) {
    if (!s || typeof s !== "object") return null;
    const r = s as Record<string, unknown>;
    if (typeof r.title !== "string" || !r.title.trim()) return null;
    if (!Array.isArray(r.items)) return null;
    const items = [];
    for (const it of r.items) {
      if (!it || typeof it !== "object") return null;
      const ir = it as Record<string, unknown>;
      if (typeof ir.detail !== "string") return null;
      items.push({
        ...(typeof ir.name === "string" && ir.name.trim() ? { name: ir.name.trim() } : {}),
        detail: ir.detail.trim(),
      });
    }
    out.push({ title: r.title.trim(), items });
  }
  return out.length > 0 ? out : null;
}

function keyOf(id: string): string {
  return `${PREFIX}${id}`;
}

/** 笔记是否存在（已知 id） */
export function isKnownNote(id: string): boolean {
  return KNOWN_IDS.includes(id);
}

/** 读取笔记（无 → 幂等 seed 默认值后返回） */
export function getNote(id: string): RehabNote | null {
  const seed = REHAB_SEEDS[id];
  if (!seed) return null;
  const saved = kvGet<RehabNote>(keyOf(id));
  if (saved && Array.isArray(saved.sections)) {
    return { ...saved, id };
  }
  kvSet(keyOf(id), seed); // 幂等 seed
  return seed;
}

/** 保存笔记（整体覆盖；title/sections 校验） */
export function saveNote(id: string, patch: { title?: string; sections?: unknown }): RehabNote | null {
  const current = getNote(id);
  if (!current) return null;
  const sections = patch.sections !== undefined ? normalizeSections(patch.sections) : null;
  if (patch.sections !== undefined && !sections) return null;
  const next: RehabNote = {
    ...current,
    title: typeof patch.title === "string" && patch.title.trim() ? patch.title.trim() : current.title,
    ...(sections ? { sections } : {}),
    updatedAt: new Date().toISOString(),
  };
  kvSet(keyOf(id), next);
  return next;
}

/** 重置为默认种子 */
export function resetNote(id: string): RehabNote | null {
  const seed = REHAB_SEEDS[id];
  if (!seed) return null;
  const fresh: RehabNote = { ...seed, updatedAt: new Date().toISOString() };
  kvSet(keyOf(id), fresh);
  return fresh;
}
