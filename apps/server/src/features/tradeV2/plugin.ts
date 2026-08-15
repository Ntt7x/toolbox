// ============================================================
// 仓位管理 v2：Cordis 插件（挂载三个服务到 Context）
// ============================================================
import type { Context } from "@deepseek-ai/cordis";
import { TradeV2AnalysisService, TradeV2GroupService, TradeV2LedgerService } from "./services.js";

export const name = "trade-v2";

export function apply(ctx: Context) {
  ctx.plugin(TradeV2GroupService as any);
  ctx.plugin(TradeV2LedgerService as any);
  ctx.plugin(TradeV2AnalysisService as any);
}
