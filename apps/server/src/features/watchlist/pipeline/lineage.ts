// ============================================================
// 自选股·数据链路血缘累加器（features/watchlist/pipeline/lineage）
// ------------------------------------------------------------
// 痛点（重构前）：meta（sources / fromCache / degraded / caveats）由每个函数
//   **各自拼装**——loadTrack 拼一份、loadLogic 拼一份、toRows 完全不拼。
//   结果：同一条链路在不同接口的血缘口径不一致（loadLogic 甚至把没用到的
//   eastmoney.news 写死进 sources），且「到底哪个源降级了」无人记录。
//
// 改法：血缘只在这里累加一次——取数链路的每一步调用 line.add/note，
//   出口统一 meta()。缺失/降级不再靠调用方自觉，而是链路结构保证。
// ============================================================

import type { WatchDataMeta } from "@toolbox/shared";

/** 数据源标识（与本地数据管理页登记的名称保持同一口径，便于对账） */
export const WATCH_SOURCES = {
  /** 股票/ETF 快照（腾讯主源 → 东财 → 新浪） */
  quote: "tencent.quote",
  /** 场外基金净值（天天基金） */
  fund: "eastmoney.fund",
  /** 日 / 周 / 月 K + 分时（腾讯） */
  kline: "tencent.kline",
  /** 全市场快讯（东财 7x24） */
  news: "eastmoney.news",
} as const;

/**
 * 血缘累加器（可变，仅在单次请求链路内使用）。
 * 用法：
 * ```ts
 * const line = new Lineage();
 * line.add(WATCH_SOURCES.quote).miss();          // 用了行情源，且发生真实取数
 * if (bad) line.note("3 个标的无日 K");           // 降级说明
 * return line.meta();                            // → WatchDataMeta
 * ```
 */
export class Lineage {
  private readonly sources = new Set<string>();
  private readonly caveats: string[] = [];
  private cacheHit = true;

  /** 登记本次链路实际用到的数据源 */
  add(...ids: string[]): this {
    for (const id of ids) this.sources.add(id);
    return this;
  }

  /** 追加降级/缺失说明（前端以 caveats 展示，用户可见「为什么缺数据」） */
  note(...notes: string[]): this {
    for (const n of notes) if (n && !this.caveats.includes(n)) this.caveats.push(n);
    return this;
  }

  /** 标记发生了真实取数（未全命中缓存） */
  miss(): this {
    this.cacheHit = false;
    return this;
  }

  /** 合并另一条链路的血缘（子链路 → 父链路） */
  merge(other: Lineage): this {
    for (const s of other.sources) this.sources.add(s);
    for (const c of other.caveats) if (!this.caveats.includes(c)) this.caveats.push(c);
    if (!other.cacheHit) this.cacheHit = false;
    return this;
  }

  /** 是否标注过降级（存在 caveat） */
  get degraded(): boolean {
    return this.caveats.length > 0;
  }

  /** 出口：统一产出 WatchDataMeta */
  meta(): WatchDataMeta {
    return {
      sources: [...this.sources],
      fromCache: this.cacheHit,
      degraded: this.degraded,
      fetchedAt: new Date().toISOString(),
      ...(this.caveats.length > 0 ? { caveats: [...this.caveats] } : {}),
    };
  }
}
