// ============================================================
// 公共模块：HTTP 代理 fetch（经本机代理访问被墙站点）
// - zlib 等站点本机直连不可达，需经用户本机代理（如 Clash/V2Ray 127.0.0.1:10808）
// - 封装 undici ProxyAgent：无代理配置时退化为全局 fetch（直连）
// - 代理地址可配置（如本地设置数据 books.proxy），调用方传入
// ============================================================

import { ProxyAgent, fetch as undiciFetch, type Dispatcher, type Response as UndiciResponse } from "undici";

const agentCache = new Map<string, Dispatcher>();

/** 创建（并缓存）ProxyAgent；空代理地址返回 undefined（直连） */
function getAgent(proxyUrl?: string): Dispatcher | undefined {
  if (!proxyUrl || !proxyUrl.trim()) return undefined;
  const key = proxyUrl.trim();
  const cached = agentCache.get(key);
  if (cached) return cached;
  const agent = new ProxyAgent(key);
  agentCache.set(key, agent);
  return agent;
}

/** 经代理发起请求（proxyUrl 为空 → 直连）。返回 undici Response */
export function proxyFetch(url: string, init: RequestInit = {}, proxyUrl?: string): Promise<UndiciResponse> {
  const agent = getAgent(proxyUrl);
  return undiciFetch(url, { ...init, ...(agent ? { dispatcher: agent } : {}) } as Parameters<typeof undiciFetch>[1]);
}

/** 经代理 GET 文本 */
export async function proxyGetText(url: string, proxyUrl?: string, timeoutMs = 20000): Promise<string> {
  const res = await proxyFetch(
    url,
    {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" },
      signal: AbortSignal.timeout(timeoutMs),
    },
    proxyUrl,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
