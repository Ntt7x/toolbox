// ============================================================
// 文档中心：Cordis Context 单例（异步初始化）
// ctx.plugin() 异步（fiber ACTIVE 后服务才可用）——Promise 缓存 + 路由 await
// ============================================================
import { Context } from "@deepseek-ai/cordis";
import * as docsPlugin from "./plugin.js";

let ctxPromise: Promise<Context> | null = null;

export function getDocsCtx(): Promise<Context> {
  if (!ctxPromise) {
    ctxPromise = (async () => {
      const c = new Context();
      await c.plugin(docsPlugin);
      return c;
    })();
  }
  return ctxPromise;
}
