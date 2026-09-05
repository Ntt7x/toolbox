// ============================================================
// 自选股·标的列表装配（features/watchlist/pipeline/rows）
// ------------------------------------------------------------
// 重构前的两个问题（都在 index.ts 的 toRows / treeWithAvg 里）：
//   ① 重复取数：`/tags` 接口先调 treeWithAvg()（内部 toRows 一次），再调 toRows()
//      一次 —— 同一批标的的行情快照被拉了两遍（首屏最重的开销被翻倍）。
//   ② 血缘缺失：toRows 完全不产 meta，取数失败的标的在页面上只是「没数字」，
//      用户无法区分「停牌」与「行情源挂了」。
//
// 改法：
//   · 装配结果（rows + pctByCode）**一次算出、多处复用** —— treeWithAvg 直接吃
//     rowsEffect 的产物，不再二次取数；
//   · 血缘随结果一起返回，缺失/降级写进 meta.caveats（前端可见）。
// ============================================================

import { Effect } from "effect";
import type { QuoteSnapshot, WatchItem, WatchItemRow } from "@toolbox/shared";
import { NET_CONCURRENCY } from "../../../core/concurrency.js";
import { allOrdered } from "../../../core/effect/concurrency.js";
import { getAlertRules, getReviews, updateItem } from "../store.js";
import { resolveStockName } from "../service.js";
import { Lineage, WATCH_SOURCES } from "./lineage.js";
import { fundSnapshots, quoteSnapshots } from "./sources.js";

/** 单次行情批量上限（与公共行情接口一致） */
const QUOTES_BATCH = 40;

/** 快照精简记录（股票用 price，基金用 nav → 统一成 price） */
interface SnapRec {
  pct?: number;
  price?: number;
  name?: string;
}

/** 装配结果：rows 与入参 items 同序；pctByCode 供 tag 树算等权平均复用 */
export interface RowsBundle {
  readonly rows: WatchItemRow[];
  /** 代码 → 日涨跌幅（仅含取数成功的；供 tag 平均复用，避免二次取数） */
  readonly pctByCode: Map<string, number>;
  /** 代码 → 当前行情已触发的提醒条数 */
  readonly triggeredByCode: Map<string, number>;
  /** 本次链路的血缘（sources / fromCache / degraded / caveats） */
  readonly lineage: Lineage;
}

function chunk<T>(arr: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** 快照 → 精简记录（双键索引：normCode 与裸码，兼容用户任意写法） */
function indexSnapshots(
  out: Map<string, SnapRec>,
  list: readonly { ok: boolean; code: string; pct?: number; name?: string; price?: number; nav?: number }[],
): void {
  for (const q of list) {
    if (!q.ok) continue;
    const rec: SnapRec = {};
    if (typeof q.pct === "number") rec.pct = q.pct;
    // 基金没有 price 字段，净值在 nav → 统一成 price，下游只认一个键
    const price = typeof q.price === "number" ? q.price : typeof q.nav === "number" ? q.nav : undefined;
    if (typeof price === "number") rec.price = price;
    if (typeof q.name === "string" && q.name) rec.name = q.name;
    out.set(q.code, rec);
    const bare = q.code.replace(/^(sh|sz|hk|bj)/, "");
    if (bare !== q.code) out.set(bare, rec);
  }
}

/** 批量拉快照（股票/基金分组；分批有界并发） */
function loadSnapshots(
  stockCodes: string[],
  fundCodes: string[],
): Effect.Effect<{ snapByCode: Map<string, SnapRec>; notes: string[] }, never> {
  return Effect.gen(function* () {
    const notes: string[] = [];
    const snapByCode = new Map<string, SnapRec>();
    // 股票与基金走不同源（类型不同），分批后并发；批量取数失败的批 → notes
    const [stockRes, fundRes] = yield* Effect.all(
      [
        Effect.all(
          chunk(stockCodes, QUOTES_BATCH).map((c) => quoteSnapshots(c)),
          { concurrency: 4 },
        ),
        Effect.all(
          chunk(fundCodes, QUOTES_BATCH).map((c) => fundSnapshots(c)),
          { concurrency: 4 },
        ),
      ],
      { concurrency: 2 },
    );
    for (const r of stockRes) {
      notes.push(...r.notes);
      indexSnapshots(snapByCode, r.snapshots as QuoteSnapshot[]);
    }
    for (const list of fundRes) indexSnapshots(snapByCode, list);
    return { snapByCode, notes };
  });
}

/** 已触发提醒数（纯计算：当前行情 × 标的规则，不额外取数） */
function countTriggered(snap: SnapRec | undefined, code: string): number {
  return getAlertRules(code).filter((r) => {
    if (!r.enabled) return false;
    if (r.kind === "price") {
      return typeof snap?.price === "number" && (r.dir === "up" ? snap.price >= r.threshold : snap.price <= r.threshold);
    }
    if (typeof snap?.pct !== "number") return false;
    return r.dir === "up" ? snap.pct >= r.threshold : snap.pct <= -r.threshold;
  }).length;
}

/** 单标的 → 行（纯装配，无取数） */
function toRow(it: WatchItem, snap: SnapRec | undefined, triggered: number): WatchItemRow {
  const history = getReviews(it.code);
  const last = history.length > 0 ? history[history.length - 1] : null;
  // 待复核：有理由/预期但从未复核，或最近一次结论非 hold
  const needReview = Boolean((it.reason || it.expectation) && (!last || last.suggestion !== "hold"));
  // 缺名标的：先用本次已取的快照名回填（零额外成本），拿不到再走行情工具二次解析
  const resolvedName = !it.name ? snap?.name || "" : it.name;
  return {
    code: it.code,
    ...(resolvedName ? { name: resolvedName } : {}),
    ...(it.kind ? { kind: it.kind } : {}),
    reason: it.reason,
    ...(it.expectation ? { expectation: it.expectation } : {}),
    ...(typeof it.targetPrice === "number" ? { targetPrice: it.targetPrice } : {}),
    addedAt: it.addedAt,
    tags: it.tags,
    ...(typeof snap?.price === "number" ? { price: snap.price } : {}),
    // 平盘 pct=0 正常下发（0 是合法值，前端显示 0.00%；停牌股行情源同样返回 0 → 一并显示 0.00%）
    ...(typeof snap?.pct === "number" ? { pct: snap.pct } : {}),
    ...(needReview ? { reviewCount: 1 } : {}),
    ...(triggered > 0 ? { alertCount: triggered } : {}),
  };
}

/**
 * 缺名标的的名称回填：快照名优先（零成本），缺失才走行情工具二次解析；
 * 解析成功写回 KV，避免下次仍显示代码。失败不阻塞（名称是展示项，不是数据项）。
 */
function backfillNames(items: readonly WatchItem[], snapByCode: Map<string, SnapRec>): Effect.Effect<string[], never> {
  const pending = items.filter((it) => !it.name);
  const notes: string[] = [];
  return Effect.map(
    allOrdered(pending, NET_CONCURRENCY, (it) =>
      Effect.tryPromise({
        try: async () => {
          const name = snapByCode.get(it.code)?.name || (await resolveStockName(it.code, it.kind));
          if (name) updateItem(it.code, { name });
          return null;
        },
        catch: () => `${it.code} 名称解析失败`,
      }).pipe(Effect.catchAll((note) => Effect.succeed(note))),
    ),
    (rs) => {
      for (const r of rs) if (r) notes.push(r);
      return notes;
    },
  );
}

/** 标的列表装配（Effect 版）：批量快照 → 提醒命中计数 → 行装配 → 缺名回填 */
export function rowsEffect(items: readonly WatchItem[]): Effect.Effect<RowsBundle, never> {
  return Effect.gen(function* () {
    const line = new Lineage();
    if (items.length === 0) return { rows: [], pctByCode: new Map(), triggeredByCode: new Map(), lineage: line };

    const stockCodes = [...new Set(items.filter((i) => i.kind !== "fund").map((i) => i.code))];
    const fundCodes = [...new Set(items.filter((i) => i.kind === "fund").map((i) => i.code))];
    if (stockCodes.length > 0) line.add(WATCH_SOURCES.quote);
    if (fundCodes.length > 0) line.add(WATCH_SOURCES.fund);

    const { snapByCode, notes } = yield* loadSnapshots(stockCodes, fundCodes);
    for (const n of notes) line.note(n);

    const triggeredByCode = new Map<string, number>();
    const pctByCode = new Map<string, number>();
    for (const it of items) {
      const snap = snapByCode.get(it.code);
      const n = countTriggered(snap, it.code);
      if (n > 0) triggeredByCode.set(it.code, n);
      if (typeof snap?.pct === "number") pctByCode.set(it.code, snap.pct);
    }

    // 取数失败的标的：明确标注「缺失原因」，而不是让前端显示一片空白
    const missed = items.filter((it) => !snapByCode.has(it.code)).map((it) => it.code);
    if (missed.length > 0) line.note(`${missed.length} 个标的未取到行情快照（${missed.slice(0, 5).join("、")}${missed.length > 5 ? " 等" : ""}）`);

    const rows = items.map((it) => toRow(it, snapByCode.get(it.code), triggeredByCode.get(it.code) ?? 0));

    const nameNotes = yield* backfillNames(items, snapByCode);
    for (const n of nameNotes) line.note(n);

    return { rows, pctByCode, triggeredByCode, lineage: line };
  });
}
