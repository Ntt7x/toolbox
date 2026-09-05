// ============================================================
// Effect 类型化错误（core/effect/errors）
// ------------------------------------------------------------
// 痛点（重构前）：取数失败有四种互不兼容的形态——
//   ① 抛异常（fetch reject / AbortSignal 超时）
//   ② 返回 { ok:false, message }（行情快照）
//   ③ 静默返回空数组（日 K / 新闻）
//   ④ 返回 { errors: string[] } 让调用方自己拼（新闻）
// 调用方必须逐处记住「这个接口用什么表示失败」，漏一处就是静默降级、数据缺失无痕迹。
//
// 改法：失败写进类型（Effect<QuoteSnapshot, QuoteError>）——
//   · 编译器强制调用方处理（漏处理 = 类型不过）
//   · _tag 可穷尽匹配 → 中文文案在 describeError 一处收口，不再各处拼字符串
//   · 失败原因（哪个源、什么状态）随错误值传递，血缘/降级标注有据可依
// 约定：所有错误用 Data.TaggedError，_tag 即判别式；业务错误另见各 feature 的 errors。
// ============================================================

import { Data } from "effect";

/** 传输层失败：fetch 直接 reject（DNS/TLS/连接重置/对端不可达） */
export class TransportError extends Data.TaggedError("TransportError")<{
  readonly url: string;
  readonly reason: string;
}> {}

/** HTTP 状态非 2xx */
export class HttpStatusError extends Data.TaggedError("HttpStatusError")<{
  readonly url: string;
  readonly status: number;
}> {}

/** 超时（Effect 中断 fetch 后由 timeoutFail 产生） */
export class TimeoutError extends Data.TaggedError("TimeoutError")<{
  readonly url: string;
  readonly ms: number;
}> {}

/** 响应解析失败：JSON 结构不符 / 文本格式不符 / 字段缺失 */
export class ParseError extends Data.TaggedError("ParseError")<{
  readonly source: string;
  readonly reason: string;
}> {}

/** 数据源整体不可用：主源与全部降级源都失败（attempts 记录每个源的失败原因） */
export class SourceUnavailableError extends Data.TaggedError("SourceUnavailable")<{
  readonly source: string;
  readonly attempts: readonly string[];
}> {}

/** HTTP 取数链路的错误联合类型 */
export type HttpError = TransportError | HttpStatusError | TimeoutError;

/** 取数链路的全部错误（含解析与降级耗尽） */
export type FetchError = HttpError | ParseError | SourceUnavailableError;

/** 结构化错误的判别标记（用于窄化 unknown） */
interface Tagged {
  readonly _tag: string;
}

function isTagged(e: unknown): e is Tagged {
  return typeof e === "object" && e !== null && typeof (e as { _tag?: unknown })._tag === "string";
}

/** 错误 → 中文文案（一处收口：页面提示 / caveats / 日志共用同一口径） */
export function describeError(e: unknown): string {
  if (isTagged(e)) {
    switch (e._tag) {
      case "TransportError":
        return `网络请求失败（${(e as TransportError).reason}）`;
      case "HttpStatusError":
        return `数据源响应异常（HTTP ${(e as HttpStatusError).status}）`;
      case "TimeoutError":
        return `数据源响应超时（超过 ${(e as TimeoutError).ms}ms）`;
      case "ParseError":
        return `数据解析失败（${(e as ParseError).reason}）`;
      case "SourceUnavailable":
        return `数据源不可用（${(e as SourceUnavailableError).attempts.join("；")}）`;
      default:
        break;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * 是否值得重试：仅网络抖动 / 超时 / 对端限流 / 服务端错误。
 * 4xx（除 429）是请求本身有问题，重试只会放大故障与延迟。
 */
export function isRetryable(e: FetchError): boolean {
  switch (e._tag) {
    case "TimeoutError":
    case "TransportError":
      return true;
    case "HttpStatusError":
      return e.status >= 500 || e.status === 429;
    default:
      return false;
  }
}
