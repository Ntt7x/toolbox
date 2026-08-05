// ============================================================
// 公共 LLM 能力模块（DeepSeek）
// - chat：Chat Completions API（OpenAI 兼容），支持 JSON 输出
// - chat + search：Responses API + 内置 web_search 工具（服务端执行联网搜索）
// - testConnection：最小请求验证 key 有效性
// ============================================================

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmChatMessage, LlmChatResult, LlmTestResult } from "@toolbox/shared";
import { deleteSetting, getSetting, setSetting } from "./settingsStore.js";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const RESPONSES_URL = "https://api.deepseek.com/responses";
export const DEFAULT_MODEL = "deepseek-chat";
/** 联网搜索仅 deepseek-v4-flash 支持 */
export const SEARCH_MODEL = "deepseek-v4-flash";
const KEY_VAR = "DEEPSEEK_API_KEY";

// ---------- API key 存储（本地设置数据公共模块） ----------

/** 设置项 key（本地设置数据 / settings:llm.apiKey） */
const LLM_KEY_SETTING = "llm.apiKey";

/**
 * 读取已配置的 API key（未配置返回 null）。
 * 存储：本地设置数据（settingsStore）。兼容迁移：若设置库为空但旧 .env
 * 仍有 DEEPSEEK_API_KEY，则一次性迁入设置库并清理 .env。
 */
export function loadApiKey(): string | null {
  const fromSettings = getSetting<string>(LLM_KEY_SETTING)?.trim();
  if (fromSettings) return fromSettings;

  // 旧 .env 一次性迁移
  const legacy = readLegacyEnvKey();
  if (legacy) {
    setSetting(LLM_KEY_SETTING, legacy);
    removeLegacyEnvKey();
    return legacy;
  }
  return null;
}

/** 保存 API key（写入本地设置数据；清理旧 .env） */
export function saveApiKey(key: string): void {
  setSetting(LLM_KEY_SETTING, key.trim());
  removeLegacyEnvKey();
}

/** 清除 API key（设置库 + 旧 .env） */
export function clearApiKey(): void {
  deleteSetting(LLM_KEY_SETTING);
  removeLegacyEnvKey();
}

// ---------- 旧 .env 兼容（仅一次性迁移用） ----------

const envPath = (): string => join(process.cwd(), ".env");

function readEnvFile(): string {
  const p = envPath();
  if (!existsSync(p)) return "";
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function writeEnvFile(content: string): void {
  writeFileSync(envPath(), content, "utf8");
}

function readLegacyEnvKey(): string | null {
  const content = readEnvFile();
  const m = content.match(/^DEEPSEEK_API_KEY=(.*)$/m);
  const key = m ? m[1].trim() : "";
  return key.length > 0 ? key : null;
}

function removeLegacyEnvKey(): void {
  const content = readEnvFile();
  if (!content.includes(KEY_VAR)) return;
  writeEnvFile(content.replace(new RegExp(`^${KEY_VAR}=.*\\n?`, "m"), ""));
}

// ---------- DeepSeek 调用 ----------

interface ChatOptions {
  model?: string;
  temperature?: number;
  /** 要求 JSON 对象输出（response_format: json_object） */
  json?: boolean;
  /** 启用联网搜索（Responses API + 内置 web_search 工具，服务端执行） */
  search?: boolean;
  /** 外部取消信号（任务取消/超时中断 LLM 请求） */
  signal?: AbortSignal;
  /** 用量归属模块（如 cb-rate / watchlist.fundamental），用于用量监控 */
  module?: string;
}

/** 组合外部信号与内置超时（AbortSignal.any：任一触发即中断） */
function buildSignal(opts: ChatOptions, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
}

interface DeepSeekResponse {
  choices?: { message?: { content?: string } }[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

/** 通用对话（非流式）。search=true 时走 Responses API + 联网搜索 */
export async function chat(
  messages: LlmChatMessage[],
  opts: ChatOptions = {},
): Promise<LlmChatResult> {
  const result = opts.search ? await chatSearch(messages, opts) : await chatCompletion(messages, opts);
  // 用量监控：成功且有 usage 时记录（模块归属）
  if (result.ok && result.usage) {
    recordLlmUsage(opts.module ?? "unknown", result.model, result.usage);
  }
  return result;
}

/** Chat Completions 实现（无搜索） */
async function chatCompletion(messages: LlmChatMessage[], opts: ChatOptions): Promise<LlmChatResult> {
  const apiKey = loadApiKey();
  if (!apiKey) {
    return { ok: false, message: "未配置 DeepSeek API key，请先在「LLM 设置」中配置" };
  }
  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model ?? DEFAULT_MODEL,
        messages,
        temperature: opts.temperature,
        stream: false,
        ...(opts.json ? { response_format: { type: "json_object" as const } } : {}),
      }),
      signal: buildSignal(opts, 120_000),
    });
    const data = (await res.json().catch(() => null)) as DeepSeekResponse | null;
    if (!res.ok) {
      const msg = data?.error?.message ?? `DeepSeek API HTTP ${res.status}`;
      return { ok: false, message: msg };
    }
    return {
      ok: true,
      content: data?.choices?.[0]?.message?.content ?? "",
      model: data?.model ?? opts.model ?? DEFAULT_MODEL,
      ...(data?.usage
        ? {
            usage: {
              promptTokens: data.usage.prompt_tokens ?? 0,
              completionTokens: data.usage.completion_tokens ?? 0,
              totalTokens: data.usage.total_tokens ?? 0,
            },
          }
        : {}),
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Responses API 实现（联网搜索，服务端执行 web_search 工具） */
async function chatSearch(messages: LlmChatMessage[], opts: ChatOptions): Promise<LlmChatResult> {
  const apiKey = loadApiKey();
  if (!apiKey) {
    return { ok: false, message: "未配置 DeepSeek API key，请先在「LLM 设置」中配置" };
  }
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n").trim();
  const input = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ type: "message" as const, role: m.role, content: m.content }));
  if (input.length === 0) {
    return { ok: false, message: "缺少用户消息" };
  }
  try {
    const res = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: SEARCH_MODEL,
        ...(system ? { instructions: system } : {}),
        input,
        tools: [{ type: "web_search" }],
        tool_choice: { type: "web_search" },
        reasoning: { effort: "low" },
        ...(opts.json ? { text: { format: { type: "json_object" as const } } } : {}),
        stream: false,
      }),
      signal: buildSignal(opts, 180_000),
    });
    const data = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      model?: string;
      output?: {
        type?: string;
        content?: { type?: string; text?: string }[];
        action?: { queries?: unknown };
      }[];
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    } | null;
    if (!res.ok) {
      const msg = data?.error?.message ?? `DeepSeek API HTTP ${res.status}`;
      return { ok: false, message: msg };
    }
    // 拼接 message 文本 + 提取 web_search_call 查询词
    let content = "";
    const searchQueries: string[] = [];
    for (const o of data?.output ?? []) {
      if (o.type === "message") {
        for (const part of o.content ?? []) {
          if (part.type === "output_text" && part.text) content += part.text;
        }
      } else if (o.type === "web_search_call") {
        const qs = Array.isArray(o.action?.queries) ? o.action.queries : [];
        for (const q of qs) {
          // 过滤内部标识（形如 ws_call_id=call_00_xxx）
          if (typeof q === "string" && !q.startsWith("ws_call_id=")) searchQueries.push(q);
        }
      }
    }
    return {
      ok: true,
      content,
      model: data?.model ?? SEARCH_MODEL,
      ...(data?.usage
        ? {
            usage: {
              promptTokens: data.usage.input_tokens ?? 0,
              completionTokens: data.usage.output_tokens ?? 0,
              totalTokens: data.usage.total_tokens ?? 0,
            },
          }
        : {}),
      ...(searchQueries.length > 0 ? { searchQueries } : {}),
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** 测试连接：发送最小请求验证 key 有效性 */
export async function testConnection(): Promise<LlmTestResult> {
  const apiKey = loadApiKey();
  if (!apiKey) {
    return { ok: false, message: "未配置 DeepSeek API key" };
  }
  const start = Date.now();
  const r = await chat([{ role: "user", content: "ping" }], { model: DEFAULT_MODEL, module: "llm.test" });
  const latencyMs = Date.now() - start;
  if (!r.ok) {
    return { ok: false, message: r.message };
  }
  return {
    ok: true,
    message: `连接成功（模型 ${r.model}）：「${r.content.slice(0, 60)}${r.content.length > 60 ? "…" : ""}」`,
    latencyMs,
    model: r.model,
  };
}

// ============================================================
// LLM 用量监控（切面记录）：每次 chat 成功记录到 KV，可按模块/按天聚合
// ============================================================

import { kvGet, kvSet } from "./kvStore.js";
import type { LlmUsageSummary } from "@toolbox/shared";

/** 用量日志 KV key（本地数据管理可见） */
export const LLM_USAGE_KEY = "llmUsage:log";

/** 日志上限（超出截断最旧） */
const USAGE_MAX = 2000;

interface UsageEntry {
  ts: string;
  module: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

function readUsageEntries(): UsageEntry[] {
  const saved = kvGet<{ entries?: unknown[] }>(LLM_USAGE_KEY);
  if (!Array.isArray(saved?.entries)) return [];
  return saved.entries
    .filter((e): e is UsageEntry => !!e && typeof (e as UsageEntry).ts === "string")
    .slice();
}

/** 记录一次 LLM 用量（失败不影响主流程） */
function recordLlmUsage(module: string, model: string, usage: { promptTokens?: number; completionTokens?: number }): void {
  try {
    const entries = readUsageEntries();
    entries.push({
      ts: new Date().toISOString(),
      module: module || "unknown",
      model: model || "unknown",
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
    });
    if (entries.length > USAGE_MAX) entries.splice(0, entries.length - USAGE_MAX);
    kvSet(LLM_USAGE_KEY, { entries });
  } catch {
    // 记录失败静默
  }
}

/** 用量汇总（总数 + 按模块 + 按天） */
export function getLlmUsageSummary(): LlmUsageSummary {
  const entries = readUsageEntries();
  const total = { calls: entries.length, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const byModule = new Map<string, { calls: number; totalTokens: number }>();
  const byDay = new Map<string, { calls: number; totalTokens: number }>();
  for (const e of entries) {
    total.promptTokens += e.promptTokens;
    total.completionTokens += e.completionTokens;
    total.totalTokens += e.promptTokens + e.completionTokens;
    const m = byModule.get(e.module) ?? { calls: 0, totalTokens: 0 };
    m.calls++;
    m.totalTokens += e.promptTokens + e.completionTokens;
    byModule.set(e.module, m);
    const day = e.ts.slice(0, 10);
    const d = byDay.get(day) ?? { calls: 0, totalTokens: 0 };
    d.calls++;
    d.totalTokens += e.promptTokens + e.completionTokens;
    byDay.set(day, d);
  }
  const sortDesc = (a: { totalTokens: number }, b: { totalTokens: number }) => b.totalTokens - a.totalTokens;
  return {
    ok: true,
    total,
    byModule: [...byModule.entries()].map(([module, v]) => ({ module, ...v })).sort(sortDesc),
    byDay: [...byDay.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => (a.day < b.day ? 1 : -1)),
  };
}

/** 查询 DeepSeek 平台余额（用户 API key 即授权；失败返回错误信息） */
export async function getDeepSeekBalance(): Promise<{ ok: boolean; balance?: { currency: string; totalBalance: string; grantedBalance: string; toppedUpBalance: string }[]; isAvailable?: boolean; message?: string }> {
  const apiKey = loadApiKey();
  if (!apiKey) return { ok: false, message: "未配置 DeepSeek API key，请先在「LLM 设置」中配置" };
  try {
    const res = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    const data = (await res.json().catch(() => null)) as { balance_infos?: { currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }[]; is_available?: boolean; error?: { message?: string } } | null;
    if (!res.ok || !data) return { ok: false, message: data?.error?.message ?? `DeepSeek API HTTP ${res.status}` };
    return {
      ok: true,
      balance: (data.balance_infos ?? []).map((b) => ({
        currency: b.currency ?? "",
        totalBalance: b.total_balance ?? "0",
        grantedBalance: b.granted_balance ?? "0",
        toppedUpBalance: b.topped_up_balance ?? "0",
      })),
      isAvailable: data.is_available,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
