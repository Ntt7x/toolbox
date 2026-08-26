// ============================================================
// 公共·纯函数：标的市场波动率（数据工程流水线——增量维护 + 历史σ分级）
// 波动率是市场/标的的客观属性（价格波动），与用户交易无关。
// 纯函数（无 I/O）：side-effect（KV 读写 / 行情拉取）在 core/volatilityStore.ts。
// 参考金融口径：年化波动率 = 日收益率标准差 × √252；
//   波动分级用「该标的历史波动分布」的 z-score（标准差）：z<0 低波 / 0~1 中波 / >1 高波。
// 三口径（数据工程派生指标，均 O(1) 增量维护）：
//   HV 历史波动率（主口径，分级基准）：日简单收益率样本标准差 × √252
//   EWMA（RiskMetrics λ=0.94）：σ²_t = λσ²_{t-1} + (1-λ)r²_t——单状态增量，对近期更敏感
//   Parkinson：用当日高低价 ln(H/L)²，信息效率是收盘价法 5~8 倍
// ============================================================

export const VOL_WINDOW = 60;    // 当前波动窗口（交易日）
export const HIST_VOL_WINDOW = 20; // 历史滚动波动的子窗口
export const HIST_LEN = 240;     // 历史波动序列长度（≈1 年交易日）
export const EWMA_LAMBDA = 0.94; // RiskMetrics 标准衰减因子

export interface VolState {
  /** 当前窗口收盘价（定长滑动，最多 VOL_WINDOW） */
  closes: number[];
  /** 当前窗口当日最高价（与 closes 同步滑动；无高低数据时 = closes） */
  highs: number[];
  /** 当前窗口当日最低价 */
  lows: number[];
  /** 窗口内 sum / sumsq（HV 的 O(1) 增量维护） */
  sum: number;
  sumsq: number;
  /** 历史滚动年化波动序列（用于 μ/σ 分级） */
  histVols: number[];
  /** EWMA 方差状态（σ²_t，单状态增量） */
  ewmaVar?: number;
  /** 当前 HV 年化波动率 %（近 VOL_WINDOW 日，主口径） */
  currentVol?: number;
  /** 当前 EWMA 年化波动率 % */
  ewmaVol?: number;
  /** 当前 Parkinson 年化波动率 % */
  parkVol?: number;
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

/** Parkinson 年化波动率 %（利用当日高低价；窗口内 ln(H/L)² 均值，σ² = E[ln(H/L)²]/(4ln2)） */
export function parkVolOf(highs: number[], lows: number[]): number | undefined {
  if (highs.length < 3 || highs.length !== lows.length) return undefined;
  let sum = 0;
  for (let i = 0; i < highs.length; i++) {
    const h = highs[i]!;
    const l = lows[i]!;
    if (!(h > 0) || !(l > 0) || h < l) return undefined;
    sum += Math.log(h / l) ** 2;
  }
  const sigma2 = sum / highs.length / (4 * Math.LN2); // 1/(4 ln2)
  return Math.sqrt(sigma2) * Math.sqrt(252) * 100;
}

/** EWMA 增量一步：σ²_t = λσ²_{t-1} + (1-λ) r²_t */
export function ewmaNext(prevVar: number, ret: number, lambda = EWMA_LAMBDA): number {
  return lambda * prevVar + (1 - lambda) * ret * ret;
}

/** EWMA 初始化：用收盘序列的前 N 日收益率样本方差作为 σ² seed */
export function initEwma(closes: number[], lambda = EWMA_LAMBDA): number {
  const n = closes.length - 1;
  if (n < 2) return 0;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i]! / closes[i - 1]! - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const v = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return v;
}

/** EWMA 年化波动率 %（方差 → 年化） */
export function ewmaAnnualVar(varToday: number): number {
  return Math.sqrt(varToday) * Math.sqrt(252) * 100;
}

/** 从 OHLC 序列初始化状态（首次：全量算；历史波动序列用 HIST_VOL_WINDOW 滚动） */
export function initVolState(
  bars: { close: number; high?: number; low?: number }[],
  lastDate?: string,
): VolState {
  const win = bars.slice(-VOL_WINDOW);
  const histVols: number[] = [];
  for (let i = HIST_VOL_WINDOW; i <= bars.length; i++) {
    const v = annualVolOf(bars.slice(i - HIST_VOL_WINDOW, i).map((b) => b.close));
    if (v !== undefined) histVols.push(v);
  }
  const closes = win.map((b) => b.close);
  const highs = win.map((b) => (b.high && b.high > 0 ? b.high : b.close));
  const lows = win.map((b) => (b.low && b.low > 0 ? b.low : b.close));
  const st: VolState = {
    closes, highs, lows, sum: 0, sumsq: 0, histVols,
    ewmaVar: initEwma(bars.map((b) => b.close)),
    lastDate,
  };
  for (const c of closes) { st.sum += c; st.sumsq += c * c; }
  return refresh(st);
}

/**
 * 增量：推入一根 K 线（O(1)：push/shift + sum/sumsq 调整；同日同价自动去重幂等）。
 * 同时维护 HV 窗口（close）、Parkinson 窗口（high/low）、EWMA 状态（close 收益率）。
 */
export function pushBar(st: VolState, bar: { close: number; high?: number; low?: number }, date?: string): VolState {
  const close = bar.close;
  const high = bar.high && bar.high > 0 ? bar.high : close;
  const low = bar.low && bar.low > 0 ? bar.low : close;
  const next: VolState = {
    ...st,
    closes: [...st.closes], highs: [...st.highs], lows: [...st.lows],
    sum: st.sum, sumsq: st.sumsq,
    histVols: [...st.histVols], ewmaVar: st.ewmaVar,
    lastDate: date ?? st.lastDate,
  };
  // 同日幂等：同日同价直接返回；同日不同价 → 替换最后一根（懒/调度双路径同日交替不污染窗口）
  if (date && date === st.lastDate && next.closes.length > 0) {
    if (Math.abs(next.closes[next.closes.length - 1]! - close) < 1e-9) return st;
    const old = next.closes[next.closes.length - 1]!;
    next.closes[next.closes.length - 1] = close;
    next.highs[next.highs.length - 1] = Math.max(high, next.highs[next.highs.length - 1]!);
    next.lows[next.lows.length - 1] = Math.min(low, next.lows[next.lows.length - 1]!);
    next.sum += close - old;
    next.sumsq += close * close - old * old;
    return refresh(next); // 同日替换：不更新 EWMA（避免重复计收益）、不追加 histVols
  }
  // EWMA 增量（用本日与上一收盘的收益率）
  const prevClose = next.closes.length > 0 ? next.closes[next.closes.length - 1]! : undefined;
  if (prevClose && prevClose > 0 && next.ewmaVar !== undefined) {
    next.ewmaVar = ewmaNext(next.ewmaVar, close / prevClose - 1);
  }
  // 窗口滑动（close/high/low 同步）
  next.closes.push(close); next.highs.push(high); next.lows.push(low);
  next.sum += close; next.sumsq += close * close;
  while (next.closes.length > VOL_WINDOW) {
    const old = next.closes.shift()!;
    next.highs.shift(); next.lows.shift();
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

/** 兼容：仅收盘价增量（无高低数据时 high/low = close，Parkinson 无效但 HV/EWMA 可用） */
export function pushClose(st: VolState, close: number, date?: string): VolState {
  return pushBar(st, { close }, date);
}

/** 刷新派生量：三口径波动 / 历史 μσ / z-score / 分级（纯） */
function refresh(st: VolState): VolState {
  const currentVol = annualVolOf(st.closes);
  const ewmaVol = st.ewmaVar !== undefined ? ewmaAnnualVar(st.ewmaVar) : undefined;
  const parkVol = parkVolOf(st.highs, st.lows);
  const hist = st.histVols;
  let zScore: number | undefined;
  if (currentVol !== undefined && hist.length >= 20) {
    const mu = hist.reduce((a, b) => a + b, 0) / hist.length;
    const sd = Math.sqrt(hist.reduce((a, b) => a + (b - mu) ** 2, 0) / (hist.length - 1));
    if (sd > 0) zScore = (currentVol - mu) / sd;
  }
  return {
    ...st, currentVol, ewmaVol, parkVol, zScore,
    // z<0 低波 / 0~1 中波 / 1~1.5 高波 / >1.5 极波（标准差分级，金融口径）
    level: zScore === undefined ? undefined : zScore < 0 ? "low" : zScore <= 1 ? "mid" : zScore <= 1.5 ? "high" : "extreme",
  };
}

/** 分级中文描述（供前端提示） */
export function levelLabel(level?: "low" | "mid" | "high" | "extreme"): string {
  return level === "low" ? "低波" : level === "mid" ? "中波" : level === "high" ? "高波" : level === "extreme" ? "极波" : "波动未知";
}

// ============================================================
// 增量感知：状态变化事件派生（纯函数）
// 对比更新前后状态 → 感知显著变化（level 跃迁 / 波动突变 / 首次有值）
// 供消费端/懒读端在每次增量更新后调用，落事件审计 + 触发下游反应。
// ============================================================

export interface VolEvent {
  /** 事件类型：new 首次有波动 / level-up 分级跃升 / level-down 分级回落 / surge 波动突变（>30%） */
  kind: "new" | "level-up" | "level-down" | "surge";
  prevLevel?: "low" | "mid" | "high" | "extreme";
  nextLevel?: "low" | "mid" | "high" | "extreme";
  prevVol?: number;
  nextVol?: number;
  z?: number;
  date?: string;
}

/** 波动分级单调序（用于判断跃升/回落） */
const LEVEL_RANK: Record<string, number> = { low: 0, mid: 1, high: 2, extreme: 3 };

/** 突变阈值：单日年化波动相对变化 > 30% 视为异常跳变 */
export const SURGE_RATIO = 0.3;

/**
 * 感知增量变化：对比更新前后状态，返回事件（无显著变化 → null）。
 * 优先级：level 跃迁 > vol 突变 > 首次有值（new）。
 * 幂等：同日同状态更新（prev === next 值）→ null。
 */
export function diffVolState(prev: VolState | null | undefined, next: VolState): VolEvent | null {
  const prevVol = prev?.currentVol;
  const nextVol = next.currentVol;
  // 首次有波动（之前无数据或之前无值）
  if (!prev || prevVol === undefined) {
    return nextVol !== undefined ? { kind: "new", nextVol, z: next.zScore, date: next.lastDate } : null;
  }
  if (nextVol === undefined) return null;
  // level 跃迁（优先级最高）
  if (prev.level !== next.level && prev.level && next.level) {
    const up = (LEVEL_RANK[next.level] ?? 1) > (LEVEL_RANK[prev.level] ?? 1);
    return {
      kind: up ? "level-up" : "level-down",
      prevLevel: prev.level, nextLevel: next.level,
      prevVol, nextVol, z: next.zScore, date: next.lastDate,
    };
  }
  // 波动突变（单日相对变化超阈值）
  if (prevVol > 0) {
    const rel = Math.abs(nextVol - prevVol) / prevVol;
    if (rel > SURGE_RATIO) {
      return { kind: "surge", prevVol, nextVol, z: next.zScore, date: next.lastDate };
    }
  }
  return null;
}
