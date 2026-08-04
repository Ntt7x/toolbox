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
} from "@toolbox/shared";
import { DEFAULT_MODEL, chat, clearApiKey, loadApiKey, saveApiKey, testConnection } from "./llm.js";

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
      ...(raw.search ? { search: true } : {}),
    });
    return c.json(result, result.ok ? 200 : 400);
  });
}
