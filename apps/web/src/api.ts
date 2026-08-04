import {
  API_PREFIX,
  type CbRateRequest,
  type CbRateResult,
  type GridPlanRequest,
  type GridPlanResult,
  type HealthResponse,
  type LlmChatRequest,
  type LlmChatResult,
  type LlmSettingsRequest,
  type LlmStatusResponse,
  type LlmTestResult,
  type QuoteResult,
  type ShareExtractResult,
  type ToolListResponse,
} from "@toolbox/shared";

// API 客户端：前端唯一访问后端的入口。
// 后端实现（TS / 未来 Go）替换时，业务代码无需改动。
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `API ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as T | null;
  if (!res.ok || data === null) throw new Error(`API ${path} failed: ${res.status}`);
  return data;
}

export const api = {
  health: () => get<HealthResponse>("/health"),
  tools: () => get<ToolListResponse>("/tools"),
  gridPlan: (req: GridPlanRequest) => post<GridPlanResult>("/tools/grid-plan", req),
  quote: (code: string) => get<QuoteResult>(`/tools/grid-plan/quote?code=${encodeURIComponent(code)}`),
  // DeepSeek 分享提取
  shareExtract: (url: string) => post<ShareExtractResult>("/tools/deepseek-share", { url }),
  // 央行利率分析
  cbRate: (req: CbRateRequest) => post<CbRateResult>("/tools/cb-rate", req),
  // LLM 能力（DeepSeek）
  llmStatus: () => get<LlmStatusResponse>("/llm/status"),
  llmSettings: (req: LlmSettingsRequest) => post<{ ok: true; configured: boolean }>("/llm/settings", req),
  llmTest: () => post<LlmTestResult>("/llm/test", {}),
  llmChat: (req: LlmChatRequest) => post<LlmChatResult>("/llm/chat", req),
};
