// ============================================================
// Effect HTTP 取数（core/effect/http）
// ------------------------------------------------------------
// 统一三件事，替掉散落在各数据源里的手写逻辑：
//   ① 超时       —— 原先每处 `AbortSignal.timeout(8000|10000|12000)`，数值各写各的，
//                    且不会被外部任务信号取消 → 统一用 Effect 中断 + 可配档位
//   ② 重试       —— 原先完全没有重试（行情源抖一下整批降级）；
//                    统一「指数退避 + 仅对超时/网络/5xx/429 重试」，4xx 不重试
//   ③ 错误类型化 —— fetch reject / 非 2xx / 解析失败 一律变 TaggedError（见 errors.ts）
// 中断语义：Effect 的 timeout 是**真中断**（把 signal 传给 fetch，连接随之关闭），
//   不是「超时后丢弃结果」，避免留下悬空请求占连接。
// ============================================================

import { Duration, Effect, Schedule } from "effect";
import {
  HttpStatusError,
  ParseError,
  TimeoutError,
  TransportError,
  isRetryable,
  type FetchError,
  type HttpError,
} from "./errors.js";

export interface RequestOptions {
  readonly url: string;
  readonly headers?: Record<string, string>;
  /** 超时（毫秒）；缺省 10s */
  readonly timeoutMs?: number;
  /** 额外重试次数（不含首次）；缺省 2（共 3 次尝试） */
  readonly retries?: number;
  /** 退避基数（毫秒）；缺省 150ms，按 2 倍指数增长 */
  readonly retryBaseMs?: number;
  /** 外部取消信号（任务中断 / 客户端断开）——与超时信号合并，任一触发即中断 */
  readonly signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 150;

/** fetch 的 reject → 类型化错误（Node 的超时 DOMException 单独识别） */
function classifyFetchError(url: string, timeoutMs: number): (e: unknown) => HttpError {
  return (e) => {
    if (e instanceof DOMException && e.name === "TimeoutError") return new TimeoutError({ url, ms: timeoutMs });
    return new TransportError({ url, reason: e instanceof Error ? e.message : String(e) });
  };
}

/** 合并外部信号与 Effect 中断信号（Node 20+ 支持 AbortSignal.any） */
function mergeSignals(outer: AbortSignal | undefined, inner: AbortSignal): AbortSignal {
  return outer ? AbortSignal.any([outer, inner]) : inner;
}

/**
 * 一次「取数 + 读响应体」的完整尝试（未含重试与超时）。
 * 响应体读取也纳入超时范围——只读 header 就放行会漏掉「连接建立但 body 卡死」的场景。
 */
function attempt<A>(opts: RequestOptions, read: (res: Response) => Promise<A>): Effect.Effect<A, HttpError | ParseError> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchEffect: Effect.Effect<Response, HttpError> = Effect.tryPromise({
    try: (signal) => fetch(opts.url, { headers: opts.headers, signal: mergeSignals(opts.signal, signal) }),
    catch: classifyFetchError(opts.url, timeoutMs),
  });
  const ensureOk = (res: Response): Effect.Effect<Response, HttpError> =>
    res.ok ? Effect.succeed(res) : Effect.fail(new HttpStatusError({ url: opts.url, status: res.status }));
  const readBody = (res: Response): Effect.Effect<A, ParseError> =>
    Effect.tryPromise({
      try: () => read(res),
      catch: (e) => new ParseError({ source: opts.url, reason: e instanceof Error ? e.message : String(e) }),
    });
  return Effect.flatMap(Effect.flatMap(fetchEffect, ensureOk), readBody);
}

/** 指数退避策略：最多 retries 次重试，间隔 150ms → 300ms → 600ms… */
function retryPolicy(retries: number, baseMs: number): Schedule.Schedule<unknown, FetchError, never> {
  return Schedule.intersect(Schedule.recurs(retries), Schedule.exponential(Duration.millis(baseMs), 2));
}

/** 取数（含超时 + 重试）——所有外部 HTTP 取数的唯一入口 */
function request<A>(opts: RequestOptions, read: (res: Response) => Promise<A>): Effect.Effect<A, FetchError> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const timed: Effect.Effect<A, HttpError | ParseError> = Effect.timeoutFail(attempt(opts, read), {
    duration: Duration.millis(timeoutMs),
    onTimeout: () => new TimeoutError({ url: opts.url, ms: timeoutMs }),
  });
  return Effect.retry(timed, { schedule: retryPolicy(retries, baseMs), while: isRetryable });
}

/** 取文本 */
export function requestText(opts: RequestOptions): Effect.Effect<string, FetchError> {
  return request(opts, (res) => res.text());
}

/** 取二进制（GBK 等需自行转码的响应用） */
export function requestBuffer(opts: RequestOptions): Effect.Effect<ArrayBuffer, FetchError> {
  return request(opts, (res) => res.arrayBuffer());
}

/** 取 JSON（解析失败 → ParseError，不静默返回 undefined） */
export function requestJson<T>(opts: RequestOptions): Effect.Effect<T, FetchError> {
  return Effect.flatMap(requestText(opts), (text) =>
    Effect.try({
      try: () => JSON.parse(text) as T,
      catch: (e) => new ParseError({ source: opts.url, reason: e instanceof Error ? e.message : String(e) }),
    }),
  );
}
