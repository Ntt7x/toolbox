// ============================================================
// 实验·页面2：化债牛市进度指数（BMPI v4.0）
// ①LLM 联网采集（国债收益率/逆回购/成分股/宏观）→ ②R/SL 服务端公式固化 + S1/S2/S3 LLM 打分
//         → ③BMPI 合成服务端计算 → LLM 综合研判 → 缓存 7 天（force 绕过）
// ============================================================
import { Hono } from "hono";
import { API_PREFIX, type AsyncTaskResult, type ExperimentBmpiRequest, type ExperimentBmpiResponse } from "@toolbox/shared";
import { createTask, getTask } from "../../core/tasks.js";
import { getPromptTemplate } from "../../core/prompts.js";
import { chat } from "../../core/llm.js";
import { robustJsonParse } from "../../core/jsonParse.js";
import { kvGet, kvSet } from "../../core/kvStore.js";
import { registerDataSource } from "../../core/dataRegistry.js";
import { bmpiR, bmpiSL, bmpiComposite, bmpiStatus } from "./indicators.js";

registerDataSource({
  kind: "kv",
  name: "experiment:bmpi:",
  page: "实验·BMPI 化债牛市",
  tag: "分析缓存",
  description: "BMPI 化债牛市进度指数结果缓存（Key-结构化 Value，TTL 7 天）",
});

const CACHE_KEY = "experiment:bmpi:v1";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function today(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

/** ① 数据采集：LLM 联网搜索（国债/逆回购/成分股股价/PB/宏观指标） */
async function collectData(signal: AbortSignal): Promise<Record<string, any>> {
  const prompt = getPromptTemplate("experiment.bmpi.collect").replace(/\{date\}/g, today());
  const r = await chat([{ role: "user", content: prompt }], { search: true, json: true, signal, module: "experiment.bmpi.collect" });
  if (!r.ok) throw new Error(r.message);
  const parsed = robustJsonParse(r.content);
  if (!parsed || typeof parsed !== "object") throw new Error("数据采集输出无法解析为结构化数据");
  return parsed as Record<string, any>;
}

/** ②③ 打分 + 综合研判（LLM），R/SL/BMPI 合成服务端固化 */
async function analyze(parsed: Record<string, any>, signal: AbortSignal): Promise<ExperimentBmpiResponse> {
  const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);

  // R / SL 服务端固化（需 10Y 收益率 + 周度净投放）
  const r = bmpiR(num(parsed.y10) ?? num(parsed.cn10y));
  const sl = bmpiSL(num(parsed.netInjectionYi) ?? num(parsed.netInjection));

  // LLM 综合研判：S1/S2/S3 打分 + 研判（数据已采集，search=false 省成本）
  const tpl = getPromptTemplate("experiment.bmpi");
  const prompt = tpl
    .replace(/\{date\}/g, today())
    .replace(/\{data\}/g, JSON.stringify({ ...parsed, computed: { R: r, SL: sl }, asOf: today() }, null, 2));
  const r2 = await chat([{ role: "user", content: prompt }], { search: false, json: true, signal, module: "experiment.bmpi" });
  if (!r2.ok) throw new Error(r2.message);
  const j = robustJsonParse(r2.content) as Record<string, unknown> | null;
  if (!j || typeof j !== "object") throw new Error("LLM 研判输出无法解析为结构化数据");

  const S = j.indices as Record<string, unknown> | undefined;
  const s1 = num(S?.S1);
  const s2 = num(S?.S2);
  const s3 = num(S?.S3);
  const weights = (S?.weights as Record<string, unknown>) ?? {};
  const w = {
    w1: num(weights.w1) ?? 0.28,
    w2: num(weights.w2) ?? 0.21,
    w3: num(weights.w3) ?? 0.21,
  };
  // 合成：S 分缺失时用 R/SL 兜底；全缺 → 0（S/R/L 内部 0-10，BMPI 输出 0-100 与框架分档一致）
  const bmpi = s1 !== null && s2 !== null && s3 !== null && r !== null && sl !== null
    ? Math.round(bmpiComposite(s1, s2, s3, r, sl, w) * 10)
    : null;

  const indices = {
    R: r ?? num(S?.R) ?? 0,
    SL: sl ?? num(S?.SL) ?? 0,
    S1: s1 ?? 0,
    S2: s2 ?? 0,
    S3: s3 ?? 0,
    weights: w,
  };

  return {
    ok: true,
    asOf: today(),
    indices,
    bmpi: bmpi ?? 0,
    status: bmpi !== null ? bmpiStatus(bmpi) : (typeof j.status === "string" ? j.status : "🟡关注"),
    summary: typeof j.summary === "string" ? j.summary : "",
    details: Array.isArray(j.details) ? j.details as ExperimentBmpiResponse["details"] : [],
    watchDates: Array.isArray(j.watchDates) ? j.watchDates as ExperimentBmpiResponse["watchDates"] : [],
    caveats: Array.isArray(j.caveats) ? j.caveats as ExperimentBmpiResponse["caveats"] : [],
    model: r2.model,
  };
}

async function runBmpi(opts: ExperimentBmpiRequest, signal: AbortSignal): Promise<ExperimentBmpiResponse> {
  const cached = kvGet<ExperimentBmpiResponse & { cachedAt?: string }>(CACHE_KEY);
  const cachedAtMs = cached?.cachedAt ? Date.parse(cached.cachedAt) : NaN;
  const fresh = cached && typeof cached === "object" && cached.ok && Number.isFinite(cachedAtMs) && Date.now() - cachedAtMs < CACHE_TTL_MS;
  if (!opts.force && fresh) return { ...cached, fromCache: true, cachedAt: cached.cachedAt ?? new Date().toISOString() };
  const parsed = await collectData(signal);
  const result = await analyze(parsed, signal);
  kvSet(CACHE_KEY, { ...result, fromCache: false, cachedAt: new Date().toISOString() });
  return result;
}

export function registerExperimentBmpi(app: Hono): void {
  app.post(`${API_PREFIX}/tools/experiment/bmpi`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Partial<ExperimentBmpiRequest> | null;
    const opts: ExperimentBmpiRequest = { force: raw?.force === true, useSearch: raw?.useSearch !== false };
    const created = createTask((signal) => runBmpi(opts, signal), { timeoutMs: 10 * 60 * 1000, name: `${today()} · BMPI 化债牛市` });
    return c.json({ ok: true, taskId: created.taskId } as AsyncTaskResult<unknown>);
  });

  app.get(`${API_PREFIX}/tools/experiment/bmpi/task/:taskId`, (c) => {
    const task = getTask<ExperimentBmpiResponse>(c.req.param("taskId"));
    if (!task) return c.json({ ok: false, message: "任务不存在或已过期" }, 404);
    return c.json(task, 200);
  });
}
