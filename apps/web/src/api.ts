import {
  API_PREFIX,
  type GridPlanRequest,
  type GridPlanResult,
  type HealthResponse,
  type ToolListResponse,
} from "@toolbox/shared";

// API 客户端：前端唯一访问后端的入口。
// 后端实现（TS / 未来 Go）替换时，业务代码无需改动。
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`);
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
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
};
