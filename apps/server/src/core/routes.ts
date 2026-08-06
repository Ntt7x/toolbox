// ============================================================
// 下层公共模块的 HTTP 出口：/api/llm/*
// 将 core/llm 能力暴露为 REST（LLM 设置页 / 前端对话验证使用）
// ============================================================

import { Hono } from "hono";
import {
  API_PREFIX,
  type LlmChatMessage,
  type LlmChatRequest,
  type LlmSettingsRequest,
  type LlmStatusResponse,
  type PromptDetailResult,
  type PromptsListResult,
} from "@toolbox/shared";
import { DEFAULT_MODEL, chat, clearApiKey, getDeepSeekBalance, getLlmUsageSummary, loadApiKey, saveApiKey, testConnection } from "./llm.js";
import { getPromptDetail, listPrompts, resetPrompt, updatePrompt } from "./prompts.js";
import { generateDependencyGraph } from "./dependencyGraph.js";
import { getQuoteSnapshot } from "./quote.js";
import { registerDataSource } from "./dataRegistry.js";

// 注册数据源：LLM 用量日志（本地数据管理可见）
registerDataSource({
  kind: "kv",
  name: "llmUsage:",
  page: "LLM 设置",
  tag: "运行状态",
  description: "LLM 用量日志（切面记录，按模块/按天聚合）",
});

export function registerLlmRoutes(app: Hono): void {
  app.get(`${API_PREFIX}/llm/status`, (c) => {
    const key = loadApiKey();
    const body: LlmStatusResponse = {
      ok: true,
      configured: key !== null,
      ...(key ? { model: DEFAULT_MODEL } : {}),
    };
    return c.json(body);
  });

  app.post(`${API_PREFIX}/llm/settings`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Partial<LlmSettingsRequest> | null;
    const apiKey = raw?.apiKey;
    if (typeof apiKey !== "string") {
      return c.json({ ok: false, message: "apiKey 必须是字符串（传空字符串表示清除）" }, 400);
    }
    if (apiKey.trim() === "") {
      clearApiKey();
    } else {
      saveApiKey(apiKey.trim());
    }
    return c.json({ ok: true, configured: apiKey.trim() !== "" });
  });

  app.post(`${API_PREFIX}/llm/test`, async (c) => {
    const result = await testConnection();
    return c.json(result, result.ok ? 200 : 400);
  });

  app.post(`${API_PREFIX}/llm/chat`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Partial<LlmChatRequest> | null;
    if (!raw || !Array.isArray(raw.messages) || raw.messages.length === 0) {
      return c.json({ ok: false, message: "messages 不能为空" }, 400);
    }
    const result = await chat(raw.messages as LlmChatMessage[], {
      model: raw.model,
      temperature: raw.temperature,
      module: "llm.chat",
      ...(raw.search ? { search: true } : {}),
    });
    return c.json(result, result.ok ? 200 : 400);
  });
}

/** 行情快照路由（公共能力：A/H 实时报价，多源 failover + 缓存） */
export function registerQuoteRoutes(app: Hono): void {
  app.get(`${API_PREFIX}/quote`, async (c) => {
    const code = c.req.query("code")?.trim() ?? "";
    if (!code) return c.json({ ok: false, code, message: "缺少 code 参数" }, 400);
    const force = c.req.query("force") === "1";
    const result = await getQuoteSnapshot(code, { force });
    return c.json(result, result.ok ? 200 : 400);
  });
}

/** LLM 用量监控路由（服务端切面记录聚合 + DeepSeek 平台余额） */
export function registerLlmUsageRoutes(app: Hono): void {
  // 用量汇总（总数 + 按模块 + 按天）
  app.get(`${API_PREFIX}/llm/usage`, (c) => {
    return c.json(getLlmUsageSummary());
  });
  // DeepSeek 平台余额（用户 API key 即授权）
  app.get(`${API_PREFIX}/llm/balance`, async (c) => {
    return c.json(await getDeepSeekBalance());
  });
}

/** 提示词管理路由（统一存储于「本地设置数据」settings:prompt.*） */
export function registerPromptRoutes(app: Hono): void {
  // 列表（含全部提示词模板）
  app.get(`${API_PREFIX}/prompts`, (c) => {
    const body: PromptsListResult = { ok: true, prompts: listPrompts() };
    return c.json(body);
  });

  // 依赖图（架构展示：扫描源码 import 自动生成）
  app.get(`${API_PREFIX}/dependency-graph`, (c) => {
    return c.json(generateDependencyGraph());
  });

  // 详情（模板 + 默认参数渲染预览，页面展示用）
  app.get(`${API_PREFIX}/prompts/:id`, (c) => {
    const detail = getPromptDetail(c.req.param("id"));
    if (!detail) return c.json({ ok: false, message: "未知提示词 id" }, 404);
    const body: PromptDetailResult = { ok: true, ...detail };
    return c.json(body);
  });

  // 更新模板
  app.put(`${API_PREFIX}/prompts/:id`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { template?: unknown } | null;
    const template = raw?.template;
    if (typeof template !== "string" || template.trim() === "") {
      return c.json({ ok: false, message: "template 必须是非空字符串" }, 400);
    }
    if (!updatePrompt(c.req.param("id"), template)) {
      return c.json({ ok: false, message: "未知提示词 id" }, 404);
    }
    return c.json({ ok: true, id: c.req.param("id") });
  });

  // 恢复默认
  app.post(`${API_PREFIX}/prompts/:id/reset`, (c) => {
    if (!resetPrompt(c.req.param("id"))) {
      return c.json({ ok: false, message: "未知提示词 id" }, 404);
    }
    return c.json({ ok: true, id: c.req.param("id") });
  });
}
