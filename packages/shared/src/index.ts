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
// 央行利率分析（cb-rate，LLM 驱动）
// ============================================================

/** 分析时间范围 */
export type CbRatePeriod = "month" | "year";

/** 央行动作类型 */
export type CbAction = "hike" | "cut" | "hold" | "mixed";

// ---------- 程序性提示词（单一来源：server 拼接发送，web 页面展示同一常量） ----------

/** 九大央行固定清单文本（提示词与白名单共用） */
export const CB_RATE_BANKS_TEXT =
  "fed 美联储 | ecb 欧洲央行 | boj 日本央行 | boe 英国央行 | boc 加拿大央行 | " +
  "rba 澳大利亚央行 | rbnz 新西兰央行 | snb 瑞士央行 | norges 挪威央行";

/** 联网搜索模式注记（占位符 {searchNote}） */
export const CB_RATE_SEARCH_NOTE_DEFAULT =
  "**联网搜索说明**\n4. 本次调用已启用联网搜索：优先采用搜索结果中的最新信息；回答中若引用搜索来源，保留类似 [reference:N] 的引用标记。\n5. 必须明确标注数据截至日期 asOf（YYYY-MM-DD），即搜索结果中最新的信息日期。";

/** 知识模式注记（防幻觉；占位符 {searchNote}） */
export const CB_RATE_SEARCH_NOTE_KNOWLEDGE =
  "**知识模式说明（防幻觉）**\n4. 本次调用未启用联网搜索，只能基于你的训练知识作答。\n5. 你的训练知识截止于约 2025 年中，而今天已到 2026 年：**严禁编造今天之后或超出你知识范围的会议与决策**（尤其不得虚构某年某月某日的加息/降息）；拿不准的信息一律省略或用 \"不确定\" 标注。\n6. 必须明确标注 asOf 为你知识的最新日期（YYYY-MM-DD，通常接近 2025 年中），并在 summary 中注明\"数据基于训练知识、时效有限，建议开启联网搜索获取实时数据\"。\n7. 额外输出字段 knowledgeCutoff（YYYY-MM）表示你知识覆盖的最新月份。";

/** system prompt 模板（占位符：{banksText} {calendarJson} {searchNote} {calendarRule}） */
export const CB_RATE_SYSTEM_PROMPT_TEMPLATE = `你是一个央行利率政策分析助手，专精于全球主要央行的利率政策时间线。
九大央行固定清单（必须全部覆盖，除非用户指定部分）：{banksText}

要求：
1. 基于你的知识给出最准确、最新的信息；不确定的字段明确省略或标注"不确定"。
2. 必须明确标注数据截至日期 asOf（YYYY-MM-DD）。
3. 输出必须是合法 JSON 对象（不要输出任何其它文字），结构严格如下：
{
  "asOf": "YYYY-MM-DD",
  "summary": "政策取向小结：按【已加息 / 多次加息后暂停 / 按兵不动】分类，并提示近期会议观察窗口",
  "banks": [
    {
      "id": "fed",
      "name": "美联储",
      "latestRate": "3.50%–3.75%",
      "action": "hike|cut|hold|mixed",
      "actionDesc": "决策描述（含日期与基点数），如：7月30日维持利率不变（连续第五次按兵不动）",
      "details": "决议详情：投票结果、内部分歧、行长表态（有则填，无则省略）",
      "nextMeeting": "下次会议时间（有则填，无则省略）",
      "outlook": "前瞻指引 / 市场预期（有则填，无则省略）",
      "updatedAt": "YYYY-MM-DD 最新一次利率变动日期（本月/今年无变动可省略）"
    }
  ]{calendarJson}
}
{searchNote}
规则：
- action 取值：hike=加息，cut=降息，hold=按兵不动，mixed=方向混合（如既有加息又有降息）。
- {calendarRule}
- banks 至少覆盖用户要求的所有央行（默认全部九家）。`;

/** 默认完整版提示词（联网搜索 + 生成会议日历），供页面「程序性提示词」展示与复制 */
export const CB_RATE_SYSTEM_PROMPT: string = CB_RATE_SYSTEM_PROMPT_TEMPLATE
  .replace("{banksText}", CB_RATE_BANKS_TEXT)
  .replace("{calendarJson}", ',\n  "calendar": [{"date": "YYYY-MM-DD", "bank": "美联储", "desc": "议息会议"}]')
  .replace("{searchNote}", CB_RATE_SEARCH_NOTE_DEFAULT)
  .replace("{calendarRule}", "calendar 列出近期（未来 2 个月内）各央行议息会议日历。");

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
