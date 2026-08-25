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
import { registerDataSource, unmarkedKvEntries } from "./dataRegistry.js";
import { deleteTask, listConsumers, listDerivators, listQueues, listTaskHistory, listTasks, orphanQueues, peekQueue, queueAudit, queueStats, requeueStale, runTask, scheduleTask, setTaskStatus, triggerDerivator } from "./data-infra/index.js";
import { clearQueue } from "./data-infra/queue.js";

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
    // 2026-08-14：消息结构权威校验（§6.7）——role 枚举 + content 字符串 + temperature 有限数值
    const badMsg = raw.messages.find(
      (m) => !m || typeof m !== "object" || !["system", "user", "assistant"].includes(String((m as LlmChatMessage).role)) || typeof (m as LlmChatMessage).content !== "string",
    );
    if (badMsg) return c.json({ ok: false, message: "每条消息必须含 role(system/user/assistant) 与字符串 content" }, 400);
    if (raw.temperature !== undefined && (typeof raw.temperature !== "number" || !Number.isFinite(raw.temperature))) {
      return c.json({ ok: false, message: "temperature 必须为有限数值" }, 400);
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

// ============================================================
// 数据工程基础设施运管 HTTP 出口：/api/data-infra/*
// 统一观察数据/消息/任务/调度四层生命周期，提供任务触发/暂停/回溯能力
// ============================================================
export function registerDataInfraRoutes(app: Hono): void {
  // 任务清单（运管：状态/上次/下次执行）
  app.get(`${API_PREFIX}/data-infra/tasks`, (c) => c.json({ ok: true, tasks: listTasks() }));

  // 任务执行历史
  app.get(`${API_PREFIX}/data-infra/tasks/:id/history`, (c) => c.json({ ok: true, entries: listTaskHistory(c.req.param("id")) }));

  // 立即触发（手动）
  app.post(`${API_PREFIX}/data-infra/tasks/:id/trigger`, async (c) => {
    const r = await runTask(c.req.param("id"), { trigger: "manual" });
    return c.json({ ok: r.ok, message: r.message ?? "ok" }, r.ok ? 200 : 400);
  });

  // 暂停 / 恢复（恢复后重新排调度）
  app.post(`${API_PREFIX}/data-infra/tasks/:id/pause`, (c) => c.json({ ok: setTaskStatus(c.req.param("id"), "paused") }));
  app.post(`${API_PREFIX}/data-infra/tasks/:id/resume`, (c) => {
    const ok = setTaskStatus(c.req.param("id"), "queued");
    if (ok) scheduleTask(c.req.param("id"));
    return c.json({ ok });
  });

  // 删除任务（定义 + 状态 + 历史）
  app.delete(`${API_PREFIX}/data-infra/tasks/:id`, (c) => c.json({ ok: deleteTask(c.req.param("id")) }));

  // 数据回溯（backfill）：幂等重跑重建派生数据（handler 必须幂等）
  app.post(`${API_PREFIX}/data-infra/backfill`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { task?: string; range?: { from?: string; to?: string }; force?: boolean } | null;
    if (!raw?.task) return c.json({ ok: false, message: "task 必填" }, 400);
    const r = await runTask(raw.task, { trigger: "backfill", range: raw.range, force: raw.force });
    return c.json({ ok: r.ok, message: r.message ?? "ok" }, r.ok ? 200 : 400);
  });

  // 消息队列统计（积压/处理中/失败）
  app.get(`${API_PREFIX}/data-infra/queues`, (c) => c.json({ ok: true, queues: listQueues().map((q) => queueStats(q)) }));

  // 清空队列（运管/孤儿队列清理）
  app.delete(`${API_PREFIX}/data-infra/queues/:name`, (c) => {
    const name = c.req.param("name");
    if (!name || !name.startsWith("dataInfra:q:")) clearQueue(name);
    return c.json({ ok: true });
  });

  // 查看队列消息（运管诊断；不改变状态）
  app.get(`${API_PREFIX}/data-infra/queues/:name/messages`, (c) => {
    const name = c.req.param("name");
    const limit = Number(c.req.query("limit") ?? 20);
    return c.json({ ok: true, messages: peekQueue(name, Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20) });
  });

  // 队列消费审计（事件日志理念：消息处理可追溯——最近 done/failed 记录）
  app.get(`${API_PREFIX}/data-infra/queues/:name/audit`, (c) => {
    const name = c.req.param("name");
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json({ ok: true, entries: queueAudit(name, Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50) });
  });

  // 恢复处理超时的 processing 消息（消费者崩溃/进程重启兜底）
  app.post(`${API_PREFIX}/data-infra/queues/:name/requeue-stale`, (c) => {
    const name = c.req.param("name");
    const ageMs = Number(c.req.query("ageMs") ?? 5 * 60 * 1000);
    const n = requeueStale(name, Number.isFinite(ageMs) ? ageMs : 5 * 60 * 1000);
    return c.json({ ok: true, restored: n, message: `已恢复 ${n} 条处理超时消息` });
  });

  // 派生器清单（含运行记录）
  app.get(`${API_PREFIX}/data-infra/derivators`, (c) => c.json({ ok: true, derivators: listDerivators() }));

  // 手动触发派生器（运管/测试）
  app.post(`${API_PREFIX}/data-infra/derivators/:id/trigger`, async (c) => {
    const r = await triggerDerivator(c.req.param("id"));
    return c.json({ ok: r.ok, message: r.message }, r.ok ? 200 : 400);
  });

  // 消费者清单（含运行状态/最近错误）
  app.get(`${API_PREFIX}/data-infra/consumers`, (c) => c.json({ ok: true, consumers: listConsumers() }));

  // 全景（运管页一次拉全）：任务 + 派生器 + 消费者 + 队列积压 + 孤儿队列
  app.get(`${API_PREFIX}/data-infra/overview`, (c) =>
    c.json({
      ok: true,
      tasks: listTasks(),
      derivators: listDerivators().map((d) => ({ id: d.id, queue: d.queue, when: d.when, runs: d.runs.slice(-5) })),
      consumers: listConsumers(),
      queues: listQueues().map((q) => queueStats(q)),
      orphanQueues: orphanQueues(),
    }),
  );

  // 健康检查（一键体检）：任务失败/队列积压/孤儿队列/消费者未运行/派生失败/未标记 KV
  app.get(`${API_PREFIX}/data-infra/health`, (c) => {
    const tasks = listTasks();
    const queues = listQueues().map((q) => queueStats(q));
    const consumers = listConsumers();
    const derivators = listDerivators();
    const problems: string[] = [];
    const failedTasks = tasks.filter((t) => t.status === "failed");
    const pausedTasks = tasks.filter((t) => t.status === "paused");
    if (failedTasks.length) problems.push(`${failedTasks.length} 个任务失败：${failedTasks.map((t) => t.id).join("、")}`);
    const backlog = queues.filter((q) => q.pending > 0);
    if (backlog.length) problems.push(`${backlog.length} 个队列积压：${backlog.map((q) => `${q.name}(${q.pending})`).join("、")}`);
    const orphan = orphanQueues();
    if (orphan.length) problems.push(`孤儿队列（有消息无消费者）：${orphan.join("、")}`);
    const notRunning = consumers.filter((c) => !c.running);
    if (notRunning.length) problems.push(`${notRunning.length} 个消费者未运行：${notRunning.map((c) => c.queue).join("、")}`);
    const derivFailed = derivators.filter((d) => d.runs.some((r) => !r.ok));
    if (derivFailed.length) problems.push(`${derivFailed.length} 个派生器有失败记录：${derivFailed.map((d) => d.id).join("、")}`);
    const unmarked = unmarkedKvEntries().length;
    if (unmarked > 0) problems.push(`${unmarked} 条未标记 KV（数据源治理缺失）`);
    return c.json({
      ok: true,
      healthy: problems.length === 0,
      problems,
      summary: {
        tasks: tasks.length,
        failedTasks: failedTasks.length,
        pausedTasks: pausedTasks.length,
        queues: queues.length,
        backlog: backlog.length,
        orphanQueues: orphan.length,
        consumers: consumers.length,
        notRunning: notRunning.length,
        derivators: derivators.length,
        derivFailed: derivFailed.length,
        unmarkedKv: unmarked,
      },
    });
  });
}
