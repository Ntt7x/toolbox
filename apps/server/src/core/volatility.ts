// ============================================================
// 公共·纯函数：标的市场波动率（数据工程流水线——增量维护 + 历史σ分级）
// 波动率是市场/标的的客观属性（价格波动），与用户交易无关。
// 纯函数（无 I/O）：side-effect（KV 读写 / 行情拉取）在 core/quote.ts 的 getStockVolatility。
// 参考金融口径：年化波动率 = 日收益率标准差 × √252；
//   波动分级用「该标的历史波动分布」的 z-score（标准差）：z<0 低波 / 0~1 中波 / >1 高波。
// ============================================================

export const VOL_WINDOW = 60;    // 当前波动窗口（交易日）
export const HIST_VOL_WINDOW = 20; // 历史滚动波动的子窗口
export const HIST_LEN = 240;     // 历史波动序列长度（≈1 年交易日）

export interface VolState {
  /** 当前窗口收盘价（定长滑动，最多 VOL_WINDOW） */
  closes: number[];
  /** 窗口内 sum / sumsq（O(1) 增量维护，避免每次重算） */
  sum: number;
  sumsq: number;
  /** 历史滚动年化波动序列（用于 μ/σ 分级） */
  histVols: number[];
  /** 当前年化波动率 %（近 VOL_WINDOW 日） */
  currentVol?: number;
  /** 当前波动相对自身历史分布的 z-score（>1σ = 高波） */
  zScore?: number;
  /** 波动分级：low / mid / high / extreme（按 z-score；extreme = z>1.5σ） */
  level?: "low" | "mid" | "high" | "extreme";
  /** 最后收盘日期（YYYY-MM-DD，防同日重复更新） */
  lastDate?: string;
}

/** 年化波动率 %（日收益率样本标准差 × √252；序列 <2 项 → undefined） */
export function annualVolOf(closes: number[]): number | undefined {
  if (closes.length < 3) return undefined; // 至少 2 个收益率
  let mean = 0;
  for (let i = 1; i < closes.length; i++) mean += (closes[i]! - closes[i - 1]!) / closes[i - 1]!;
  mean /= closes.length - 1;
  let v = 0;
  for (let i = 1; i < closes.length; i++) {
    const r = (closes[i]! - closes[i - 1]!) / closes[i - 1]!;
    v += (r - mean) ** 2;
  }
  const sd = Math.sqrt(v / (closes.length - 2));
  return sd * Math.sqrt(252) * 100;
}

/** 从收盘序列初始化状态（首次：全量算；历史波动序列用 HIST_VOL_WINDOW 滚动） */
export function initVolState(closes: number[], lastDate?: string): VolState {
  const win = closes.slice(-VOL_WINDOW);
  const histVols: number[] = [];
  for (let i = HIST_VOL_WINDOW; i <= closes.length; i++) {
    const v = annualVolOf(closes.slice(i - HIST_VOL_WINDOW, i));
    if (v !== undefined) histVols.push(v);
  }
  const st: VolState = { closes: win, sum: 0, sumsq: 0, histVols, lastDate };
  for (const c of win) { st.sum += c; st.sumsq += c * c; }
  return refresh(st);
}

/** 增量：推入一个新收盘价（O(1)：push/shift + sum/sumsq 调整；同日重复价自动去重） */
export function pushClose(st: VolState, close: number, date?: string): VolState {
  const next: VolState = {
    closes: [...st.closes], sum: st.sum, sumsq: st.sumsq,
    histVols: [...st.histVols], currentVol: st.currentVol,
    zScore: st.zScore, level: st.level, lastDate: date ?? st.lastDate,
  };
  if (next.closes.length > 0 && Math.abs(next.closes[next.closes.length - 1]! - close) < 1e-9 && date && date === st.lastDate) return next; // 同日同价，幂等
  next.closes.push(close); next.sum += close; next.sumsq += close * close;
  while (next.closes.length > VOL_WINDOW) {
    const old = next.closes.shift()!;
    next.sum -= old; next.sumsq -= old * old;
  }
  // 历史波动序列：本日 20 日窗口波动入列，超长截断
  const tail = [...st.closes, close].slice(-HIST_VOL_WINDOW);
  const v = annualVolOf(tail);
  if (v !== undefined) {
    next.histVols.push(v);
    while (next.histVols.length > HIST_LEN) next.histVols.shift();
  }
  return refresh(next);
}

/** 刷新派生量：当前波动 / 历史 μσ / z-score / 分级（纯） */
function refresh(st: VolState): VolState {
  const currentVol = annualVolOf(st.closes);
  const hist = st.histVols;
  let zScore: number | undefined;
  if (currentVol !== undefined && hist.length >= 20) {
    const mu = hist.reduce((a, b) => a + b, 0) / hist.length;
    const sd = Math.sqrt(hist.reduce((a, b) => a + (b - mu) ** 2, 0) / (hist.length - 1));
    if (sd > 0) zScore = (currentVol - mu) / sd;
  }
  return {
    ...st, currentVol,
    zScore,
    // z<0 低波 / 0~1 中波 / 1~1.5 高波 / >1.5 极波（标准差分级，金融口径）
    level: zScore === undefined ? undefined : zScore < 0 ? "low" : zScore <= 1 ? "mid" : zScore <= 1.5 ? "high" : "extreme",
  };
}

/** 分级中文描述（供前端提示） */
export function levelLabel(level?: "low" | "mid" | "high" | "extreme"): string {
  return level === "low" ? "低波" : level === "mid" ? "中波" : level === "high" ? "高波" : level === "extreme" ? "极波" : "波动未知";
}
