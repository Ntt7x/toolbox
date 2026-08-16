// ============================================================
// 实验·页面3：欧元/日元泡沫预警（ec）——数据源直采版（2026-08-16 重构）
// ①外汇走腾讯 wh 真实接口（fetchFx）②VIX/利差/CFTC/估值走用户补全 KV（无免费 API）
// ③B/Ω/CVAS/CCV 指标公式固化（indicators.ts）④LLM 仅做研判——不再用 LLM 采集数据
// ============================================================
import { Hono } from "hono";
import { API_PREFIX, type AsyncTaskResult, type ExperimentEcRequest, type ExperimentEcResponse, type ExperimentEcData } from "@toolbox/shared";
import { createTask, getTask } from "../../core/tasks.js";
import { getPromptTemplate } from "../../core/prompts.js";
import { chat } from "../../core/llm.js";
import { robustJsonParse } from "../../core/jsonParse.js";
import { kvGet, kvSet } from "../../core/kvStore.js";
import { registerDataSource } from "../../core/dataRegistry.js";
import { fetchFx } from "../../core/quote.js";
import { cachedFetch } from "../../core/cache.js";
import { ecB, ecOmega, ecCvas, ecCcv, ecStatus } from "./indicators.js";
import { refreshWindow, saveDailyResult, listHistory } from "./datahub.js";

registerDataSource({
  kind: "kv",
  name: "experiment:ec:",
  page: "实验·ec 泡沫预警",
  tag: "分析缓存",
  description: "ec 预警结果缓存（TTL 6h）+ 用户补全数据（experiment:ec:supplement）",
  deps: ["tencent.fx", "user.supplement"],
});

const CACHE_KEY = "experiment:ec:v2";          // v2：数据源直采版（旧 LLM 采集缓存失效）
const SUPP_KEY = "experiment:ec:supplement";   // 用户补全（无 API 字段）
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** 用户补全数据结构（页面输入区保存） */
export interface EcSupplement {
  vix?: number;            // VIX 指数
  vixPrev?: number;        // 上一交易日 VIX
  lowVolWeeks?: number;    // VIX<20 连续周数
  de10y?: number;          // 德国 10Y 收益率 %
  jp10y?: number;          // 日本 10Y 收益率 %
  spreadDiff?: number;     // 德日 10Y 利差（百分点）
  cftcNetShortK?: number;  // CFTC 日元净空头（千手）
  cftcZ?: number;          // 空头 z 分数
  buffettIndicator?: number; // 巴菲特指标
  zFx?: number; zSpread?: number; zValuation?: number;  // z 分数
  fxChangePct?: number;    // 欧元/日元周度变动 %
  spreadChangePct?: number; // 利差周度变动（百分点）
  bTrend?: string;         // up|down|flat
  updatedAt?: string;
}

function today(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}
const num = (v: unknown): number | undefined => (typeof v === "number" && isFinite(v) ? v : undefined);

/** ① 数据采集：外汇真实接口（窗口持久化）+ 用户补全合并（无 LLM） */
async function collectData(): Promise<{ fx: ExperimentEcData["fx"]; supp: EcSupplement }> {
  const supp = (kvGet<EcSupplement>(SUPP_KEY) ?? {}) as EcSupplement;
  const w = await refreshWindow("ec");
  return { fx: w.fx ?? {}, supp };
}

/** ② 指标计算（公式固化） */
function compute(fx: ExperimentEcData["fx"], supp: EcSupplement) {
  const data: ExperimentEcData = {
    asOf: today(),
    fx,
    spreads: {
      de10y: num(supp.de10y),
      jp10y: num(supp.jp10y),
      diff: num(supp.spreadDiff),
    },
    vix: num(supp.vix),
    cftc: {
      netShortK: num(supp.cftcNetShortK),
      zScore: num(supp.cftcZ),
    },
    buffettIndicator: num(supp.buffettIndicator),
  };
  const b = ecB(num(supp.fxChangePct) ?? 0, num(supp.spreadChangePct) ?? 0);
  const cvasVal = ecCvas(data.vix ?? null, num(supp.lowVolWeeks) ?? 0);
  const omega = ecOmega(
    { fx: num(supp.zFx), short: data.cftc?.zScore, spread: num(supp.zSpread), valuation: num(supp.zValuation) },
    cvasVal,
  );
  const ccv = ecCcv(data.vix ?? null, num(supp.vixPrev) ?? null);
  const indicators = {
    b, bTrend: typeof supp.bTrend === "string" ? supp.bTrend : "flat",
    omega, cvas: cvasVal, ccv,
    signals: [] as string[],
  };
  const quick = ecStatus(b, omega);
  return { data, indicators, quick };
}

/** ③ LLM 研判（基于真实外汇 + 补全 + 指标；不再采集数据） */
async function analyze(d: Awaited<ReturnType<typeof compute>>, supp: EcSupplement, signal: AbortSignal): Promise<ExperimentEcResponse> {
  const tpl = getPromptTemplate("experiment.ec");
  const prompt = tpl
    .replace(/\{date\}/g, today())
    .replace(/\{data\}/g, JSON.stringify({ data: d.data, computed: d.indicators, quickStatus: d.quick, supplement: supp, asOf: today() }, null, 2));
  const r = await chat([{ role: "user", content: prompt }], { search: false, json: true, signal, module: "experiment.ec" });
  if (!r.ok) throw new Error(r.message);
  const j = robustJsonParse(r.content) as Partial<ExperimentEcResponse> | null;
  if (!j || typeof j !== "object") throw new Error("LLM 研判输出无法解析为结构化数据");
  return {
    ok: true,
    asOf: today(),
    data: d.data,
    indicators: { ...d.indicators, signals: Array.isArray(j.indicators?.signals) ? j.indicators!.signals : [] },
    status: typeof j.status === "string" ? j.status : d.quick,
    summary: typeof j.summary === "string" ? j.summary : "",
    anchors: Array.isArray(j.anchors) ? j.anchors : [],
    watchDates: Array.isArray(j.watchDates) ? j.watchDates : [],
    caveats: Array.isArray(j.caveats) ? j.caveats : [],
    model: r.model,
  };
}

async function runEc(opts: ExperimentEcRequest, signal: AbortSignal): Promise<ExperimentEcResponse> {
  const cached = await cachedFetch<ExperimentEcResponse & { cachedAt?: string }>(
    CACHE_KEY, CACHE_TTL_MS,
    async () => {
      const { fx, supp } = await collectData();
      const d = compute(fx, supp);
      const result = await analyze(d, supp, signal);
      // 每日结果持久化
      saveDailyResult("ec", {
        asOf: result.asOf,
        indices: {
          b: typeof result.indicators.b === "number" ? result.indicators.b : NaN,
          omega: typeof result.indicators.omega === "number" ? result.indicators.omega : NaN,
          cvas: typeof result.indicators.cvas === "number" ? result.indicators.cvas : NaN,
          ccv: typeof result.indicators.ccv === "number" ? result.indicators.ccv : NaN,
        },
        status: result.status,
        summary: result.summary,
        createdAt: new Date().toISOString(),
      });
      return { ...result, fromCache: false, cachedAt: new Date().toISOString() };
    },
    { force: opts.force },
  );
  return { ...cached.data, fromCache: cached.fromCache } as ExperimentEcResponse & { cachedAt?: string };
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

  // 历史结果（每日快照）
  app.get(`${API_PREFIX}/tools/experiment/ec/history`, (c) => c.json({ ok: true, history: listHistory("ec", 90) }));

  // 研判提示词预览
  app.get(`${API_PREFIX}/tools/experiment/ec/prompt`, async (c) => {
    const { fx, supp } = await collectData();
    const d = compute(fx, supp);
    const tpl = getPromptTemplate("experiment.ec");
    const prompt = tpl
      .replace(/\{date\}/g, today())
      .replace(/\{data\}/g, JSON.stringify({ data: d.data, computed: d.indicators, quickStatus: d.quick, supplement: supp, asOf: today() }, null, 2));
    return c.json({ ok: true, prompt });
  });

  // 用户补全数据读写
  app.get(`${API_PREFIX}/tools/experiment/ec/supplement`, (c) => c.json({ ok: true, supplement: kvGet<EcSupplement>(SUPP_KEY) ?? {} }));
  app.put(`${API_PREFIX}/tools/experiment/ec/supplement`, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<EcSupplement> | null;
    if (!body) return c.json({ ok: false, message: "补全数据不能为空" }, 400);
    const old = (kvGet<EcSupplement>(SUPP_KEY) ?? {}) as EcSupplement;
    const merged: EcSupplement = { ...old, ...body, updatedAt: new Date().toISOString() };
    kvSet(SUPP_KEY, merged);
    return c.json({ ok: true, supplement: merged });
  });
}
