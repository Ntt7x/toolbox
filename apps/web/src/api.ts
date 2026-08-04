import { API_PREFIX, type HealthResponse, type ToolListResponse } from "@toolbox/shared";

// API 客户端：前端唯一访问后端的入口。
// 后端实现（TS / 未来 Go）替换时，业务代码无需改动。
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`);
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  health: () => get<HealthResponse>("/health"),
  tools: () => get<ToolListResponse>("/tools"),
};
