import {
  API_PREFIX,
  type AsyncTaskResult,
  type CbRateRequest,
  type CbRateResponse,
  type FundSnapshot,
  type GridPlanRequest,
  type GridPlanResult,
  type GridPlanHistoryDeleteResult,
  type GridPlanHistoryDetailResult,
  type GridPlanHistoryListResult,
  type HealthResponse,
  type LlmChatRequest,
  type LlmChatResult,
  type LlmSettingsRequest,
  type LlmSettingsResponse,
  type LlmStatusResponse,
  type LlmTestResult,
  type LlmBalanceResult,
  type TaskHistoryEntry,
  type TaskHistoryListResponse,
  type KnowledgeAskResult,
  type KnowledgeEntry,
  type KnowledgeImportResult,
  type LlmUsageSummary,
  type AgentSessionsResult,
  type AgentSessionCreateRequest,
  type AgentSessionCreateResult,
  type AgentSessionAskResult,
  type ChatSessionDetail,
  type ReasonixSessionDetail,
  type ReasonixProcessStatus,
  type McpServersResult,
  type McpServerConfigItem,
  type LocalDataResult,
  type LocalDataUpdateRequest,
  type PromptDetailResult,
  type PromptsListResult,
  type QuoteResult,
  type QuoteSnapshot,
  type ReverseRepoDailyResponse,
  type ReverseRepoMonthlyResult,
  type ReverseRepoMonthlyUpdateStatus,
  type WatchlistCreateResult,
  type WatchlistDeleteResult,
  type WatchlistDetailResult,
  type WatchlistFundamentalResult,
  type WatchlistListResult,
  type WatchlistTopic,
  type WatchlistUpdateRequest,
  type MemoCreateResult,
  type MemoDeleteResult,
  type MemoDetailResult,
  type MemoListResult,
  type MemoUpdateRequest,
  type BookConfig,
  type BookFavoritesResult,
  type BookHistoryResult,
  type BookItem,
  type BookSearchResult,
  type ShareHistoryResult,
  type KellyHistoryDeleteResult,
  type KellyHistoryDetailResult,
  type KellyHistoryListResult,
  type KellyRequest,
  type KellyResult,
  type RehabNoteResult,
  type RehabNoteUpdateRequest,
  type ShareExtractRequest,
  type ShareExtractResult,
  type ToolListResponse,
  type TreasuryFxRequest,
  type TreasuryFxResponse,
} from "@toolbox/shared";

// API 客户端：前端唯一访问后端的入口。
// 后端实现（TS / 未来 Go）替换时，业务代码无需改动。
// 统一约定：非 2xx 时若后端返回 { message }，优先抛出该 message（调用方展示详情）。

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`, init);
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
  if (res.ok) return body as T;
  throw new Error(body?.message ?? `API ${path} failed: ${res.status}`);
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** 从异常中提取可读消息（后端 Error(message) 或网络错误统一处理） */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const api = {
  health: () => request<HealthResponse>("/health"),
  tools: () => request<ToolListResponse>("/tools"),
  gridPlan: (req: GridPlanRequest) => request<GridPlanResult>("/tools/grid-plan", jsonInit("POST", req)),
  quote: (code: string) => request<QuoteResult>(`/tools/grid-plan/quote?code=${encodeURIComponent(code)}`),
  /** 行情快照（实时报价，含 price；公共模块 /api/quote） */
  quoteSnapshot: (code: string) => request<QuoteSnapshot>(`/quote?code=${encodeURIComponent(code)}`),
  // 凯利仓位助手
  kellyCalculate: (req: KellyRequest) => request<KellyResult>("/tools/kelly/calculate", jsonInit("POST", req)),
  kellyHistory: () => request<KellyHistoryListResult>("/tools/kelly/history"),
  kellyHistoryDetail: (id: string) => request<KellyHistoryDetailResult>(`/tools/kelly/history/${encodeURIComponent(id)}`),
  kellyHistoryDelete: (id: string) =>
    request<KellyHistoryDeleteResult>(`/tools/kelly/history/${encodeURIComponent(id)}`, jsonInit("DELETE", {})),
  // 康复笔记
  rehabGet: (id: string) => request<RehabNoteResult>(`/tools/rehab/${encodeURIComponent(id)}`),
  rehabSave: (id: string, patch: RehabNoteUpdateRequest) =>
    request<RehabNoteResult>(`/tools/rehab/${encodeURIComponent(id)}`, jsonInit("PUT", patch)),
  rehabReset: (id: string) => request<RehabNoteResult>(`/tools/rehab/${encodeURIComponent(id)}/reset`, jsonInit("POST", {})),
  // 医学知识库（medical 实例，core/knowledge 业务落地）
  medicalKbImport: (urls: string[], conflict: "skip" | "overwrite" | "merge" = "skip") =>
    request<AsyncTaskResult<KnowledgeImportResult>>("/tools/medical-kb/import", jsonInit("POST", { urls, conflict })),
  medicalKbList: () => request<{ ok: true; entries: KnowledgeEntry[]; total: number }>("/tools/medical-kb"),
  medicalKbDelete: (key: string) => request<{ ok: true; deleted: number } | { ok: false; message: string }>(`/tools/medical-kb/${encodeURIComponent(key)}`, jsonInit("DELETE", {})),
  medicalKbAsk: (question: string) => request<AsyncTaskResult<KnowledgeAskResult>>("/tools/medical-kb/ask", jsonInit("POST", { question })),
  /** 历史网格计划（列表/详情/删除） */
  gridPlanHistory: () => request<GridPlanHistoryListResult>("/tools/grid-plan/history"),
  gridPlanHistoryDetail: (id: string) => request<GridPlanHistoryDetailResult>(`/tools/grid-plan/history/${encodeURIComponent(id)}`),
  gridPlanHistoryDelete: (id: string) =>
    request<GridPlanHistoryDeleteResult>(`/tools/grid-plan/history/${encodeURIComponent(id)}`, jsonInit("DELETE", {})),
  // DeepSeek 分享提取
  shareExtract: (url: string) =>
    request<ShareExtractResult>("/tools/deepseek-share", jsonInit("POST", { url } satisfies ShareExtractRequest)),
  // 央行利率分析（异步任务）
  cbRate: (req: CbRateRequest) => request<AsyncTaskResult<CbRateResponse>>("/tools/cb-rate", jsonInit("POST", req)),
  cbRateTaskStatus: (taskId: string) =>
    request<AsyncTaskResult<CbRateResponse>>(`/tools/cb-rate/task/${encodeURIComponent(taskId)}`),
  // 国债汇率分析（异步任务）
  treasuryFx: (req: TreasuryFxRequest) =>
    request<AsyncTaskResult<TreasuryFxResponse>>("/tools/treasury-fx", jsonInit("POST", req)),
  treasuryFxTaskStatus: (taskId: string) =>
    request<AsyncTaskResult<TreasuryFxResponse>>(`/tools/treasury-fx/task/${encodeURIComponent(taskId)}`),
  // 逆回购余额跟踪（存量月度数据 + 增量每日探查）
  reverseRepoMonthly: () => request<ReverseRepoMonthlyResult>("/tools/reverse-repo/monthly"),
  /** 月度数据触发式更新状态（stale 时后台自动触发，此接口查进度/结果） */
  reverseRepoMonthlyUpdateStatus: () => request<ReverseRepoMonthlyUpdateStatus>("/tools/reverse-repo/monthly/update-status"),
  /** 手动触发月度数据更新（幂等：running 中/已最新不重复） */
  reverseRepoMonthlyRefresh: () => request<ReverseRepoMonthlyUpdateStatus>("/tools/reverse-repo/monthly/refresh", jsonInit("POST", {})),
  reverseRepoDaily: (force = false) =>
    request<AsyncTaskResult<ReverseRepoDailyResponse>>("/tools/reverse-repo/daily", jsonInit("POST", { force })),
  // 专题自选股（专题 CRUD + 个股财报分析）
  watchlistList: () => request<WatchlistListResult>("/tools/watchlist"),
  watchlistCreate: (name: string, description?: string) =>
    request<WatchlistCreateResult>("/tools/watchlist", jsonInit("POST", description ? { name, description } : { name })),
  watchlistDetail: (id: string) => request<WatchlistDetailResult>(`/tools/watchlist/${encodeURIComponent(id)}`),
  watchlistUpdate: (id: string, patch: WatchlistUpdateRequest) =>
    request<WatchlistDetailResult>(`/tools/watchlist/${encodeURIComponent(id)}`, jsonInit("PUT", patch)),
  watchlistDelete: (id: string) => request<WatchlistDeleteResult>(`/tools/watchlist/${encodeURIComponent(id)}`, jsonInit("DELETE", {})),
  watchlistResolve: (code: string, kind?: string) =>
    request<{ ok: boolean; code: string; name: string }>(`/tools/watchlist/resolve?code=${encodeURIComponent(code)}${kind ? `&kind=${encodeURIComponent(kind)}` : ""}`),
  /** Chat 导入：分享链接 → 自动创建专题（后台任务） */
  watchlistImport: (url: string) => request<AsyncTaskResult<WatchlistTopic>>("/tools/watchlist/import", jsonInit("POST", { url })),
  watchlistImportTaskStatus: (taskId: string) => request<AsyncTaskResult<WatchlistTopic>>(`/tools/watchlist/import/task/${encodeURIComponent(taskId)}`),
  /** Chat 补充：分享链接 → 追加个股到指定专题（后台任务） */
  watchlistAppend: (id: string, url: string) =>
    request<AsyncTaskResult<WatchlistTopic>>(`/tools/watchlist/${encodeURIComponent(id)}/import`, jsonInit("POST", { url })),
  /** 批量行情快照（个股基本信息） */
  watchlistQuotes: (codes: string[]) =>
    request<{ ok: boolean; quotes: (QuoteSnapshot | FundSnapshot)[] }>(`/tools/watchlist/quotes?codes=${encodeURIComponent(codes.join(","))}`),
  watchlistFundamental: (id: string, code: string, force = false) =>
    request<AsyncTaskResult<WatchlistFundamentalResult>>(
      `/tools/watchlist/${encodeURIComponent(id)}/fundamental?code=${encodeURIComponent(code)}${force ? "&force=1" : ""}`,
      jsonInit("POST", {}),
    ),
  watchlistFundamentalTaskStatus: (id: string, taskId: string) =>
    request<AsyncTaskResult<WatchlistFundamentalResult>>(
      `/tools/watchlist/${encodeURIComponent(id)}/fundamental/task/${encodeURIComponent(taskId)}`,
    ),
  // 改进备忘录（TODO list）
  memoList: () => request<MemoListResult>("/tools/memo"),
  memoCreate: (text: string, kind: "fix" | "feature" = "fix") => request<MemoCreateResult>("/tools/memo", jsonInit("POST", { text, kind })),
  memoUpdate: (id: string, patch: MemoUpdateRequest) =>
    request<MemoDetailResult>(`/tools/memo/${encodeURIComponent(id)}`, jsonInit("PUT", patch)),
  memoDelete: (id: string) => request<MemoDeleteResult>(`/tools/memo/${encodeURIComponent(id)}`, jsonInit("DELETE", {})),
  // 书籍下载（zlib）
  booksSearch: (q: string, page = 1, limit = 20) =>
    request<BookSearchResult>(`/tools/books/search?q=${encodeURIComponent(q)}&page=${page}&limit=${limit}`),
  booksConfig: () => request<BookConfig>("/tools/books/config"),
  booksSaveConfig: (patch: { zlibBase?: string; proxy?: string }) => request<BookConfig>("/tools/books/config", jsonInit("PUT", patch)),
  booksHistory: () => request<BookHistoryResult>("/tools/books/history"),
  booksHistoryDelete: (q?: string) =>
    request<BookHistoryResult>(`/tools/books/history${q ? `?q=${encodeURIComponent(q)}` : ""}`, jsonInit("DELETE", {})),
  booksFavorites: () => request<BookFavoritesResult>("/tools/books/favorites"),
  booksFavoriteAdd: (item: BookItem) => request<BookFavoritesResult>("/tools/books/favorites", jsonInit("POST", item)),
  booksFavoriteDelete: (id?: number) =>
    request<BookFavoritesResult>(`/tools/books/favorites${id !== undefined ? `?id=${id}` : ""}`, jsonInit("DELETE", {})),
  // DeepSeek Share 提取历史
  shareHistory: () => request<ShareHistoryResult>("/tools/deepseek-share/history"),
  shareHistoryClear: () => request<ShareHistoryResult>("/tools/deepseek-share/history", jsonInit("DELETE", {})),
  reverseRepoDailyTaskStatus: (taskId: string) =>
    request<AsyncTaskResult<ReverseRepoDailyResponse>>(`/tools/reverse-repo/daily/task/${encodeURIComponent(taskId)}`),
  // 任务取消（中止服务端 LLM 调用与资源）
  cancelTask: (taskId: string) =>
    request<{ ok: true; taskId: string; status: string } | { ok: false; message: string }>(
      `/tasks/${encodeURIComponent(taskId)}/cancel`,
      jsonInit("POST", {}),
    ),
  // 任务历史（KV 持久化，页面回看）：列表 + 单条详情
  taskHistoryList: (module: string) => request<TaskHistoryListResponse>(`/tasks/history?module=${encodeURIComponent(module)}`),
  taskHistoryEntry: (taskId: string) =>
    request<{ ok: true; entry: TaskHistoryEntry } | { ok: false; message: string }>(`/tasks/history/${encodeURIComponent(taskId)}`),
  // 任务实时状态（轮询兜底；SSE 优先）
  taskStatus: <T = unknown>(taskId: string) => request<AsyncTaskResult<T>>(`/tasks/${encodeURIComponent(taskId)}`),
  // 本地数据管理
  localSources: () => request<LocalDataResult>("/data/local/sources"),
  localEntries: (q: { source?: string; table?: string; search?: string; limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      // 剔除 undefined / 空串，避免 URLSearchParams 把 undefined 序列化为 "undefined" 导致过滤错乱
      if (v !== undefined && v !== "") params.set(k, String(v));
    }
    return request<LocalDataResult>(`/data/local/entries?${params.toString()}`);
  },
  /** 批量清空数据源（KV，key 归属校验） */
  localClearSource: (source: string) =>
    request<{ ok: boolean; deleted: number }>(`/data/local/entries?source=${encodeURIComponent(source)}`, jsonInit("DELETE", {})),
  localEntry: (q: { source?: string; table?: string; key: string }) =>
    request<LocalDataResult>(`/data/local/entry?${new URLSearchParams(q as Record<string, string>).toString()}`),
  localDelete: (q: { source?: string; table?: string; key: string }) =>
    request<LocalDataResult>(`/data/local/entry?${new URLSearchParams(q as Record<string, string>).toString()}`, {
      method: "DELETE",
    }),
  localUpdate: (body: LocalDataUpdateRequest) =>
    request<LocalDataResult>("/data/local/entry", jsonInit("PUT", body)),
  // LLM 能力（DeepSeek）
  llmStatus: () => request<LlmStatusResponse>("/llm/status"),
  llmSettings: (req: LlmSettingsRequest) => request<LlmSettingsResponse>("/llm/settings", jsonInit("POST", req)),
  llmTest: () => request<LlmTestResult>("/llm/test", jsonInit("POST", {})),
  /** LLM 用量汇总（服务端切面记录） */
  llmUsage: () => request<LlmUsageSummary>("/llm/usage"),
  /** DeepSeek 平台余额（API key 授权） */
  llmBalance: () => request<LlmBalanceResult>("/llm/balance"),
  llmChat: (req: LlmChatRequest) => request<LlmChatResult>("/llm/chat", jsonInit("POST", req)),
  // Agent 会话管理（chatSession / reasonix）
  agentSessions: () => request<AgentSessionsResult>("/llm/agent-sessions"),
  agentSessionCreate: (kind: "chat" | "reasonix", req: AgentSessionCreateRequest) =>
    request<AgentSessionCreateResult>(`/llm/agent-sessions/${kind}`, jsonInit("POST", req)),
  agentSessionDetail: (id: string) => request<ChatSessionDetail>(`/llm/agent-sessions/chat/${encodeURIComponent(id)}`),
  agentSessionReasonixDetail: (id: string) => request<ReasonixSessionDetail>(`/llm/agent-sessions/reasonix/${encodeURIComponent(id)}`),
  reasonixProcess: () => request<ReasonixProcessStatus>("/llm/agent-sessions/process"),
  reasonixProcessStart: () => request<ReasonixProcessStatus>("/llm/agent-sessions/process/start", jsonInit("POST", {})),
  reasonixProcessStop: () => request<ReasonixProcessStatus>("/llm/agent-sessions/process/stop", jsonInit("POST", {})),
  mcpServers: () => request<McpServersResult>("/llm/mcp-servers"),
  mcpServersSave: (servers: McpServerConfigItem[]) => request<McpServersResult>("/llm/mcp-servers", jsonInit("PUT", { servers })),
  agentSessionRestore: (id: string) =>
    request<{ ok: boolean; message: string }>(`/llm/agent-sessions/chat/${encodeURIComponent(id)}/restore`, jsonInit("POST", {})),
  agentSessionAsk: (kind: "chat" | "reasonix", id: string, text: string) =>
    request<AsyncTaskResult<AgentSessionAskResult>>(
      `/llm/agent-sessions/${kind}/${encodeURIComponent(id)}/ask`,
      jsonInit("POST", kind === "chat" ? { message: text } : { text }),
    ),
  agentSessionDelete: (kind: "chat" | "reasonix", id: string) =>
    request<{ ok: boolean; message: string }>(`/llm/agent-sessions/${kind}/${encodeURIComponent(id)}`, jsonInit("DELETE", {})),
  // 提示词（统一存储于「本地设置数据」）
  prompts: () => request<PromptsListResult>("/prompts"),
  promptDetail: (id: string) => request<PromptDetailResult>(`/prompts/${encodeURIComponent(id)}`),
  promptUpdate: (id: string, template: string) =>
    request<{ ok: true; id: string } | { ok: false; message: string }>(
      `/prompts/${encodeURIComponent(id)}`,
      jsonInit("PUT", { template }),
    ),
  promptReset: (id: string) =>
    request<{ ok: true; id: string } | { ok: false; message: string }>(
      `/prompts/${encodeURIComponent(id)}/reset`,
      jsonInit("POST", {}),
    ),
  // 项目架构依赖图（扫描源码自动生成）
  dependencyGraph: () => request<{ ok: boolean; generatedAt: string; nodes: unknown[]; edges: unknown[] }>("/dependency-graph"),
  // 知乎爬虫
  zhihuCookie: () => request<{ ok: boolean; configured: boolean }>("/tools/zhihu-crawler/cookie"),
  zhihuSaveCookie: (cookie: string) => request<{ ok: boolean; configured: boolean }>(`/tools/zhihu-crawler/cookie`, jsonInit("PUT", { cookie })),
  zhihuAuth: () => request<{ ok: boolean; taskId: string; status: string }>("/tools/zhihu-crawler/auth", jsonInit("POST", {})),
  zhihuUser: (target: string) => request<import("@toolbox/shared").ZhihuUserInfo>(`/tools/zhihu-crawler/user?target=${encodeURIComponent(target)}`),
  zhihuCrawl: (req: import("@toolbox/shared").ZhihuCrawlRequest) =>
    request<{ ok: boolean; taskId: string; status: string }>("/tools/zhihu-crawler/crawl", jsonInit("POST", req)),
  zhihuHistory: () => request<{ ok: boolean; items: import("@toolbox/shared").ZhihuCrawlHistoryEntry[] }>("/tools/zhihu-crawler/history"),
  zhihuHistoryDelete: (id: string) => request<{ ok: boolean }>(`/tools/zhihu-crawler/history/${encodeURIComponent(id)}`, jsonInit("DELETE", {})),
  zhihuResult: (id: string) => request<import("@toolbox/shared").ZhihuCrawlResult>(`/tools/zhihu-crawler/result/${encodeURIComponent(id)}`),
  zhihuInstances: () => request<{ ok: boolean; instances: { instance: string; count: number; updatedAt?: string }[] }>("/tools/zhihu-crawler/instances"),
  zhihuImport: (req: import("@toolbox/shared").ZhihuImportRequest) =>
    request<import("@toolbox/shared").ZhihuImportResult>("/tools/zhihu-crawler/import", jsonInit("POST", req)),
  zhihuFavorites: () => request<{ ok: boolean; items: import("@toolbox/shared").ZhihuFavoriteEntry[] }>("/tools/zhihu-crawler/favorites"),
  zhihuFavoriteAdd: (target: string, name?: string) =>
    request<{ ok: boolean; favorites: import("@toolbox/shared").ZhihuFavoriteEntry[] }>("/tools/zhihu-crawler/favorites", jsonInit("PUT", { target, name })),
  zhihuFavoriteDelete: (token: string) => request<{ ok: boolean; favorites: import("@toolbox/shared").ZhihuFavoriteEntry[] }>(`/tools/zhihu-crawler/favorites/${encodeURIComponent(token)}`, jsonInit("DELETE", {})),
};
