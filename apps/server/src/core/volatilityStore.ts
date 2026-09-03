// ============================================================
// 公共·副作用层：标的市场波动率（KV 持久化 + 行情日K OHLC）
// 纯计算在 core/volatility.ts（initVolState / pushBar / annualVolOf / parkVolOf / ewmaNext）
// 这里只做 I/O：读状态 → 增量更新（O(1) 流水线）→ 写回；首次全量初始化。
// 数据工程消费端：registerVolConsumer 订阅 vol:update 队列（FaaS）——
//   由调度任务（features/volatilityJob）枚举标的入队，消费端拉日K OHLC 增量更新。
// 懒读取兜底：getStockVolatility（读行情快照，仅 HV/EWMA，Parkinson 等调度权威口径）。
// ============================================================
import { kvGet, kvSet } from "./kvStore.js";
import { initVolState, pushBar, diffVolState, type VolEvent, type VolState } from "./volatility.js";
import { fetchDailyCloses, fetchDailyOHLC, getQuoteSnapshot } from "./quote.js";
import { registerDataSource } from "./dataRegistry.js";
import { mapLimit, NET_CONCURRENCY } from "./concurrency.js";
import { registerConsumer } from "./data-infra/consumer.js";
import { enqueue } from "./data-infra/queue.js";

// 注册数据源：标的市场波动率流水线状态（本地数据管理可见，避免"未标记"）
registerDataSource({
  kind: "kv",
  name: "quote:v:",
  page: "行情工具",
  tag: "分析数据",
  description: "标的市场波动率流水线（HV/EWMA/Parkinson 三口径 + 历史波动分布，KV 持久化，每日增量；vol:update 队列消费）",
});
registerDataSource({
  kind: "kv",
  name: "quote:vhist:",
  page: "行情工具",
  tag: "分析数据",
  description: "标的市场波动率每日序列（波动率曲线数据，按标的保留近一年，增量感知落库）",
});
registerDataSource({
  kind: "kv",
  name: "quote:vevent:",
  page: "行情工具",
  tag: "分析数据",
  description: "标的市场波动率变化事件审计（level 跃迁 / 波动突变 / 首次有值，增量感知）",
});

export const VOL_PREFIX = "quote:v:";
export const VOL_HIST_PREFIX = "quote:vhist:";
export const VOL_EVENT_PREFIX = "quote:vevent:";
export const VOL_QUEUE = "vol:update";
/** 每日波动序列长度（≈1 年交易日，波动率曲线数据） */
export const VOL_HIST_LEN = 240;
/** 事件审计上限（每标的保留最近事件） */
export const VOL_EVENT_LEN = 50;

/**
 * 新增标的感知：业务侧（仓位管理分组加标的 / 自选股加标的等）在标的出现时调用，
 * 立即入队波动率初始化/更新（不必等每日 16:30 调度或页面懒读取）。
 * 幂等：消费端按 lastDate 跳过已处理 K；同日重复入队无害（TTL 6h）。
 */
export function enqueueVolUpdate(code: string): void {
  const c = code.trim();
  if (!c) return;
  enqueue(VOL_QUEUE, { code: c }, { ttlMs: 6 * 60 * 60 * 1000 });
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 一年前日期（增量拉取起点） */
function yearAgoStr(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface StockVolatility {
  /** 当前 HV 年化波动率 %（近 VOL_WINDOW 交易日，主口径） */
  vol?: number;
  /** 当前 EWMA 年化波动率 % */
  ewmaVol?: number;
  /** 当前 Parkinson 年化波动率 % */
  parkVol?: number;
  /** 相对自身历史波动分布的 z-score（>1σ = 高波） */
  z?: number;
  /** 分级：low / mid / high / extreme */
  level?: "low" | "mid" | "high" | "extreme";
}

/**
 * 单标的增量更新（消费端 / 幂等）：拉日K OHLC → 增量 pushBar → 写 KV。
 * 首次（无状态）全量初始化；已有状态从 lastDate 之后增量拉取。
 * 更新后：感知变化（diffVolState）→ 事件审计落库 + 每日波动序列落库。
 * 失败（无行情/网络）返回 false，不改状态（队列层将重投）。
 */
export async function consumeVolUpdate(code: string): Promise<boolean> {
  const key = VOL_PREFIX + code.trim();
  const today = todayStr();
  const prev = kvGet<VolState>(key);
  const from = prev?.lastDate ? prev.lastDate : yearAgoStr();
  const bars = await fetchDailyOHLC(code, from, today, 300);
  if (!bars || bars.length === 0) {
    // 无新数据但已有状态：视为幂等成功（已是最新）
    return !!prev;
  }
  bars.sort((a, b) => (a.date < b.date ? -1 : 1));
  let st: VolState;
  if (!prev) {
    st = initVolState(bars, bars[bars.length - 1]?.date);
  } else {
    st = prev;
    // 从上次日期之后增量（跳过已处理的旧 K；同日幂等由 pushBar 保证）
    for (const b of bars) {
      if (prev.lastDate && b.date <= prev.lastDate) continue;
      st = pushBar(st, b, b.date);
    }
  }
  kvSet(key, st);
  // 增量感知与反应：事件审计 + 每日波动序列（幂等：同日同值不重复事件）
  persistVolDerived(code, prev, st);
  return true;
}

/** 增量感知落库：每日波动序列（vhist，每次更新都记）+ 变化事件（vevent，显著变化才记） */
export function persistVolDerived(code: string, prev: VolState | null | undefined, next: VolState): void {
  // 每日波动序列（供波动率曲线；按日期去重）
  if (next.currentVol !== undefined && next.lastDate) {
    const histKey = VOL_HIST_PREFIX + code.trim();
    const hist = kvGet<{ date: string; vol?: number; ewmaVol?: number; parkVol?: number; level?: string }[]>(histKey) ?? [];
    const last = hist[hist.length - 1];
    if (!last || last.date !== next.lastDate) {
      hist.push({ date: next.lastDate, vol: next.currentVol, ewmaVol: next.ewmaVol, parkVol: next.parkVol, level: next.level });
      while (hist.length > VOL_HIST_LEN) hist.shift();
      kvSet(histKey, hist);
    }
  }
  // 变化事件（level 跃迁 / 波动突变 / 首次有值）
  const evt = diffVolState(prev, next);
  if (evt) {
    const evKey = VOL_EVENT_PREFIX + code.trim();
    const events = kvGet<VolEvent[]>(evKey) ?? [];
    events.push(evt);
    while (events.length > VOL_EVENT_LEN) events.shift();
    kvSet(evKey, events);
  }
}

/** 懒读取兜底：读 KV；未更新则用行情快照最新价增量（仅 HV/EWMA 口径） */
export async function getStockVolatility(code: string): Promise<StockVolatility> {
  const key = VOL_PREFIX + code.trim();
  const prev = kvGet<VolState>(key);
  let st = prev;
  const today = todayStr();

  // 今日已更新 → 直接返回（流水线命中）
  if (st && st.lastDate === today && st.currentVol !== undefined) {
    return { vol: st.currentVol, ewmaVol: st.ewmaVol, parkVol: st.parkVol, z: st.zScore, level: st.level };
  }

  if (!st) {
    // 首次：拉近 250+ 交易日收盘（腾讯日K），初始化全量
    const closes = await fetchDailyCloses(code, yearAgoStr(), today, 260);
    if (closes.length < 20) return {};
    closes.sort((a, b) => (a.date < b.date ? -1 : 1));
    st = initVolState(closes.map((c) => ({ close: c.close })), closes[closes.length - 1]?.date);
  } else {
    // 增量：拉最新收盘价（行情快照，缓存命中即 O(1)）
    try {
      const snap = await getQuoteSnapshot(code, {});
      const price = typeof snap?.price === "number" && snap.price > 0 ? snap.price : undefined;
      if (price !== undefined) st = pushBar(st, { close: price }, today);
    } catch {
      // 行情失败：保留旧状态
    }
  }

  kvSet(key, st);
  // 懒路径也统一增量感知（vhist/vevent），与消费端一致
  persistVolDerived(code, prev, st);
  return { vol: st.currentVol, ewmaVol: st.ewmaVol, parkVol: st.parkVol, z: st.zScore, level: st.level };
}

/** 批量获取（并去重；逐标的独立失败不影响其他） */
export async function getStockVolatilities(codes: string[]): Promise<Map<string, StockVolatility>> {
  const uniq = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  // 有界并发：未命中缓存时会回源拉日线，无界并发会瞬时打满行情源
  const entries = await mapLimit(uniq, NET_CONCURRENCY, async (code) => [code, await getStockVolatility(code)] as const);
  return new Map(entries);
}

/**
 * 注册波动率更新消费者（数据工程 FaaS 端）。
 * 订阅 vol:update 队列，消费一条即增量更新一个标的（幂等）。
 * 由 features/volatilityJob 的调度任务枚举标的入队。
 */
export function registerVolConsumer(): void {
  registerConsumer({
    queue: VOL_QUEUE,
    name: "市场波动率更新",
    concurrency: 3,
    handlerTimeoutMs: 60_000, // 单标的日K拉取（fetch 12s 超时 + 处理余量）；防挂起卡死消费循环
    handler: async (msg) => {
      const code = (msg.payload as { code?: string } | undefined)?.code;
      if (!code) return;
      await consumeVolUpdate(code);
    },
  });
}
