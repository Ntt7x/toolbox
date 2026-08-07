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
import { registerDataSource } from "../../core/dataRegistry.js";
import { createTopic, deleteTopic, getTopic, listTopics, PREFIX, updateTopic } from "./store.js";
import { fundamentalAnalysis, importFromChat, optimizeReason, resolveStockName, extendPrompt } from "./service.js";
import { getQuoteSnapshots } from "../../core/quote.js";
import { getFundSnapshots } from "../../core/fund.js";

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

  // 专题列表（轻量）
  app.get(`${API_PREFIX}/tools/watchlist`, (c) => {
    return c.json({ ok: true, topics: listTopics() });
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
      { timeoutMs: 10 * 60 * 1000 },
    );
    return c.json(getTask<WatchlistTopic>(taskId), 202);
  });

  // 生成延续思路/扩展思考提示词（专题信息 → LLM；返回可粘贴 DeepSeek Chat 的提示词）
  app.post(`${API_PREFIX}/tools/watchlist/:id/extend-prompt`, async (c) => {
    const id = c.req.param("id");
    const t = getTopic(id);
    if (!t) return c.json({ ok: false, message: "专题不存在" }, 404);
    const r = await extendPrompt(t);
    if (!r.ok) return c.json({ ok: false, message: r.message }, 400);
    return c.json({ ok: true, prompt: r.prompt });
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
      { timeoutMs: 10 * 60 * 1000 },
    );
    return c.json(getTask<WatchlistTopic>(taskId), 202);
  });

  // Chat 导入任务状态
  app.get(`${API_PREFIX}/tools/watchlist/import/task/:taskId`, (c) => {
    const task: AsyncTaskResult<WatchlistTopic> | null = getTask<WatchlistTopic>(c.req.param("taskId"));
    if (!task) return c.json({ ok: false, message: "任务不存在或已过期" }, 404);
    return c.json(task, 200);
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
      { timeoutMs: 10 * 60 * 1000 },
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
