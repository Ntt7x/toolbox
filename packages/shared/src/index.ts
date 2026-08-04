// ============================================================
// API 契约层（前后端共享）
// 前端只依赖本文件中的类型与路由约定；后端实现可替换
// （TS / 未来 Go 等），只要保持本契约不变即可无缝切换。
// ============================================================

/** 后端健康检查响应 */
export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  time: string;
}

/** 单个小工具的元信息 */
export interface ToolMeta {
  id: string;
  name: string;
  description: string;
  /** 前端路由路径，如 /tools/grid-plan */
  path: string;
}

/** 工具列表响应 */
export interface ToolListResponse {
  tools: ToolMeta[];
}

// ============================================================
// 交易网格计划工具（grid-plan）
// ============================================================

/** 行情趋势类型：1~7 */
export type GridTrendType = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** 风格键：rad=激进 bal=均衡 con=保守 */
export type GridStyleKey = "rad" | "bal" | "con";

/** 网格计划请求体 */
export interface GridPlanRequest {
  /** 趋势类型 1~7 */
  type: GridTrendType;
  /** 月线布林带三个数值，顺序任意（程序按大小排序取 U/M/L） */
  boll: [number, number, number];
  /**
   * 最大仓位金额（可选）：按各档理论总成本 TotalCost = Q_max × C_avg 缩放，
   * 将份数换算为金额维度（每份参考价 = C_avg，金额单位与输入一致）。
   * 不传时保持 K=1000 份基准。
   */
  maxAmount?: number;
}

/** 单档风格的完整结果 */
export interface GridStyleResult {
  key: GridStyleKey;
  /** 方案是否不可用（极端安全重算仍超限时跳过） */
  unavailable: boolean;
  /** 附加标记：如「不对称」「偏差过大」「盈利约束不满足」等 */
  flags: string[];
  /** 止损（百分数） */
  L_stop: number;
  /** 锁盈（百分数） */
  P_lock: number;
  /** 间距系数 m */
  m: number;
  /** 加仓次数 n */
  n: number;
  /** 极端浮盈（百分数，相对成本） */
  profit_ratio: number;
  /** 极端浮亏（百分数，相对成本） */
  loss_ratio: number;
  /** 最大仓位（份） */
  Q_max: number;
  /** 最小仓位（份） */
  Q_min: number;
  /** 上涨卖出间距（百分数） */
  a_final: number;
  /** 下跌买入间距（百分数） */
  b_final: number;
  /** 上涨卖出份数 */
  S_int: number;
  /** 下跌买入份数 */
  B_int: number;
  /**
   * 金额模式数据（请求传了 maxAmount 时才有）：
   * 份数按 maxAmount / TotalCost 缩放，每份参考价 = C_avg。
   */
  amount?: {
    /** 每份参考价（加权均价 C_avg） */
    unitPrice: number;
    /** 每格买入金额 */
    buyAmount: number;
    /** 每格卖出金额 */
    sellAmount: number;
    /** 最大仓位金额（≈ 用户输入的 maxAmount，含舍入） */
    maxAmount: number;
    /** 最小仓位金额 */
    minAmount: number;
  };
}

/** 网格计划成功响应 */
export interface GridPlanResponse {
  ok: true;
  /** 方案产出日期 YYYY-MM-DD */
  date: string;
  U: number;
  M: number;
  L: number;
  /** 月波动率（百分数，两位小数） */
  sigma_m: number;
  /** 日波动率（百分数，两位小数） */
  sigma_d: number;
  type: GridTrendType;
  typeName: string;
  /** 不对称比 r */
  r: number;
  r_desc: string;
  /** 布林带不对称标记 */
  asymmetric: boolean;
  /** 用户输入的最大仓位金额（金额模式时存在） */
  maxAmount?: number;
  styles: Record<GridStyleKey, GridStyleResult>;
  /** 完整 Markdown 计划文本（与 LLM 输出同构） */
  markdown: string;
}

/** 网格计划错误响应 */
export interface GridPlanErrorResponse {
  ok: false;
  /** format=输入格式错误 boll=布林带数值异常 volatility=波动率计算异常 */
  error: "format" | "boll" | "volatility";
  message: string;
}

export type GridPlanResult = GridPlanResponse | GridPlanErrorResponse;

/** API 统一前缀（前端 dev server 会代理到后端） */
export const API_PREFIX = "/api";
