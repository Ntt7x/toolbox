// ============================================================
// 行情流客户端（lib/quoteStream，RxJS）
// -----------------------------------------------------------
// 为什么用 RxJS 而不是直接在组件里 new EventSource：
//   重构前每个面板各自轮询 / 各自 new EventSource，N 个面板 = N 条连接 +
//   N 倍服务端取数；且「订阅/退订/重连」的生命周期散落在各个 useEffect 里，
//   很容易漏退订（页面切走后连接还在，服务端继续推）。
//
// 这里用 RxJS 一次性解决三件事：
//   · 共享连接   —— 相同代码集合的多个订阅者共用一条 SSE（refCount: true）
//   · 自动重连   —— 断线按指数退避重连（retry），最后一个订阅者离开才真正关闭
//   · 生命周期   —— 组件卸载只需退订，连接与重连定时器随之释放
//
// 服务端对应：GET /api/tools/watchlist/stream?codes=...（事件名 tick）
// ============================================================

import { Observable, Subscription, filter, finalize, map, retry, share, timer } from "rxjs";

/** 一次推送的行情快照（与服务端 tick 事件一致） */
export interface QuoteTick {
  readonly ts: string;
  readonly quotes: readonly {
    ok: true;
    code: string;
    name?: string;
    price?: number;
    pct?: number;
  }[];
  readonly notes?: readonly string[];
}

/** 重连配置 */
const RETRY_COUNT = 5;
const RETRY_BASE_MS = 1000;

/** 一条 SSE 连接（惰性：订阅才连；退订即关） */
function sseObservable(url: string): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    const es = new EventSource(url);
    const onMessage = (ev: MessageEvent): void => subscriber.next(ev);
    const onError = (): void => subscriber.error(new Error("行情流连接中断"));
    es.addEventListener("tick", onMessage as EventListener);
    es.addEventListener("error", onError as EventListener);
    return () => {
      es.removeEventListener("tick", onMessage as EventListener);
      es.removeEventListener("error", onError as EventListener);
      es.close();
    };
  });
}

/** 单个代码集合的行情流（共享 + 自动重连） */
function streamOf(codes: readonly string[]): Observable<QuoteTick> {
  const url = `/api/tools/watchlist/stream?codes=${encodeURIComponent(codes.join(","))}`;
  return sseObservable(url).pipe(
    map((ev): QuoteTick | null => {
      try {
        return JSON.parse(ev.data) as QuoteTick;
      } catch {
        return null;
      }
    }),
    // 丢弃无法解析的帧（不因单帧异常断掉整条流）
    filter((tick): tick is QuoteTick => tick !== null),
    // 指数退避重连：1s → 2s → 4s → 8s → 16s（timer 返回 Observable，delay 需 ObservableInput）
    retry({ count: RETRY_COUNT, delay: (_err, n) => timer(RETRY_BASE_MS * 2 ** (n - 1)) }),
    share(),
  );
}

/** 代码集合 → 共享流（同一集合复用一条连接） */
const streams = new Map<string, Observable<QuoteTick>>();

function keyOf(codes: readonly string[]): string {
  return [...new Set(codes)].sort().join(",");
}

/**
 * 订阅一批标的的实时行情。
 * 用法：`const sub = subscribeQuotes(codes, tick => ...); ... sub.unsubscribe();`
 * - 相同代码集合的多个订阅者共用一条 SSE 连接
 * - 最后一个订阅者退订 → 连接关闭（不会在后台空转）
 */
export function subscribeQuotes(codes: readonly string[], onTick: (tick: QuoteTick) => void): Subscription {
  const list = [...new Set(codes)].filter(Boolean).sort();
  if (list.length === 0) return new Subscription();
  const key = keyOf(list);
  let stream = streams.get(key);
  if (!stream) {
    stream = streamOf(list).pipe(finalize(() => streams.delete(key)));
    streams.set(key, stream);
  }
  return stream.subscribe({ next: onTick, error: () => undefined });
}

/**
 * 代码集合变化 → 重新订阅（旧的自动退订）。
 * 适合在 useEffect 里用：`const sub = resubscribe(codes, cb)`。
 */
export function resubscribeQuotes(codes: readonly string[], onTick: (tick: QuoteTick) => void): () => void {
  const sub = subscribeQuotes(codes, onTick);
  return () => sub.unsubscribe();
}

/** 请求服务端立即刷新一次（合并后由服务端统一执行，不产生额外取数） */
export async function requestQuoteRefresh(): Promise<void> {
  await fetch("/api/tools/watchlist/stream/refresh", { method: "POST" }).catch(() => undefined);
}

/** 便于测试：当前持有的共享连接数 */
export function activeStreamCount(): number {
  return streams.size;
}
