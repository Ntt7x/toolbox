// ============================================================
// 公共 hook：订阅实时行情流（hook 层，RxJS）
// -----------------------------------------------------------
// 用法：
//   const { quotes, ts, connected } = useQuoteStream(codes);
//   // quotes: 代码 → { price, pct }（只在服务端推来的 ts 更新时变化）
//
// 生命周期由本 hook 托管：codes 变化 → 重新订阅；组件卸载 → 退订
// （最后一个订阅者退订时，lib/quoteStream 才会真正关闭 SSE 连接）。
// ============================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { subscribeQuotes, type QuoteTick } from "../lib/quoteStream";

export interface LiveQuote {
  price?: number;
  pct?: number;
  name?: string;
}

export interface UseQuoteStreamResult {
  /** 代码 → 最新行情 */
  quotes: Map<string, LiveQuote>;
  /** 最近一次推送时间（空串 = 尚未收到） */
  ts: string;
  /** 是否已收到过至少一帧（用于展示「实时/加载中」） */
  connected: boolean;
}

/**
 * 订阅一批标的的实时行情。
 * 设计要点：
 *   - codes 用**排序去重后的字符串**做依赖，避免数组引用变化导致反复重连
 *   - 行情合入本地 Map 时保留本地已有字段（服务端只推价/涨跌，不推名称）
 */
export function useQuoteStream(codes: readonly string[], enabled = true): UseQuoteStreamResult {
  const [quotes, setQuotes] = useState<Map<string, LiveQuote>>(new Map());
  const [ts, setTs] = useState("");
  const [connected, setConnected] = useState(false);
  // 最新行情的镜像（避免 setQuotes 里读旧 state）
  const mirror = useRef<Map<string, LiveQuote>>(new Map());

  const key = useMemo(() => [...new Set(codes)].filter(Boolean).sort().join(","), [codes]);
  const list = useMemo(() => (key ? key.split(",") : []), [key]);

  useEffect(() => {
    if (!enabled || list.length === 0) return;
    const sub = subscribeQuotes(list, (tick: QuoteTick) => {
      const next = new Map(mirror.current);
      for (const q of tick.quotes) {
        if (!q?.code) continue;
        // 只覆盖服务端给的字段（服务端不推名称时保留本地已有的）
        next.set(q.code, { ...next.get(q.code), ...(typeof q.price === "number" ? { price: q.price } : {}), ...(typeof q.pct === "number" ? { pct: q.pct } : {}), ...(q.name ? { name: q.name } : {}) });
      }
      mirror.current = next;
      setQuotes(next);
      setTs(tick.ts);
      setConnected(true);
    });
    return () => sub.unsubscribe();
  }, [key, list, enabled]);

  return { quotes, ts, connected };
}

/**
 * 把实时行情合并进行列表：列表自带的 price/pct 作为兜底，实时值优先。
 * 典型用法：`const rows = useMemo(() => mergeLive(items, live), [items, live]);`
 */
export function mergeLiveQuotes<T extends { code: string; price?: number; pct?: number; name?: string }>(
  rows: readonly T[],
  live: Map<string, LiveQuote>,
): T[] {
  if (live.size === 0) return rows as T[];
  return rows.map((r) => {
    const q = live.get(r.code);
    if (!q) return r;
    return {
      ...r,
      ...(typeof q.price === "number" ? { price: q.price } : {}),
      ...(typeof q.pct === "number" ? { pct: q.pct } : {}),
      ...(!r.name && q.name ? { name: q.name } : {}),
    };
  });
}
