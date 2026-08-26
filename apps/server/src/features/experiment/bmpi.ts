// ============================================================
// 实验·页面2：化债牛市进度指数（BMPI v4.0）——数据源直采版（2026-08-16 重构）
// ①成分股股价/PB 走 quote 真实行情（腾讯）②宏观/利率/流动性走用户补全 KV（无免费 API）
// ③S1/S2/S3 + R/SL + 三段权重 + BMPI 合成全部服务端公式固化（indicators.ts）
// ④LLM 仅做综合研判（summary/依据/观察节点）——不再用 LLM 采集数据（省成本、数据更硬）
// ============================================================
import { Hono } from "hono";
import { API_PREFIX, type ExperimentBmpiRequest, type ExperimentBmpiResponse } from "@toolbox/shared";
import { newTaskId, registerScheduledTask, registerTask, startTask } from "../../core/data-infra/index.js";

registerScheduledTask({
  id: "experiment-bmpi-window",
  type: "experiment",
  name: "实验窗口 · BMPI 每日刷新",
  cron: "0 0 9 * * *",
  handler: async (ctx) => {
    const r = await refreshWindow("bmpi", ctx.signal);
    return { ok: true, message: `窗口已刷新（${r.asOf}）`, result: r };
  },
});
import { getPromptTemplate } from "../../core/prompts.js";
import { chat } from "../../core/llm.js";
import { robustJsonParse } from "../../core/jsonParse.js";
import { kvGet, kvSet } from "../../core/kvStore.js";
import { registerDataSource } from "../../core/dataRegistry.js";
import { getQuoteSnapshot } from "../../core/quote.js";
import { cachedFetch } from "../../core/cache.js";
import { bmpiWeights, bmpiComposite, bmpiStatus, bmpiS1, bmpiS2, bmpiS3, pctile } from "./indicators.js";
import { refreshWindow, saveDailyResult, listHistory, runBmpiBacktest, loadBacktest } from "./datahub.js";

registerDataSource({
  kind: "kv",
  name: "experiment:bmpi:",
  page: "实验·BMPI 化债牛市",
  tag: "分析缓存",
  description: "BMPI 结果缓存（TTL 7 天）+ 用户补全数据（experiment:bmpi:supplement）",
  deps: ["tencent.quote", "user.supplement"],
});
registerDataSource({
  kind: "kv",
  name: "experiment:window:",
  page: "实验·BMPI 化债牛市",
  tag: "分析缓存",
  description: "实验窗口数据（experiment:window:<module>：数据工程窗口快照，自动触发更新）",
});

const CACHE_KEY = "experiment:bmpi:v2";          // v2：数据源直采版（旧 LLM 采集缓存失效）
const SUPP_KEY = "experiment:bmpi:supplement";   // 用户补全（无 API 字段）
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 用户补全数据结构（页面输入区保存；服务端读取合并） */
export interface BmpiSupplement {
  y10?: number;            // 中国 10Y 国债收益率 %
  y1?: number;             // 中国 1Y 国债收益率 %
  netInjection?: number;   // 央行周度净投放（亿元，负=净回笼）
  // S1 宏观（发行进度/PMI/基建）
  progressPct?: number; s1Pmi?: number; infraYoY?: number;
  // S2 宏观（城投利差 bp/贷款同比/CPI/应收天数）
  spreadBp?: number; loanYoY?: number; cpi?: number; receivableDays?: number;
  // S3 宏观（房价同比/国企 PB/政府债占比）
  housePriceYoY?: number; soePb?: number; govDebtPct?: number;
  updatedAt?: string;
}

function today(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}
const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);

/** S₁ 建筑股（框架 §4）：代码/起点/终点 */
const S1_STOCKS = [
  { code: "600502", start: 3.82, end: 8.5 },   // 安徽建工
  { code: "601868", start: 1.84, end: 4.5 },   // 中国能建
  { code: "601390", start: 4.63, end: 7.5 },   // 中国中铁
  { code: "601800", start: 6.53, end: 9.8 },   // 中国交建
  { code: "600039", start: 5.09, end: 10.5 },  // 四川路桥
];
/** S₂ 信用边际股（框架 §5） */
const S2_STOCKS = [
  { code: "601006", start: 5.42, end: 6.1 },   // 大秦铁路
  { code: "01052", start: 3.11, end: 4.65 },   // 越秀交通（港）
  { code: "601818", start: 2.74, end: 5.1 },   // 光大银行
  { code: "600350", start: 8.06, end: 11.5 },  // 山东高速
  { code: "01359", start: 0.55, end: 1.25 },   // 中国信达（港）
  { code: "00152", start: 5.27, end: 8.5 },    // 深圳国际（港）
];
/** S₃ 核心资产（框架 §6）：PB 终点（起点 ≈ 终点×0.9，框架 2024.09 起点×0.9 近似，可校准） */
const S3_STOCKS = [
  { code: "601939", endPb: 0.85 },  // 建设银行
  { code: "601398", endPb: 0.8 },   // 工商银行
  { code: "601088", endPb: 2.1 },   // 中国神华
  { code: "601857", endPb: 1.35 },  // 中国石油
  { code: "600048", endPb: 0.7 },   // 保利发展
  { code: "600019", endPb: 0.85 },  // 宝钢股份
  { code: "002142", endPb: 1.1 },   // 宁波银行
  { code: "001979", endPb: 0.95 },  // 招商蛇口
  { code: "601169", endPb: 0.55 },  // 北京银行
  { code: "00788", endPb: 1.25 },   // 中国铁塔（港）
  { code: "600900", endPb: 3.2 },   // 长江电力
];

/** ① 数据采集：成分股 quote 真实行情（窗口持久化）+ 用户补全合并（无 LLM） */
async function collectData(): Promise<{ stocks: Record<string, { price?: number; pb?: number }>; supp: BmpiSupplement }> {
  const supp = (kvGet<BmpiSupplement>(SUPP_KEY) ?? {}) as BmpiSupplement;
  const w = await refreshWindow("bmpi");
  return { stocks: w.stocks ?? {}, supp };
}

/** ② 指标计算（公式固化）：S1/S2/S3 + R/SL + 权重 + BMPI */
async function compute(stocks: Record<string, { price?: number; pb?: number }>, supp: BmpiSupplement) {
  const s1Pct = S1_STOCKS.map((s) => { const p = stocks[s.code]?.price; return p !== undefined ? pctile(p, s.start, s.end) : null; }).filter((v): v is number => v !== null);
  const s2Pct = S2_STOCKS.map((s) => { const p = stocks[s.code]?.price; return p !== undefined ? pctile(p, s.start, s.end) : null; }).filter((v): v is number => v !== null);
  const s3Pb = S3_STOCKS.map((s) => { const pb = stocks[s.code]?.pb; return pb !== undefined ? pctile(pb, s.endPb * 0.9, s.endPb) : null; }).filter((v): v is number => v !== null);

  const s1 = bmpiS1(s1Pct, { progressPct: num(supp.progressPct), pmi: num(supp.s1Pmi), infraYoY: num(supp.infraYoY) });
  const s2 = bmpiS2(s2Pct, { spreadBp: num(supp.spreadBp), loanYoY: num(supp.loanYoY), cpi: num(supp.cpi), receivableDays: num(supp.receivableDays) });
  const y10 = num(supp.y10); const y1 = num(supp.y1);
  const rateSpreadBp = y10 !== null && y1 !== null ? (y10 - y1) * 100 : null;
  const s3 = bmpiS3(s3Pb, { housePriceYoY: num(supp.housePriceYoY), soePb: num(supp.soePb), govDebtPct: num(supp.govDebtPct) }, rateSpreadBp);
  const r = y10 !== null ? Math.round(100 - y10 * 25) : null;
  const sl = supp.netInjection !== undefined ? Math.round((() => { const n = supp.netInjection!; return n >= 5000 ? 100 : n <= -3000 ? 10 : Math.min(Math.max(50 + (n / 1000) * 10, 10), 100); })()) : null;

  const weights = bmpiWeights(s1 ?? 50, s2 ?? 50, s3 ?? 50);
  // BMPI：S 三因子全有才算；R/SL 缺失时仅用 S 部分归一化（0-100），并标注 missing
  const missing: string[] = [];
  if (s1 === null || s2 === null || s3 === null) missing.push("S1/S2/S3");
  if (r === null) missing.push("R(国债收益率)");
  if (sl === null) missing.push("SL(逆回购净投放)");
  let bmpi: number | null = null;
  if (s1 !== null && s2 !== null && s3 !== null) {
    const sPart = weights.w1 * s1 + weights.w2 * s2 + weights.w3 * s3;
    bmpi = r !== null && sl !== null
      ? bmpiComposite(s1, s2, s3, r, sl, weights)
      : Math.round((sPart / 0.7) * 100) / 100;
  }
  return {
    indices: { R: r ?? 0, SL: sl ?? 0, S1: s1 ?? 0, S2: s2 ?? 0, S3: s3 ?? 0, weights },
    s1, s2, s3, r, sl, bmpi, rateSpreadBp, missing,
    s1Pct, s2Pct, s3Pb,
  };
}

/** ③ LLM 综合研判（基于真实数据 + 计算的指数；不再采集数据） */
async function analyze(c: Awaited<ReturnType<typeof compute>>, supp: BmpiSupplement, stocks: Record<string, { price?: number; pb?: number }>, signal: AbortSignal): Promise<ExperimentBmpiResponse> {
  const tpl = getPromptTemplate("experiment.bmpi");
  const prompt = tpl
    .replace(/\{date\}/g, today())
    .replace(/\{data\}/g, JSON.stringify({ computed: c.indices, bmpi: c.bmpi, weights: c.indices.weights, missing: c.missing, stocks, supplement: supp, asOf: today() }, null, 2));
  const r = await chat([{ role: "user", content: prompt }], { search: false, json: true, signal, module: "experiment.bmpi" });
  if (!r.ok) throw new Error(r.message);
  const j = robustJsonParse(r.content) as Record<string, unknown> | null;
  if (!j || typeof j !== "object") throw new Error("LLM 研判输出无法解析为结构化数据");
  const details = (Array.isArray(j.details) ? j.details : []).map((d) => {
    const o = d as Record<string, unknown>;
    return { index: String(o.index ?? ""), score: Number(o.score ?? 0), evidence: String(o.evidence ?? ""), confidence: String(o.confidence ?? "中") };
  });
  return {
    ok: true,
    asOf: today(),
    indices: c.indices,
    bmpi: c.bmpi ?? 0,
    status: c.bmpi !== null ? bmpiStatus(c.bmpi) : (typeof j.status === "string" ? j.status : "🟡关注"),
    summary: typeof j.summary === "string" ? j.summary : "",
    details,
    watchDates: Array.isArray(j.watchDates) ? j.watchDates as ExperimentBmpiResponse["watchDates"] : [],
    caveats: Array.isArray(j.caveats) ? j.caveats as ExperimentBmpiResponse["caveats"] : [],
    model: r.model,
  };
}

async function runBmpi(opts: ExperimentBmpiRequest, signal: AbortSignal): Promise<ExperimentBmpiResponse> {
  const cached = await cachedFetch<ExperimentBmpiResponse & { cachedAt?: string }>(
    CACHE_KEY, CACHE_TTL_MS,
    async () => {
      const { stocks, supp } = await collectData();
      const c = await compute(stocks, supp);
      const result = await analyze(c, supp, stocks, signal);
      // 每日结果持久化（数据工程：保留历史供回溯）
      saveDailyResult("bmpi", {
        asOf: result.asOf,
        indices: result.indices,
        bmpi: result.bmpi,
        status: result.status,
        summary: result.summary,
        createdAt: new Date().toISOString(),
      });
      return { ...result, fromCache: false, cachedAt: new Date().toISOString() };
    },
    { force: opts.force },
  );
  // cachedFetch 命中缓存时返回缓存值（含 cachedAt）；未命中时 fetcher 返回的就是新结果
  return { ...cached.data, fromCache: cached.fromCache } as ExperimentBmpiResponse & { cachedAt?: string };
}

export function registerExperimentBmpi(app: Hono): void {
  app.post(`${API_PREFIX}/tools/experiment/bmpi`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Partial<ExperimentBmpiRequest> | null;
    const opts: ExperimentBmpiRequest = { force: raw?.force === true, useSearch: raw?.useSearch !== false };
    const taskId = newTaskId("experiment-bmpi");

registerTask({ id: taskId, type: "experiment", name: `${today()} · BMPI 化债牛市`, handler: async (ctx) => { const result = await runBmpi(opts, ctx.signal ?? new AbortController().signal); return { ok: true, message: "分析完成", result }; } }, { ephemeral: true });
    startTask(taskId, { trigger: "manual" });
    return c.json({ ok: true, taskId });
  });

  // 历史结果（每日快照）
  app.get(`${API_PREFIX}/tools/experiment/bmpi/history`, (c) => c.json({ ok: true, history: listHistory("bmpi", 90) }));

  // 回测（今年起日序列）
  app.post(`${API_PREFIX}/tools/experiment/bmpi/backtest`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { force?: boolean } | null;
    const existing = loadBacktest();
    if (!raw?.force && existing && existing.series.length > 0) return c.json({ ok: true, backtest: existing, fromCache: true });
    const backtest = await runBmpiBacktest("2026-01-01");
    return c.json({ ok: true, backtest, fromCache: false });
  });
  app.get(`${API_PREFIX}/tools/experiment/bmpi/backtest`, (c) => {
    const b = loadBacktest();
    return b ? c.json({ ok: true, backtest: b }) : c.json({ ok: true, backtest: null });
  });

  // 研判提示词预览（模板 + 注入数据示例）
  app.get(`${API_PREFIX}/tools/experiment/bmpi/prompt`, async (c) => {
    const { stocks, supp } = await collectData();
    const computed = await compute(stocks, supp);
    const tpl = getPromptTemplate("experiment.bmpi");
    const prompt = tpl
      .replace(/\{date\}/g, today())
      .replace(/\{data\}/g, JSON.stringify({ computed: computed.indices, bmpi: computed.bmpi, weights: computed.indices.weights, missing: computed.missing, stocks, supplement: supp, asOf: today() }, null, 2));
    return c.json({ ok: true, prompt });
  });

  // 用户补全数据读写（无 API 字段：国债/逆回购/S 宏观）
  app.get(`${API_PREFIX}/tools/experiment/bmpi/supplement`, (c) => c.json({ ok: true, supplement: kvGet<BmpiSupplement>(SUPP_KEY) ?? {} }));
  app.put(`${API_PREFIX}/tools/experiment/bmpi/supplement`, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<BmpiSupplement> | null;
    if (!body) return c.json({ ok: false, message: "补全数据不能为空" }, 400);
    const old = (kvGet<BmpiSupplement>(SUPP_KEY) ?? {}) as BmpiSupplement;
    const merged: BmpiSupplement = { ...old, ...body, updatedAt: new Date().toISOString() };
    kvSet(SUPP_KEY, merged);
    return c.json({ ok: true, supplement: merged });
  });
}
