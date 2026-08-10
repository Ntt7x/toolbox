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
// 康复（个人经验笔记：rehab）
// ============================================================

/** 康复笔记条目（证型/要点 → 方剂链/说明） */
export interface RehabNoteItem {
  name?: string;
  detail: string;
}

/** 康复笔记分区 */
export interface RehabNoteSection {
  title: string;
  items: RehabNoteItem[];
}

/** 康复笔记（KV 持久化：rehab:<id>） */
export interface RehabNote {
  id: string;
  title: string;
  /** 末次更新时间 */
  updatedAt: string;
  sections: RehabNoteSection[];
}

/** 康复笔记读写结果 */
export interface RehabNoteResult {
  ok: boolean;
  note?: RehabNote;
  message?: string;
}

/** 康复笔记保存请求 */
export interface RehabNoteUpdateRequest {
  title?: string;
  sections?: RehabNoteSection[];
}

// ============================================================
// 凯利仓位助手（kelly）
// ============================================================

/** 凯利仓位计算请求 */
export interface KellyRequest {
  /** 当前价格 */
  price: number;
  /** 上止盈价格 */
  takeProfit: number;
  /** 下止损价格 */
  stopLoss: number;
  /** 主观胜率 0~1 */
  winRate: number;
  /** 仓位可用最大金额 */
  maxAmount: number;
  /** 可选：股票代码（历史记录关联） */
  code?: string;
  /** 可选：股票名称（历史记录展示） */
  name?: string;
}

/** 凯利方案（分数凯利） */
export interface KellyScheme {
  key: "quarter" | "third" | "half" | "kelly";
  label: string;
  /** 占配额比例（%） */
  pct: number;
  /** 实际开仓资金 */
  cash: number;
  /** 实际份额（100 的整数倍） */
  shares: number;
  note: string;
}

/** 凯利计算响应 */
export interface KellyResult {
  ok: boolean;
  price: number;
  takeProfit: number;
  stopLoss: number;
  /** 胜率 0~1 */
  winRate: number;
  /** 盈亏比 */
  b: number;
  /** 期望优势 */
  edge: number;
  /** 凯利原始比例（未截断） */
  fRaw: number;
  /** 无正期望（分支一） */
  noPositiveEdge?: boolean;
  /** 所有方案份额为零（分支二） */
  allZero?: boolean;
  /** 截断提示（f_raw > 1 时） */
  cutMessage?: string;
  schemes?: KellyScheme[];
  message?: string;
}

/** 凯利历史条目 */
export interface KellyHistoryEntry {
  id: string;
  createdAt: string;
  request: {
    price: number;
    takeProfit: number;
    stopLoss: number;
    winRate: number;
    maxAmount: number;
    code?: string;
    name?: string;
  };
  summary: {
    price: number;
    takeProfit: number;
    stopLoss: number;
    winRate: number;
    maxAmount: number;
    b: number;
    fRaw: number;
    /** 凯利方案开仓资金/占配额比例 */
    kellyCash: number;
    kellyPct: number;
    code?: string;
    name?: string;
  };
  result: KellyResult;
}

export type KellyHistoryListResult = { ok: true; entries: KellyHistoryEntry[] };
export type KellyHistoryDetailResult = { ok: true; entry: KellyHistoryEntry };
export type KellyHistoryDeleteResult = { ok: true; deleted: number };

// ============================================================
// 书籍下载工具（books · zlib）
// ============================================================

/** zlib 搜索命中条目（归一化） */
export interface BookItem {
  /** zlib 书籍 id */
  id: number;
  title: string;
  author?: string;
  year?: number;
  publisher?: string;
  language?: string;
  pages?: number;
  /** 格式（pdf/epub/mobi…） */
  extension?: string;
  /** 文件大小字节 */
  filesize?: number;
  /** 文件大小人类可读（43.29 MB） */
  filesizeString?: string;
  md5?: string;
  /** 短哈希 */
  hash?: string;
  /** 封面图 URL */
  cover?: string;
  /** 详情页 URL（绝对） */
  detailUrl?: string;
  /** 相对下载路径（如 /dl/xxx） */
  downloadPath?: string;
  /** 在线读 URL */
  readOnlineUrl?: string;
}

/** zlib 搜索响应 */
export interface BookSearchResult {
  ok: boolean;
  items?: BookItem[];
  /** 命中总数 */
  total?: number;
  /** 当前页 */
  page?: number;
  /** zlib 站点 base（前端拼下载链接用） */
  base?: string;
  /** 提示（如匿名限流/需要登录） */
  message?: string;
  /** 限流码（rate_limited 等） */
  code?: string;
}

/** 书籍下载工具配置（存本地设置数据） */
export interface BookConfig {
  ok: boolean;
  /** zlib 站点 base */
  zlibBase: string;
  /** 本机 HTTP 代理地址（空 = 直连） */
  proxy: string;
  message?: string;
}

/** 书籍下载历史搜索记录 */
export interface BookHistoryResult {
  ok: boolean;
  items?: { q: string; ts: string; hits?: number }[];
  removed?: boolean;
  cleared?: boolean;
}

/** 书籍下载收藏结果 */
export interface BookFavoritesResult {
  ok: boolean;
  items?: (BookItem & { ts: string })[];
  added?: boolean;
  removed?: boolean;
  cleared?: boolean;
  count?: number;
  message?: string;
}

/** DeepSeek Share 提取历史 */
export interface ShareHistoryResult {
  ok: boolean;
  items?: { url: string; shareId: string; ts: string; messageCount: number }[];
  cleared?: boolean;
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
  /** 可选：股票代码（历史记录关联，如 sh600519 / 600519） */
  code?: string;
  /** 可选：股票名称（历史记录展示用） */
  name?: string;
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

/** 历史网格计划：保存的生成记录（含时间戳与完整结果） */
export interface GridPlanHistoryEntry {
  id: string;
  /** 生成时间（ISO 时间戳） */
  createdAt: string;
  /** 输入参数 */
  request: { type: number; boll: [number, number, number]; maxAmount?: number; code?: string; name?: string };
  /** 摘要（列表展示用） */
  summary: {
    typeName: string;
    U: number;
    M: number;
    L: number;
    /** 网格档数（styles 行数） */
    rows: number;
    maxAmount?: number;
    /** 均衡档单档买入金额（styles[first].amount.buyAmount） */
    perBuy?: number;
    code?: string;
    name?: string;
  };
  /** 完整结果（查看详情用） */
  result: GridPlanResult;
}

export interface GridPlanHistoryListResult {
  ok: true;
  entries: {
    id: string;
    createdAt: string;
    summary: GridPlanHistoryEntry["summary"];
  }[];
}

export interface GridPlanHistoryDetailResult {
  ok: true;
  entry: GridPlanHistoryEntry;
}

export interface GridPlanHistoryDeleteResult {
  ok: true;
  deleted: number;
}

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

/** 场外基金（开放式基金）净值快照：天天基金 */
export interface FundSnapshot {
  ok: boolean;
  /** 基金代码（6 位） */
  code: string;
  /** 基金名称 */
  name?: string;
  /** 单位净值 */
  nav?: number;
  /** 净值日期 YYYY-MM-DD */
  navDate?: string;
  /** 日涨跌幅（%） */
  pct?: number;
  /** 累计净值 */
  totalNav?: number;
  /** 近 1 月 / 近 1 年收益率（%） */
  m1?: number;
  y1?: number;
  /** 风险等级（1-5） */
  riskLevel?: string;
  /** 基金经理 / 基金公司 */
  manager?: string;
  company?: string;
  /** 申购/赎回状态 */
  buyStatus?: string;
  redeemStatus?: string;
  /** 数据源 */
  source?: string;
  /** 快照时间（ISO） */
  ts?: string;
  message?: string;
}

/** 行情快照（实时报价）：腾讯为主源，东财/新浪自动降级 */
export interface QuoteSnapshot {
  ok: boolean;
  /** 标准代码（sh600519 / hk00700） */
  code: string;
  /** 股票名称 */
  name?: string;
  /** 最新价 */
  price?: number;
  /** 昨收 */
  prevClose?: number;
  /** 今开 */
  open?: number;
  /** 涨跌额 */
  change?: number;
  /** 涨跌幅（%） */
  pct?: number;
  /** 最高/最低 */
  high?: number;
  low?: number;
  /** 成交量（手） */
  volume?: number;
  /** 成交额（亿元） */
  amount?: number;
  /** 换手率（%） */
  turnover?: number;
  /** 市盈率 TTM */
  pe?: number;
  /** 市净率 */
  pb?: number;
  /** 总市值（亿元） */
  marketCap?: number;
  /** 52 周最高/最低 */
  high52?: number;
  low52?: number;
  /** 币种（CNY / HKD） */
  currency?: string;
  /** 数据源（tencent / eastmoney / sina） */
  source?: string;
  /** 快照时间（ISO） */
  ts?: string;
  message?: string;
}

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
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** 命中 DeepSeek 前缀缓存的输入 token 数 */
    cacheHitTokens?: number;
    /** 未命中缓存的输入 token 数 */
    cacheMissTokens?: number;
  };
  /** 联网搜索实际执行的查询词（search 模式） */
  searchQueries?: string[];
}

export interface LlmChatErrorResponse {
  ok: false;
  message: string;
}

export type LlmChatResult = LlmChatResponse | LlmChatErrorResponse;

/** LLM 调用模式（用量按模式统计） */
export type LlmCallMode = "direct" | "chat-session" | "reasonix";

/** LLM 用量场景（按业务场景区分，测试/系统用量不混入业务统计） */
export type LlmUsageScene = "business" | "system" | "test";

/** LLM 用量汇总（服务端切面记录，按模块/按天/按模式/按场景聚合） */
export interface LlmUsageSummary {
  ok: true;
  total: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** 命中缓存输入 token / 未命中输入 token */
    cacheHitTokens: number;
    cacheMissTokens: number;
    /** 缓存命中率（0~1；无输入时 0） */
    cacheRate: number;
    /** 估算费用（DeepSeek 公开价近似；USD 与 CNY） */
    costUsd: number;
    costCny: number;
    /** 按调用模式聚合（direct 直调 / chat-session 自研会话 / reasonix ACP 会话） */
    byMode: { mode: LlmCallMode; label: string; calls: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number; cacheRate: number }[];
    /** 按场景聚合（business 业务 / system 系统 / test 测试）；旧数据按 module 推断 */
    byScene: { scene: LlmUsageScene; label: string; calls: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number; cacheRate: number }[];
  };
  byModule: { module: string; label: string; scene: LlmUsageScene; calls: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number; cacheRate: number }[];
  /** 逐日（倒序）；byModule 为该日各模块明细（单日扇形图用） */
  byDay: { day: string; calls: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number; cacheRate: number; costCny: number; byModule: { module: string; label: string; scene: LlmUsageScene; calls: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number; cacheRate: number }[] }[];
}

/** DeepSeek 平台余额查询结果 */
export interface LlmBalanceResult {
  ok: boolean;
  balance?: { currency: string; totalBalance: string; grantedBalance: string; toppedUpBalance: string }[];
  isAvailable?: boolean;
  message?: string;
}

// ============================================================
// Agent 会话管理（chatSession 模式 2 / reasonix 模式 3）
// ============================================================

/** 会话列表项（两类统一形态） */
export interface AgentSessionListItem {
  id: string;
  module: string;
  status: "active" | "archived";
  createdAt: number;
  lastAt: number;
  /** 已交换轮数（chatSession）；reasonix 无历史轮数，恒 0 */
  turns: number;
  /** system 提示词预览（≤60 字，reasonix 无） */
  systemPreview?: string;
  /** 会话工作目录（reasonix） */
  cwd?: string;
}

export interface AgentSessionsResult {
  ok: boolean;
  chat: AgentSessionListItem[];
  reasonix: AgentSessionListItem[];
}

export interface AgentSessionCreateRequest {
  /** 归属模块（用量统计） */
  module: string;
  /** system 提示词（chatSession 必填） */
  system?: string;
  search?: boolean;
  json?: boolean;
  temperature?: number;
  /** reasonix 工作目录 */
  cwd?: string;
}

export interface AgentSessionCreateResult {
  ok: boolean;
  id?: string;
  message?: string;
}

/** chatSession 详情（含完整 history） */
export interface ChatSessionDetail {
  ok: boolean;
  id?: string;
  module?: string;
  system?: string;
  history?: LlmChatMessage[];
  turns?: number;
  droppedTurns?: number;
  archived?: boolean;
  summary?: string;
  createdAt?: number;
  lastAt?: number;
  message?: string;
}

export interface AgentSessionAskResult {
  ok: boolean;
  /** 回答内容 */
  content?: string;
  /** 用量（含缓存命中） */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
    estimatedCost?: number;
  };
  message?: string;
}

/** Reasonix 会话详情（含服务端托管对话数据） */
export interface ReasonixSessionDetail {
  ok: boolean;
  id?: string;
  module?: string;
  status?: "active" | "archived";
  createdAt?: number;
  lastAt?: number;
  cwd?: string;
  /** 对话数据（user/assistant 成对，服务端托管） */
  history?: { role: "user" | "assistant"; content: string; time: number; usage?: AgentSessionAskResult["usage"] }[];
  message?: string;
}

/** Reasonix ACP 进程状态（显式进程管理） */
export interface ReasonixProcessStatus {
  ok: boolean;
  running: boolean;
  pid?: number;
  startedAt?: number;
  binary?: string;
  pendingRequests: number;
  /** 会话数（注册表活跃会话） */
  sessionCount: number;
  message?: string;
}

/** MCP Server 配置项（存储于本地设置数据） */
export interface McpServerConfigItem {
  name: string;
  url?: string;
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface McpServersResult {
  ok: boolean;
  servers: McpServerConfigItem[];
}

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
  /** 场景分组（交易 / 知识库 / 系统…） */
  group: string;
  /** 归属页面 */
  page: string;
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
  /** 余额序列（累计净投放 = 存量余额；缺失月份为模型推算，estimated=true） */
  series: { month: string; balance: number; estimated?: boolean }[];
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
  /** 任务结束时间（ISO；终态时存在） */
  finishedAt?: string;
  /** 任务耗时（ms；终态时存在） */
  durationMs?: number;
  /** 任务归属模块（如 cb-rate），用于历史归档 */
  module?: string;
}

export interface AsyncTaskErrorResponse {
  ok: false;
  message: string;
}

export type AsyncTaskResult<T = unknown> = AsyncTaskResponse<T> | AsyncTaskErrorResponse;

/** 任务历史条目（持久化于 KV taskHistory:<module>，供页面回看） */
export interface TaskHistoryEntry {
  taskId: string;
  module: string;
  /** 用户可读任务名称（如「2026-08 · 央行利率分析（九大央行）」）；旧数据缺省 */
  name?: string;
  status: AsyncTaskStatus;
  createdAt: string;
  finishedAt?: string;
  durationMs?: number;
  /** done 时的结果（全量快照） */
  result?: unknown;
  /** error/cancelled 信息 */
  message?: string;
}

export interface TaskHistoryListResponse {
  ok: true;
  module: string;
  entries: TaskHistoryEntry[];
  total: number;
}

// ============================================================
// 本地数据管理（local-data）：查询/删改本地表与 KV 数据
// ============================================================

/** 数据源（KV 前缀或表）的注册元信息 + 实时条目数 + 存储大小 */
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
  /** KV 源：全部条目 value 的 UTF-8 字节总数（table 源为 0） */
  sizeBytes?: number;
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
  /** value 的 UTF-8 字节数（存储大小） */
  size?: number;
  /** 表数据行：行字段（table 类型时存在） */
  row?: Record<string, unknown>;
}

export interface LocalDataListResponse {
  ok: true;
  source: { kind: "kv" | "table"; name: string };
  entries: LocalDataEntry[];
  total: number;
  /** 分页：当前偏移/页大小 */
  offset?: number;
  limit?: number;
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

// ============================================================
// 专题自选股（watchlist）：专题 + 入选个股（含入选理由）
// ============================================================

/** 专题内的一只自选股（code 为标准 A/H 代码；name 为解析/用户填写的名称） */
export interface WatchlistStock {
  /** 标准代码：sh600519 / sz000001 / hk00700 / 600519 / 00700；场外基金为 6 位数字（如 161725） */
  code: string;
  /** 名称（行情接口解析，可空） */
  name?: string;
  /** 入选理由 */
  reason: string;
  /** 类型：stock=股票/场内ETF（默认），fund=场外基金（净值来自天天基金） */
  kind?: "stock" | "fund";
}

/** 一个专题（KV 持久化：watchlist:<id>） */
export interface WatchlistTopic {
  id: string;
  name: string;
  /** 专题介绍（主题逻辑/选股思路，可选） */
  description?: string;
  /** 分组名（缺省未分组；列表按此分组展示） */
  group?: string;
  createdAt: string;
  updatedAt: string;
  stocks: WatchlistStock[];
}

/** 专题列表项（轻量，不带全量个股） */
export interface WatchlistSummary {
  id: string;
  name: string;
  /** 专题介绍（列表悬浮展示用） */
  description?: string;
  /** 分组名（缺省未分组；列表按此分组展示） */
  group?: string;
  stockCount: number;
  /** 当前仓位占比 %（总市值/总仓位，未配置时缺省） */
  positionPct?: number;
  /** 当日平均涨幅 %（等权：专题内有行情的股票/基金涨跌幅算术平均；全部无行情时缺省） */
  avgPct?: number;
  /** 参与平均统计的数量（有行情且涨跌幅可用的股票/基金数） */
  avgCount?: number;
  updatedAt: string;
}

export interface WatchlistListResult {
  ok: true;
  topics: WatchlistSummary[];
}

export interface WatchlistCreateRequest {
  name: string;
  /** 专题介绍（可选） */
  description?: string;
  /** 分组名（可选） */
  group?: string;
}

export interface WatchlistCreateResult {
  ok: true;
  topic: WatchlistTopic;
}

/** 更新请求：改名 / 改介绍 / 增删个股 / 重排（原子提交） */
export interface WatchlistUpdateRequest {
  name?: string;
  /** 专题介绍（传空字符串可清空） */
  description?: string;
  /** 分组名（传空字符串可清空；缺省未分组） */
  group?: string;
  addStocks?: WatchlistStock[];
  removeCodes?: string[];
  /** 新顺序（code 数组，stocks 将按此重排；顺序 = 优先级） */
  reorderCodes?: string[];
}

export interface WatchlistDetailResult {
  ok: true;
  topic: WatchlistTopic;
}

export interface WatchlistDeleteResult {
  ok: true;
  deleted: number;
}

/** 个股财报分析（LLM 驱动）请求：POST /api/tools/watchlist/:id/fundamental?code=xxx&force=1 */
export interface WatchlistFundamentalRequest {
  /** 股票代码 */
  code: string;
  /** 是否强制重新分析（忽略缓存；默认 false） */
  force?: boolean;
}

/** 个股财报分析结果 */
export interface WatchlistFundamentalResult {
  ok: boolean;
  /** 股票代码/名称 */
  code: string;
  name?: string;
  /** 分析结论摘要（LLM） */
  summary: string;
  /** 关键财务数据（营收/净利/估值等） */
  financials?: string;
  /** 核心看点 */
  strengths?: string;
  /** 主要风险 */
  risks?: string;
  /** 一句话结论 */
  conclusion?: string;
  /** dataMode：search=联网实时 / knowledge=训练知识 */
  dataMode?: "search" | "knowledge";
  model?: string;
  /** 是否命中缓存 */
  fromCache?: boolean;
  /** LLM 原始输出（容错兜底展示） */
  raw?: string;
  message?: string;
}

export interface WatchlistErrorResult {
  ok: false;
  message: string;
}

export type WatchlistResult =
  | WatchlistListResult
  | WatchlistCreateResult
  | WatchlistDetailResult
  | WatchlistDeleteResult
  | WatchlistFundamentalResult
  | WatchlistErrorResult;

// ============================================================
// 改进备忘录（memo）：TODO list（用户记录问题 → Agent 驱动修复）
// ============================================================

/** 备忘录条目状态 */
export type MemoStatus = "open" | "doing" | "done";

/** 改进类型：fix 修复型（简短改进要求）/ feature 需求型（详细需求描述）/ agent Agent 型（开发者/Agent 驱动的自增记录） */
export type MemoKind = "fix" | "feature" | "agent";

export interface MemoItem {
  id: string;
  text: string;
  status: MemoStatus;
  /** 改进类型（缺省 fix；agent 型仅供 Agent 自增记录，与用户输入严格区分） */
  kind?: MemoKind;
  createdAt: string;
  updatedAt: string;
}

export interface MemoListResult {
  ok: true;
  items: MemoItem[];
}

export interface MemoCreateRequest {
  text: string;
  /** 创建类型：Agent 新增改进记录必须显式传 "agent"；用户输入缺省 fix/feature */
  kind?: MemoKind;
}

export interface MemoCreateResult {
  ok: true;
  item: MemoItem;
}

/** 更新：改文本 / 改状态 / 改类型 */
export interface MemoUpdateRequest {
  text?: string;
  status?: MemoStatus;
  kind?: MemoKind;
}

export interface MemoDetailResult {
  ok: true;
  item: MemoItem;
}

export interface MemoDeleteResult {
  ok: true;
  deleted: number;
}

export interface MemoErrorResult {
  ok: false;
  message: string;
}

export type MemoResult = MemoListResult | MemoCreateResult | MemoDetailResult | MemoDeleteResult | MemoErrorResult;

// ============================================================
// 知识库（knowledge）：服务端公共模块契约
// ============================================================

/** 知识条目 */
export interface KnowledgeEntry {
  /** 分层点分隔 key（如 project.module.attribute；首段为实例名） */
  key: string;
  /** 事实内容 */
  value: string;
  /** 来源（对话分享 id / 标题 / 用户标注 / agent-write） */
  source?: string;
  updatedAt: string;
}

/** Chat 分享导入结果（kbImportFromChat） */
export interface KnowledgeImportResult {
  ok: true;
  imported: number;
  facts: { key: string; value: string; source?: string }[];
  title: string;
  shareId: string;
  /** 因内容重复被跳过的条数（去重） */
  skipped?: number;
  /** 因 key 冲突被跳过（skip 策略）或解决的条数 */
  conflicts?: number;
  /** 冲突处理策略：skip / overwrite / merge */
  strategy?: string;
  /** 批量导入时：逐条结果与汇总 */
  items?: { url: string; ok: boolean; imported: number; title?: string; message?: string }[];
  summary?: string;
}

/** 知识问答结果（kbAsk；失败为 KnowledgeErrorResult） */
export interface KnowledgeAskResult {
  ok: true;
  answer: string;
  /** 命中的知识条目（供前端展示依据） */
  used?: KnowledgeEntry[];
}

export interface KnowledgeErrorResult {
  ok: false;
  message: string;
}

// ---------- 知识库中心（虚拟知识库） ----------
export interface KnowledgeInstanceInfo {
  instance: string;
  count: number;
  updatedAt?: string;
}

export interface KnowledgeDomainMeta {
  name: string;
  desc: string;
  keywords: string[];
  /** 领域特化问答模板（覆盖默认；空则用通用/医学默认） */
  askTemplate?: string;
  /** 领域特化导入提取模板 */
  extractTemplate?: string;
}

export interface VirtualKb {
  name: string;
  domains: string[];
  desc?: string;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeHubOverview {
  ok: true;
  instances: (KnowledgeInstanceInfo & { meta?: KnowledgeDomainMeta | null })[];
  domains: KnowledgeDomainMeta[];
  virst: VirtualKb[];
}

// ---------- 知识库导入历史 ----------
export interface KnowledgeImportRecordItem {
  url: string;
  ok: boolean;
  imported: number;
  skipped?: number;
  conflicts?: number;
  title?: string;
  message?: string;
}

export interface KnowledgeImportRecord {
  time: number;
  target: string;
  targetType: "domain" | "virt";
  items: KnowledgeImportRecordItem[];
  totalImported: number;
  distribution?: Record<string, number>;
}

/** API 统一前缀（前端 dev server 会代理到后端） */
export const API_PREFIX = "/api";

// ============================================================
// 知乎爬虫（小工具）
// ============================================================
export interface ZhihuCrawlRequest {
  /** 用户主页 URL 或 urlToken */
  target: string;
  /** 抓取类型：all / answers / articles / pins（默认 all） */
  types?: ZhihuCrawlKind[];
  /** 每类最大条数（0=不限制，默认 0） */
  limit?: number;
  /** 起始日期 YYYY-MM-DD（含）；仅抓取此日期之后的创作 */
  dateFrom?: string;
  /** 截止日期 YYYY-MM-DD（含）；仅抓取此日期之前的创作 */
  dateTo?: string;
}

/** 收藏的爬取目标 */
export interface ZhihuFavoriteEntry {
  token: string;
  name: string;
  ts: string;
}

export type ZhihuCrawlKind = "answer" | "article" | "pin";

export interface ZhihuCrawlItem {
  kind: ZhihuCrawlKind;
  /** 问题标题 / 文章标题 / 想法首句 */
  title: string;
  /** 内容（markdown） */
  content: string;
  /** 发布时间（ISO） */
  createdAt: string;
  url: string;
  voteupCount?: number;
  /** 作者参与讨论的评论（含上下文），抓取评论时填充 */
  comments?: ZhihuComment[];
}

/** 作者参与的评论（含回复上下文） */
export interface ZhihuComment {
  id: string;
  author: string;
  content: string;
  createdAt: string;
  /** 被回复的评论作者（上下文链） */
  replyTo?: string;
  /** 子评论（作者参与的回复讨论） */
  children?: ZhihuComment[];
}

export interface ZhihuUserInfo {
  ok: boolean;
  name?: string;
  urlToken?: string;
  headline?: string;
  answerCount?: number;
  articleCount?: number;
  pinCount?: number;
  message?: string;
}

export interface ZhihuCrawlResult {
  ok: boolean;
  user?: { name: string; urlToken: string; headline?: string };
  items?: ZhihuCrawlItem[];
  total?: number;
  /** 结果持久化 id（历史查看/导入知识库用） */
  resultId?: string;
  /** 是否部分结果（数量上限/超时自动暂停，或用户取消） */
  partial?: boolean;
  /** 自动暂停（达到数量上限或超时） */
  paused?: boolean;
  /** 用户取消（已返回已抓取的部分结果） */
  cancelled?: boolean;
  /** 断点续爬 id（暂停/取消后可从此继续） */
  progressId?: string;
  /** 抓取过程中的诊断信息（各类型失败/0 结果/风控原因，供前端告知用户） */
  warnings?: string[];
  message?: string;
}

/** 断点续爬请求 */
export interface ZhihuResumeRequest {
  progressId: string;
}

/** 爬取进度快照（暂停/取消后保存，供续爬） */
export interface ZhihuCrawlProgress {
  progressId: string;
  token: string;
  types: ZhihuCrawlKind[];
  /** 每类目标条数 */
  limit: number;
  dateFrom?: string;
  dateTo?: string;
  items: ZhihuCrawlItem[];
  commentsDone: boolean;
  /** 续爬起点：当前处理到的类型下标（之前的类型已抓满/完成） */
  phaseIndex: number;
  startedAt: number;
  updatedAt: number;
}

export interface ZhihuCrawlHistoryEntry {
  id: string;
  target: string;
  name: string;
  ts: string;
  total: number;
  /** 关联的持久化结果 id（可查看完整结果/导入知识库） */
  resultId?: string;
}

/** 导入知识库请求：从已保存结果中选条目写入指定知识库实例 */
export interface ZhihuImportRequest {
  resultId: string;
  /** 目标知识库实例（knowledge.<instance>，如 medical / trading / mine） */
  instance: string;
  /** 选中条目下标（缺省=全部） */
  indexes?: number[];
}

export interface ZhihuImportResult {
  ok: boolean;
  imported: number;
  instance?: string;
  message?: string;
}


// ============================================================
// 交易规划（trade-plan）
// ============================================================

/** 交易标的风险配置（保护单标的不过度集中） */
export interface TradePlanStockCfg {
  code: string;
  name?: string;
  /** 单标的上限：占总仓位百分比（0~100，可选；不配则不受单标的上限约束） */
  maxWeightPct?: number;
}

/** 当前仓位（拆分自配置：仓位现状独立管理，由日度计划应用后自动更新） */
export interface TradePlanPosition {
  code: string;
  name?: string;
  /** 当前持仓数量 */
  quantity: number;
  /** 成本价 → 持仓市值 = quantity × avgCost */
  avgCost: number;
}

export interface TradePlanConfig {
  /** 总仓位（元）——策略总资金规模，保护仓位不失控 */
  totalCapital: number;
  /** 单日加仓上限（元）——当日所有加仓合计不得超过 */
  dailyAddLimit: number;
  /** 交易标的列表（策略限定的可交易标的） */
  stocks: TradePlanStockCfg[];
  /** 当前仓位（拆分自配置） */
  positions: TradePlanPosition[];
  updatedAt: string;
}

export interface TradePlanStrategy {
  id: string;
  /** 策略名称（如「稳健成长」） */
  name: string;
  /** 总仓位（元） */
  totalCapital: number;
  /** 单日加仓上限（元） */
  dailyAddLimit: number;
  /** 交易标的列表 */
  stocks: TradePlanStockCfg[];
  /** 当前仓位（与配置拆分：独立管理，由日度计划应用后自动更新） */
  positions: TradePlanPosition[];
  /** 仓位基线（手动编辑固化；日度计划应用/删除时从此基线重放，保证多日链一致） */
  basePositions?: TradePlanPosition[];
  updatedAt: string;
  createdAt: string;
}

export interface TradePlanStrategySummary {
  id: string;
  name: string;
  totalCapital: number;
  dailyAddLimit: number;
  stockCount: number;
  dayCount: number;
  /** 当前仓位占比 %（总市值/总仓位） */
  positionPct?: number;
  /** 盈亏汇总（列表接口附：最新价市值/浮动盈亏；负成本标的不参与盈亏统计） */
  pnl?: TradePlanPnl;
  updatedAt: string;
}

/** 策略列表响应 */
export interface TradePlanStrategyListResult {
  ok: boolean;
  strategies: TradePlanStrategySummary[];
}

/** 策略读写响应 */
export interface TradePlanStrategyResult {
  ok: boolean;
  strategy?: TradePlanStrategy;
  message?: string;
  /** 盈亏汇总（仅详情接口 GET /strategies/:id 附行情计算） */
  pnl?: TradePlanPnl;
  /** 交易复盘（Deal：加仓→清仓按笔配对；仅详情接口附） */
  deals?: TradePlanDealSummary;
}

/**
 * 一笔完整交易（Deal）：从零仓位建仓（entry）到清仓（exit）的入→出周期；
 * 在途（open）= 当前仍持有。盈亏按平均成本法归因到段内（buyAmount vs sellAmount）。
 */
export interface TradePlanDeal {
  code: string;
  /** 标的名称（详情接口从策略 stocks 补全） */
  name?: string;
  /** open=在途（尚未清仓）；closed=已完结（数量归零） */
  status: "open" | "closed";
  /** 建仓日期（本段第一笔加仓） */
  entryDate: string;
  /** 清仓日期（数量归零的减仓日；在途缺省） */
  exitDate?: string;
  /** 持仓天数（closed 为 entry→exit 自然日差；在途为 entry→今天） */
  days?: number;
  /** 本段累计买入数量（股） */
  buyQty: number;
  /** 本段累计买入金额（元） */
  buyAmount: number;
  /** 本段卖出回款（元）= 卖出数量 × 卖出价 */
  sellAmount: number;
  /** 段内剩余数量（在途 > 0） */
  qty: number;
  /** 段内平均成本 = buyAmount / buyQty */
  avgCost: number;
  /** 已实现盈亏（closed）= sellAmount − buyAmount；在途缺省 */
  pnl?: number;
}

/** 交易复盘汇总（按标的×交易段） */
export interface TradePlanDealSummary {
  deals: TradePlanDeal[];
  /** 已完结笔数 */
  closedCount: number;
  /** 在途笔数 */
  openCount: number;
  /** 胜率 %（closed 中盈利笔数占比；无 closed 缺省） */
  winRate?: number;
  /** 已实现总盈亏（closed pnl 合计，元） */
  realizedPnl: number;
  /** 总盈利（closed pnl>0 合计，元） */
  totalProfit: number;
  /** 总亏损（closed pnl<0 绝对值合计，元） */
  totalLoss: number;
  /** 平均持仓天数（closed） */
  avgDays?: number;
}

/** 单标的盈亏（详情接口附行情计算；最新价 vs 成本价） */
export interface TradePlanPnlByCode {
  latestPrice?: number;
  pnl?: number;
  /** 盈亏率（%）；负成本时无意义为 undefined */
  pnlPct?: number;
  /** 成本为负（已回本）：盈亏无法计算 */
  costNegative?: boolean;
}

/** 策略详情盈亏汇总（新增字段，不污染持久化 strategy） */
export interface TradePlanPnl {
  byCode: Record<string, TradePlanPnlByCode>;
  totalPnl: number;
  totalCost: number;
  /** 最新价总市值（负成本标的一样计入） */
  totalMv: number;
  /** 负成本标的数量（盈亏不参与统计） */
  negCount: number;
  /** 总盈亏率（%）；无正成本持仓时为 undefined */
  totalPnlPct?: number;
}

/** 删除策略响应（含其日度计划） */
export interface TradePlanStrategyDeleteResult {
  ok: boolean;
  message?: string;
}


/** 日度计划条目（加/减仓以数量为单位；每次操作必须填写本次交易价格） */
export interface TradePlanItem {
  code: string;
  /** 标的名称（可选；日历总计划聚合时由服务端从策略 stocks 补全，供展示） */
  name?: string;
  /** 加仓 / 减仓 */
  action: "add" | "reduce";
  /** 数量（股）；金额 = 数量 × 本次交易价格 */
  amount: number;
  /** 本次交易价格（必填，>0）：加仓 = 买入价，减仓 = 卖出价。
   * 金额 = 数量 × 价格；加仓用买入价重算持仓均价，减仓用卖出价计算卖出回款（持仓均价不变）。 */
  cost?: number;
  note?: string;
}

/** 告警级别 */
export type TradePlanAlertLevel = "error" | "warn" | "info";

/** 单条校验结果 */
export interface TradePlanAlert {
  level: TradePlanAlertLevel;
  message: string;
  /** 关联标的代码（可选） */
  code?: string;
  /** 详细计算说明（可选） */
  detail?: string;
}

/** 执行后单标的状态 */
export interface TradePlanAfterPosition {
  code: string;
  name?: string;
  shares: number;
  avgCost: number;
  /** 执行后市值（元） */
  marketValue: number;
  /** 占总仓位百分比 */
  weightPct: number;
  /** 本次加仓金额 */
  addAmount: number;
  /** 本次操作价格（加仓=买入价 / 减仓=卖出价；三源解析，兼容缺省） */
  tradePrice?: number;
  /** 减仓已实现盈亏（元）= (卖出价 − 当前持仓均价) × 减仓数量；加仓/无减仓缺省 */
  realizedPnl?: number;
}

/** 校验汇总 */
export interface TradePlanCheckTotals {
  /** 当日加仓合计（元） */
  addTotal: number;
  /** 当日减仓回款（元）= 减仓股数 × 卖出价 */
  reduceTotal: number;
  /** 执行后总市值（元） */
  totalMarketValue: number;
  /** 执行后总仓位占比 % */
  positionPct: number;
  /** 剩余可用仓位（元，totalCapital - totalMarketValue） */
  remaining: number;
}

/** 日度计划校验结果 */
export interface TradePlanCheckResult {
  /** 是否全部通过（无 error 级告警） */
  ok: boolean;
  alerts: TradePlanAlert[];
  after: TradePlanAfterPosition[];
  totals: TradePlanCheckTotals;
}

/** 日度计划（含校验快照） */
export interface TradePlanDay {
  id: string;
  date: string;
  items: TradePlanItem[];
  result: TradePlanCheckResult;
  /** 是否已应用（应用 = 已按本计划自动更新当前仓位） */
  applied: boolean;
  /** 应用前的仓位快照（同日覆盖时用于回滚） */
  before?: TradePlanPosition[];
  /** 应用后的仓位 */
  after?: TradePlanPosition[];
  createdAt: string;
  appliedAt?: string;
}

/** 配置保存/读取响应 */
export interface TradePlanConfigResult {
  ok: boolean;
  config: TradePlanConfig;
  message?: string;
}

/** 日度计划校验/创建响应 */
export interface TradePlanCheckResponse {
  ok: boolean;
  result: TradePlanCheckResult;
  /** 校验但未保存（check 接口）时为 true */
  previewOnly?: boolean;
  /** 已保存的计划（创建接口返回） */
  day?: TradePlanDay;
  /** 应用后最新策略（含已更新的当前仓位） */
  strategy?: TradePlanStrategy;
  /** 覆盖保存后：后续已应用计划中无法完整执行的警告（如减仓超过当前持仓） */
  chainWarnings?: string[];
  message?: string;
}

/** 历史列表响应 */
export interface TradePlanDayListResult {
  ok: boolean;
  days: TradePlanDay[];
}

/** 删除响应 */
export interface TradePlanDeleteResult {
  ok: boolean;
  /** 删除后：其余已应用计划中无法完整执行的警告（如减仓超过当前持仓） */
  chainWarnings?: string[];
  message?: string;
}

/** 日历总计划：某天所有策略的操作汇总 */
export interface TradePlanCalendarDay {
  date: string;
  strategies: {
    id: string;
    name: string;
    items: TradePlanItem[];
    result: TradePlanCheckResult;
  }[];
}

/** 日历总计划响应 */
export interface TradePlanCalendarResult {
  ok: boolean;
  month: string;
  days: TradePlanCalendarDay[];
}
