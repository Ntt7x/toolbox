// ============================================================
// 自选股·行情流（features/watchlist/stream/quoteStream）
// ------------------------------------------------------------
// 为什么需要「流」而不是继续轮询：
//   重构前每个面板各自 setInterval 轮询，N 个面板 = N 条独立取数链路，
//   对同一批标的在 60s 内重复请求 N 次（数据源侧看就是 N 倍 QPS），
//   刷新节奏还不一致（有的 30s 有的 60s），页面之间数字对不上。
//
// RxJS 在这里解决的是**事件流的编排问题**（Effect 不擅长、也不该做）：
//   · 多播共享   —— N 个订阅者共用一条取数链路（shareReplay + refCount）
//   · 无人即停   —— 最后一个订阅者离开 → 自动停轮询（refCount:true），不留后台定时器
//   · 单飞/防抖  —— exhaustMap：取数进行中的触发被丢弃，不会堆积成请求风暴
//   · 节奏统一   —— throttleTime(leading+trailing)：一次立即取数，窗口内的触发合并为
//                   窗口结束时补取一次（既响应交互，又不超出最低间隔）
//
// 分工：取数本身仍是 Effect（core/effect），RxJS 只编排「什么时候取、取完怎么分发」。
// ============================================================

import {
  BehaviorSubject,
  EMPTY,
  Observable,
  Subject,
  defer,
  exhaustMap,
  filter,
  finalize,
  interval,
  map,
  merge,
  shareReplay,
  switchMap,
  throttleTime,
  withLatestFrom,
} from "rxjs";
import type { QuoteSnapshot } from "@toolbox/shared";
import { describeError } from "../../../core/effect/errors.js";
import { runEffect } from "../../../core/effect/runtime.js";
import { quoteSnapshots } from "../pipeline/sources.js";

/** 默认轮询间隔（毫秒）：自选股盯盘不需要秒级，15s 兼顾实时性与数据源压力 */
export const DEFAULT_INTERVAL_MS = 15_000;

/** 一次刷新的产出 */
export interface QuoteTick {
  /** 本次取数完成时刻 */
  readonly ts: string;
  /** 与请求顺序一致的快照列表（含 ok:false 项，消费方自行区分） */
  readonly quotes: readonly QuoteSnapshot[];
  /** 代码 → 快照（仅含取数成功的） */
  readonly byCode: ReadonlyMap<string, QuoteSnapshot>;
  /** 取数过程中的降级说明（批量失败等） */
  readonly notes: readonly string[];
}

/** 代码订阅表（引用计数 → 取「当前有人要看」的代码并集） */
const refCount = new Map<string, number>();
const wantedCodes$ = new BehaviorSubject<readonly string[]>([]);
/** 手动刷新信号（前端点刷新 / 服务端写操作后触发） */
const manual$ = new Subject<void>();

function acquire(codes: readonly string[]): void {
  let changed = false;
  for (const c of codes) {
    const n = refCount.get(c) ?? 0;
    refCount.set(c, n + 1);
    if (n === 0) changed = true;
  }
  if (changed) wantedCodes$.next([...refCount.keys()]);
}

function release(codes: readonly string[]): void {
  let changed = false;
  for (const c of codes) {
    const n = (refCount.get(c) ?? 0) - 1;
    if (n <= 0) {
      refCount.delete(c);
      changed = true;
    } else {
      refCount.set(c, n);
    }
  }
  if (changed) wantedCodes$.next([...refCount.keys()]);
}

/** 当前有订阅者的代码（测试与运维可见） */
export function activeCodes(): string[] {
  return [...refCount.keys()];
}

/** 执行一次取数（失败不抛：转成 notes，保证流不中断） */
async function fetchTick(codes: readonly string[]): Promise<QuoteTick> {
  const ts = new Date().toISOString();
  try {
    const { snapshots, notes } = await runEffect(quoteSnapshots([...codes]));
    const byCode = new Map<string, QuoteSnapshot>();
    for (const s of snapshots) if (s.ok) byCode.set(s.code, s);
    return { ts, quotes: snapshots, byCode, notes };
  } catch (e) {
    // 单飞链路上取数失败若让流 error，所有订阅者会一起掉线 → 收敛成空 tick + 说明
    return { ts, quotes: [], byCode: new Map(), notes: [`行情刷新失败：${describeError(e)}`] };
  }
}

/**
 * 共享行情流（进程内单例）。
 * - 代码集合变化 → 用新的并集重启轮询（switchMap）
 * - 触发源 = 定时 + 手动，经 throttle 限速后由 exhaustMap 串行执行（单飞）
 */
const shared$: Observable<QuoteTick> = wantedCodes$.pipe(
  switchMap((codes) =>
    codes.length === 0
      ? EMPTY
      : merge(
          interval(DEFAULT_INTERVAL_MS).pipe(map(() => codes)),
          manual$.pipe(withLatestFrom(wantedCodes$), map(([, latest]) => (latest.length > 0 ? latest : codes))),
        ),
  ),
  // 限速：窗口内首次立即执行（leading），余下合并为窗口末尾补一次（trailing）
  throttleTime(DEFAULT_INTERVAL_MS, undefined, { leading: true, trailing: true }),
  // 单飞：上一次取数未完成时，新触发直接丢弃（不排队、不并发打对端）
  exhaustMap((codes) => (codes.length > 0 ? fetchTick(codes) : Promise.resolve<QuoteTick>({ ts: new Date().toISOString(), quotes: [], byCode: new Map(), notes: [] }))),
  filter((tick) => tick.byCode.size > 0 || tick.notes.length > 0),
  shareReplay({ bufferSize: 1, refCount: true }),
);

/**
 * 订阅一批标的的实时行情。
 *
 * 用法：`quoteStream(["sh600519"]).subscribe(tick => ...)`
 * - 多订阅者共享同一条取数链路（相同代码不会重复请求）
 * - 最后一个订阅者退订 → 该代码从轮询集合移除；集合空 → 自动停轮询
 * - 新订阅者立即拿到最近一次 tick（shareReplay(1)），无需等待下一个轮询周期
 */
export function quoteStream(codes: readonly string[]): Observable<QuoteTick> {
  const list = [...new Set(codes)].filter(Boolean);
  return defer(() => {
    if (list.length === 0) return EMPTY;
    acquire(list);
    return shared$.pipe(finalize(() => release(list)));
  });
}

/** 请求立即刷新一次（合并后由流统一执行；不绕过限速与单飞） */
export function requestRefresh(): void {
  manual$.next();
}
