// ============================================================
// 仓位管理 v2：Cordis Context 单例（异步初始化）
// ctx.plugin() 异步（fiber ACTIVE 后服务才可用）——Promise 缓存 + 路由 await
// ============================================================
import { Context } from "@deepseek-ai/cordis";
import * as tradeV2Plugin from "./plugin.js";

let ctxPromise: Promise<Context> | null = null;

export function getTradeV2Ctx(): Promise<Context> {
  if (!ctxPromise) {
    ctxPromise = (async () => {
      const c = new Context();
      await c.plugin(tradeV2Plugin);
      return c;
    })();
  }
  return ctxPromise;
}
