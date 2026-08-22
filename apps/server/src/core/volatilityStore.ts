// ============================================================
// 公共·副作用层：标的市场波动率（KV 持久化 + 行情日K）
// 纯计算在 core/volatility.ts（initVolState / pushClose / annualVolOf）
// 这里只做 I/O：读状态 → 增量更新（O(1) 流水线）→ 写回；首次全量初始化。
// 波动率是市场客观属性，与用户交易无关（新分组/无交易标的也能算）。
// ============================================================
import { kvGet, kvSet } from "./kvStore.js";
import { initVolState, pushClose, type VolState } from "./volatility.js";
import { fetchDailyCloses, getQuoteSnapshot } from "./quote.js";
import { registerDataSource } from "./dataRegistry.js";

// 注册数据源：标的市场波动率流水线状态（本地数据管理可见，避免"未标记"）
registerDataSource({
  kind: "kv",
  name: "quote:v:",
  page: "行情工具",
  tag: "分析数据",
  description: "标的市场波动率流水线（近60日收盘窗口 + 历史波动分布，KV 持久化，每日增量）",
});

const VOL_PREFIX = "quote:v:";

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface StockVolatility {
  /** 当前年化波动率 %（近 VOL_WINDOW 交易日） */
  vol?: number;
  /** 相对自身历史波动分布的 z-score（>1σ = 高波） */
  z?: number;
  /** 分级：low / mid / high */
  level?: "low" | "mid" | "high" | "extreme";
}

/** 获取标的市场波动率（流水线：首次拉 250 日初始化；此后每日 O(1) 增量） */
export async function getStockVolatility(code: string): Promise<StockVolatility> {
  const key = VOL_PREFIX + code.trim();
  let st = kvGet<VolState>(key);
  const today = todayStr();

  // 今日已更新 → 直接返回（流水线命中）
  if (st && st.lastDate === today && st.currentVol !== undefined) {
    return { vol: st.currentVol, z: st.zScore, level: st.level };
  }

  if (!st) {
    // 首次：拉近 250+ 交易日收盘（腾讯日K），初始化全量
    const closes = await fetchDailyCloses(code, "2025-01-01", today, 260);
    if (closes.length < 20) return {};
    closes.sort((a, b) => (a.date < b.date ? -1 : 1));
    st = initVolState(closes.map((c) => c.close), closes[closes.length - 1]?.date);
  } else {
    // 增量：拉最新收盘价（行情快照，缓存命中即 O(1)）
    try {
      const snap = await getQuoteSnapshot(code, {});
      const price = typeof snap?.price === "number" && snap.price > 0 ? snap.price : undefined;
      if (price !== undefined) st = pushClose(st, price, today);
    } catch {
      // 行情失败：保留旧状态
    }
  }

  kvSet(key, st);
  return { vol: st.currentVol, z: st.zScore, level: st.level };
}

/** 批量获取（并去重；逐标的独立失败不影响其他） */
export async function getStockVolatilities(codes: string[]): Promise<Map<string, StockVolatility>> {
  const uniq = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  const entries = await Promise.all(uniq.map(async (code) => [code, await getStockVolatility(code)] as const));
  return new Map(entries);
}
