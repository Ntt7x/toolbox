// ============================================================
// 业务模块：Agent 会话管理（设置 → Agent 会话管理）
// 管理两类有状态 LLM 会话：
//   模式 2 自研 Cache 会话（core/chatSession）——可看历史/续问/恢复归档
//   模式 3 Reasonix 会话（core/reasonix）——可续问/关闭
// 依赖下层公共模块：core/chatSession、core/reasonix、core/tasks
// ============================================================
import { Hono } from "hono";
import { API_PREFIX, type AgentSessionAskResult, type AgentSessionCreateResult, type AgentSessionCreateRequest, type AgentSessionsResult, type ChatSessionDetail, type ToolMeta } from "@toolbox/shared";
import { createChatSession, chatSessionAsk, listChatSessions, deleteChatSession, getChatSessionDetail, restoreArchivedSession } from "../../core/chatSession.js";
import { createReasonixSession, reasonixAsk, closeReasonixSession, listReasonixSessions } from "../../core/reasonix.js";
import { createTask } from "../../core/tasks.js";

export const meta: ToolMeta = {
  id: "agent-sessions",
  name: "Agent 会话管理",
  description: "管理两类有状态 LLM 会话（自研 Cache 会话 / Reasonix 会话）：查看、续问、恢复、删除",
  path: "/settings/agent-sessions",
};

export function register(app: Hono): void {
  // 列表：GET /api/llm/agent-sessions
  app.get(`${API_PREFIX}/llm/agent-sessions`, (c) => {
    const body: AgentSessionsResult = {
      ok: true,
      chat: listChatSessions().map((s) => ({
        id: s.id,
        module: s.module,
        status: s.status,
        createdAt: s.createdAt,
        lastAt: s.lastAt,
        turns: s.turns,
      })),
      reasonix: listReasonixSessions().map((s) => ({
        id: s.id,
        module: s.module,
        status: s.status,
        createdAt: s.createdAt,
        lastAt: s.lastAt,
        turns: 0,
        cwd: s.cwd,
      })),
    };
    return c.json(body);
  });

  // 新建 chatSession：POST /api/llm/agent-sessions/chat { module, system, search?, json?, temperature? }
  app.post(`${API_PREFIX}/llm/agent-sessions/chat`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Partial<AgentSessionCreateRequest> | null;
    if (!raw) return c.json({ ok: false, message: "缺少请求体" } as AgentSessionCreateResult, 400);
    const module = raw?.module?.trim() ?? "";
    const system = raw?.system?.trim() ?? "";
    if (!module || !system) {
      const body: AgentSessionCreateResult = { ok: false, message: "缺少 module 或 system" };
      return c.json(body, 400);
    }
    const s = createChatSession({
      module,
      system,
      ...(raw.search !== undefined ? { search: raw.search } : {}),
      ...(raw.json !== undefined ? { json: raw.json } : {}),
      ...(raw.temperature !== undefined ? { temperature: raw.temperature } : {}),
    });
    const body: AgentSessionCreateResult = { ok: true, id: s.id };
    return c.json(body, 201);
  });

  // 新建 reasonix 会话：POST /api/llm/agent-sessions/reasonix { module, cwd? }
  app.post(`${API_PREFIX}/llm/agent-sessions/reasonix`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Partial<AgentSessionCreateRequest> | null;
    if (!raw) return c.json({ ok: false, message: "缺少请求体" } as AgentSessionCreateResult, 400);
    const module = raw?.module?.trim() ?? "";
    if (!module) {
      const body: AgentSessionCreateResult = { ok: false, message: "缺少 module" };
      return c.json(body, 400);
    }
    const s = await createReasonixSession({ module, ...(raw.cwd ? { cwd: raw.cwd } : {}) });
    const body: AgentSessionCreateResult = s;
    return c.json(body, s.ok ? 201 : 400);
  });

  // chatSession 详情：GET /api/llm/agent-sessions/chat/:id
  app.get(`${API_PREFIX}/llm/agent-sessions/chat/:id`, (c) => {
    const d = getChatSessionDetail(c.req.param("id"));
    if (!d) {
      const body: ChatSessionDetail = { ok: false, message: "会话不存在或已过期" };
      return c.json(body, 404);
    }
    const body: ChatSessionDetail = {
      ok: true,
      id: d.id,
      module: d.module,
      system: d.system,
      history: d.history,
      turns: d.turns,
      droppedTurns: d.droppedTurns,
      archived: !!d.archived,
      summary: d.summary,
      createdAt: d.createdAt,
      lastAt: d.lastAt,
    };
    return c.json(body);
  });

  // 恢复归档：POST /api/llm/agent-sessions/chat/:id/restore
  app.post(`${API_PREFIX}/llm/agent-sessions/chat/:id/restore`, (c) => {
    const s = restoreArchivedSession(c.req.param("id"));
    return c.json({ ok: !!s, message: s ? "已恢复（摘要注入上下文，重新进入活跃期）" : "会话不存在" });
  });

  // 续问：POST /api/llm/agent-sessions/chat/:id/ask { message } —— 后台任务
  app.post(`${API_PREFIX}/llm/agent-sessions/chat/:id/ask`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof raw?.message === "string" ? raw.message.trim() : "";
    if (!message) return c.json({ ok: false, message: "缺少 message" }, 400);
    const id = c.req.param("id");
    const { taskId } = createTask<AgentSessionAskResult>(async (signal) => {
      const r = await chatSessionAsk(id, message, { signal });
      if (!r.ok) return { ok: false, message: r.message };
      return { ok: true, content: r.content, usage: r.usage };
    }, { timeoutMs: 5 * 60 * 1000, module: "agent-session.chat", name: `会话续问 · ${message.slice(0, 24)}` });
    return c.json({ ok: true, taskId, status: "running" }, 202);
  });

  // 删除 chatSession：DELETE /api/llm/agent-sessions/chat/:id
  app.delete(`${API_PREFIX}/llm/agent-sessions/chat/:id`, (c) => {
    const ok = deleteChatSession(c.req.param("id"));
    return c.json({ ok, message: ok ? "已删除" : "会话不存在" }, ok ? 200 : 404);
  });

  // Reasonix 续问：POST /api/llm/agent-sessions/reasonix/:id/ask { text } —— 后台任务
  app.post(`${API_PREFIX}/llm/agent-sessions/reasonix/:id/ask`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof raw?.text === "string" ? raw.text.trim() : "";
    if (!text) return c.json({ ok: false, message: "缺少 text" }, 400);
    const id = c.req.param("id");
    const { taskId } = createTask<AgentSessionAskResult>(async () => {
      const r = await reasonixAsk(id, text);
      if (!r.ok) return { ok: false, message: r.message };
      return { ok: true, content: r.content, usage: r.usage as AgentSessionAskResult["usage"] };
    }, { timeoutMs: 8 * 60 * 1000, module: "agent-session.reasonix", name: `Reasonix 续问 · ${text.slice(0, 24)}` });
    return c.json({ ok: true, taskId, status: "running" }, 202);
  });

  // 关闭 reasonix 会话：DELETE /api/llm/agent-sessions/reasonix/:id
  app.delete(`${API_PREFIX}/llm/agent-sessions/reasonix/:id`, async (c) => {
    await closeReasonixSession(c.req.param("id"));
    return c.json({ ok: true, message: "已关闭并删除注册表" });
  });
}
