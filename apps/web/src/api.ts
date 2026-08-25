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
  type WatchlistStock,
  type WatchlistTopic,
  type WatchlistUpdateRequest,
  type MemoCreateResult,
  type MemoKind,
  type MemoDeleteResult,
  type MemoDetailResult,
  type MemoListResult,
  type MemoUpdateRequest,
  type TodoV3ListResult,
  type TodoV3MutateResult,
  type TodoV3UpdateRequest,
  type DocDetailResult,
  type DocFolderMutateResult,
  type DocsListResult,
  type DocsMutateResult,
  type DocsTrashResult,
  type ZhihuCrawlBrief,
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
  type TradeV2OverviewResult,
  type TradeV2GroupResult,
  type TradeV2GroupDetailResult,
  type TradeV2EntryDraft,
  type TradeV2EntryResult,
  type TradeV2CheckResponse,
  type TradeV2GlobalResult,
  type TradeV2BatchResult,
} from "@toolbox/shared";

// API 客户端：前端唯一访问后端的入口。
// 后端实现（TS / 未来 Go）替换时，业务代码无需改动。
// 统一约定：非 2xx 时若后端返回 { message }，优先抛出该 message（调用方展示详情）。

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    // 统一超时（仅普通请求；调用方已传 signal 的任务流不覆盖，避免破坏 SSE/长任务）
    signal: init?.signal ?? AbortSignal.timeout(20000),
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
  if (res.ok) return body as T;
  // 附加 rejectReason（如「计划违反策略仓位管理」的具体原因），errMsg 可直接展示
  const reason = (body as { rejectReason?: string } | null)?.rejectReason;
  throw new Error(reason ? `${body?.message ?? `API ${path} failed: ${res.status}`}：${reason}` : (body?.message ?? `API ${path} failed: ${res.status}`));
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
  watchlistCreate: (name: string, description?: string, group?: string) =>
    request<WatchlistCreateResult>("/tools/watchlist", jsonInit("POST", { name, ...(description ? { description } : {}), ...(group ? { group } : {}) })),
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
  /** Chat 补充预览：解析对话 → 候选个股（不落库，用户确认后导入） */
  watchlistAppendPreview: (id: string, url: string) =>
    request<AsyncTaskResult<{ name: string; description?: string; stocks: WatchlistStock[] }>>(
      `/tools/watchlist/${encodeURIComponent(id)}/import/preview`,
      jsonInit("POST", { url }),
    ),
  watchlistAppendPreviewStatus: (id: string, taskId: string) =>
    request<AsyncTaskResult<{ name: string; description?: string; stocks: WatchlistStock[] }> & { preview?: WatchlistStock[] | null }>(
      `/tools/watchlist/${encodeURIComponent(id)}/import/preview/task/${encodeURIComponent(taskId)}`,
    ),
  /** Chat 补充确认：勾选的候选个股批量加入专题 */
  watchlistAppendConfirm: (id: string, taskId: string, codes: string[]) =>
    request<{ ok: boolean; topic?: WatchlistTopic; imported?: number; message?: string }>(
      `/tools/watchlist/${encodeURIComponent(id)}/import/confirm`,
      jsonInit("POST", { taskId, codes }),
    ),
  /** 移动/复制个股到其他专题（copy=true 保留源专题个股） */
  watchlistMoveStock: (fromTopicId: string, code: string, toTopicId: string, copy: boolean) =>
    request<{ ok: boolean; fromTopic?: WatchlistTopic; toTopic?: WatchlistTopic; moved?: boolean; message?: string }>(
      "/tools/watchlist/move-stock",
      jsonInit("POST", { fromTopicId, code, toTopicId, copy }),
    ),
  /** 股票名称搜索（名称 → 代码候选，添加股票输入补全用） */
  watchlistSearchStock: (name: string, limit = 8) =>
    request<{ ok: boolean; items: { code: string; name: string; market: string; type: string }[]; message?: string }>(
      `/tools/watchlist/search-stock?name=${encodeURIComponent(name)}&limit=${limit}`,
    ),
  watchlistQuotes: (codes: string[]) =>
    request<{ ok: boolean; quotes: (QuoteSnapshot | FundSnapshot)[] }>(`/tools/watchlist/quotes?codes=${encodeURIComponent(codes.join(","))}`),
    /** DeepSeek Chat 自动填入（服务端 playwright 打开浏览器并填提示词；未登录会弹窗登录一次） */
  /** 仓位管理 v2：逐笔交易账本 + 仓位明细（自动派生）+ 分组约束 */
  tradeV2Overview: () => request<TradeV2OverviewResult>("/tools/trade-v2"),
  tradeV2Group: (id: string) => request<TradeV2GroupDetailResult>("/tools/trade-v2/groups/" + encodeURIComponent(id)),
  tradeV2GroupStocks: (id: string) => request<{ ok: boolean; stocks?: { code: string; name?: string }[] }>("/tools/trade-v2/groups/" + encodeURIComponent(id) + "/stocks"),
  tradeV2CreateGroup: (name: string, infoType?: "info" | "noinfo") => request<TradeV2GroupResult>("/tools/trade-v2/groups", jsonInit("POST", { name, ...(infoType ? { infoType } : {}) })),
  tradeV2SaveGroup: (id: string, patch: { name?: string; totalCapital?: number; dailyAddLimit?: number; stockLimits?: { code: string; name?: string; maxWeightPct?: number }[]; allowShort?: boolean; infoType?: "info" | "noinfo" | null }) =>
    request<TradeV2GroupResult>("/tools/trade-v2/groups/" + encodeURIComponent(id), jsonInit("PUT", patch)),
  tradeV2DeleteGroup: (id: string) => request<{ ok: boolean; message?: string }>("/tools/trade-v2/groups/" + encodeURIComponent(id), jsonInit("DELETE", {})),
  tradeV2CheckEntry: (draft: TradeV2EntryDraft) => request<TradeV2CheckResponse>("/tools/trade-v2/entries/check", jsonInit("POST", draft)),
  tradeV2CreateEntry: (draft: TradeV2EntryDraft) => request<TradeV2EntryResult>("/tools/trade-v2/entries", jsonInit("POST", draft)),
  tradeV2UpdateEntry: (id: string, draft: TradeV2EntryDraft) => request<TradeV2EntryResult>("/tools/trade-v2/entries/" + encodeURIComponent(id), jsonInit("PUT", draft)),
  tradeV2DeleteEntry: (id: string) => request<{ ok: boolean; message?: string }>("/tools/trade-v2/entries/" + encodeURIComponent(id), jsonInit("DELETE", {})),
  /** 移动某标的的全部交易到另一分组（memo mt2ttvqd） */
  tradeV2MoveStock: (fromGroupId: string, code: string, toGroupId: string) => request<{ ok: boolean; moved?: number; message?: string }>("/tools/trade-v2/move-stock", jsonInit("POST", { fromGroupId, code, toGroupId })),
  /** 每日交易单批量提交（整批校验 → 入库 + 逐标的净归并汇总；preview=true 只校验不入库） */
  tradeV2BatchEntries: (items: TradeV2EntryDraft[], preview = false) =>
    request<TradeV2BatchResult>("/tools/trade-v2/entries/batch", jsonInit("POST", { items, ...(preview ? { preview: true } : {}) })),
  tradeV2Analysis: () => request<TradeV2GlobalResult>("/tools/trade-v2/analysis"),
  chatBrowserOpen: (prompt: string, opts?: { send?: boolean; deepThink?: boolean; search?: boolean }) =>
    request<{ ok: boolean; loggedIn?: boolean; message?: string }>("/tools/chat-browser/open", jsonInit("POST", { prompt, ...(opts?.send ? { send: true } : {}), ...(opts?.deepThink ? { deepThink: true } : {}), ...(opts?.search ? { search: true } : {}) })),
  watchlistFundamental: (id: string, code: string, force = false) =>
    request<AsyncTaskResult<WatchlistFundamentalResult>>(
      `/tools/watchlist/${encodeURIComponent(id)}/fundamental?code=${encodeURIComponent(code)}${force ? "&force=1" : ""}`,
      jsonInit("POST", {}),
    ),
  /** 根据财报分析优化入选理由（LLM；成功后更新专题内该股理由） */
  watchlistOptimizeReason: (id: string, code: string, reason?: string) =>
    request<{ ok: boolean; reason?: string; topic?: WatchlistTopic; message?: string }>(`/tools/watchlist/${encodeURIComponent(id)}/optimize-reason`, jsonInit("POST", { code, reason })),
  /** 生成延续思路/扩展思考提示词（LLM；返回可粘贴 DeepSeek Chat 的提示词） */
  watchlistExtendPrompt: (id: string, force = false) =>
    request<{ ok: boolean; prompt?: string; fromCache?: boolean; message?: string }>(`/tools/watchlist/${encodeURIComponent(id)}/extend-prompt`, jsonInit("POST", { ...(force ? { force: true } : {}) })),
  watchlistFundamentalTaskStatus: (id: string, taskId: string) =>
    request<AsyncTaskResult<WatchlistFundamentalResult>>(
      `/tools/watchlist/${encodeURIComponent(id)}/fundamental/task/${encodeURIComponent(taskId)}`,
    ),
  // 新闻中心（多源配置 + 展示）
  newsSources: () => request<{ ok: boolean; sources: { id: string; name: string; desc: string; enabled: boolean }[]; message?: string }>("/tools/news/sources"),
  newsConfig: (sources: string[]) => request<{ ok: boolean; sources: { id: string; name: string; desc: string; enabled: boolean }[]; message?: string }>("/tools/news/config", jsonInit("POST", { sources })),
  newsItems: (sources?: string[], page = 1) =>
    request<{ ok: boolean; items: { title: string; digest: string; time: string; url: string; source: string; sourceName: string }[]; errors: string[]; fromCache: boolean[]; page: number; message?: string }>(
      `/tools/news/items${sources && sources.length ? `?sources=${encodeURIComponent(sources.join(","))}` : ""}${sources && sources.length ? "&" : "?"}page=${page}`,
    ),
  // 改进备忘录（TODO list）
  memoList: () => request<MemoListResult>("/tools/memo"),
  memoCreate: (text: string, kind?: MemoKind) => request<MemoCreateResult>("/tools/memo", jsonInit("POST", { text, ...(kind ? { kind } : {}) })),
  memoUpdate: (id: string, patch: MemoUpdateRequest) =>
    request<MemoDetailResult>(`/tools/memo/${encodeURIComponent(id)}`, jsonInit("PUT", patch)),
  memoDelete: (id: string) => request<MemoDeleteResult>(`/tools/memo/${encodeURIComponent(id)}`, jsonInit("DELETE", {})),
  // 待办清单 v3（Cordis 框架：Service 服务化 + DAG 依赖 + 周期调度）
  todoV3List: () => request<TodoV3ListResult>("/tools/todo-v3"),
  todoV3Add: (text: string, dependencies?: string[], repeat?: "daily" | "weekly" | "monthly", parentId?: string) =>
    request<TodoV3MutateResult>("/tools/todo-v3", jsonInit("POST", repeat || parentId ? { text, dependencies, repeat, parentId } : { text, dependencies })),
  todoV3Update: (id: string, patch: TodoV3UpdateRequest) =>
    request<TodoV3MutateResult>(`/tools/todo-v3/${encodeURIComponent(id)}`, jsonInit("PUT", patch)),
  todoV3Delete: (id: string) => request<TodoV3MutateResult>(`/tools/todo-v3/${encodeURIComponent(id)}`, jsonInit("DELETE", {})),
  todoV3ClearDone: () => request<TodoV3MutateResult>("/tools/todo-v3/clear-done", jsonInit("POST", {})),
  /** closed todo 归档：归档区 / 手动归档 / 恢复 */
  todoV3ArchiveList: () => request<TodoV3ListResult>("/tools/todo-v3/archive"),
  todoV3Archive: (id: string) => request<TodoV3MutateResult>(`/tools/todo-v3/${encodeURIComponent(id)}/archive`, jsonInit("POST", {})),
  todoV3Restore: (id: string) => request<TodoV3MutateResult>(`/tools/todo-v3/${encodeURIComponent(id)}/restore`, jsonInit("POST", {})),
  // 文档中心（markdown/pdf 管理与浏览）
  docsList: () => request<DocsListResult>("/tools/docs"),
  docsDetail: (id: string) => request<DocDetailResult>(`/tools/docs/${encodeURIComponent(id)}`),
  docsUpload: (files: File[], folderId?: string, tags: string[] = []) => {
    const fd = new FormData();
    if (folderId) fd.append("folderId", folderId);
    for (const t of tags) fd.append("tags", t);
    for (const f of files) fd.append("files", f);
    return request<DocsMutateResult & { created: { name: string; type: string }[]; errors: string[]; tags: { name: string; count: number }[] }>("/tools/docs/upload", {
      method: "POST",
      body: fd,
    });
  },
  docsFolderCreate: (name: string, parentId?: string) =>
    request<DocFolderMutateResult>("/tools/docs/folder", jsonInit("POST", parentId ? { name, parentId } : { name })),
  docsFolderRename: (id: string, name: string) =>
    request<DocFolderMutateResult>(`/tools/docs/folder/${encodeURIComponent(id)}`, jsonInit("PUT", { name })),
  docsRename: (id: string, name: string) =>
    request<DocsMutateResult>(`/tools/docs/${encodeURIComponent(id)}/rename`, jsonInit("PUT", { name })),
  docsFolderMove: (id: string, parentId: string | null) =>
    request<DocFolderMutateResult>(`/tools/docs/folder/${encodeURIComponent(id)}/move`, jsonInit("PUT", { parentId })),
  docsFolderDelete: (id: string) =>
    request<DocsMutateResult & { tags: { name: string; count: number }[] }>(`/tools/docs/folder/${encodeURIComponent(id)}`, jsonInit("DELETE", {})),
  docsUpdate: (id: string, patch: { name?: string; tags?: string[]; folderId?: string | "none"; content?: string }) =>
    request<DocsMutateResult & { tags: { name: string; count: number }[] }>(`/tools/docs/${encodeURIComponent(id)}`, jsonInit("PUT", patch)),
  docsDelete: (id: string) =>
    request<DocsMutateResult & { tags: { name: string; count: number }[] }>(`/tools/docs/${encodeURIComponent(id)}`, jsonInit("DELETE", {})),
  docsRestore: (id: string) =>
    request<DocsMutateResult & { tags: { name: string; count: number }[] }>(`/tools/docs/${encodeURIComponent(id)}/restore`, jsonInit("POST", {})),
  docsPurge: (id: string) =>
    request<DocsMutateResult & { tags: { name: string; count: number }[] }>(`/tools/docs/${encodeURIComponent(id)}/purge`, jsonInit("DELETE", {})),
  docsFolderRestore: (id: string) =>
    request<DocsMutateResult & { tags: { name: string; count: number }[] }>(`/tools/docs/folder/${encodeURIComponent(id)}/restore`, jsonInit("POST", {})),
  docsFolderPurge: (id: string) =>
    request<DocsMutateResult & { tags: { name: string; count: number }[] }>(`/tools/docs/folder/${encodeURIComponent(id)}/purge`, jsonInit("DELETE", {})),
  docsTrash: () => request<DocsTrashResult>("/tools/docs/trash"),
  docsEmptyTrash: () =>
    request<DocsMutateResult & { tags: { name: string; count: number }[] }>("/tools/docs/trash/empty", jsonInit("POST", {})),
  docsZhihuResults: () => request<{ ok: true; results: ZhihuCrawlBrief[] }>("/tools/docs/zhihu-results"),
  docsZhihuImport: (resultIds: string[], folderId?: string, tags: string[] = []) =>
    request<DocsMutateResult & { imported: number; errors: string[]; tags: { name: string; count: number }[] }>("/tools/docs/zhihu-import", jsonInit("POST", { resultIds, folderId, tags })),
  /** DeepSeek Chat Share 导入为 md 文档 */
  docsDeepseekImport: (url: string, folderId?: string, tags: string[] = []) =>
    request<DocsMutateResult & { message?: string; created?: { name: string; type: string }[]; tags: { name: string; count: number }[] }>("/tools/docs/deepseek-import", jsonInit("POST", { url, folderId, tags })),
  /** 导出文档到本地文件（供 VSCode 唤起编辑） */
  docsExportFile: (id: string) =>
    request<{ ok: boolean; path?: string; message?: string }>(`/tools/docs/${encodeURIComponent(id)}/export-file`, jsonInit("POST", {})),
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
  // 实验分组（memo msvwslfq：投资框架 / ec 泡沫预警 / BMPI）
  experimentFramework: (topic: string) => request<AsyncTaskResult<import("@toolbox/shared").ExperimentFrameworkResponse>>("/tools/experiment/framework", jsonInit("POST", { topic })),
  experimentFrameworkTask: (taskId: string) => request<AsyncTaskResult<import("@toolbox/shared").ExperimentFrameworkResponse>>(`/tools/experiment/framework/task/${encodeURIComponent(taskId)}`),
  experimentEc: (force: boolean) => request<AsyncTaskResult<import("@toolbox/shared").ExperimentEcResponse>>("/tools/experiment/ec", jsonInit("POST", { force })),
  experimentEcTask: (taskId: string) => request<AsyncTaskResult<import("@toolbox/shared").ExperimentEcResponse>>(`/tools/experiment/ec/task/${encodeURIComponent(taskId)}`),
  experimentBmpi: (force: boolean) => request<AsyncTaskResult<import("@toolbox/shared").ExperimentBmpiResponse>>("/tools/experiment/bmpi", jsonInit("POST", { force })),
  experimentBmpiTask: (taskId: string) => request<AsyncTaskResult<import("@toolbox/shared").ExperimentBmpiResponse>>(`/tools/experiment/bmpi/task/${encodeURIComponent(taskId)}`),
  // 实验 · 用户补全数据（无 API 字段）
  experimentBmpiSupplement: () => request<{ ok: boolean; supplement: Record<string, unknown> }>("/tools/experiment/bmpi/supplement"),
  experimentBmpiSaveSupplement: (data: Record<string, unknown>) => request<{ ok: boolean; supplement: Record<string, unknown> }>("/tools/experiment/bmpi/supplement", jsonInit("PUT", data)),
  experimentEcSupplement: () => request<{ ok: boolean; supplement: Record<string, unknown> }>("/tools/experiment/ec/supplement"),
  experimentEcSaveSupplement: (data: Record<string, unknown>) => request<{ ok: boolean; supplement: Record<string, unknown> }>("/tools/experiment/ec/supplement", jsonInit("PUT", data)),
  // 实验 · 数据工程（历史/回测/提示词预览）
  experimentBmpiHistory: () => request<{ ok: boolean; history: { asOf: string; indices: Record<string, number | { w1: number; w2: number; w3: number }>; bmpi?: number; status: string; summary: string }[] }>("/tools/experiment/bmpi/history"),
  experimentBmpiBacktest: (force = false) => request<{ ok: boolean; backtest: { from: string; to: string; series: { date: string; bmpi: number | null; s1: number | null; s2: number | null; s3: number | null }[]; generatedAt: string } | null; fromCache?: boolean }>("/tools/experiment/bmpi/backtest", jsonInit("POST", { force })),
  experimentBmpiPrompt: () => request<{ ok: boolean; prompt: string }>("/tools/experiment/bmpi/prompt"),
  experimentEcHistory: () => request<{ ok: boolean; history: { asOf: string; indices: Record<string, number>; status: string; summary: string }[] }>("/tools/experiment/ec/history"),
  experimentEcPrompt: () => request<{ ok: boolean; prompt: string }>("/tools/experiment/ec/prompt"),
  // 知乎爬虫
  zhihuCookie: () => request<{ ok: boolean; configured: boolean }>("/tools/zhihu-crawler/cookie"),
  zhihuSaveCookie: (cookie: string) => request<{ ok: boolean; configured: boolean }>(`/tools/zhihu-crawler/cookie`, jsonInit("PUT", { cookie })),
  zhihuAuth: () => request<{ ok: boolean; taskId: string; status: string }>("/tools/zhihu-crawler/auth", jsonInit("POST", {})),
  zhihuUser: (target: string) => request<import("@toolbox/shared").ZhihuUserInfo>(`/tools/zhihu-crawler/user?target=${encodeURIComponent(target)}`),
  zhihuResolveLink: (input: string) => request<{ ok: boolean; kind?: string; ref?: string; url?: string; title?: string; message?: string }>("/tools/zhihu-crawler/resolve-link", jsonInit("POST", { input })),
  zhihuCrawl: (req: import("@toolbox/shared").ZhihuCrawlRequest) =>
    request<{ ok: boolean; taskId: string; status: string }>("/tools/zhihu-crawler/crawl", jsonInit("POST", req)),
  zhihuResume: (progressId: string) =>
    request<{ ok: boolean; taskId: string; status: string }>("/tools/zhihu-crawler/resume", jsonInit("POST", { progressId })),
  zhihuProgress: (progressId: string) => request<{ ok: boolean; items: number; total: number; updatedAt: number }>(`/tools/zhihu-crawler/progress/${encodeURIComponent(progressId)}`),
  zhihuHistory: () => request<{ ok: boolean; items: import("@toolbox/shared").ZhihuCrawlHistoryEntry[] }>("/tools/zhihu-crawler/history"),
  zhihuHistoryDelete: (id: string) => request<{ ok: boolean }>(`/tools/zhihu-crawler/history/${encodeURIComponent(id)}`, jsonInit("DELETE", {})),
  zhihuResult: (id: string) => request<import("@toolbox/shared").ZhihuCrawlResult>(`/tools/zhihu-crawler/result/${encodeURIComponent(id)}`),
  zhihuInstances: () => request<{ ok: boolean; instances: { instance: string; count: number; updatedAt?: string; type?: string }[] }>("/tools/zhihu-crawler/instances"),
  zhihuImport: (req: import("@toolbox/shared").ZhihuImportRequest) =>
    request<import("@toolbox/shared").ZhihuImportResult>("/tools/zhihu-crawler/import", jsonInit("POST", req)),
  zhihuFavorites: () => request<{ ok: boolean; items: import("@toolbox/shared").ZhihuFavoriteEntry[] }>("/tools/zhihu-crawler/favorites"),
  zhihuFavoriteAdd: (target: string, name?: string) =>
    request<{ ok: boolean; favorites: import("@toolbox/shared").ZhihuFavoriteEntry[] }>("/tools/zhihu-crawler/favorites", jsonInit("PUT", { target, name })),
  zhihuFavoriteDelete: (token: string) => request<{ ok: boolean; favorites: import("@toolbox/shared").ZhihuFavoriteEntry[] }>(`/tools/zhihu-crawler/favorites/${encodeURIComponent(token)}`, jsonInit("DELETE", {})),

  // ---------- 知识库中心（虚拟知识库） ----------
  knowledgeHubOverview: () => request<import("@toolbox/shared").KnowledgeHubOverview>("/tools/knowledge-hub/overview"),
  knowledgeHubCreateVirt: (name: string, domains: string[], desc?: string) =>
    request<{ ok: boolean; virt?: import("@toolbox/shared").VirtualKb; message?: string }>("/tools/knowledge-hub/virt", jsonInit("POST", { name, domains, desc })),
  knowledgeHubUpdateVirt: (name: string, patch: { domains?: string[]; desc?: string }) =>
    request<{ ok: boolean; virt?: import("@toolbox/shared").VirtualKb; message?: string }>(`/tools/knowledge-hub/virt/${encodeURIComponent(name)}`, jsonInit("PUT", patch)),
  knowledgeHubCreateDomain: (name: string, desc?: string, keywords?: string[], generateTemplates?: boolean) =>
    request<{ ok: boolean; domain?: import("@toolbox/shared").KnowledgeDomainMeta; message?: string; warning?: string }>("/tools/knowledge-hub/domain", jsonInit("POST", { name, desc, keywords, generateTemplates: generateTemplates === true })),
  knowledgeHubDeleteVirt: (name: string) => request<{ ok: boolean }>(`/tools/knowledge-hub/virt/${encodeURIComponent(name)}`, jsonInit("DELETE", {})),
  knowledgeHubDeleteDomain: (name: string) => request<{ ok: boolean; message?: string; removedEntries?: number }>(`/tools/knowledge-hub/domain/${encodeURIComponent(name)}`, jsonInit("DELETE", {})),
  knowledgeHubAskVirt: (name: string, question: string) =>
    request<{ ok: boolean; answer?: string; message?: string }>(`/tools/knowledge-hub/virt/${encodeURIComponent(name)}/ask`, jsonInit("POST", { question })),
  knowledgeHubImportVirt: (name: string, url: string) =>
    request<import("@toolbox/shared").KnowledgeImportResult>(`/tools/knowledge-hub/virt/${encodeURIComponent(name)}/import`, jsonInit("POST", { url })),
  knowledgeHubSetDomain: (name: string, meta: { desc?: string; keywords?: string[]; askTemplate?: string; extractTemplate?: string }) =>
    request<{ ok: boolean; domain: import("@toolbox/shared").KnowledgeDomainMeta }>(`/tools/knowledge-hub/domain/${encodeURIComponent(name)}`, jsonInit("PUT", meta)),
  knowledgeHubSeedMedical: (force?: boolean) => request<{ ok: boolean; domain?: import("@toolbox/shared").KnowledgeDomainMeta }>("/tools/knowledge-hub/domain/medical/seed", jsonInit("POST", { force: force === true })),
  knowledgeHubAskDomain: (name: string, question: string) =>
    request<{ ok: boolean; answer?: string; message?: string }>(`/tools/knowledge-hub/domain/${encodeURIComponent(name)}/ask`, jsonInit("POST", { question })),
  knowledgeHubDomainEntries: (name: string, limit = 50, offset = 0) =>
    request<{ ok: true; total: number; entries: import("@toolbox/shared").KnowledgeEntry[]; offset: number; limit: number }>(`/tools/knowledge-hub/domain/${encodeURIComponent(name)}/entries?limit=${limit}&offset=${offset}`),
  knowledgeHubVirtEntries: (name: string, limit = 50, offset = 0) =>
    request<{ ok: true; total: number; entries: import("@toolbox/shared").KnowledgeEntry[]; offset: number; limit: number }>(`/tools/knowledge-hub/virt/${encodeURIComponent(name)}/entries?limit=${limit}&offset=${offset}`),
  knowledgeHubDeleteEntry: (domain: string, key: string) =>
    request<{ ok: boolean; message?: string; deleted?: number }>(`/tools/knowledge-hub/domain/${encodeURIComponent(domain)}/entry/${encodeURIComponent(key)}`, jsonInit("DELETE", {})),
  knowledgeHubImportDomain: (name: string, url: string) =>
    request<import("@toolbox/shared").KnowledgeImportResult>(`/tools/knowledge-hub/domain/${encodeURIComponent(name)}/import`, jsonInit("POST", { url })),
  knowledgeHubImportBatchDomain: (name: string, urls: string[]) =>
    request<{ ok: boolean; items: import("@toolbox/shared").KnowledgeImportRecordItem[]; totalImported: number; message?: string }>(`/tools/knowledge-hub/domain/${encodeURIComponent(name)}/import-batch`, jsonInit("POST", { urls })),
  knowledgeHubImportBatchVirt: (name: string, urls: string[]) =>
    request<{ ok: boolean; items: import("@toolbox/shared").KnowledgeImportRecordItem[]; totalImported: number; distribution?: Record<string, number>; message?: string }>(`/tools/knowledge-hub/virt/${encodeURIComponent(name)}/import-batch`, jsonInit("POST", { urls })),
  knowledgeHubImportHistory: () => request<{ ok: boolean; items: import("@toolbox/shared").KnowledgeImportRecord[] }>("/tools/knowledge-hub/import-history"),
  knowledgeHubClearImportHistory: () => request<{ ok: boolean }>("/tools/knowledge-hub/import-history", jsonInit("DELETE", {})),

  // ---------- 数据工程基础设施（data-infra 运管） ----------
  dataInfraTasks: () => request<{ ok: boolean; tasks: import("@toolbox/shared").DataInfraTaskSummary[] }>("/data-infra/tasks"),
  dataInfraHistory: (id: string) => request<{ ok: boolean; entries: import("@toolbox/shared").DataInfraTaskHistoryEntry[] }>(`/data-infra/tasks/${encodeURIComponent(id)}/history`),
  dataInfraTrigger: (id: string) => request<{ ok: boolean; message?: string }>(`/data-infra/tasks/${encodeURIComponent(id)}/trigger`, jsonInit("POST", {})),
  dataInfraPause: (id: string) => request<{ ok: boolean }>(`/data-infra/tasks/${encodeURIComponent(id)}/pause`, jsonInit("POST", {})),
  dataInfraResume: (id: string) => request<{ ok: boolean }>(`/data-infra/tasks/${encodeURIComponent(id)}/resume`, jsonInit("POST", {})),
  dataInfraDelete: (id: string) => request<{ ok: boolean }>(`/data-infra/tasks/${encodeURIComponent(id)}`, jsonInit("DELETE", {})),
  dataInfraBackfill: (task: string, opts?: { range?: { from?: string; to?: string }; force?: boolean }) =>
    request<{ ok: boolean; message?: string }>("/data-infra/backfill", jsonInit("POST", { task, ...opts })),
  dataInfraQueues: () => request<{ ok: boolean; queues: import("@toolbox/shared").DataInfraQueueStats[] }>("/data-infra/queues"),
  dataInfraQueueMessages: (name: string) => request<{ ok: boolean; messages: any[] }>(`/data-infra/queues/${encodeURIComponent(name)}/messages`),
  dataInfraQueueAudit: (name: string) => request<{ ok: boolean; entries: any[] }>(`/data-infra/queues/${encodeURIComponent(name)}/audit`),
  dataInfraQueueRequeueStale: (name: string) => request<{ ok: boolean; restored: number; message: string }>(`/data-infra/queues/${encodeURIComponent(name)}/requeue-stale`, jsonInit("POST", {})),
  dataInfraOverview: () => request<{ ok: boolean; orphanQueues: string[] }>("/data-infra/overview"),
  dataInfraHealth: () => request<{ ok: boolean; healthy: boolean; problems: string[]; summary: Record<string, number> }>("/data-infra/health"),
  dataInfraDerivators: () => request<{ ok: boolean; derivators: any[] }>("/data-infra/derivators"),
  dataInfraConsumers: () => request<{ ok: boolean; consumers: any[] }>("/data-infra/consumers"),
  dataInfraDerivatorTrigger: (id: string) => request<{ ok: boolean; message: string }>(`/data-infra/derivators/${id}/trigger`, jsonInit("POST", {})),
};
