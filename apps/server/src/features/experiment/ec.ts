// ============================================================
// 实验·页面3：欧元/日元泡沫预警（ec）
// 两段式：①LLM 联网采集最新数据（汇率/利差/VIX/CFTC/估值）→ ②服务端指标公式固化（B/Ω/CVAS/CCV）
//         → ③LLM 研判（基于数据+指标，输出结构化预警 JSON）→ 缓存 6h（force 绕过）
// ============================================================
import { Hono } from "hono";
import { API_PREFIX, type AsyncTaskResult, type ExperimentEcRequest, type ExperimentEcResponse, type ExperimentEcData } from "@toolbox/shared";
import { createTask, getTask } from "../../core/tasks.js";
import { getPromptTemplate } from "../../core/prompts.js";
import { chat } from "../../core/llm.js";
import { robustJsonParse } from "../../core/jsonParse.js";
import { kvGet, kvSet } from "../../core/kvStore.js";
import { registerDataSource } from "../../core/dataRegistry.js";
import { ecB, ecOmega, ecCvas, ecCcv, ecStatus } from "./indicators.js";

registerDataSource({
  kind: "kv",
  name: "experiment:ec:",
  page: "实验·ec 泡沫预警",
  tag: "分析缓存",
  description: "欧元/日元泡沫预警结果缓存（Key-结构化 Value，TTL 6h）",
});

const CACHE_KEY = "experiment:ec:v1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function today(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

/** ① 数据采集：LLM 联网搜索最新数据（结构化 JSON） */
async function collectData(signal: AbortSignal): Promise<Record<string, any>> {
  const prompt = getPromptTemplate("experiment.ec.collect").replace(/\{date\}/g, today());
  const r = await chat([{ role: "user", content: prompt }], { search: true, json: true, signal, module: "experiment.ec.collect" });
  if (!r.ok) throw new Error(r.message);
  const parsed = robustJsonParse(r.content);
  if (!parsed || typeof parsed !== "object") throw new Error("数据采集输出无法解析为结构化数据");
  return parsed as Record<string, any>;
}

/** ② 指标计算（公式固化）+ ③ LLM 研判 */
async function analyze(parsed: Record<string, any>, signal: AbortSignal): Promise<ExperimentEcResponse> {
  const num = (v: unknown): number | undefined => (typeof v === "number" && isFinite(v) ? v : undefined);
  const data: ExperimentEcData = {
    asOf: today(),
    fx: {
      eurjpy: num(parsed.eurjpy ?? parsed.fx?.eurjpy) ?? undefined,
      usdjpy: num(parsed.usdjpy ?? parsed.fx?.usdjpy) ?? undefined,
      eurusd: num(parsed.eurusd ?? parsed.fx?.eurusd) ?? undefined,
    },
    spreads: {
      de10y: num(parsed.de10y ?? parsed.spreads?.de10y) ?? undefined,
      jp10y: num(parsed.jp10y ?? parsed.spreads?.jp10y) ?? undefined,
      diff: num(parsed.spreadDiff ?? parsed.spreads?.diff) ?? undefined,
    },
    vix: num(parsed.vix) ?? undefined,
    cftc: {
      netShortK: num(parsed.cftcNetShortK ?? parsed.cftc?.netShortK) ?? undefined,
      zScore: num(parsed.cftcZ ?? parsed.cftc?.zScore) ?? undefined,
    },
    buffettIndicator: num(parsed.buffettIndicator) ?? undefined,
  };

  // 指标（周度变动由采集提供：fxChangePct / spreadChangePct / vixPrev / lowVolWeeks）
  const b = ecB(num(parsed.fxChangePct) ?? 0, num(parsed.spreadChangePct) ?? 0);
  const cvasVal = ecCvas(data.vix ?? null, num(parsed.lowVolWeeks) ?? 0);
  const omega = ecOmega(
    { fx: num(parsed.zFx) ?? undefined, short: data.cftc?.zScore, spread: num(parsed.zSpread) ?? undefined, valuation: num(parsed.zValuation) ?? undefined },
    cvasVal,
  );
  const ccv = ecCcv(data.vix ?? null, num(parsed.vixPrev) ?? null);
  const bTrend: string = typeof parsed.bTrend === "string" ? parsed.bTrend : "flat";
  const signals: string[] = Array.isArray(parsed.signals) ? parsed.signals.map(String) : [];

  const indicators = { b, bTrend, omega, cvas: cvasVal, ccv, signals };
  const quick = ecStatus(b, omega);

  // LLM 研判（数据 + 指标 → 预警 JSON）
  const tpl = getPromptTemplate("experiment.ec");
  const prompt = tpl
    .replace(/\{date\}/g, today())
    .replace(/\{data\}/g, JSON.stringify({ ...data, raw: parsed, computed: indicators, quickStatus: quick }, null, 2));
  const r = await chat([{ role: "user", content: prompt }], { search: false, json: true, signal, module: "experiment.ec" });
  if (!r.ok) throw new Error(r.message);
  const j = robustJsonParse(r.content) as Partial<ExperimentEcResponse> | null;
  if (!j || typeof j !== "object") throw new Error("LLM 研判输出无法解析为结构化数据");

  return {
    ok: true,
    asOf: today(),
    data,
    indicators,
    status: typeof j.status === "string" ? j.status : quick,
    summary: typeof j.summary === "string" ? j.summary : "",
    anchors: Array.isArray(j.anchors) ? j.anchors : [],
    watchDates: Array.isArray(j.watchDates) ? j.watchDates : [],
    caveats: Array.isArray(j.caveats) ? j.caveats : [],
    model: r.model,
  };
}

async function runEc(opts: ExperimentEcRequest, signal: AbortSignal): Promise<ExperimentEcResponse> {
  const cached = kvGet<ExperimentEcResponse & { cachedAt?: string }>(CACHE_KEY);
  const cachedAtMs = cached?.cachedAt ? Date.parse(cached.cachedAt) : NaN;
  const fresh = cached && typeof cached === "object" && cached.ok && Number.isFinite(cachedAtMs) && Date.now() - cachedAtMs < CACHE_TTL_MS;
  if (!opts.force && fresh) return { ...cached, fromCache: true, cachedAt: cached.cachedAt ?? new Date().toISOString() };
  const parsed = await collectData(signal);
  const result = await analyze(parsed, signal);
  kvSet(CACHE_KEY, { ...result, fromCache: false, cachedAt: new Date().toISOString() });
  return result;
}

export function registerExperimentEc(app: Hono): void {
  app.post(`${API_PREFIX}/tools/experiment/ec`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Partial<ExperimentEcRequest> | null;
    const opts: ExperimentEcRequest = { force: raw?.force === true, useSearch: raw?.useSearch !== false };
    const created = createTask((signal) => runEc(opts, signal), { timeoutMs: 10 * 60 * 1000, name: `${today()} · ec 泡沫预警` });
    return c.json({ ok: true, taskId: created.taskId } as AsyncTaskResult<unknown>);
  });

  app.get(`${API_PREFIX}/tools/experiment/ec/task/:taskId`, (c) => {
    const task = getTask<ExperimentEcResponse>(c.req.param("taskId"));
    if (!task) return c.json({ ok: false, message: "任务不存在或已过期" }, 404);
    return c.json(task, 200);
  });
}
