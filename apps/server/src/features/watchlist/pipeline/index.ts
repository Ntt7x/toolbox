// ============================================================
// 自选股·数据管道（features/watchlist/pipeline）统一出口
// ------------------------------------------------------------
// 本目录是自选股**唯一**的取数/编排入口，路由层（index.ts）只做
// 参数解析 + 调用本目录 + 组装响应。
//
//   lineage.ts —— 血缘累加器（sources / fromCache / degraded / caveats 唯一出口）
//   sources.ts —— 数据源 Effect 封装（快照 / 基金净值 / 日K / 分时 / 新闻）
//   rows.ts    —— 标的列表装配（批量快照 + 提醒命中 + 缺名回填）
//   track.ts   —— 行情跟踪采集（快照与日K并行 + 周期聚合）
//   alerts.ts  —— 提醒判定（消费行情流，产出命中）
//
// 使用约定：
//   · 取数一律返回 Effect；副作用不散落到路由
//   · 失败语义：批量场景逐项容错（标注而非中断），单标的场景可整体失败
//   · 路由层统一用 core/effect/runtime 的 runEffect 落地为 Promise
// ============================================================

export { Lineage, WATCH_SOURCES } from "./lineage.js";
export type { NewsOutcome } from "./sources.js";
export { DEFAULT_DAILY_COUNT, dailyBars, fundSnapshots, intraday, klineBars, newsOf, quoteSnapshots } from "./sources.js";
export type { RowsBundle } from "./rows.js";
export { rowsEffect } from "./rows.js";
export type { TrackBundle, TrackItem } from "./track.js";
export { PERIOD_LIMIT, PERIOD_NOTE, trackEffect } from "./track.js";
