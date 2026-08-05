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
  type WatchlistUpdateRequest,
} from "@toolbox/shared";
import { createTask, getTask } from "../../core/tasks.js";
import { registerDataSource } from "../../core/dataRegistry.js";
import { createTopic, deleteTopic, getTopic, listTopics, PREFIX, updateTopic } from "./store.js";
import { fundamentalAnalysis, resolveStockName } from "./service.js";

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

export const meta: ToolMeta = {
  id: "watchlist",
  name: "专题自选股",
  description: "自建投资专题，收录个股与入选理由；一键 LLM 财报分析（联网搜索）",
  path: "/tools/watchlist",
};

/** 校验股票代码格式（宽松：sh/sz/hk 前缀或纯数字） */
function isValidCode(code: string): boolean {
  return /^(sh|sz|hk)?\d{5,6}$/i.test(code);
}

export function register(app: Hono): void {
  // 专题列表（轻量）
  app.get(`${API_PREFIX}/tools/watchlist`, (c) => {
    return c.json({ ok: true, topics: listTopics() });
  });

  // 新建专题
  app.post(`${API_PREFIX}/tools/watchlist`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as WatchlistCreateRequest | null;
    const name = raw?.name?.trim() ?? "";
    if (!name) return c.json({ ok: false, message: "缺少专题名称" }, 400);
    const topic = createTopic(name, raw?.description);
    return c.json({ ok: true, topic }, 201);
  });

  // 解析股票名称（标准行情工具）——必须在 /:id 之前注册（避免被当作 id）
  app.get(`${API_PREFIX}/tools/watchlist/resolve`, async (c) => {
    const code = c.req.query("code")?.trim() ?? "";
    if (!code) return c.json({ ok: false, message: "缺少 code 参数" }, 400);
    const name = await resolveStockName(code);
    return c.json({ ok: true, code, name });
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
      addStocks: Array.isArray(raw.addStocks) ? raw.addStocks : undefined,
      removeCodes: Array.isArray(raw.removeCodes) ? raw.removeCodes : undefined,
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

  // 解析股票名称（标准行情工具）
  app.get(`${API_PREFIX}/tools/watchlist/resolve`, async (c) => {
    const code = c.req.query("code")?.trim() ?? "";
    if (!code) return c.json({ ok: false, message: "缺少 code 参数" }, 400);
    const name = await resolveStockName(code);
    return c.json({ ok: true, code, name });
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
