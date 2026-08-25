// ============================================================
// 业务模块：专题自选股（features/watchlist）
// - meta：工具注册信息
// - register：专题 CRUD（KV 持久化）+ 个股财报分析（LLM，后台任务 + 缓存）
// 依赖下层公共模块：core/kvStore、core/tasks、core/llm、core/prompts
// ============================================================

import { Hono } from "hono";
import {
  API_PREFIX,
  type AsyncTaskResult,
  type ToolMeta,
  type WatchlistCreateRequest,
  type WatchlistDetailResult,
  type WatchlistFundamentalResult,
  type WatchlistStock,
  type WatchlistTopic,
  type WatchlistUpdateRequest,
} from "@toolbox/shared";
import { createTask, getTask } from "../../core/tasks.js";
import { kvDelete, kvGet, kvSet } from "../../core/kvStore.js";
import { registerDataSource } from "../../core/dataRegistry.js";
import { createTopic, deleteTopic, getTopic, listTopics, PREFIX, updateTopic } from "./store.js";
import { fundamentalAnalysis, importFromChat, optimizeReason, parseImportFromChat, resolveStockName, extendPrompt } from "./service.js";
import { getQuoteSnapshots } from "../../core/quote.js";
import { getFundSnapshots } from "../../core/fund.js";
import type { WatchlistSummary } from "@toolbox/shared";

// 注册数据源：专题自选股（本地数据管理页展示 tag 用）
registerDataSource({
  kind: "kv",
  name: PREFIX,
  page: "专题自选股",
  tag: "自选数据",
  description: "专题自选股（专题 + 入选个股 + 入选理由，Key-结构化 Value）",
});
registerDataSource({
  kind: "kv",
  name: "watchlist:extend:",
  page: "专题自选股",
  tag: "分析数据",
  description: "延续思考/扩展思考提示词结果缓存（LLM 驱动，TTL 2 年，可刷新）",
});
registerDataSource({
  kind: "kv",
  name: "watchlist:fundamental:",
  page: "专题自选股",
  tag: "分析数据",
  description: "个股财报分析结果缓存（LLM 驱动，TTL 2 年）",
});

// ============================================================

export const meta: ToolMeta = {
  id: "watchlist",
  name: "专题自选股",
  description: "自建投资专题，收录个股与入选理由；一键 LLM 财报分析（联网搜索）",
  path: "/tools/watchlist",
};

/** 股票代码校验（sh/sz/hk 前缀或纯数字） */
function isValidCode(code: string): boolean {
  return /^(sh|sz|hk)?\d{5,6}$/i.test(code);
}

// ---------- 列表等权平均涨幅 ----------

/** 单次行情批量上限（与 /quotes 接口一致） */
const QUOTES_BATCH = 40;

/**
 * 为专题列表附当日平均涨幅（等权）：
 * 收集各专题全部股票/基金代码 → 分 40 只一批批量行情（复用 5 分钟缓存，避免与详情页重复拉取）
 * → 每专题对「有行情且涨跌幅可用」的标的取算术平均（等权）。
 * 全部无行情 → avgPct 缺省（前端不展示）。
 */
async function attachAvgPct(topics: WatchlistSummary[]): Promise<WatchlistSummary[]> {
  if (topics.length === 0) return topics;
  // 轻量摘要不含 stocks → 取详情收集各专题代码
  const topicCodes = new Map<string, { code: string; isFund: boolean }[]>();
  for (const t of topics) {
    const full = getTopic(t.id);
    const codes: { code: string; isFund: boolean }[] = [];
    for (const s of full?.stocks ?? []) {
      codes.push(s.kind === "fund" ? { code: s.code, isFund: true } : { code: s.code, isFund: false });
    }
    if (codes.length > 0) topicCodes.set(t.id, codes);
  }
  if (topicCodes.size === 0) return topics;

  const all = [...topicCodes.values()].flat();
  const stockCodes = [...new Set(all.filter((x) => !x.isFund).map((x) => x.code))];
  const fundCodes = [...new Set(all.filter((x) => x.isFund).map((x) => x.code))];
  const chunk = <T,>(arr: T[], n: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  };
  const [stockGroups, fundGroups] = await Promise.all([
    Promise.all(chunk(stockCodes, QUOTES_BATCH).map((c) => getQuoteSnapshots(c))),
    Promise.all(chunk(fundCodes, QUOTES_BATCH).map((c) => getFundSnapshots(c))),
  ]);

  // 索引：normCode（sh600519）+ 裸码（600519）双键 → 兼容专题内用户输入的任意写法；基金为纯数字
  const pctByCode = new Map<string, number>();
  for (const q of [...stockGroups.flat(), ...fundGroups.flat()]) {
    if (q.ok && typeof q.pct === "number") {
      pctByCode.set(q.code, q.pct);
      const bare = q.code.replace(/^(sh|sz|hk|bj)/, "");
      if (bare !== q.code) pctByCode.set(bare, q.pct);
    }
  }

  return topics.map((t) => {
    const codes = topicCodes.get(t.id);
    if (!codes || codes.length === 0) return t;
    let sum = 0;
    let n = 0;
    for (const x of codes) {
      const pct = pctByCode.get(x.code);
      if (typeof pct === "number") {
        sum += pct;
        n += 1;
      }
    }
    if (n === 0) return t;
    return { ...t, avgPct: Math.round((sum / n) * 10000) / 10000, avgCount: n };
  });
}

export function register(app: Hono): void {
  // 股票名称搜索（东财 suggest：名称 → 代码候选，添加股票用）
  app.get(`${API_PREFIX}/tools/watchlist/search-stock`, async (c) => {
    const name = (c.req.query("name") ?? "").trim();
    if (!name) return c.json({ ok: false, message: "请输入股票名称" }, 400);
    const limit = Math.min(10, Math.max(1, Number(c.req.query("limit") ?? 8) || 8));
    try {
      const res = await fetch(`https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(name)}&type=14&count=${limit}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`东财搜索接口 ${res.status}`);
      const j = (await res.json()) as { QuotationCodeTable?: { Data?: { Code?: string; Name?: string; MktNum?: string | number; SecurityTypeName?: string }[] } };
      const items = (j.QuotationCodeTable?.Data ?? [])
        .filter((x) => x?.Code && x?.Name)
        .map((x) => {
          const mkt = String(x.MktNum ?? "");
          const t = x.SecurityTypeName ?? "";
          const market =
            mkt === "1" ? "sh"
            : mkt === "2" ? "sz"
            : mkt === "3" ? "bj"
            : mkt === "116" ? "hk"
            : t.includes("深") ? "sz"
            : t.includes("沪") ? "sh"
            : t.includes("京") ? "bj"
            : t.includes("港") ? "hk"
            : "";
          return { code: String(x.Code), name: x.Name ?? "", market, type: t };
        });
      return c.json({ ok: true, items });
    } catch (e) {
      return c.json({ ok: false, message: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  // 专题列表（轻量 + 当日平均涨幅：等权平均，有行情股票的涨跌幅算术平均；走行情 5 分钟缓存）
  app.get(`${API_PREFIX}/tools/watchlist`, async (c) => {
    const topics = listTopics();
    const withPct = await attachAvgPct(topics);
    return c.json({ ok: true, topics: withPct });
  });

  // 新建专题
  app.post(`${API_PREFIX}/tools/watchlist`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as WatchlistCreateRequest | null;
    const name = raw?.name?.trim() ?? "";
    if (!name) return c.json({ ok: false, message: "缺少专题名称" }, 400);
    const topic = createTopic(name, raw?.description, raw?.group);
    return c.json({ ok: true, topic }, 201);
  });

  // 解析股票名称（标准行情工具）——必须在 /:id 之前注册（避免被当作 id）
  app.get(`${API_PREFIX}/tools/watchlist/resolve`, async (c) => {
    const code = c.req.query("code")?.trim() ?? "";
    const kind = c.req.query("kind")?.trim() ?? "stock";
    if (!code) return c.json({ ok: false, message: "缺少 code 参数" }, 400);
    const name = await resolveStockName(code, kind);
    return c.json({ ok: true, code, kind, name });
  });

  // 批量快照（个股列表基本信息展示；复用公共行情模块缓存）
  // codes 支持前缀：`fund:161725` 走场外基金净值接口（天天基金），其余走股票行情
  app.get(`${API_PREFIX}/tools/watchlist/quotes`, async (c) => {
    const codesRaw = c.req.query("codes")?.trim() ?? "";
    const raw = codesRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (raw.length === 0) return c.json({ ok: false, message: "缺少 codes 参数（逗号分隔）" }, 400);
    if (raw.length > 40) return c.json({ ok: false, message: "一次最多 40 只" }, 400);
    const force = c.req.query("force") === "1";
    const fundCodes = raw.filter((x) => x.startsWith("fund:")).map((x) => x.slice(5));
    const stockCodes = raw.filter((x) => !x.startsWith("fund:"));
    const [stockQuotes, fundQuotes] = await Promise.all([
      stockCodes.length ? getQuoteSnapshots(stockCodes, { force }) : Promise.resolve([]),
      fundCodes.length ? getFundSnapshots(fundCodes, { force }) : Promise.resolve([]),
    ]);
    return c.json({ ok: true, quotes: [...stockQuotes, ...fundQuotes] });
  });

  // Chat 导入：分享链接 → 提取对话 → LLM 整理 → 自动创建专题（后台任务）
  app.post(`${API_PREFIX}/tools/watchlist/import`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    const url = typeof raw?.url === "string" ? raw.url.trim() : "";
    if (!url) return c.json({ ok: false, message: "缺少 Chat 分享链接" }, 400);
    if (!/^https:\/\/chat\.deepseek\.com\/share\/[A-Za-z0-9_-]+$/.test(url)) {
      return c.json({ ok: false, message: "链接格式无效，应为 https://chat.deepseek.com/share/<id>" }, 400);
    }
    const { taskId } = createTask<WatchlistTopic>(
      async (signal) => importFromChat(url, signal),
      { timeoutMs: 10 * 60 * 1000, module: "watchlist.import", name: "专题 Chat 导入" },
    );
    return c.json(getTask<WatchlistTopic>(taskId), 202);
  });

  // 移动/复制个股到其他专题（静态路由须在 /:id 之前注册）
  app.post(`${API_PREFIX}/tools/watchlist/move-stock`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { fromTopicId?: unknown; code?: unknown; toTopicId?: unknown; copy?: unknown } | null;
    const fromId = typeof raw?.fromTopicId === "string" ? raw.fromTopicId : "";
    const toId = typeof raw?.toTopicId === "string" ? raw.toTopicId : "";
    const code = typeof raw?.code === "string" ? raw.code.trim() : "";
    const copy = raw?.copy === true;
    if (!fromId || !toId || !code) return c.json({ ok: false, message: "缺少参数（fromTopicId/code/toTopicId）" }, 400);
    const from = getTopic(fromId);
    const to = getTopic(toId);
    if (!from || !to) return c.json({ ok: false, message: "专题不存在" }, 404);
    const stock = from.stocks.find((s) => s.code === code);
    if (!stock) return c.json({ ok: false, message: "个股不在源专题中" }, 404);
    if (fromId === toId) return c.json({ ok: false, message: "目标专题与源专题相同" }, 400);
    // 目标专题添加（同 code 覆盖更新）
    const updatedTo = updateTopic(toId, { addStocks: [stock] });
    if (!updatedTo) return c.json({ ok: false, message: "添加失败" }, 500);
    // 移动：源专题移除；复制：保留
    if (!copy) updateTopic(fromId, { removeCodes: [code] });
    return c.json({ ok: true, fromTopic: getTopic(fromId), toTopic: updatedTo, moved: !copy });
  });

  // 生成延续思路/扩展思考提示词（专题信息 → LLM；返回可粘贴 DeepSeek Chat 的提示词）
  // 按专题缓存（TTL 2 年）；force=1 刷新（绕过缓存重新生成）
  app.post(`${API_PREFIX}/tools/watchlist/:id/extend-prompt`, async (c) => {
    const id = c.req.param("id");
    const t = getTopic(id);
    if (!t) return c.json({ ok: false, message: "专题不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { force?: unknown } | null;
    const force = raw?.force === true;
    // 缓存 key 含专题 updatedAt：专题内容变化（增删股/改名）即自动失效，不再命中旧提示词（2026-08 修复）
    const cacheKey = `watchlist:extend:${id}:${t.updatedAt ?? ""}`;
    if (!force) {
      const cached = kvGet<{ prompt?: string; _at?: string }>(cacheKey);
      if (cached?.prompt) return c.json({ ok: true, prompt: cached.prompt, fromCache: true });
    }
    const r = await extendPrompt(t);
    if (!r.ok) return c.json({ ok: false, message: r.message }, 400);
    kvSet(cacheKey, { prompt: r.prompt, _at: new Date().toISOString() });
    return c.json({ ok: true, prompt: r.prompt, fromCache: false });
  });

  // 根据财报分析优化入选理由（LLM；先须有 fundamental 缓存）
  app.post(`${API_PREFIX}/tools/watchlist/:id/optimize-reason`, async (c) => {
    const id = c.req.param("id");
    const t = getTopic(id);
    if (!t) return c.json({ ok: false, message: "专题不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { code?: unknown; reason?: unknown } | null;
    const code = typeof raw?.code === "string" ? raw.code.trim() : "";
    if (!code) return c.json({ ok: false, message: "缺少股票代码" }, 400);
    const stock = t.stocks.find((s) => s.code === code);
    // 2026-08 修复：code 不在专题中 → 400（防经 addStocks 注入任意字符串 code 污染专题）
    if (!stock) return c.json({ ok: false, message: `标的 ${code} 不在专题中` }, 400);
    const reason = typeof raw?.reason === "string" ? raw.reason : stock?.reason;
    const r = await optimizeReason(code, { reason, name: stock?.name });
    if (!r.ok) return c.json({ ok: false, message: r.message }, 400);
    // 更新专题内该股理由（addStocks 同 code 覆盖）
    const updated = updateTopic(id, { addStocks: [{ code, name: stock?.name, reason: r.reason ?? "" }] });
    return c.json({ ok: true, reason: r.reason, topic: updated });
  });

  // Chat 补充：分享链接 → 提取对话 → LLM 整理 → 追加个股到指定专题（后台任务）
  app.post(`${API_PREFIX}/tools/watchlist/:id/import`, async (c) => {
    const id = c.req.param("id");
    if (!getTopic(id)) return c.json({ ok: false, message: "专题不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    const url = typeof raw?.url === "string" ? raw.url.trim() : "";
    if (!url) return c.json({ ok: false, message: "缺少 Chat 分享链接" }, 400);
    if (!/^https:\/\/chat\.deepseek\.com\/share\/[A-Za-z0-9_-]+$/.test(url)) {
      return c.json({ ok: false, message: "链接格式无效，应为 https://chat.deepseek.com/share/<id>" }, 400);
    }
    const { taskId } = createTask<WatchlistTopic>(
      async (signal) => importFromChat(url, signal, id),
      { timeoutMs: 10 * 60 * 1000, module: "watchlist.import", name: "专题 Chat 补充" },
    );
    return c.json(getTask<WatchlistTopic>(taskId), 202);
  });

  // Chat 导入任务状态
  app.get(`${API_PREFIX}/tools/watchlist/import/task/:taskId`, (c) => {
    const task: AsyncTaskResult<WatchlistTopic> | null = getTask<WatchlistTopic>(c.req.param("taskId"));
    if (!task) return c.json({ ok: false, message: "任务不存在或已过期" }, 404);
    return c.json(task, 200);
  });

  // Chat 补充预览：解析对话 → 候选个股（不落库；用户确认后才导入，memo msozzpcl）
  app.post(`${API_PREFIX}/tools/watchlist/:id/import/preview`, async (c) => {
    const id = c.req.param("id");
    if (!getTopic(id)) return c.json({ ok: false, message: "专题不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    const url = typeof raw?.url === "string" ? raw.url.trim() : "";
    if (!url) return c.json({ ok: false, message: "缺少 Chat 分享链接" }, 400);
    if (!/^https:\/\/chat\.deepseek\.com\/share\/[A-Za-z0-9_-]+$/.test(url)) {
      return c.json({ ok: false, message: "链接格式无效，应为 https://chat.deepseek.com/share/<id>" }, 400);
    }
    // 后台任务：解析（LLM 耗时）→ 结果存 KV 供确认接口读取
    const { taskId } = createTask<{ name: string; description?: string; stocks: WatchlistStock[] }>(
      async (signal) => {
        const parsed = await parseImportFromChat(url, signal);
        if (parsed.stocks.length === 0) throw new Error("Chat 对话中未识别到可补充的个股");
        kvSet(`watchlist:importPreview:${taskId}`, { ...parsed, _at: Date.now() });
        return parsed;
      },
      { timeoutMs: 10 * 60 * 1000, module: "watchlist.import", name: "专题 Chat 解析" },
    );
    return c.json(getTask<{ name: string; description?: string; stocks: WatchlistStock[] }>(taskId), 202);
  });

  // Chat 补充预览任务状态
  app.get(`${API_PREFIX}/tools/watchlist/:id/import/preview/task/:taskId`, (c) => {
    const task = getTask<{ name: string; description?: string; stocks: WatchlistStock[] }>(c.req.param("taskId"));
    if (!task) return c.json({ ok: false, message: "任务不存在或已过期" }, 404);
    // 附加候选（预览结果）
    const preview = kvGet<{ name: string; description?: string; stocks?: WatchlistStock[] }>(`watchlist:importPreview:${c.req.param("taskId")}`);
    return c.json({ ...task, preview: preview?.stocks ?? null }, 200);
  });

  // Chat 补充确认：读取预览候选 → 批量加入专题（memo msozzpcl）
  app.post(`${API_PREFIX}/tools/watchlist/:id/import/confirm`, async (c) => {
    const id = c.req.param("id");
    if (!getTopic(id)) return c.json({ ok: false, message: "专题不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { taskId?: unknown; codes?: unknown } | null;
    const taskId = typeof raw?.taskId === "string" ? raw.taskId : "";
    const codes = Array.isArray(raw?.codes) ? raw.codes.filter((x): x is string => typeof x === "string") : null;
    if (!taskId) return c.json({ ok: false, message: "缺少预览任务 id" }, 400);
    const preview = kvGet<{ name?: string; description?: string; stocks?: WatchlistStock[] }>(`watchlist:importPreview:${taskId}`);
    if (!preview?.stocks?.length) return c.json({ ok: false, message: "预览结果不存在或已过期，请重新解析" }, 404);
    // codes 指定 → 只导入勾选的；null → 全部
    const selected = codes ? preview.stocks.filter((s) => codes.includes(s.code)) : preview.stocks;
    if (selected.length === 0) return c.json({ ok: false, message: "未选择任何个股" }, 400);
    // 补名：无 name 的候选用行情工具解析（A股/港股/ETF 名称，缓存优先）
    for (const s of selected) {
      if (!s.name) {
        try {
          s.name = await resolveStockName(s.code);
          if (!s.name && /^\d{6}$/.test(s.code)) s.name = await resolveStockName(s.code, "fund"); // 2026-08-14：6 位纯数字可能是场外基金，股票行情查不到时走基金接口
        } catch { /* 保留 code 展示 */ }
      }
    }
    const updated = updateTopic(id, { addStocks: selected });
    if (!updated) return c.json({ ok: false, message: "补充失败" }, 500);
    // 用后即焚
    kvDelete(`watchlist:importPreview:${taskId}`);
    return c.json({ ok: true, topic: updated, imported: selected.length });
  });

  // 专题详情
  app.get(`${API_PREFIX}/tools/watchlist/:id`, (c) => {
    const topic = getTopic(c.req.param("id"));
    if (!topic) return c.json({ ok: false, message: "专题不存在" }, 404);
    const body: WatchlistDetailResult = { ok: true, topic };
    return c.json(body);
  });

  // 更新专题（改名 / 增删个股）
  app.put(`${API_PREFIX}/tools/watchlist/:id`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as WatchlistUpdateRequest | null;
    if (!raw || typeof raw !== "object") return c.json({ ok: false, message: "请求体无效" }, 400);
    const topic = updateTopic(c.req.param("id"), {
      name: raw.name,
      description: raw.description,
      group: raw.group,
      addStocks: Array.isArray(raw.addStocks) ? raw.addStocks : undefined,
      removeCodes: Array.isArray(raw.removeCodes) ? raw.removeCodes : undefined,
      reorderCodes: Array.isArray(raw.reorderCodes) ? raw.reorderCodes : undefined,
    });
    if (!topic) return c.json({ ok: false, message: "专题不存在" }, 404);
    return c.json({ ok: true, topic });
  });

  // 删除专题
  app.delete(`${API_PREFIX}/tools/watchlist/:id`, (c) => {
    const ok = deleteTopic(c.req.param("id"));
    if (!ok) return c.json({ ok: false, message: "专题不存在" }, 404);
    return c.json({ ok: true, deleted: 1 });
  });

  // 个股财报分析（LLM，后台任务 + 缓存）：POST ?code=xxx&force=1
  app.post(`${API_PREFIX}/tools/watchlist/:id/fundamental`, async (c) => {
    const id = c.req.param("id");
    const topic = getTopic(id);
    if (!topic) return c.json({ ok: false, message: "专题不存在" }, 404);

    const code = c.req.query("code")?.trim() ?? "";
    if (!isValidCode(code)) return c.json({ ok: false, message: "股票代码格式无效（如 sh600519/sz000001/hk00700/600519）" }, 400);
    const force = c.req.query("force") === "1";
    const stock = topic.stocks.find((s) => s.code === code);
    const name = stock?.name ?? undefined;

    const { taskId } = createTask<WatchlistFundamentalResult>(
      async (signal) => {
        const r = await fundamentalAnalysis(code, { force, name, signal });
        if (!r.ok) throw new Error(r.message || "财报分析失败");
        return r;
      },
      { timeoutMs: 10 * 60 * 1000, module: "watchlist.fundamental", name: `财报分析 · ${code}` },
    );
    return c.json(getTask<WatchlistFundamentalResult>(taskId), 202);
  });

  // 财报分析任务状态
  app.get(`${API_PREFIX}/tools/watchlist/:id/fundamental/task/:taskId`, (c) => {
    const task: AsyncTaskResult<WatchlistFundamentalResult> | null = getTask<WatchlistFundamentalResult>(c.req.param("taskId"));
    if (!task) return c.json({ ok: false, message: "任务不存在或已过期" }, 404);
    return c.json(task, 200);
  });
}
