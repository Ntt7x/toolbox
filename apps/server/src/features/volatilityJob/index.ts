// ============================================================
// 业务·市场波动率数据工程编排（调度器-任务-消息-FaaS 完整用例）
// 数据源：腾讯日K OHLC（core/quote.fetchDailyOHLC）
// 调度：每日 16:30 触发 vol-daily-update（枚举器）→ 每条入队 vol:update:<code>
// 消费：core/volatilityStore.registerVolConsumer（FaaS，并发 3，幂等增量）
// 派生：HV / EWMA / Parkinson 三口径 + z-score 分级（core/volatility）
// 枚举源：仓位管理 v2 分组标的（tradeV2:groups）+ 自选股分组标的（watchlist:）
//   ——波动率是市场客观属性，凡业务中出现的标的都值得预热
// 幂等：消费端按 lastDate 跳过旧 K + 同日去重；调度任务可重复触发（入队幂等）
// ============================================================
import { registerScheduledTask, enqueue } from "../../core/data-infra/index.js";
import { registerVolConsumer, VOL_QUEUE } from "../../core/volatilityStore.js";
import { listGroups } from "../tradeV2/store.js";
import { listItems } from "../watchlist/store.js";

/** 聚合需要预热波动率的标的（tradeV2 分组 + 自选股标的，去重） */
export function listVolWatchCodes(): string[] {
  const codes = new Set<string>();
  for (const g of listGroups()) {
    for (const s of g.stockLimits ?? []) {
      if (typeof s?.code === "string" && s.code.trim()) codes.add(s.code.trim());
    }
  }
  // 新模型下标的是一等公民（不再藏在分组里），直接枚举全部标的
  for (const s of listItems()) {
    if (typeof s?.code === "string" && s.code.trim()) codes.add(s.code.trim());
  }
  return [...codes];
}

/**
 * 注册波动率数据工程工作流：
 * 1. 消费者（FaaS 端）——core 层注册，幂等增量更新
 * 2. 调度任务（枚举器）——每日 16:30 聚合标的 → 逐条入队 vol:update
 */
export function registerVolJob(): void {
  registerVolConsumer();
  registerScheduledTask({
    id: "vol-daily-update",
    type: "volatility",
    name: "市场波动率每日更新",
    cron: "0 30 16 * * *",
    handler: async () => {
      const codes = listVolWatchCodes();
      let n = 0;
      for (const code of codes) {
        enqueue(VOL_QUEUE, { code }, { ttlMs: 6 * 60 * 60 * 1000 });
        n++;
      }
      return { ok: true, message: `已入队 ${n} 个标的波动率更新（vol:update）` };
    },
  });
}
