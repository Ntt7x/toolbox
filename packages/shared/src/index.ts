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
    /** 均衡档（bal）单档买入金额（styles.bal.amount.buyAmount） */
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
  /** 启用缓存（默认 true；命中直接返回，TTL 2 年，见 cbRate 同款语义） */
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
/** 异步任务响应（result 类型由业务方指定） */
/** 任务历史条目（持久化于 KV taskHistory:<module>，供页面回看） */
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

/** 待办清单条目（用户日常 todo；区别于开发者驱动的改进备忘录 memo） */
export interface TodoItemV3 {
  id: string;
  text: string;
  done: boolean;
  /** 父任务 id（分解树：单父天然无环；父完成 = 全部子完成；删父级联删子孙） */
  parentId?: string;
  /** 前置依赖任务 id 列表（无环 DAG；全部完成 → 本任务才可执行；可跨树依赖） */
  dependencies: string[];
  /** 周期：每日/每周/每月（完成记录 lastDoneAt，跨期自动视为待做） */
  repeat?: "daily" | "weekly" | "monthly";
  /** 上次完成时间（周期项；跨期后视为 done=false） */
  lastDoneAt?: string;
  /** 归档时间（closed todo：手动归档 / 到期自动归档；归档后从主列表隐藏，进归档区可恢复） */
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 列表视图：附反应式计算字段（resolver 服务实时计算） */
export interface TodoItemV3View extends TodoItemV3 {
  /** 依赖未全部完成 → 阻塞（不可勾选完成；服务端权威校验 400 拒绝） */
  blocked: boolean;
  /** 未完成的前置依赖 id 列表 */
  blockedBy: string[];
  /** 直接子任务 id（分解树渲染用） */
  children: string[];
  /** 子孙完成率（有子任务时；父任务进度展示） */
  progress?: { done: number; total: number };
}

export interface TodoV3ListResult {
  ok: true;
  items: TodoItemV3View[];
}

export interface TodoV3CreateRequest {
  text: string;
  dependencies?: string[];
  repeat?: "daily" | "weekly" | "monthly";
}

export interface TodoV3MutateResult {
  ok: true;
  items: TodoItemV3View[];
}

/** 更新：切换完成 / 改文本 / 改依赖 / 改周期 / 改父任务 */
export interface TodoV3UpdateRequest {
  done?: boolean;
  text?: string;
  dependencies?: string[];
  parentId?: string | "none";
  /** 周期（"none" 清除） */
  repeat?: "daily" | "weekly" | "monthly" | "none";
}

export interface MemoCreateResult {
  ok: true;
  item: MemoItem;
}/** 更新：改文本 / 改状态 / 改类型 */
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
// 文档中心（工具分组）：markdown + pdf 管理与浏览
// 文件夹树（docs:folders）+ 文档元数据（docs:meta）+ md 内容（docs:content:<id>）
// + pdf 二进制（.file/docs/<id>.pdf）；tag 分类；知乎爬虫结果导入
// ============================================================
export interface DocFolder {
  id: string;
  name: string;
  /** 父文件夹 id（根目录缺省） */
  parentId?: string;
  /** 软删除时间（在回收站时设置；null/缺省 = 正常） */
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocItem {
  id: string;
  /** 文档名（含扩展名） */
  name: string;
  /** 类型：markdown / pdf */
  type: "md" | "pdf";
  /** 所属文件夹 id（根目录缺省） */
  folderId?: string;
  tags: string[];
  /** 字节大小 */
  size: number;
  /** 软删除时间（在回收站时设置；null/缺省 = 正常） */
  deletedAt?: string;
  /** 知乎导入来源（kind: url）——可选 */
  source?: { kind: string; url?: string };
  createdAt: string;
  updatedAt: string;
}

export interface DocsListResult {
  ok: true;
  folders: DocFolder[];
  items: DocItem[];
  /** 全部 tag 聚合（去重计数） */
  tags: { name: string; count: number }[];
}

export interface DocDetailResult {
  ok: true;
  item: DocItem;
  /** md 内容（type=md 时） */
  content?: string;
}

export interface DocFolderMutateResult {
  ok: true;
  folders: DocFolder[];
}

export interface DocsMutateResult {
  ok: true;
  items: DocItem[];
  folders: DocFolder[];
}

/** 知乎爬取历史（供文档中心导入） */
export interface ZhihuCrawlBrief {
  resultId: string;
  user: string;
  total: number;
  savedAt: string;
  items: { title: string; kind: string; url?: string }[];
}
export interface DocsTrashResult {
  ok: true;
  /** 回收站中的文档 */
  items: DocItem[];
  /** 回收站中的文件夹（含被软删的子文件夹） */
  folders: DocFolder[];
}

// ============================================================
// 仓位管理 v2（trade-v2）：逐笔交易（增量）→ 仓位明细（存量）→ 分组约束与分析
// 单一数据源：仓位 = 组内交易按日期重放（加权平均成本，含手续费）纯派生；
// 改/删任一笔交易 → 全部派生结果自动重算（无 v1 基线/重放一致性问题）
// ============================================================

/** 单标的上限配置（组内约束） */
export interface TradeV2StockLimit {
  code: string;
  name?: string;
  /** 单标的上限：占组总仓位百分比（0~100，可选；不配则不受单标的上限约束） */
  maxWeightPct?: number;
}

/** 交易分组（tag 组织单元，如策略）：名称 + 仓位限制 */
export interface TradeV2Group {
  id: string;
  /** 组名（如策略名） */
  name: string;
  /** 总仓位上限（元）——组内持仓市值不得超过 */
  totalCapital: number;
  /** 单日加仓上限（元）——组内当日所有加仓金额合计不得超过（期初建仓除外） */
  dailyAddLimit: number;
  /** 单标的上限配置 */
  stockLimits: TradeV2StockLimit[];
  /** 允许做空（卖出可超持仓 → 负持仓）。默认 false：卖出超持仓视为异常 */
  allowShort?: boolean;
  /** 信息分类（memo mt4hl5g9）：有信息（info）/无信息（noinfo）——交易噪声是否携带信息的策略定位 */
  infoType?: "info" | "noinfo";
  /** 虚盘分组（memo mtbjkyro）：金额与标的不参与「全部组合 / 实盘实际金额」计算，仅作独立分组展示与记账 */
  isPaper?: boolean;
  /** 聚合分组（memo 新增）：标的是来源分组（基础/聚合均可）的标的并集（递归派生）；作为合并视图参与分析/仓位，不参与全部组合与约束校验，不可直接记账 */
  aggSources?: string[];
  createdAt: string;
  updatedAt: string;
}

/** 一笔交易（增量；账本条目）。期初建仓 initial=true 为存量起点（不计入限额校验）。
 * 做空（组 allowShort）：卖出可超过当前持仓，超卖部分形成负持仓（空头）。 */

export interface TradeV2Entry {
  id: string;
  /** 所属分组 */
  groupId: string;
  /** 成交日期 YYYY-MM-DD */
  date: string;
  code: string;
  name?: string;
  /** 买入 / 卖出 */
  action: "buy" | "sell";
  /** 数量（股，>0 整数） */
  quantity: number;
  /** 成交价（>0） */
  price: number;
  /** 手续费（可选，≥0；摊入成本/回款） */
  fee?: number;
  /** 期初建仓（存量起点；不参与单日加仓/单标的上限校验） */
  initial?: boolean;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/** 仓位明细行（存量，由账本重放派生）。quantity<0 = 空头（做空，组 allowShort）。 */
export interface TradeV2Position {
  code: string;
  name?: string;
  /** 持仓数量（股；负 = 空头） */
  quantity: number;
  /** 加权平均成本（含手续费摊入；空头为开空均价，正数） */
  avgCost: number;
  /** 成本均价（摊薄口径，2026-08-17）：把已实现盈亏摊入剩余持仓 = (总成本基数−已实现盈亏)/数量；
   *  与 avgCost（买入均价）区分——卖出盈利后成本均价下降（券商「摊薄成本」显示） */
  costAvg?: number;
  /** 持仓成本（= quantity × avgCost；空头为负 = 空头占用） */
  costValue: number;
  /** 最新价（行情可得时） */
  latestPrice?: number;
  /** 实时涨跌幅 %（最新价 vs 昨收，行情可得时） */
  changePct?: number;
  /** 今日盈亏（涨跌额 × 持仓数量，行情可得时） */
  todayPnl?: number;
  /** 标的市场年化波动率 %（行情日K，近60交易日；与交易无关） */
  volatility?: number;
  /** 波动分级：low/mid/high（相对该标的历史波动分布 z-score） */
  volLevel?: "low" | "mid" | "high" | "extreme";
  /** 市值（行情可得：quantity × latestPrice；否则按成本计；空头为负） */
  marketValue: number;
  /** 未实现盈亏（= marketValue − costValue；空头：价格下跌为正盈利） */
  unrealizedPnl: number;
  /** 未实现盈亏率 %（costValue>0 时；空头/负成本不显示） */
  unrealizedPnlPct?: number;
  /** 占总仓位百分比（marketValue / totalCapital × 100） */
  weightPct?: number;
  /** 本 code 累计已实现盈亏（组内卖出/回补累计） */
  realizedPnl: number;
}

/** 一笔完整交易（买入→清仓配对；在途 = 当前仍持有） */
export interface TradeV2Deal {
  code: string;
  name?: string;
  /** open=在途 / closed=已完结 */
  status: "open" | "closed";
  entryDate: string;
  exitDate?: string;
  /** 持仓天数（closed: entry→exit；open: entry→今天） */
  days?: number;
  /** 段内累计买入数量（股） */
  buyQty: number;
  /** 段内累计买入金额（元） */
  buyAmount: number;
  /** 段内卖出回款（元）= Σ 卖出数量 × 卖出价 */
  sellAmount: number;
  /** 段内手续费合计（元） */
  feeTotal: number;
  /** 段内剩余数量（open > 0） */
  qty: number;
  /** 段内平均成本 = buyAmount / buyQty */
  avgCost: number;
  /** 已实现盈亏（closed）= sellAmount − buyAmount − feeTotal */
  pnl?: number;
}

/** 每日动态点（成本口径，按日期升序；供每日动态表与规模曲线） */
export interface TradeV2DailyPoint {
  date: string;
  /** 当日买入金额（含手续费） */
  buyAmount: number;
  /** 当日卖出回款（扣手续费） */
  sellAmount: number;
  /** 当日买入量（股） */
  buyQty: number;
  /** 当日卖出量（股） */
  sellQty: number;
  /** 当日已实现盈亏（卖出时按摊余成本结算） */
  realizedPnl: number;
  /** 当日收盘持仓市值（成本口径 Σ qty×avgCost） */
  marketValue: number;
  /** 当日持仓标数 */
  openCount: number;
}

/** 月度汇总（供月度收益柱状图/表） */
export interface TradeV2MonthlyPoint {
  month: string;
  buyAmount: number;
  sellAmount: number;
  realizedPnl: number;
  /** 月末持仓市值（成本口径） */
  marketValue: number;
  /** 月收益率 %（成本口径：(月已实现 + 市值变动 − 净流入) / 月初市值；首月缺省） */
  pnlPct?: number;
}

/** 收益归因（按标的：已实现 + 未实现 贡献） */
export interface TradeV2PnlAttribution {
  code: string;
  name?: string;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  /** 贡献度 %（|totalPnl| 合计口径） */
  sharePct?: number;
}

/** 组分析（详情接口附：仓位明细 + 复盘 + 汇总 + 收益时间/空间/每日动态） */
/** 综合交易指标（memo mt4hl5g9：收益分析波动率/夏普/回撤/盈亏比/期望） */
export interface TradeV2Metrics {
  /** 年化波动率 %（日收益标准差 × √252） */
  annualVol?: number;
  /** 夏普比率（年化收益 − 2% 无风险 ÷ 年化波动） */
  sharpe?: number;
  /** 最大回撤 %（日市值序列峰值到谷底最大跌幅，负值） */
  maxDrawdown?: number;
  /** 盈亏比（平均盈利 ÷ 平均亏损，按已平仓段） */
  profitFactor?: number;
  /** 单笔期望（平均每笔段盈亏，元） */
  expectancy?: number;
}

export interface TradeV2GroupAnalysis {
  groupId: string;
  name: string;
  totalCapital: number;
  dailyAddLimit: number;
  positions: TradeV2Position[];
  deals: TradeV2Deal[];
  /** 持仓成本合计 */
  totalCost: number;
  /** 持仓市值合计 */
  totalMv: number;
  /** 未实现盈亏 */
  unrealizedPnl: number;
  /** 已实现盈亏（卖出累计） */
  realizedPnl: number;
  /** 总盈亏 = realized + unrealized */
  totalPnl: number;
  /** 累计净投入（Σ买入金额 − Σ卖出回款，现金口径） */
  invested: number;
  /** 仓位占比 %（totalMv / totalCapital × 100） */
  positionPct?: number;
  /** 剩余可用仓位（totalCapital − totalMv） */
  remaining: number;
  /** 当日加仓金额合计 */
  todayAdd: number;
  /** 累计买入量（股，全部交易） */
  buyQty: number;
  /** 累计卖出量（股，全部交易） */
  sellQty: number;
  /** 在仓标的数 */
  openCount: number;
  /** 负成本（已回本/做空记账）标的数——存在时盈亏率无意义（显示 —） */
  negCount: number;
  /** 已完结笔数 */
  closedCount: number;
  /** 胜率 %（closed 中盈利笔占比；无 closed 缺省） */
  winRate?: number;
  /** 平均持仓天数（closed） */
  avgDays?: number;
  /** 收益·时间性：每日动态（成本口径） */
  dailySeries: TradeV2DailyPoint[];
  /** 收益·时间性：月度汇总 */
  monthlySeries: TradeV2MonthlyPoint[];
  /** 收益·空间：按标的归因（已实现+未实现贡献） */
  pnlAttribution: TradeV2PnlAttribution[];
  /** 综合交易指标（memo mt4hl5g9：波动率/夏普/回撤/盈亏比/期望） */
  metrics?: TradeV2Metrics;
}

/** 交易单净归并：逐标的当日买卖净效果 */
export interface TradeV2OrderNet {
  code: string;
  name?: string;
  /** 净数量（买+ 卖−） */
  netQty: number;
  /** 净动作（netQty>0 buy / <0 sell / =0 持平） */
  action: "buy" | "sell" | "flat";
  /** 净金额（净买入额 / 净卖出额） */
  netAmount: number;
}

/** 交易单当日归并汇总（服务端权威计算） */
export interface TradeV2DayOrderSummary {
  /** 当日买入合计（含手续费） */
  buyTotal: number;
  /** 当日卖出回款（扣手续费） */
  sellTotal: number;
  /** 当日已实现盈亏（按摊余成本） */
  realizedPnl: number;
  /** 逐标的净归并 */
  netPerCode: TradeV2OrderNet[];
}

/** 交易单批量提交结果 */
export interface TradeV2BatchResult {
  ok: boolean;
  /** 实际入库笔数 */
  createdCount: number;
  result?: TradeV2CheckResult;
  daySummary?: TradeV2DayOrderSummary;
  message?: string;
  rejectReason?: string;
}

/** 组摘要（列表接口附） */
export interface TradeV2GroupSummary {
  id: string;
  name: string;
  totalCapital: number;
  dailyAddLimit: number;
  stockLimitCount: number;
  /** 信息分类（memo mt4hl5g9） */
  infoType?: "info" | "noinfo";
  /** 虚盘分组（memo mtbjkyro） */
  isPaper?: boolean;
  /** 聚合分组（memo 新增）：标的是来源分组并集，作为合并视图 */
  isAgg?: boolean;
  /** 交易笔数 */
  entryCount: number;
  /** 在仓标的数 */
  openCount: number;
  totalMv: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalPnl: number;
  positionPct?: number;
  /** 违反组约束的告警数（服务端权威校验：超总仓位/超单标的上限/超日限等）——前端显示 ⚠️ 徽章 */
  riskCount?: number;
  updatedAt: string;
}

/** 交易条目草稿（前端提交/校验用；无 id/时间戳） */
export interface TradeV2EntryDraft {
  groupId: string;
  /** 成交日期 YYYY-MM-DD */
  date: string;
  code: string;
  name?: string;
  action: "buy" | "sell";
  quantity: number;
  /** 成交价（普通交易必须 > 0；期初建仓 initial=true 可为负——负成本基点：已回本/做空记账） */
  price: number;
  fee?: number;
  /** 期初建仓（存量起点；不参与单日加仓/单标的上限校验；允许负价成本基点） */
  initial?: boolean;
  note?: string;
}

/** 校验告警级别 */
export type TradeV2AlertLevel = "error" | "warn" | "info";

/** 单条校验结果 */
export interface TradeV2Alert {
  level: TradeV2AlertLevel;
  message: string;
  code?: string;
  detail?: string;
}

/** 交易校验结果（保存前服务端权威校验） */
export interface TradeV2CheckResult {
  ok: boolean;
  alerts: TradeV2Alert[];
}

/** 全局分析（跨组对比 + 时间线） */
export interface TradeV2AggregateAnalysis {
  groups: TradeV2GroupSummary[];
  /** 全部组合合并持仓（跨组合按 code 合并，成本摊薄口径——服务端权威，前端不自行核算） */
  positions: TradeV2Position[];
  /** 全部组合计市值 */
  totalMv: number;  /** 持仓成本合计（V1 口径：仅正成本；负成本标的已回本不计入） */
  totalCost: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalPnl: number;
  invested: number;
  openCount: number;
  closedCount: number;
  /** 负成本标的数（跨组合合计） */
  negCount: number;
  winRate?: number;
  avgDays?: number;
  /** 累计已实现盈亏时间线（closed 交易按清仓日期累计；供曲线图） */
  realizedTimeline: { date: string; cumulative: number }[];
  /** 组合每日动态（跨组合按日合并市值/买入/卖出/已实现/持仓数；成本口径） */
  dailySeries: TradeV2DailyPoint[];
  /** 全部组合作为一般组合的分析（与分组同一数据结构 analyzeGroup 输出——mt52hjgp） */
  analysis?: TradeV2GroupAnalysis;
  /** 组合分析（收益分析能力对齐一般分组）：累计买卖量 / 月度 / 归因 / 综合指标 */
  buyQty?: number;
  sellQty?: number;
  monthlySeries?: TradeV2MonthlyPoint[];
  pnlAttribution?: TradeV2PnlAttribution[];
  metrics?: TradeV2Metrics;
  /** 全部交易段（收益分析 PerformanceCard/DealsTable 复用一般分组渲染） */
  deals?: TradeV2Deal[];
}

// ---------- 响应 ----------

export interface TradeV2OverviewResult {
  ok: true;
  groups: TradeV2GroupSummary[];
  entries: TradeV2Entry[];
}

export interface TradeV2GroupResult {
  ok: boolean;
  group?: TradeV2Group;
  message?: string;
}

export interface TradeV2GroupDetailResult {
  ok: boolean;
  group?: TradeV2Group;
  analysis?: TradeV2GroupAnalysis;
  message?: string;
}

export interface TradeV2EntryResult {
  ok: boolean;
  entry?: TradeV2Entry;
  result?: TradeV2CheckResult;
  message?: string;
  /** 违反组约束时的具体原因（多条用；分隔） */
  rejectReason?: string;
}

export interface TradeV2CheckResponse {
  ok: boolean;
  result?: TradeV2CheckResult;
  message?: string;
}

export interface TradeV2GlobalResult {
  ok: boolean;
  analysis?: TradeV2AggregateAnalysis;
  message?: string;
}

// ============================================================
// 实验分组（memo msvwslfq：通用投资框架 / ec 泡沫预警 / BMPI 化债牛市）
// ============================================================

export interface ExperimentFrameworkRequest {
  topic: string;
}

export interface ExperimentFrameworkResponse {
  ok: true;
  topic: string;
  /** markdown 分析报告（哲学/战略/战术/批判 4 层 + e-梯队仓位表） */
  report: string;
  asOf: string;
  model?: string;
}

export interface ExperimentEcData {
  asOf: string;
  fx: { eurjpy?: number; usdjpy?: number; eurusd?: number };
  spreads?: { de10y?: number; jp10y?: number; diff?: number };
  vix?: number;
  cftc?: { netShortK?: number; zScore?: number };
  buffettIndicator?: number;
  cvas?: number;
  ccv?: number;
}

export interface ExperimentEcRequest {
  force?: boolean;
  useSearch?: boolean;
}

export interface ExperimentEcResponse {
  ok: true;
  asOf: string;
  data: ExperimentEcData;
  indicators: { b: number | null; bTrend: string; omega: number | null; cvas: number | null; ccv: number | null; signals: string[] };
  status: string;
  summary: string;
  anchors: { condition: string; status: string; action: string }[];
  watchDates: { date: string; event: string; focus: string }[];
  caveats: string[];
  fromCache?: boolean;
  cachedAt?: string;
  model?: string;
}

export interface ExperimentBmpiRequest {
  force?: boolean;
  useSearch?: boolean;
}

export interface ExperimentBmpiResponse {
  ok: true;
  asOf: string;
  indices: { R: number; SL: number; S1: number; S2: number; S3: number; weights: { w1: number; w2: number; w3: number } };
  bmpi: number;
  status: string;
  summary: string;
  details: { index: string; score: number; evidence: string; confidence: string }[];
  watchDates: { date: string; event: string; focus: string }[];
  caveats: string[];
  fromCache?: boolean;
  cachedAt?: string;
  model?: string;
}

// ---------- 数据工程基础设施（data-infra 运管） ----------
export interface DataInfraTaskSummary {
  id: string;
  type: string;
  name: string;
  cron?: string;
  status: "queued" | "running" | "done" | "failed" | "paused";
  lastRunAt?: number;
  lastResult?: string;
  nextRunAt?: number;
  createdAt: number;
  updatedAt: number;
}
export interface DataInfraTaskHistoryEntry {
  at: number;
  trigger?: string;
  status: string;
  message?: string;
  durationMs?: number;
}
export interface DataInfraQueueStats {
  name: string;
  pending: number;
  processing: number;
  done: number;
  failed: number;
  total: number;
}
