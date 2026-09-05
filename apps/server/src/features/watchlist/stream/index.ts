// ============================================================
// 自选股·流式层（features/watchlist/stream）统一出口
// ------------------------------------------------------------
// 本目录用 RxJS 解决「事件流编排」问题（取数本身仍是 Effect，见 pipeline/）。
//
//   quoteStream.ts  —— 共享行情流：多播 / 单飞 / 限速 / 无人即停
//   alertWatcher.ts —— 提醒消费者：行情流 → 纯函数判定 → 落库 → 推送新增命中
//
// 使用约定：
//   · 取数不在本目录发生，一律委托 pipeline/sources（Effect）
//   · 流里的错误就地收敛成 notes，不让流 error（否则所有订阅者一起掉线）
//   · 订阅必须可退订（组件卸载 / 客户端断开 → 引用计数归零 → 自动停轮询）
// ============================================================

export type { QuoteTick } from "./quoteStream.js";
export { DEFAULT_INTERVAL_MS, activeCodes, quoteStream, requestRefresh } from "./quoteStream.js";
export type { AlertWatchResult, AlertWatcher } from "./alertWatcher.js";
export { consumeTick, startAlertWatcher } from "./alertWatcher.js";
