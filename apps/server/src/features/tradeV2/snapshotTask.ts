// ============================================================
// 净值快照任务（数据工程集成运用——首个能力消费方）
// 每日收盘后（cron 16:30）调度触发 → 生成各分组日终快照序列（按日展开）→ KV 持久化
// 可手动触发 / 回溯（backfill 幂等重跑，弥补历史缺口）
// 存储：tradeV2:snapshot:<groupId> → { groupId, name, asOf, series, updatedAt }
// ============================================================
import { registerConsumer, registerDerivator, registerScheduledTask } from "../../core/data-infra/index.js";
import { kvGet, kvListRaw, kvSet } from "../../core/kvStore.js";
import { registerDataSource } from "../../core/dataRegistry.js";
import { fetchKlinesForCodes } from "../../core/kline.js";
import { buildDailySeries } from "./compute.js";
import type { Context } from "@deepseek-ai/cordis";

export const SNAPSHOT_PREFIX = "tradeV2:snapshot:";

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function registerSnapshotTask(getCtx: () => Promise<Context>): void {
  registerScheduledTask({
    id: "tradeV2-snapshot",
    type: "snapshot",
    name: "净值快照（每日更新）",
    cron: "0 30 16 * * *",
    handler: async () => {
      const ctx = await getCtx();
      const groups = ctx.tradeV2Group.list();
      let n = 0;
      for (const g of groups) {
        const raw = ctx.tradeV2Ledger.listByGroup(g.id);
        const entries = await ctx.tradeV2Ledger.enrichNames(raw, [g]);
        const klines = await fetchKlinesForCodes(entries.map((e) => e.code));
        const series = buildDailySeries(entries, klines);
        kvSet(SNAPSHOT_PREFIX + g.id, {
          groupId: g.id,
          name: g.name,
          asOf: todayStr(),
          series,
          updatedAt: Date.now(),
        });
        n++;
      }
      return { ok: true, message: `已更新 ${n} 个分组快照（每日净值序列）` };
    },
  });

  // 数据源注册（本地数据管理可见）
  registerDataSource({
    kind: "kv",
    name: SNAPSHOT_PREFIX,
    page: "仓位管理 v2",
    tag: "分析数据",
    description: "净值快照（每日收盘后由调度任务生成；可按需回溯重建）",
  });

  // 消息驱动工作流（真实业务链路）：快照任务完成 → 派生器 → 消息 → 消费者生成净值摘要
  registerDerivator({
    id: "tradeV2-snapshot-done",
    when: { taskDone: ["tradeV2-snapshot"] },
    queue: "tradeV2:snapshotDone",
    derive: () => {
      // 从快照 KV 汇总各分组最新净值（市值口径）与日变化（derive 可重放：读持久化快照，无副作用）
      const rows: Array<{ groupId: string; name: string; nav: number | null; change: number | null }> = [];
      for (const r of kvListRaw(SNAPSHOT_PREFIX)) {
        const snap = kvGet<{ groupId: string; name: string; series: { date: string; marketValue: number }[] }>(r.key);
        if (!snap?.series?.length) continue;
        const last = snap.series[snap.series.length - 1];
        const prev = snap.series.length > 1 ? snap.series[snap.series.length - 2] : undefined;
        rows.push({
          groupId: snap.groupId,
          name: snap.name,
          nav: typeof last?.marketValue === "number" ? +last.marketValue.toFixed(2) : null,
          change: prev && last && typeof prev.marketValue === "number" && typeof last.marketValue === "number" ? +(last.marketValue - prev.marketValue).toFixed(2) : null,
        });
      }
      return [{ type: "snapshot-summary", payload: { rows, at: Date.now() } }];
    },
  });
  registerConsumer({
    queue: "tradeV2:snapshotDone",
    name: "快照完成衍生（净值摘要）",
    handler: async (msg) => {
      // 幂等：消息内容即最终数据（重复消费结果一致）
      kvSet("tradeV2:snapshot:summary", { ...(msg.payload as object), derivedAt: new Date().toISOString() });
    },
  });
}
