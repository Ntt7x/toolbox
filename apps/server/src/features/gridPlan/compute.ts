// ============================================================
// 交易网格计划生成（由 LLM 提示词固化而来的确定性计算）
// 输入：type(1~7) + 月线布林带三值（顺序任意）
// 输出：三档风格（激进/均衡/保守）完整参数 + Markdown 计划文本
// 注意：所有百分比变量均为百分数数值（如 2.21 表示 2.21%），
//       仅在转小数时（d = b_final/100）才除以 100。
// ============================================================

import type {
  GridPlanResponse,
  GridPlanResult,
  GridStyleKey,
  GridStyleResult,
  GridTrendType,
} from "@toolbox/shared";

// ---------- 参数表 ----------

interface StyleParams {
  m: number;
  L: number; // L_stop（百分数）
  P: number; // P_lock（百分数）
}

interface TypeParams {
  name: string;
  r: number;
  b_max: number; // 百分数
  styles: Record<GridStyleKey, StyleParams>;
}

const TYPE_PARAMS: Record<GridTrendType, TypeParams> = {
  1: {
    name: "单边强牛市",
    r: 5.0,
    b_max: 15,
    styles: { rad: { m: 1.0, L: 12, P: 18 }, bal: { m: 1.8, L: 11, P: 16 }, con: { m: 2.5, L: 10, P: 14 } },
  },
  2: {
    name: "单边强熊市",
    r: 0.2,
    b_max: 15,
    styles: { rad: { m: 1.5, L: 8, P: 8 }, bal: { m: 2.5, L: 7, P: 6 }, con: { m: 3.5, L: 6, P: 4 } },
  },
  3: {
    name: "慢牛震荡市",
    r: 2.5,
    b_max: 10,
    styles: { rad: { m: 0.55, L: 11, P: 14 }, bal: { m: 1.0, L: 10, P: 12 }, con: { m: 1.2, L: 9, P: 10 } },
  },
  4: {
    name: "慢熊震荡市",
    r: 0.4,
    b_max: 10,
    styles: { rad: { m: 0.8, L: 10, P: 10 }, bal: { m: 1.5, L: 9, P: 8 }, con: { m: 2.0, L: 8, P: 6 } },
  },
  5: {
    name: "宽幅震荡市",
    r: 1.0,
    b_max: 10,
    styles: { rad: { m: 0.8, L: 13, P: 10 }, bal: { m: 1.2, L: 12, P: 8 }, con: { m: 1.5, L: 11, P: 6 } },
  },
  6: {
    name: "窄幅盘整市",
    r: 1.0,
    b_max: 7,
    styles: { rad: { m: 0.3, L: 6, P: 5 }, bal: { m: 0.5, L: 5, P: 4 }, con: { m: 0.7, L: 4, P: 3 } },
  },
  7: {
    name: "喇叭口震荡",
    r: 1.0,
    b_max: 10,
    styles: { rad: { m: 0.8, L: 10, P: 12 }, bal: { m: 1.2, L: 9, P: 10 }, con: { m: 1.5, L: 8, P: 8 } },
  },
};

/** x* 表：方程 x·e⁻ˣ/(1−e⁻ˣ) = 1−L_stop/100 的解 */
const X_STAR: Record<number, number> = {
  4: 0.080, 5: 0.100, 6: 0.121, 7: 0.142, 8: 0.162, 9: 0.185, 10: 0.2075,
  11: 0.232, 12: 0.248, 13: 0.265, 14: 0.284, 15: 0.305, 16: 0.327, 17: 0.350, 18: 0.374,
};

const STYLE_ORDER: GridStyleKey[] = ["rad", "bal", "con"];

/** 相邻下一档（rad→bal→con；con 无下一档） */
const NEXT_STYLE: Partial<Record<GridStyleKey, GridStyleKey>> = { rad: "bal", bal: "con" };

// ---------- 数值工具 ----------

const SQRT21 = 4.58257569496;

/** 四舍五入保留 n 位小数 */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** 格式化数值：最多 4 位小数、去尾零（用于布林带原值展示） */
function fmt4(x: number): string {
  return String(parseFloat(x.toFixed(4)));
}

/** 格式化百分数/一般数值：最多 2 位小数、去尾零 */
function fmt2(x: number): string {
  return String(parseFloat(x.toFixed(2)));
}

// ---------- 网格间距与仓位计算 ----------

interface GridCalc {
  m: number;
  a_raw: number;
  b_raw: number;
  S_int: number;
  B_int: number;
  a_final: number;
  b_final: number;
  a_dev: number;
  b_dev: number;
  n: number;
  Q_max: number;
  C_avg: number;
  Q_min: number;
  profit_ratio: number;
  loss_ratio: number;
  flags: string[];
}

/**
 * 用指定 m 计算网格间距（a~h 步骤）。
 * 返回 null 表示输入非法（m≤0 或 σ_d 异常，不应发生）。
 */
function calcSpacing(m: number, r: number, sigmaD: number): GridCalc | null {
  if (!(m > 0) || !(r > 0)) return null;
  const delta = m * sigmaD; // 百分数
  const aRaw = (2 * r) / (r + 1) * delta; // 百分数
  const bRaw = 2 / (r + 1) * delta; // 百分数
  const SInt = Math.max(100, Math.round((aRaw * 1000) / 100) * 100);
  const BInt = Math.max(100, Math.round((bRaw * 1000) / 100) * 100);
  const aFinal = SInt / 1000; // 百分数
  const bFinal = BInt / 1000; // 百分数
  return {
    m,
    a_raw: aRaw,
    b_raw: bRaw,
    S_int: SInt,
    B_int: BInt,
    a_final: aFinal,
    b_final: bFinal,
    a_dev: Math.abs(aFinal - aRaw) / aRaw,
    b_dev: Math.abs(bFinal - bRaw) / bRaw,
    n: 0,
    Q_max: 0,
    C_avg: 0,
    Q_min: 0,
    profit_ratio: 0,
    loss_ratio: 0,
    flags: [],
  };
}

/** F(n) = n·d·qⁿ / (1−qⁿ) */
function F(n: number, d: number, q: number): number {
  const qn = Math.pow(q, n);
  return (n * d * qn) / (1 - qn);
}

/**
 * 仓位约束：求最小 n，最大仓位 Q_max、均价 C_avg、最小仓位 Q_min。
 */
function calcPosition(
  g: GridCalc,
  L_stop: number,
  P_lock: number,
  M: number,
  sigmaM: number,
): GridCalc {
  const d = g.b_final / 100;
  const q = 1 - d;
  const limit = 1 - L_stop / 100;
  const xStar = X_STAR[L_stop] ?? 0.25;

  // 求最小 n
  let n = g.b_final > 8 ? 1 : Math.ceil(xStar / d);
  let guard = 0;
  while (F(n, d, q) > limit && guard++ < 10000) n++;
  while (n > 1 && F(n - 1, d, q) <= limit) n--;
  g.n = n;

  // 最大仓位与均价
  g.Q_max = n * g.B_int;
  const qn = Math.pow(q, n);
  g.C_avg = (M * (1 - qn)) / (n * d);

  // 盈利锁仓
  const P_high = M * (1 + (2 * sigmaM) / 100);
  const totalCost = g.Q_max * g.C_avg;
  const target = (P_lock / 100) * totalCost;
  if (P_high <= g.C_avg) {
    // P_high ≤ C_avg：盈利约束不满足
    g.Q_min = 100;
    g.flags.push("盈利约束不满足");
  } else {
    const diff = P_high - g.C_avg;
    let qMin = Math.max(100, Math.round((target / diff) / 100) * 100);
    if (qMin >= g.Q_max) {
      // 锁盈所需仓位 ≥ 最大仓位：钳制并警告
      qMin = g.Q_max;
      g.flags.push("锁盈仓位超出最大仓位");
    }
    // 递增至满足锁盈条件，或达 Q_max-100
    guard = 0;
    while (qMin < g.Q_max - 100 && qMin * diff < target && guard++ < 10000) qMin += 100;
    if (qMin * diff < target) g.flags.push("盈利约束不满足");
    g.Q_min = qMin;
  }

  g.profit_ratio = (P_high / g.C_avg - 1) * 100;
  g.loss_ratio = ((M * (1 - (2 * sigmaM) / 100)) / g.C_avg - 1) * 100;
  return g;
}

/**
 * 计算单档风格完整结果。
 * 流程：本档 m → 偏差>8% 时在 m±0.05(0.01步长) 搜索 → 仍失败用下一档 m → 仍失败保留并标记
 * → 极端安全：b_final ≥ b_max 时 m 减半重算一次，仍超限则标记不可用。
 * maxAmount 传入时附加金额维度数据（按 TotalCost = Q_max × C_avg 缩放）。
 */
function computeStyle(
  key: GridStyleKey,
  params: TypeParams,
  M: number,
  sigmaM: number,
  sigmaD: number,
  maxAmount?: number,
): GridStyleResult {
  const base = params.styles[key];
  const flags: string[] = [];

  // 候选 m 序列：本档 → ±0.05 搜索（>0）→ 下一档 m
  const candidates: number[] = [base.m];
  for (let dm = -0.05; dm <= 0.05001; dm += 0.01) {
    const m = Math.round((base.m + dm) * 100) / 100;
    if (m > 0 && Math.abs(m - base.m) > 1e-9) candidates.push(m);
  }
  const next = NEXT_STYLE[key];
  if (next) candidates.push(params.styles[next].m);

  let g: GridCalc | null = null;
  for (const m of candidates) {
    const cand = calcSpacing(m, params.r, sigmaD);
    if (!cand) continue;
    if (cand.a_dev <= 0.08 && cand.b_dev <= 0.08) {
      g = cand;
      break;
    }
    if (g === null) g = cand; // 记住首个结果兜底
  }
  if (g === null) g = calcSpacing(base.m, params.r, sigmaD)!;
  if (g.a_dev > 0.08 || g.b_dev > 0.08) flags.push("偏差过大");

  // 极端安全：b_final ≥ b_max → m 减半重算一次
  if (g.b_final >= params.b_max) {
    const half = calcSpacing(g.m / 2, params.r, sigmaD);
    if (half) {
      const halfFull = calcPosition(half, base.L, base.P, M, sigmaM);
      if (halfFull.b_final < params.b_max) {
        g = halfFull;
      } else {
        flags.push("极端安全超限");
        // 方案不可用：跳过后续（返回不可用结果）
        return {
          key,
          unavailable: true,
          flags: [...flags, "方案不可用"],
          L_stop: base.L,
          P_lock: base.P,
          m: half.m,
          n: 0,
          profit_ratio: 0,
          loss_ratio: 0,
          Q_max: 0,
          Q_min: 0,
          a_final: half.a_final,
          b_final: half.b_final,
          S_int: half.S_int,
          B_int: half.B_int,
        };
      }
    }
  }

  g = calcPosition(g, base.L, base.P, M, sigmaM);
  g.flags = [...flags, ...g.flags];
  const result: GridStyleResult = {
    key,
    unavailable: false,
    flags: g.flags,
    L_stop: base.L,
    P_lock: base.P,
    m: g.m,
    n: g.n,
    profit_ratio: g.profit_ratio,
    loss_ratio: g.loss_ratio,
    Q_max: g.Q_max,
    Q_min: g.Q_min,
    a_final: g.a_final,
    b_final: g.b_final,
    S_int: g.S_int,
    B_int: g.B_int,
  };
  // 金额模式：按用户最大仓位金额缩放
  if (typeof maxAmount === "number" && maxAmount > 0 && g.Q_max > 0 && g.C_avg > 0) {
    const totalCost = g.Q_max * g.C_avg;
    const k = maxAmount / totalCost;
    const roundMoney = (x: number) => Math.round(x * 100) / 100;
    result.amount = {
      unitPrice: roundMoney(g.C_avg),
      buyAmount: roundMoney(k * g.B_int * g.C_avg),
      sellAmount: roundMoney(k * g.S_int * g.C_avg),
      maxAmount: roundMoney(k * g.Q_max * g.C_avg),
      minAmount: roundMoney(k * g.Q_min * g.C_avg),
    };
  }
  return result;
}

// ---------- 方案分析文本 ----------

interface TypeText {
  feature: string;
  rad: string;
  bal: string;
  con: string;
}

const TYPE_TEXT: Record<GridTrendType, TypeText> = {
  1: {
    feature: "单边强牛，回调即买点。宽止损积累大仓位，高锁盈让利润奔跑。",
    rad: "最宽止损高锁盈搏弹性",
    bal: "宽止损高锁盈平衡推荐",
    con: "适中止损锁盈稳参与",
  },
  2: {
    feature: "单边强熊，反弹即卖点。紧止损控风险，极低锁盈兑现微弱反弹。",
    rad: "加仓积极但止损严锁盈低",
    bal: "紧止损极低锁盈推荐",
    con: "最克制最轻仓",
  },
  3: {
    feature: "慢牛缓升急跌慢涨，止损适中，锁盈适中偏高。",
    rad: "宽止损高锁盈浅回调积累",
    bal: "适中推荐",
    con: "紧止损稳锁盈",
  },
  4: {
    feature: "慢熊缓降反弹弱，止损偏紧，锁盈偏低。",
    rad: "快卖加仓较快止损紧",
    bal: "平衡",
    con: "最保守等深跌",
  },
  5: {
    feature: "宽幅震荡无方向，止损放宽捕波段，锁盈及时防回吐。",
    rad: "高频大波段",
    bal: "推荐",
    con: "及时锁盈减损耗",
  },
  6: {
    feature: "波动极低价格粘滞，止损极紧防突破，锁盈谨慎免仓位膨胀。",
    rad: "超密网吃微利",
    bal: "推荐",
    con: "保留资金等变盘",
  },
  7: {
    feature: "波动率显著变化，止损适中，锁盈预留空间。",
    rad: "较密留缓冲",
    bal: "推荐",
    con: "安全边际最高",
  },
};

const STYLE_LABEL: Record<GridStyleKey, string> = { rad: "🔴激进", bal: "🟡均衡", con: "🟢保守" };

// ---------- Markdown 生成 ----------

function buildMarkdown(
  resp: Omit<GridPlanResponse, "ok" | "markdown">,
  styles: Record<GridStyleKey, GridStyleResult>,
  maxAmount?: number,
): string {
  const { date, U, M, L, sigma_m, sigma_d, type, typeName, r, r_desc } = resp;
  const s = styles;
  const txt = TYPE_TEXT[type];
  const amountMode = typeof maxAmount === "number" && maxAmount > 0;

  const flagNote = (key: GridStyleKey): string =>
    s[key].unavailable || s[key].flags.length > 0
      ? `（⚠️ ${s[key].flags.join("；")}）`
      : "";

  const lines: string[] = [];
  lines.push("**📊 网格计划概要**");
  lines.push(`方案产出日期：**${date}**  `);
  lines.push(`月线布林带：**${fmt4(U)} / ${fmt4(M)} / ${fmt4(L)}**  `);
  lines.push(`月波动率 σ_m：**${fmt2(sigma_m)}%**  |  日波动率 σ_d：**${fmt2(sigma_d)}%**  `);
  lines.push(`趋势类型：**${typeName}**  |  不对称比 r = **${fmt2(r)}** (${r_desc})  `);
  lines.push("风控模式：牛熊非对称风格化止损/锁盈");
  lines.push("");
  lines.push("| 风格 | 📈 上涨卖出 (a% / 份 / 金额) | 📉 下跌买入 (b% / 份 / 金额) | ⚖️ 仓位控制 (范围 → 浮亏止 / 浮盈止) |");
  lines.push("|------|----------------------|----------------------|-----------------------------------------------|");
  for (const key of STYLE_ORDER) {
    const st = s[key];
    if (st.unavailable) {
      lines.push(`| ${STYLE_LABEL[key]} | — | — | 方案不可用${flagNote(key)} |`);
      continue;
    }
    const amt = st.amount;
    if (amountMode && amt) {
      lines.push(
        `| ${STYLE_LABEL[key]} | ${fmt2(st.a_final)}% / ${st.S_int} / ${fmt2(amt.sellAmount)} | ${fmt2(st.b_final)}% / ${st.B_int} / ${fmt2(amt.buyAmount)} | ${fmt2(amt.maxAmount)}~${fmt2(amt.minAmount)} → 加仓至-${st.L_stop}%止 / 减仓至盈利${st.P_lock}%止${flagNote(key)} |`,
      );
    } else {
      lines.push(
        `| ${STYLE_LABEL[key]} | ${fmt2(st.a_final)}% / ${st.S_int} | ${fmt2(st.b_final)}% / ${st.B_int} | ${st.Q_max}~${st.Q_min}份 → 加仓至-${st.L_stop}%止 / 减仓至盈利${st.P_lock}%止${flagNote(key)} |`,
      );
    }
  }
  lines.push("");
  lines.push(
    amountMode
      ? `> 📝 仓位按最大仓位金额 ${fmt2(maxAmount!)} 缩放（每份参考价 = 加权均价 C_avg，金额单位与输入一致）。最大仓位由各自浮亏止损决定，最小仓位由盈利锁定反推验算。🔴宽止损高仓 🟡平衡推荐 🟢紧止损轻仓。`
      : "> 📝 仓位中性 K=1000，百份倍数。最大仓位由各自浮亏止损决定，最小仓位由盈利锁定反推验算。🔴宽止损高仓 🟡平衡推荐 🟢紧止损轻仓。",
  );
  lines.push("");
  lines.push("**🔬 方案分析：趋势适配与数学逻辑**");
  lines.push(txt.feature);
  lines.push(`> **趋势特征**：${txt.feature}`);
  lines.push(">");
  lines.push("> | 风格 | 止损 L | 锁盈 P | 买入 b% | 加仓 n | 最大仓位 | 最小仓位 | 极端浮盈 | 极端浮亏 |");
  lines.push("> |------|--------|--------|---------|--------|----------|----------|----------|----------|");
  for (const key of STYLE_ORDER) {
    const st = s[key];
    if (st.unavailable) {
      lines.push(`> | ${STYLE_LABEL[key]} | ${st.L_stop}% | ${st.P_lock}% | — | — | — | — | — | — |`);
      continue;
    }
    lines.push(
      `> | ${STYLE_LABEL[key]} | ${st.L_stop}% | ${st.P_lock}% | ${fmt2(st.b_final)}% | ${st.n} | ${st.Q_max} | ${st.Q_min} | ${fmt2(st.profit_ratio)}% | ${fmt2(st.loss_ratio)}% |`,
    );
  }
  lines.push(">");
  lines.push(
    `> ${STYLE_LABEL.rad}：${txt.rad}；${STYLE_LABEL.bal}：${txt.bal}；${STYLE_LABEL.con}：${txt.con}。`,
  );
  lines.push("");
  lines.push("**🧪 操作示例（以均衡型为例）**");
  const b = s.bal;
  if (!b.unavailable) {
    const amt = b.amount;
    lines.push("以中轨 M 为基准：");
    lines.push(
      amountMode && amt
        ? `1. 价格下跌 ${fmt2(b.b_final)}% 至 M×(1-${fmt2(b.b_final)}/100) → 买入 ${b.B_int} 份（约 ${fmt2(amt.buyAmount)}），重复至浮亏达 ${b.L_stop}% 停止，此时为最大仓位。`
        : `1. 价格下跌 ${fmt2(b.b_final)}% 至 M×(1-${fmt2(b.b_final)}/100) → 买入 ${b.B_int} 份，重复至浮亏达 ${b.L_stop}% 停止，此时为最大仓位。`,
    );
    lines.push(
      amountMode && amt
        ? `2. 价格从低点上涨 ${fmt2(b.a_final)}% → 卖出 ${b.S_int} 份（约 ${fmt2(amt.sellAmount)}）。当价格触及 M×(1+2σ_m/100) 时，若剩余浮盈≥总成本 ${b.P_lock}%，停止卖出，保留最小仓位。`
        : `2. 价格从低点上涨 ${fmt2(b.a_final)}% → 卖出 ${b.S_int} 份。当价格触及 M×(1+2σ_m/100) 时，若剩余浮盈≥总成本 ${b.P_lock}%，停止卖出，保留最小仓位。`,
    );
    lines.push("3. 震荡反复获利；单边严守仓位约束。");
  } else {
    lines.push("（均衡型方案不可用，请参考其它风格或重新评估市场环境）");
  }
  lines.push("");
  lines.push("**⚠️ 风险排序与执行要点**");
  lines.push("**🔴 首要风险：趋势误判** — 行情与预期相反将逆势加仓至硬止损，趋势改变立即暂停或修正。");
  lines.push("**🟠 第二风险：数据滞后与跳空** — 布林带滞后，跳空可击穿多层网格，极端事件前缩减仓位。");
  lines.push("**🟡 第三风险：资金管理失控** — 最大仓位市值超总资金可承受比例将致保证金不足。预评估最大仓位市值，等比例缩放份额。");
  lines.push("**🟢 常规操作：** 中枢 M，突破 M×(1±2σ_m) 暂停网格；每月更新布林带，σ_d 变动超 ±0.3% 重选方案；触发价加 0.05% 缓冲；方案标注“⚠️盈利约束不满足”不可用，须更保守或等环境改变。");

  return lines.join("\n");
}

// ---------- 入口 ----------

export function generateGridPlan(
  type: GridTrendType,
  boll: [number, number, number],
  maxAmount?: number,
): GridPlanResult {
  // 排序取 U / M / L
  const sorted = [...boll].sort((a, b) => b - a);
  const U = sorted[0];
  const M = sorted[1];
  const L = sorted[2];
  if (U <= M || M <= L) {
    return { ok: false, error: "boll", message: "布林带数值异常" };
  }

  const params = TYPE_PARAMS[type];

  // 1. 波动率（此处已保证 U > M > L，M !== L 恒成立）
  const sigmaM = ((U - L) / (4 * M)) * 100;
  const ratio = (U - M) / (M - L);
  const asymmetric = ratio < 0.7 || ratio > 1.3;
  const sigmaD = sigmaM / SQRT21;
  // 2026-08-14 注：SQRT21≈4.58，sigmaD = sigmaM/4.58 恒小于 sigmaM，此分支为防御性死代码
  if (sigmaD >= sigmaM) {
    return { ok: false, error: "volatility", message: "波动率计算异常" };
  }

  // 2~4. 三档风格
  const styles = {} as Record<GridStyleKey, GridStyleResult>;
  for (const key of STYLE_ORDER) {
    styles[key] = computeStyle(key, params, M, sigmaM, sigmaD, maxAmount);
  }

  // r 描述
  const r = params.r;
  const r_desc = r > 1.5 ? "强牛向" : r > 1 ? "牛向" : r === 1 ? "中性" : r >= 0.5 ? "熊向" : "强熊向";

  // 日期（本地时区 YYYY-MM-DD）
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const resp: Omit<GridPlanResponse, "ok" | "markdown"> = {
    date,
    U,
    M,
    L,
    sigma_m: round2(sigmaM),
    sigma_d: round2(sigmaD),
    type,
    typeName: params.name,
    r,
    r_desc,
    asymmetric,
    ...(typeof maxAmount === "number" && maxAmount > 0 ? { maxAmount } : {}),
    styles,
  };

  return { ok: true, ...resp, markdown: buildMarkdown(resp, styles, maxAmount) };
}
