// ============================================================
// 实验·页面1：通用投资框架（framework）
// 输入投资主题 → LLM 联网搜索 → 4 层分析（哲学/战略/战术/批判）+ e-梯队仓位表
// 复用：core/llm（chatSearch）、core/prompts（experiment.framework 模板）、core/tasks（长分析）
// ============================================================
import { Hono } from "hono";
import { API_PREFIX, type AsyncTaskResult, type ExperimentFrameworkRequest, type ExperimentFrameworkResponse } from "@toolbox/shared";
import { createTask, getTask } from "../../core/tasks.js";
import { getPromptTemplate } from "../../core/prompts.js";
import { chat } from "../../core/llm.js";

function today(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

async function runFramework(topic: string, signal: AbortSignal): Promise<ExperimentFrameworkResponse> {
  const template = getPromptTemplate("experiment.framework");
  const prompt = template.replace(/\{topic\}/g, topic.trim()).replace(/\{date\}/g, today());
  const r = await chat([{ role: "user", content: prompt }], { search: true, json: false, signal, module: "experiment.framework" });
  if (!r.ok) throw new Error(r.message);
  return {
    ok: true,
    topic: topic.trim(),
    report: r.content,
    asOf: today(),
    model: r.model,
  };
}

function taskName(topic: string): string {
  return `${today()} · 投资框架「${topic.slice(0, 20)}」`;
}

export function registerExperimentFramework(app: Hono): void {
  app.post(`${API_PREFIX}/tools/experiment/framework`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Partial<ExperimentFrameworkRequest> | null;
    const topic = raw?.topic?.trim();
    if (!topic) return c.json({ ok: false, message: "topic（投资主题）不能为空" }, 400);
    if (topic.length > 200) return c.json({ ok: false, message: "主题过长（≤200 字）" }, 400);
    const created = createTask((signal) => runFramework(topic, signal), { timeoutMs: 10 * 60 * 1000, name: taskName(topic) });
    return c.json({ ok: true, taskId: created.taskId } as AsyncTaskResult<unknown>);
  });

  app.get(`${API_PREFIX}/tools/experiment/framework/task/:taskId`, (c) => {
    const task = getTask<ExperimentFrameworkResponse>(c.req.param("taskId"));
    if (!task) return c.json({ ok: false, message: "任务不存在或已过期" }, 404);
    return c.json(task, 200);
  });
}
