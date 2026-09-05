// ============================================================
// 自选股·提醒消费者（features/watchlist/stream/alertWatcher）
// ------------------------------------------------------------
// 重构前：提醒命中是**被动**的——只有用户打开列表页/跟踪页触发一次取数，
//   才顺带用当时的快照算一遍命中。盘中止损点位到了，页面没开就永远不会提醒。
//
// 改法：把提醒判定挂到行情流上（消费者），流推一次 → 判定一次 → 落库。
//   判定逻辑本身仍是纯函数（alerts.ts），这里只做「取上下文 + 落库」的编排：
//     行情流 tick → 组装 AlertContext → evaluateRules → mergeHits → saveAlertHits
//
// 为什么用流而不是 setInterval：与页面共享同一条取数链路（见 quoteStream），
//   页面开着时不再多一次请求；页面关掉且无人订阅时，消费者自己就是订阅者，
//   按流的节奏继续跑（这对「页面没开也要能提醒」是必要的）。
// ============================================================

import { Observable, Subscription, distinctUntilChanged, map } from "rxjs";
import type { WatchAlertHit } from "@toolbox/shared";
import { evaluateRules, mergeHits, applyOnceFired, type AlertContext } from "../alerts.js";
import { getAlertHits, getAlertRules, saveAlertHits, saveAlertRules, listItems } from "../store.js";
import { quoteStream, type QuoteTick } from "./quoteStream.js";

/** 命中落库后的产出（供 SSE/日志使用） */
export interface AlertWatchResult {
  /** 本次新写入的命中（去重后） */
  readonly hits: readonly WatchAlertHit[];
  /** 因 once 规则触发而被停用的规则 id */
  readonly disabledRuleIds: readonly string[];
}

/** 快照 → 提醒判定上下文（日期取今天；周期涨跌幅在本层不取，留给跟踪链路补齐） */
function toContext(tick: QuoteTick, code: string, name?: string): AlertContext | null {
  const q = tick.byCode.get(code);
  if (!q || !q.ok) return null;
  const price = typeof q.price === "number" ? q.price : undefined;
  if (typeof price !== "number") return null;
  return {
    code,
    ...(name ? { name } : {}),
    // 去重日期：快照时间优先（行情源给出的是交易日），缺失退回本次取数时刻
    date: (typeof q.ts === "string" && q.ts ? q.ts : tick.ts).slice(0, 10),
    last: price,
    ...(typeof q.pct === "number" ? { dayPct: q.pct } : {}),
  };
}

/** 当前所有被提醒规则关注的标的 */
function watchedCodes(): { code: string; name?: string }[] {
  return listItems()
    .filter((it) => getAlertRules(it.code).some((r) => r.enabled))
    .map((it) => ({ code: it.code, ...(it.name ? { name: it.name } : {}) }));
}

/**
 * 单个 tick 的提醒判定 + 落库（纯编排，可在单测里直接喂 tick）。
 * 只处理「本次有快照」的标的；未取到行情的标的保持原命中不变（不误清、不误报）。
 */
export function consumeTick(tick: QuoteTick, watched: readonly { code: string; name?: string }[]): AlertWatchResult {
  const ctxs: AlertContext[] = [];
  for (const w of watched) {
    const ctx = toContext(tick, w.code, w.name);
    if (ctx) ctxs.push(ctx);
  }
  if (ctxs.length === 0) return { hits: [], disabledRuleIds: [] };

  const rules = ctxs.flatMap((c) => getAlertRules(c.code));
  const incoming = evaluateRules(rules, ctxs);
  if (incoming.length === 0) return { hits: [], disabledRuleIds: [] };

  const hits: WatchAlertHit[] = [];
  const disabledRuleIds: string[] = [];
  // 按标的聚合落库（命中记录按 code 存储）
  const byCode = new Map<string, WatchAlertHit[]>();
  for (const h of incoming) {
    const list = byCode.get(h.code) ?? [];
    list.push(h);
    byCode.set(h.code, list);
  }
  for (const [code, list] of byCode) {
    const before = getAlertHits(code);
    const after = mergeHits(before, list);
    // 无新增（同规则同交易日已有）→ 不写库，避免每 15s 产生一次无效 IO
    if (after.length === before.length && list.every((h) => before.some((b) => b.ruleId === h.ruleId && b.date === h.date))) continue;
    saveAlertHits(code, after);
    hits.push(...list);
    // once 规则命中后停用（幂等：已停用的不会重复写）
    const rules0 = getAlertRules(code);
    const rules1 = applyOnceFired(rules0, after);
    for (const r of rules1) {
      if (rules0.find((x) => x.id === r.id)?.enabled && !r.enabled) disabledRuleIds.push(r.id);
    }
    saveAlertRules(code, rules1);
  }
  return { hits, disabledRuleIds };
}

/** 提醒消费者的运行句柄 */
export interface AlertWatcher {
  /** 新增命中的推送流（SSE / 日志可订阅） */
  readonly hits$: Observable<AlertWatchResult>;
  /** 停止消费（退订行情流） */
  readonly stop: () => void;
}

/**
 * 启动提醒消费者：订阅行情流 → 每 tick 判定 → 落库 → 推送新增命中。
 * 只在有新命中时向下游推送（distinctUntilChanged 按命中数变化去重）。
 */
export function startAlertWatcher(): AlertWatcher {
  const watched = watchedCodes();
  const codes = watched.map((w) => w.code);
  const inner = new Subscription();
  if (codes.length === 0) {
    return { hits$: new Observable<AlertWatchResult>(), stop: () => inner.unsubscribe() };
  }
  const hits$ = new Observable<AlertWatchResult>((subscriber) => {
    inner.add(
      quoteStream(codes)
        .pipe(
          map((tick) => consumeTick(tick, watched)),
          // 只在命中集合变化时推送（避免每 15s 推一次空结果）
          distinctUntilChanged((a, b) => a.hits.length === b.hits.length && a.hits.every((h, i) => b.hits[i]?.ruleId === h.ruleId)),
        )
        .subscribe({
          next: (r) => {
            if (r.hits.length > 0) subscriber.next(r);
          },
          error: (e) => subscriber.error(e),
        }),
    );
  });
  return { hits$, stop: () => inner.unsubscribe() };
}
