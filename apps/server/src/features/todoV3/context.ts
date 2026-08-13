// ============================================================
// 待办清单 v3：Cordis Context 单例（异步初始化）
// ctx.plugin() 是异步的（fiber 启动为 PENDING→LOADING→ACTIVE），
// 服务注册在 ACTIVE 后才可用——因此用 Promise 缓存，路由 await 后访问服务。
// 若未来需要热重载，可保存 fiber 句柄并 dispose/重挂（教程 02 fiber 生命周期）
// ============================================================
import { Context } from "@deepseek-ai/cordis";
import * as todoV3Plugin from "./plugin.js";

let ctxPromise: Promise<Context> | null = null;

/** 获取全局 todo-v3 Context（惰性异步初始化 + 幂等；等待插件 ACTIVE 后返回） */
export function getTodoV3Ctx(): Promise<Context> {
  if (!ctxPromise) {
    ctxPromise = (async () => {
      const c = new Context();
      await c.plugin(todoV3Plugin);   // 等待 fiber ACTIVE（服务注册完成）
      return c;
    })();
  }
  return ctxPromise;
}
