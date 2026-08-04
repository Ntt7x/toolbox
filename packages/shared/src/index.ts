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
  /** 附加标记：如「偏差过大」「极端安全超限」「盈利约束不满足」等（数据可信度提示） */
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

/** 股票行情查询响应（自动补全月线 BOLL） */
export interface QuoteResponse {
  ok: true;
  /** 归一化代码，如 sh600519 / hk00700 */
  code: string;
  /** 证券名称，如 贵州茅台 */
  name: string;
  /** 月线布林带上/中/下轨（由最近 20 根完整月 K 收盘价计算） */
  U: number;
  M: number;
  L: number;
  /** 参与计算的完整月 K 根数（不足 20 时按实际根数） */
  bars: number;
  /** 最后一根参与计算的月 K 日期（YYYY-MM-DD） */
  lastDate: string;
  warning?: string;
}

export interface QuoteErrorResponse {
  ok: false;
  message: string;
}

export type QuoteResult = QuoteResponse | QuoteErrorResponse;

// ============================================================
// LLM 能力模块（DeepSeek）
// ============================================================

/** LLM 状态响应 */
export interface LlmStatusResponse {
  ok: true;
  /** 是否已配置 API key */
  configured: boolean;
  /** 默认使用的模型名（仅展示，无模型配置机制） */
  model?: string;
}

/** 保存/清除 LLM 设置请求 */
export interface LlmSettingsRequest {
  /** DeepSeek API key；传空字符串表示清除 */
  apiKey: string;
}

export interface LlmSettingsResponse {
  ok: true;
  configured: boolean;
}

/** 测试连接响应 */
export interface LlmTestResponse {
  ok: true;
  /** 测试结果说明 */
  message: string;
  /** 响应耗时（ms） */
  latencyMs: number;
  /** 返回的模型名 */
  model: string;
}

export interface LlmTestErrorResponse {
  ok: false;
  message: string;
}

export type LlmTestResult = LlmTestResponse | LlmTestErrorResponse;

/** 对话消息 */
export interface LlmChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 通用对话请求 */
export interface LlmChatRequest {
  messages: LlmChatMessage[];
  /** 默认 deepseek-chat */
  model?: string;
  temperature?: number;
  /** 预留：流式输出（SSE）当前未实现，勿传 */
  stream?: boolean;
  /** 启用联网搜索（Responses API + web_search 工具，服务端执行） */
  search?: boolean;
}

export interface LlmChatResponse {
  ok: true;
  content: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** 联网搜索实际执行的查询词（search 模式） */
  searchQueries?: string[];
}

export interface LlmChatErrorResponse {
  ok: false;
  message: string;
}

export type LlmChatResult = LlmChatResponse | LlmChatErrorResponse;

// ============================================================
// DeepSeek 分享链接对话提取（deepseek-share）
// ============================================================

/** 提取出的单条对话消息 */
export interface ShareMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** 思考链（DeepSeek 推理模式时存在） */
  thinking?: string;
  /** ISO 时间 */
  time?: string;
  /** token 用量 */
  tokenUsage?: number;
}

/** 分享对话提取请求 */
export interface ShareExtractRequest {
  /** DeepSeek 分享链接或 share id，如 https://chat.deepseek.com/share/u5myqtvktzo5gal4qi */
  url: string;
}

/** 分享对话提取成功响应 */
export interface ShareExtractResponse {
  ok: true;
  /** 分享标题 */
  title: string;
  shareId: string;
  /** 规范化后的原始链接 */
  url: string;
  messages: ShareMessage[];
  /** 对话总 token 用量 */
  totalTokens: number;
  /** 消息总数 */
  count: number;
}

export interface ShareExtractErrorResponse {
  ok: false;
  message: string;
}

export type ShareExtractResult = ShareExtractResponse | ShareExtractErrorResponse;

// ============================================================
// 提示词（统一存储于「本地设置数据」settings:prompt.*）
// ============================================================

/** 提示词元信息（列表项） */
export interface PromptMeta {
  /** 稳定 id，如 cb-rate.system */
  id: string;
  /** settingsStore 存储键（不含 settings: 前缀） */
  key: string;
  description: string;
  /** 当前模板文本 */
  template: string;
}

/** 提示词列表响应 */
export interface PromptsListResponse {
  ok: true;
  prompts: PromptMeta[];
}

/** 提示词详情（模板 + 默认参数渲染预览，页面展示用） */
export interface PromptDetailResponse {
  ok: true;
  id: string;
  template: string;
  /** 默认参数渲染后的完整可读文本（无占位符的提示词与 template 相同） */
  rendered: string;
}

export type PromptsListResult = PromptsListResponse | { ok: false; message: string };
export type PromptDetailResult = PromptDetailResponse | { ok: false; message: string };

// ============================================================
// 央行利率分析（cb-rate，LLM 驱动）
// ============================================================

/** 分析时间范围 */
export type CbRatePeriod = "month" | "year";

/** 央行动作类型 */
export type CbAction = "hike" | "cut" | "hold" | "mixed";

/** 单家央行分析结果 */
export interface CbRateBank {
  /** 稳定 id：fed/ecb/boj/boe/boc/rba/rbnz/snb/norges */
  id: string;
  name: string;
  /** 最新利率描述，如 3.50%–3.75% */
  latestRate: string;
  action: CbAction;
  /** 决策描述，如 7月8日加息25个基点 */
  actionDesc: string;
  /** 决议详情（投票/内部分歧/行长表态等） */
  details?: string;
  /** 下次会议 */
  nextMeeting?: string;
  /** 前瞻指引 / 市场预期 */
  outlook?: string;
  /** 最新一次利率变动日期（YYYY-MM-DD） */
  updatedAt?: string;
  /** 数据可信度提示（如 action 无法识别被降级展示、数据存疑） */
  flags?: string[];
}

/** 央行利率分析请求 */
export interface CbRateRequest {
  /** month=本月以来 year=今年以来 */
  period: CbRatePeriod;
  /**
   * 具体查询月份（YYYY-MM，过去 24 个月内）。
   * 传此字段时分析该自然月的利率政策时间线（period 仍为 month）。
   */
  month?: string;
  /** 央行 id 白名单；空数组/省略 = 全部九大 */
  banks?: string[];
  /** 是否生成会议日历 */
  withCalendar?: boolean;
  /**
   * 启用 LLM 联网搜索获取实时数据（默认 true；传 false 关闭，回退模型知识，
   * 响应 dataMode 相应为 knowledge 并标注 knowledgeCutoff）。
   */
  search?: boolean;
  /**
   * 启用缓存（默认 true）：命中缓存直接返回（fromCache:true），
   * 未命中则查询后写入缓存（Key-结构化 Value 持久化），TTL 24h 过期自动重查。
   */
  useCache?: boolean;
}

/** 央行利率分析成功响应 */
export interface CbRateResponse {
  ok: true;
  /** 数据截至日期（LLM 标注） */
  asOf: string;
  period: CbRatePeriod;
  /** 政策取向小结 */
  summary: string;
  banks: CbRateBank[];
  /** 近期会议日历 */
  calendar?: { date: string; bank: string; desc: string }[];
  /** 联网搜索实际执行的查询词（search 模式） */
  searchQueries?: string[];
  /** 结果是否来自缓存（未调 LLM） */
  fromCache?: boolean;
  /** 缓存写入时间（ISO） */
  cachedAt?: string;
  /** 模型来源 */
  model: string;
  /**
   * 数据模式：search=联网搜索实时数据；knowledge=模型训练知识（可能过时，勿用于实盘决策）。
   * 与请求 search 对应，缓存/解析全程保留。
   */
  dataMode: "search" | "knowledge";
  /** 知识模式下的模型知识截止日期（YYYY-MM，如 2025-06）；search 模式无此字段 */
  knowledgeCutoff?: string;
  /** 请求了但 LLM 未返回的央行 id（完整性提示） */
  missingBanks?: string[];
  /** 原始 LLM 文本（无条件附带，供排障/核对） */
  raw?: string;
}

export interface CbRateErrorResponse {
  ok: false;
  message: string;
}

export type CbRateResult = CbRateResponse | CbRateErrorResponse;

// ============================================================
// 国债汇率分析（treasury-fx，LLM 驱动）
// 人民币短波段研判框架：汇率套利 + 债券信号
// ============================================================

/** 国债汇率分析请求 */
export interface TreasuryFxRequest {
  /** 分析最近 N 个交易日（1~10，默认 5） */
  days?: number;
  /** 启用联网搜索获取实时汇率/国债数据（默认 true；false 回退模型知识） */
  search?: boolean;
  /** 启用缓存（默认 true；命中直接返回，TTL 24h） */
  useCache?: boolean;
}

/** 单日数据行 */
export interface TreasuryFxRow {
  /** 交易日 YYYY-MM-DD */
  date: string;
  /** USDJPY 数值（含 ~ 估算或来源标注） */
  usdjpy?: string;
  /** USDCNY 数值（在岸/中间价注明口径） */
  usdcny?: string;
  /** UJ 日变动率 % */
  uj?: string;
  /** UC 日变动率 % */
  uc?: string;
  /** 排序判定，如 "UJ < UC < 0" */
  rank?: string;
  /** 日本 10 年期国债收益率 % */
  jp10y?: string;
  /** 中国 10 年期国债收益率 % */
  cn10y?: string;
  /** 利差 BP */
  spreadBp?: string;
}

/** 国债汇率分析成功响应 */
export interface TreasuryFxResponse {
  ok: true;
  /** 数据截至日期 YYYY-MM-DD */
  asOf: string;
  /** 分析窗口（交易日数） */
  days: number;
  /** 框架判定小结（宏观阶段/资金流向/债券确认/A股含义） */
  summary: string;
  /** 各交易日数据速览 */
  rows: TreasuryFxRow[];
  /** 操作结论（脉冲做波段/回调减仓/等待主升信号等） */
  conclusion: string;
  /** 数据模式（与请求 search 对应） */
  dataMode: "search" | "knowledge";
  /** 知识模式下模型知识截止（YYYY-MM） */
  knowledgeCutoff?: string;
  /** 结果是否来自缓存 */
  fromCache?: boolean;
  /** 缓存写入时间（ISO） */
  cachedAt?: string;
  model: string;
  /** 联网搜索实际执行的查询词 */
  searchQueries?: string[];
  /** 原始 LLM 文本 */
  raw?: string;
}

export interface TreasuryFxErrorResponse {
  ok: false;
  message: string;
}

export type TreasuryFxResult = TreasuryFxResponse | TreasuryFxErrorResponse;

// ============================================================
// 逆回购余额跟踪（reverse-repo）
// 存量：买断式逆回购（2024.10 启用）月度操作/余额表（权威数据种子）
// 增量：每日变动探查（LLM）+ 当月变动量说明
// ============================================================

/** 单笔买断式逆回购操作（精确到年月日；日期未知标注"月内择机操作"） */
export interface ReverseRepoOperation {
  /** 操作日期：YYYY-MM-DD 或 "YYYY-MM-（月内）" */
  date: string;
  /** 期限：3M（91天左右）/ 6M（182天左右） */
  term: string;
  /** 金额（亿元） */
  amount: number;
  /** 公告/来源 */
  source?: string;
}

/** 单月买断式逆回购汇总（金额单位：亿元；每日经济新闻口径，推算补充） */
export interface ReverseRepoMonthlyRow {
  /** 月份 YYYY-MM */
  month: string;
  /** 操作日期（如 "10-28" / "月内" / "6-06 / 6-16"） */
  opDate: string;
  /** 当月操作总量 */
  operationTotal: number;
  /** 其中 3 个月期 */
  m3: number;
  /** 其中 6 个月期 */
  m6: number;
  /** 当月净投放（未披露为 null） */
  netChange: number | null;
  /** 累计净投放 = 存量余额（未披露为 null；以此绘制余额曲线） */
  cumulativeNet: number | null;
  /** 备注/数据依据 */
  note?: string;
}

/** 月度存量响应（逐笔流水 + 月度汇总 + 余额曲线） */
export interface ReverseRepoMonthlyResponse {
  ok: true;
  /** 数据来源说明 */
  source: string;
  /** 逐笔操作流水（精确到年月日） */
  operations: ReverseRepoOperation[];
  /** 月度汇总表（投放/净投放/累计净投放） */
  rows: ReverseRepoMonthlyRow[];
  /** 余额序列（累计净投放，非空月份；= 存量余额） */
  series: { month: string; balance: number }[];
  /** 数据截至月份 */
  asOf: string;
  /** 是否存在未更新的月份（最新数据月份 < 上个月） */
  stale?: boolean;
  /** 缺失月份列表（YYYY-MM，从最新数据月+1 到上个月） */
  staleMonths?: string[];
}

/** 月度数据触发式更新状态 */
export interface ReverseRepoMonthlyUpdateStatus {
  ok: true;
  state: "idle" | "running" | "done" | "failed";
  /** 本次尝试更新的缺失月份 */
  months?: string[];
  startedAt?: string;
  finishedAt?: string;
  /** done/failed 时的说明 */
  message?: string;
  /** 更新成功写入的月份汇总 */
  updated?: { month: string; operationTotal: number; netChange?: number | null; cumulativeNet?: number | null }[];
}

/** 每日变动探查请求 */
export interface ReverseRepoDailyRequest {
  /** 是否强制重新探查（忽略缓存；默认 false） */
  force?: boolean;
}

/** 单日变动记录 */
export interface ReverseRepoDailyChange {
  date: string;
  /** 买断式逆回购 / 7天期逆回购 */
  type: string;
  kind: string;
  /** 3M / 6M / 7D */
  term?: string;
  /** 金额（亿元） */
  amount: number;
  desc: string;
}

/** 每日变动探查响应 */
export interface ReverseRepoDailyResponse {
  ok: true;
  asOf: string;
  dailyChanges: ReverseRepoDailyChange[];
  /** 当月买断式逆回购变动量说明 */
  monthSummary: string;
  /** 买断式逆回购当前存量余额（亿元；无则省略） */
  currentBalance?: number;
  /** 结果是否来自缓存 */
  fromCache?: boolean;
  model: string;
  raw?: string;
}

export interface ReverseRepoErrorResponse {
  ok: false;
  message: string;
}

export type ReverseRepoMonthlyResult = ReverseRepoMonthlyResponse | ReverseRepoErrorResponse;
export type ReverseRepoDailyResult = ReverseRepoDailyResponse | ReverseRepoErrorResponse;

// ============================================================
// 通用异步任务（服务端后台执行 + SSE 推送 / 轮询）
// ============================================================

/** 异步任务状态 */
export type AsyncTaskStatus = "pending" | "running" | "done" | "error" | "cancelled";

/** 异步任务响应（result 类型由业务方指定） */
export interface AsyncTaskResponse<T = unknown> {
  ok: true;
  taskId: string;
  status: AsyncTaskStatus;
  /** done 时的任务结果 */
  result?: T;
  /** error 时的错误信息 */
  message?: string;
  /** 任务创建时间（ISO） */
  createdAt: string;
}

export interface AsyncTaskErrorResponse {
  ok: false;
  message: string;
}

export type AsyncTaskResult<T = unknown> = AsyncTaskResponse<T> | AsyncTaskErrorResponse;

// ============================================================
// 本地数据管理（local-data）：查询/删改本地表与 KV 数据
// ============================================================

/** 数据源（KV 前缀或表）的注册元信息 + 实时条目数 */
export interface LocalDataSource {
  kind: "kv" | "table";
  /** kv: key 前缀；table: 表名 */
  name: string;
  /** 来源页面（如 央行利率分析） */
  page: string;
  /** 使用场景标签（如 分析缓存） */
  tag: string;
  /** 场景说明 */
  description: string;
  /** 当前条目数 */
  count: number;
}

export interface LocalDataSourcesResponse {
  ok: true;
  sources: LocalDataSource[];
}

/** 数据条目（列表用，含值预览） */
export interface LocalDataEntry {
  key: string;
  updatedAt?: string;
  /** value 的 JSON 预览（截断） */
  preview: string;
  /** 表数据行：行字段（table 类型时存在） */
  row?: Record<string, unknown>;
}

export interface LocalDataListResponse {
  ok: true;
  source: { kind: "kv" | "table"; name: string };
  entries: LocalDataEntry[];
  total: number;
}

/** 详情（KV：完整 value；表：整行） */
export interface LocalDataDetailResponse {
  ok: true;
  source: { kind: "kv" | "table"; name: string };
  key: string;
  value: unknown;
  updatedAt?: string;
}

/** 编辑 KV 值请求 */
export interface LocalDataUpdateRequest {
  source: string;
  key: string;
  /** 新的任意 JSON 值 */
  value: unknown;
}

export interface LocalDataErrorResponse {
  ok: false;
  message: string;
}

export type LocalDataResult =
  | LocalDataSourcesResponse
  | LocalDataListResponse
  | LocalDataDetailResponse
  | LocalDataErrorResponse;

/** API 统一前缀（前端 dev server 会代理到后端） */
export const API_PREFIX = "/api";
