// ============================================================
// 业务模块：自选股（features/watchlist）
// - meta：工具注册信息
// - register：分组 CRUD + 四个功能面（行情跟踪 / 下沉分析 / 提醒设置 / 逻辑确认）
// ------------------------------------------------------------
// 依赖下层公共模块：core/kvStore、core/cache、core/data-infra（统一任务）、
//   core/quote（行情快照）、core/kline（日 K）、core/llm、core/prompts
// 本文件只做「路由 + 参数解析 + 编排」；业务规则在 store / track / alerts / logic（可单测）
// ============================================================

import { Hono } from "hono";
import {
  API_PREFIX,
  type ToolMeta,
  type WatchAlertRule,
  type WatchGroupCreateRequest,
  type WatchGroupDetailResult,
  type WatchGroupSummary,
  type WatchGroupUpdateRequest,
  type WatchItem,
  type WatchPeriod,
} from "@toolbox/shared";
import { newTaskId, registerTask, startTask } from "../../core/data-infra/index.js";
import { kvDelete, kvGet, kvSet } from "../../core/kvStore.js";
import { registerDataSource } from "../../core/dataRegistry.js";
import { searchStock } from "../../core/stockSearch.js";
import { getQuoteSnapshots } from "../../core/quote.js";
import { getFundSnapshots } from "../../core/fund.js";
import {
  ALERT_HIT_PREFIX,
  ALERT_PREFIX,
  LOGIC_PREFIX,
  PREFIX,
  createGroup,
  deleteGroup,
  getAlertHits,
  getAlertRules,
  getGroup,
  isAggGroup,
  listGroups,
  resolveItems,
  saveAlertHits,
  saveAlertRules,
  toSummary,
  updateGroup,
} from "./store.js";
import {
  fundamentalAnalysis,
  importFromChat,
  optimizeReason,
  parseImportFromChat,
  resolveStockName,
  extendPrompt,
} from "./service.js";
import { loadTrack, toAlertContexts, toTrackResult } from "./track.js";
import { applyOnceFired, evaluateRules, mergeHits, sanitizeRule, validateRule } from "./alerts.js";
import { loadNews } from "./news.js";
import { loadLogic, reviewItem } from "./logic.js";
import { getReviews } from "./store.js";

// ---------- 数据源注册（本地数据管理页可见/可编辑/可删除） ----------
registerDataSource({
  kind: "kv",
  name: PREFIX,
  page: "自选股",
  tag: "自选数据",
  description: "自选股分组（基础分组：自有标的；聚合分组：源分组并集，Key-结构化 Value）",
});
registerDataSource({
  kind: "kv",
  name: ALERT_PREFIX,
  page: "自选股",
  tag: "自选数据",
  description: "分组提醒规则（价格点位 / 涨跌幅 / 振幅，券商式提醒）",
});
registerDataSource({
  kind: "kv",
  name: ALERT_HIT_PREFIX,
  page: "自选股",
  tag: "自选数据",
  description: "提醒命中记录（按 ruleId + 交易日去重）",
});
registerDataSource({
  kind: "kv",
  name: LOGIC_PREFIX,
  page: "自选股",
  tag: "分析数据",
  description: "标的时间序列逻辑复核历史（watchlist:logic:<groupId>:<code>）",
});
registerDataSource({
  kind: "kv",
  name: "watchlist:extend:",
  page: "自选股",
  tag: "分析数据",
  description: "延续思路/扩展思考提示词结果缓存（LLM 驱动，内容哈希版本化）",
});
registerDataSource({
  kind: "kv",
  name: "watchlist:fundamental:",
  page: "自选股",
  tag: "分析数据",
  description: "标的财报分析结果缓存（LLM 驱动，按标的维度，与分组无关）",
});

export const meta: ToolMeta = {
  id: "watchlist",
  name: "自选股",
  description: "以标的为中心的分组跟踪：行情跟踪（日/周/月）· 下沉分析（财报/新闻）· 提醒设置（点位）· 逻辑确认",
  path: "/tools/watchlist",
};

/** 标的代码校验（sh/sz/hk 前缀或 5-6 位纯数字） */
function isValidCode(code: string): boolean {
  return /^(sh|sz|hk|bj)?\d{5,6}$/i.test(code);
}

/** 周期参数解析（非法 → 默认 day） */
function parsePeriod(raw: string | undefined): WatchPeriod {
  return raw === "week" || raw === "month" ? raw : "day";
}

/** Chat 分享链接格式校验 */
const SHARE_URL_RE = /^https:\/\/chat\.deepseek\.com\/share\/[A-Za-z0-9_-]+$/;

// ---------- 列表统计（等权平均涨幅 + 待确认逻辑 + 已触发提醒） ----------

/** 单次行情批量上限（与公共行情接口一致） */
const QUOTES_BATCH = 40;

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * 为分组列表附统计（一次性批量取数，避免 N 次重复取详情）：
 * - avgPct / avgCount：组内标的当日涨跌幅等权平均（聚合分组按并集统计）
 * - reviewCount：有理由/预期但从未复核、或最近复核结论为 review/exit 的标的数
 * - alertCount：当前行情下实时命中的提醒条数（用 loaded 的快照判定，不额外取数）
 */
async function attachStats(groups: WatchGroupSummary[]): Promise<WatchGroupSummary[]> {
  if (groups.length === 0) return groups;
  const all = listGroups();
  const byId = new Map(all.map((g) => [g.id, g]));
  const itemsById = new Map<string, WatchItem[]>();
  for (const g of groups) {
    const full = byId.get(g.id);
    if (full) itemsById.set(g.id, resolveItems(full));
  }
  const items = [...itemsById.values()].flat();
  const stockCodes = [...new Set(items.filter((i) => i.kind !== "fund").map((i) => i.code))];
  const fundCodes = [...new Set(items.filter((i) => i.kind === "fund").map((i) => i.code))];

  const [stockGroups, fundGroups] = await Promise.all([
    Promise.all(chunk(stockCodes, QUOTES_BATCH).map((c) => getQuoteSnapshots(c))),
    Promise.all(chunk(fundCodes, QUOTES_BATCH).map((c) => getFundSnapshots(c))),
  ]);
  // 索引：normCode（sh600519）+ 裸码（600519）双键 → 兼容用户输入的任意写法
  const pctByCode = new Map<string, number>();
  const priceByCode = new Map<string, number>();
  for (const q of [...stockGroups.flat(), ...fundGroups.flat()]) {
    if (!q.ok || typeof q.pct !== "number") continue;
    pctByCode.set(q.code, q.pct);
    const bare = q.code.replace(/^(sh|sz|hk|bj)/, "");
    if (bare !== q.code) pctByCode.set(bare, q.pct);
    const price = (q as { price?: number }).price ?? (q as { nav?: number }).nav;
    if (typeof price === "number") priceByCode.set(q.code, price);
  }

  return groups.map((g) => {
    const list = itemsById.get(g.id) ?? [];
    let sum = 0;
    let n = 0;
    for (const it of list) {
      const pct = pctByCode.get(it.code);
      if (typeof pct === "number") {
        sum += pct;
        n += 1;
      }
    }
    // 待确认逻辑：从未复核，或最近一次复核建议非 hold
    const reviewCount = list.filter((it) => {
      if (!it.reason && !it.expectation) return false;
      const history = getReviews(g.id, it.code);
      if (history.length === 0) return true;
      return history[history.length - 1].suggestion !== "hold";
    }).length;
    // 已触发提醒：当前行情下该分组规则的命中条数
    const rules = getAlertRules(g.id).filter((r) => r.enabled);
    const alertCount = rules.filter((r) => {
      const pct = pctByCode.get(r.code);
      const price = priceByCode.get(r.code);
      if (r.kind === "price") return typeof price === "number" && (r.dir === "up" ? price >= r.threshold : price <= r.threshold);
      if (typeof pct !== "number") return false;
      return r.dir === "up" ? pct >= r.threshold : pct <= -r.threshold;
    }).length;

    return {
      ...g,
      ...(n > 0 ? { avgPct: Math.round((sum / n) * 10000) / 10000, avgCount: n } : {}),
      ...(reviewCount > 0 ? { reviewCount } : {}),
      ...(alertCount > 0 ? { alertCount } : {}),
    };
  });
}

export function register(app: Hono): void {
  // ---------- 静态路由（须在 /:id 之前注册） ----------

  // 代码搜索（名称/拼音 → 候选；core/stockSearch，公共能力）
  app.get(`${API_PREFIX}/tools/watchlist/search-stock`, async (c) => {
    const name = (c.req.query("name") ?? "").trim();
    if (!name) return c.json({ ok: false, message: "请输入标的名称" }, 400);
    const limit = Math.min(10, Math.max(1, Number(c.req.query("limit") ?? 8) || 8));
    const items = await searchStock(name, limit);
    return c.json({ ok: true, items });
  });

  // 分组列表（轻量摘要 + 统计）
  app.get(`${API_PREFIX}/tools/watchlist`, async (c) => {
    const groups = listGroups().map(toSummary);
    return c.json({ ok: true, groups: await attachStats(groups) });
  });

  // 新建分组（基础分组 / 聚合分组）
  app.post(`${API_PREFIX}/tools/watchlist`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as WatchGroupCreateRequest | null;
    const name = raw?.name?.trim() ?? "";
    if (!name) return c.json({ ok: false, message: "缺少分组名称" }, 400);
    const sources = Array.isArray(raw?.aggSources) ? raw!.aggSources!.map((s) => String(s).trim()).filter(Boolean) : [];
    // 服务端权威校验：源分组必须存在、不得引用聚合分组（禁多层聚合，与仓位管理一致）
    if (sources.length > 0) {
      for (const sid of sources) {
        const g = getGroup(sid);
        if (!g) return c.json({ ok: false, message: `源分组不存在：${sid}` }, 400);
        if (isAggGroup(g)) return c.json({ ok: false, message: `聚合分组不可作为聚合来源：${g.name}` }, 400);
      }
    }
    const group = createGroup(name, raw?.description, sources);
    return c.json({ ok: true, group }, 201);
  });

  // 解析标的名称（标准行情工具）
  app.get(`${API_PREFIX}/tools/watchlist/resolve`, async (c) => {
    const code = c.req.query("code")?.trim() ?? "";
    const kind = c.req.query("kind")?.trim() ?? "stock";
    if (!code) return c.json({ ok: false, message: "缺少 code 参数" }, 400);
    const name = await resolveStockName(code, kind);
    return c.json({ ok: true, code, kind, name });
  });

  // 批量快照（标的列表基本信息展示；复用公共行情模块缓存）
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

  // Chat 导入：分享链接 → 提取对话 → LLM 整理 → 自动创建分组（后台任务）
  app.post(`${API_PREFIX}/tools/watchlist/import`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    const url = typeof raw?.url === "string" ? raw.url.trim() : "";
    if (!url) return c.json({ ok: false, message: "缺少 Chat 分享链接" }, 400);
    if (!SHARE_URL_RE.test(url)) return c.json({ ok: false, message: "链接格式无效，应为 https://chat.deepseek.com/share/<id>" }, 400);
    const taskId = newTaskId("watchlist-import");
    registerTask({
      id: taskId, type: "watchlist", name: "自选股 Chat 导入",
      handler: async (ctx) => {
        const r = await importFromChat(url, ctx.signal ?? new AbortController().signal);
        return { ok: true, message: "导入完成", result: r };
      },
    }, { ephemeral: true });
    startTask(taskId, { trigger: "manual" });
    return c.json({ ok: true, taskId }, 202);
  });

  // 移动/复制标的到其他分组（跨分组以标的为单位流转）
  app.post(`${API_PREFIX}/tools/watchlist/move-item`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { fromGroupId?: unknown; toGroupId?: unknown; code?: unknown; copy?: unknown } | null;
    const fromId = typeof raw?.fromGroupId === "string" ? raw.fromGroupId : "";
    const toId = typeof raw?.toGroupId === "string" ? raw.toGroupId : "";
    const code = typeof raw?.code === "string" ? raw.code.trim() : "";
    const copy = raw?.copy === true;
    if (!fromId || !toId || !code) return c.json({ ok: false, message: "缺少参数（fromGroupId/code/toGroupId）" }, 400);
    if (fromId === toId) return c.json({ ok: false, message: "目标分组与源分组相同" }, 400);
    const from = getGroup(fromId);
    const to = getGroup(toId);
    if (!from || !to) return c.json({ ok: false, message: "分组不存在" }, 404);
    if (isAggGroup(to)) return c.json({ ok: false, message: "聚合分组的标的来自源分组，请到源分组修改" }, 400);
    const item = from.items.find((s) => s.code === code);
    if (!item) return c.json({ ok: false, message: "标的不在源分组中" }, 404);
    const updatedTo = updateGroup(toId, { addItems: [item] });
    if (!updatedTo) return c.json({ ok: false, message: "添加失败" }, 500);
    if (!copy) updateGroup(fromId, { removeCodes: [code] });
    return c.json({ ok: true, fromGroup: getGroup(fromId), toGroup: updatedTo, moved: !copy });
  });

  // ---------- 分组级路由 ----------

  // 分组详情（聚合分组附带展开后的标的集合）
  app.get(`${API_PREFIX}/tools/watchlist/:id`, (c) => {
    const group = getGroup(c.req.param("id"));
    if (!group) return c.json({ ok: false, message: "分组不存在" }, 404);
    const body: WatchGroupDetailResult = { ok: true, group, items: resolveItems(group) };
    return c.json(body);
  });

  // 更新分组（改名 / 改介绍 / 改聚合来源 / 增删改标的 / 重排）
  app.put(`${API_PREFIX}/tools/watchlist/:id`, async (c) => {
    const id = c.req.param("id");
    const g = getGroup(id);
    if (!g) return c.json({ ok: false, message: "分组不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as WatchGroupUpdateRequest | null;
    if (!raw || typeof raw !== "object") return c.json({ ok: false, message: "请求体无效" }, 400);

    // 聚合分组的标的由源分组决定，不接受标的级改动（服务端权威校验，前端只是 UX 提示）
    const itemPatch = Array.isArray(raw.addItems) || Array.isArray(raw.updateItems) || Array.isArray(raw.removeCodes) || Array.isArray(raw.reorderCodes);
    if (isAggGroup(g) && itemPatch) {
      return c.json({ ok: false, message: "聚合分组的标的来自源分组，请到源分组修改" }, 400);
    }

    if (raw.aggSources !== undefined && raw.aggSources !== null && raw.aggSources.length > 0) {
      for (const sid of raw.aggSources.map((s) => String(s).trim())) {
        if (sid === id) return c.json({ ok: false, message: "聚合分组不可引用自身" }, 400);
        const src = getGroup(sid);
        if (!src) return c.json({ ok: false, message: `源分组不存在：${sid}` }, 400);
        if (isAggGroup(src)) return c.json({ ok: false, message: `聚合分组不可作为聚合来源：${src.name}` }, 400);
      }
    }

    const items = Array.isArray(raw.addItems) ? raw.addItems : undefined;
    if (items) {
      for (const it of items) {
        if (!it || typeof it.code !== "string" || !isValidCode(it.code.trim())) {
          return c.json({ ok: false, message: `标的代码格式无效：${String(it?.code ?? "")}（如 sh600519/600519/hk00700）` }, 400);
        }
      }
    }

    const group = updateGroup(id, {
      ...(raw.name !== undefined ? { name: raw.name } : {}),
      ...(raw.description !== undefined ? { description: raw.description } : {}),
      ...(raw.aggSources !== undefined ? { aggSources: raw.aggSources } : {}),
      ...(items ? { addItems: items } : {}),
      ...(Array.isArray(raw.updateItems) ? { updateItems: raw.updateItems } : {}),
      ...(Array.isArray(raw.removeCodes) ? { removeCodes: raw.removeCodes } : {}),
      ...(Array.isArray(raw.reorderCodes) ? { reorderCodes: raw.reorderCodes } : {}),
    });
    if (!group) return c.json({ ok: false, message: "分组不存在" }, 404);
    return c.json({ ok: true, group, items: resolveItems(group) });
  });

  // 删除分组（连带清理提醒/命中/复核历史，并从其它聚合分组摘除引用）
  app.delete(`${API_PREFIX}/tools/watchlist/:id`, (c) => {
    const ok = deleteGroup(c.req.param("id"));
    if (!ok) return c.json({ ok: false, message: "分组不存在" }, 404);
    return c.json({ ok: true, deleted: 1 });
  });

  // 行情跟踪（日/周/月）
  app.get(`${API_PREFIX}/tools/watchlist/:id/track`, async (c) => {
    const id = c.req.param("id");
    if (!getGroup(id)) return c.json({ ok: false, message: "分组不存在" }, 404);
    const period = parsePeriod(c.req.query("period"));
    const force = c.req.query("force") === "1";
    const bundle = await loadTrack(id, period, { force });
    if (!bundle) return c.json({ ok: false, message: "分组不存在" }, 404);
    return c.json({ ...toTrackResult(id, period, bundle), group: bundle.group });
  });

  // 下沉分析·新闻（标的维度；确定性关键词匹配，零 LLM）
  app.get(`${API_PREFIX}/tools/watchlist/:id/news`, async (c) => {
    const id = c.req.param("id");
    const g = getGroup(id);
    if (!g) return c.json({ ok: false, message: "分组不存在" }, 404);
    const code = c.req.query("code")?.trim() ?? "";
    if (!code) return c.json({ ok: false, message: "缺少 code 参数" }, 400);
    const item = resolveItems(g).find((i) => i.code === code);
    if (!item) return c.json({ ok: false, message: `标的 ${code} 不在该分组中` }, 400);
    return c.json(await loadNews(code, item.name));
  });

  // 下沉分析·财报（LLM，后台任务 + 缓存）：POST ?code=xxx&force=1
  app.post(`${API_PREFIX}/tools/watchlist/:id/fundamental`, async (c) => {
    const id = c.req.param("id");
    const g = getGroup(id);
    if (!g) return c.json({ ok: false, message: "分组不存在" }, 404);
    const code = c.req.query("code")?.trim() ?? "";
    if (!isValidCode(code)) return c.json({ ok: false, message: "标的代码格式无效（如 sh600519/sz000001/hk00700/600519）" }, 400);
    const item = resolveItems(g).find((i) => i.code === code);
    if (!item) return c.json({ ok: false, message: `标的 ${code} 不在该分组中` }, 400);
    const force = c.req.query("force") === "1";

    const taskId = newTaskId("watchlist-fundamental");
    registerTask({
      id: taskId, type: "watchlist", name: `财报分析 · ${code}`,
      handler: async (ctx) => {
        const r = await fundamentalAnalysis(code, { force, name: item.name, signal: ctx.signal ?? new AbortController().signal });
        if (!r.ok) throw new Error(r.message || "财报分析失败");
        return { ok: true, message: "分析完成", result: r };
      },
    }, { ephemeral: true });
    startTask(taskId, { trigger: "manual" });
    return c.json({ ok: true, taskId }, 202);
  });

  // 提醒设置：读取规则 + 命中（顺带用当前行情做一次判定并落库）
  app.get(`${API_PREFIX}/tools/watchlist/:id/alerts`, async (c) => {
    const id = c.req.param("id");
    if (!getGroup(id)) return c.json({ ok: false, message: "分组不存在" }, 404);
    const rules = getAlertRules(id);
    const history = getAlertHits(id);
    const bundle = await loadTrack(id, "day");
    if (!bundle) return c.json({ ok: false, message: "分组不存在" }, 404);
    // 判定（纯函数）→ 去重合并 → 落库；once 规则命中后自动停用
    const triggered = evaluateRules(rules.filter((r) => r.enabled), toAlertContexts(bundle));
    const merged = mergeHits(history, triggered);
    if (merged.length !== history.length || triggered.length > 0) saveAlertHits(id, merged);
    const nextRules = applyOnceFired(rules, merged);
    if (nextRules.some((r, i) => r.enabled !== rules[i].enabled)) saveAlertRules(id, nextRules);
    return c.json({
      ok: true,
      groupId: id,
      rules: nextRules,
      hits: merged.slice(0, 50),
      triggered,
      meta: bundle.meta,
    });
  });

  // 提醒设置：全量覆盖保存规则（服务端权威校验）
  app.put(`${API_PREFIX}/tools/watchlist/:id/alerts`, async (c) => {
    const id = c.req.param("id");
    const g = getGroup(id);
    if (!g) return c.json({ ok: false, message: "分组不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { rules?: unknown } | null;
    if (!raw || !Array.isArray(raw.rules)) return c.json({ ok: false, message: "请求体无效（rules 数组）" }, 400);
    const known = new Set(resolveItems(g).map((i) => i.code));
    const rules: WatchAlertRule[] = [];
    for (const r of raw.rules) {
      const rule = sanitizeRule(r);
      if (!rule) return c.json({ ok: false, message: "存在无效提醒规则（缺少标的代码/类型/阈值）" }, 400);
      const err = validateRule(rule, known);
      if (err) return c.json({ ok: false, message: err }, 400);
      rules.push(rule);
    }
    if (rules.length > 200) return c.json({ ok: false, message: "提醒规则过多（上限 200 条）" }, 400);
    return c.json({ ok: true, groupId: id, rules: saveAlertRules(id, rules) });
  });

  // 提醒设置：清空命中记录（规则保留）
  app.delete(`${API_PREFIX}/tools/watchlist/:id/alerts/hits`, (c) => {
    const id = c.req.param("id");
    if (!getGroup(id)) return c.json({ ok: false, message: "分组不存在" }, 404);
    saveAlertHits(id, []);
    return c.json({ ok: true, deleted: 1 });
  });

  // 逻辑确认：分组内每标的的理由/预期 + 最新复核 + 确定性锚
  app.get(`${API_PREFIX}/tools/watchlist/:id/logic`, async (c) => {
    const id = c.req.param("id");
    if (!getGroup(id)) return c.json({ ok: false, message: "分组不存在" }, 404);
    const force = c.req.query("force") === "1";
    const r = await loadLogic(id, { force });
    if (!r) return c.json({ ok: false, message: "分组不存在" }, 404);
    return c.json(r);
  });

  // 逻辑确认：对单个标的做一次复核（LLM，用户点击触发）
  app.post(`${API_PREFIX}/tools/watchlist/:id/logic/review`, async (c) => {
    const id = c.req.param("id");
    const g = getGroup(id);
    if (!g) return c.json({ ok: false, message: "分组不存在" }, 404);
    const code = c.req.query("code")?.trim() ?? "";
    if (!code) return c.json({ ok: false, message: "缺少 code 参数" }, 400);
    if (!resolveItems(g).some((i) => i.code === code)) return c.json({ ok: false, message: `标的 ${code} 不在该分组中` }, 400);
    const force = c.req.query("force") === "1";

    const taskId = newTaskId("watchlist-logic");
    registerTask({
      id: taskId, type: "watchlist", name: `逻辑复核 · ${code}`,
      handler: async (ctx) => {
        const r = await reviewItem(id, code, { force, signal: ctx.signal ?? new AbortController().signal });
        if (!r.ok) throw new Error(r.message || "逻辑复核失败");
        return { ok: true, message: "复核完成", result: r };
      },
    }, { ephemeral: true });
    startTask(taskId, { trigger: "manual" });
    return c.json({ ok: true, taskId }, 202);
  });

  // 逻辑确认：单个标的的复核历史（时间序列，体现「随时间」）
  app.get(`${API_PREFIX}/tools/watchlist/:id/logic/history`, (c) => {
    const id = c.req.param("id");
    if (!getGroup(id)) return c.json({ ok: false, message: "分组不存在" }, 404);
    const code = c.req.query("code")?.trim() ?? "";
    if (!code) return c.json({ ok: false, message: "缺少 code 参数" }, 400);
    return c.json({ ok: true, groupId: id, code, reviews: getReviews(id, code) });
  });

  // 生成延续思路/扩展思考提示词（分组信息 → LLM；内容哈希版本化缓存，force=1 刷新）
  app.post(`${API_PREFIX}/tools/watchlist/:id/extend-prompt`, async (c) => {
    const id = c.req.param("id");
    const g = getGroup(id);
    if (!g) return c.json({ ok: false, message: "分组不存在" }, 404);
    const r = await extendPrompt({ name: g.name, ...(g.description ? { description: g.description } : {}), items: resolveItems(g) });
    if (!r.ok) return c.json({ ok: false, message: r.message }, 400);
    return c.json({ ok: true, prompt: r.prompt });
  });

  // 根据财报分析优化入选理由（LLM；须先有 fundamental 缓存）
  app.post(`${API_PREFIX}/tools/watchlist/:id/optimize-reason`, async (c) => {
    const id = c.req.param("id");
    const g = getGroup(id);
    if (!g) return c.json({ ok: false, message: "分组不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { code?: unknown; reason?: unknown } | null;
    const code = typeof raw?.code === "string" ? raw.code.trim() : "";
    if (!code) return c.json({ ok: false, message: "缺少标的代码" }, 400);
    const item = resolveItems(g).find((s) => s.code === code);
    // code 必须在分组内（防经 addItems 注入任意字符串 code 污染数据）
    if (!item) return c.json({ ok: false, message: `标的 ${code} 不在该分组中` }, 400);
    if (isAggGroup(g)) return c.json({ ok: false, message: "聚合分组的标的来自源分组，请到源分组修改" }, 400);
    const reason = typeof raw?.reason === "string" ? raw.reason : item.reason;
    const r = await optimizeReason(code, { reason, name: item.name });
    if (!r.ok) return c.json({ ok: false, message: r.message }, 400);
    const updated = updateGroup(id, { updateItems: [{ ...item, reason: r.reason ?? item.reason }] });
    return c.json({ ok: true, reason: r.reason, group: updated });
  });

  // Chat 补充：分享链接 → 提取对话 → LLM 整理 → 追加标的到指定分组（后台任务）
  app.post(`${API_PREFIX}/tools/watchlist/:id/import`, async (c) => {
    const id = c.req.param("id");
    if (!getGroup(id)) return c.json({ ok: false, message: "分组不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    const url = typeof raw?.url === "string" ? raw.url.trim() : "";
    if (!url) return c.json({ ok: false, message: "缺少 Chat 分享链接" }, 400);
    if (!SHARE_URL_RE.test(url)) return c.json({ ok: false, message: "链接格式无效，应为 https://chat.deepseek.com/share/<id>" }, 400);
    const taskId = newTaskId("watchlist-import");
    registerTask({
      id: taskId, type: "watchlist", name: "自选股 Chat 补充",
      handler: async (ctx) => {
        const r = await importFromChat(url, ctx.signal ?? new AbortController().signal, id);
        return { ok: true, message: "补充完成", result: r };
      },
    }, { ephemeral: true });
    startTask(taskId, { trigger: "manual" });
    return c.json({ ok: true, taskId }, 202);
  });

  // Chat 补充预览：解析对话 → 候选标的（不落库；用户确认后才导入）
  app.post(`${API_PREFIX}/tools/watchlist/:id/import/preview`, async (c) => {
    const id = c.req.param("id");
    if (!getGroup(id)) return c.json({ ok: false, message: "分组不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    const url = typeof raw?.url === "string" ? raw.url.trim() : "";
    if (!url) return c.json({ ok: false, message: "缺少 Chat 分享链接" }, 400);
    if (!SHARE_URL_RE.test(url)) return c.json({ ok: false, message: "链接格式无效，应为 https://chat.deepseek.com/share/<id>" }, 400);
    const taskId = newTaskId("watchlist-import");
    registerTask({
      id: taskId, type: "watchlist", name: "自选股 Chat 解析",
      handler: async (ctx) => {
        const parsed = await parseImportFromChat(url, ctx.signal ?? new AbortController().signal);
        kvSet(`watchlist:importPreview:${ctx.taskId ?? taskId}`, { ...parsed, _at: Date.now() });
        return { ok: true, message: "解析完成", result: parsed };
      },
    }, { ephemeral: true });
    startTask(taskId, { trigger: "manual" });
    return c.json({ ok: true, taskId }, 202);
  });

  // Chat 补充确认：读取预览候选 → 批量加入分组
  app.post(`${API_PREFIX}/tools/watchlist/:id/import/confirm`, async (c) => {
    const id = c.req.param("id");
    const g = getGroup(id);
    if (!g) return c.json({ ok: false, message: "分组不存在" }, 404);
    if (isAggGroup(g)) return c.json({ ok: false, message: "聚合分组的标的来自源分组，请到源分组补充" }, 400);
    const raw = (await c.req.json().catch(() => null)) as { taskId?: unknown; codes?: unknown } | null;
    const taskId = typeof raw?.taskId === "string" ? raw.taskId : "";
    if (!taskId) return c.json({ ok: false, message: "缺少预览任务 id" }, 400);
    const codes = Array.isArray(raw?.codes) ? raw!.codes!.filter((x): x is string => typeof x === "string") : null;
    const preview = kvGet<{ name?: string; description?: string; items?: WatchItem[] }>(`watchlist:importPreview:${taskId}`);
    if (!preview?.items?.length) return c.json({ ok: false, message: "预览结果不存在或已过期，请重新解析" }, 404);
    // codes 指定 → 只导入勾选的；null → 全部
    const selected = codes ? preview.items.filter((s) => codes.includes(s.code)) : preview.items;
    if (selected.length === 0) return c.json({ ok: false, message: "未选择任何标的" }, 400);
    // 补名：无 name 的候选用行情工具解析（A股/港股/ETF 名称，缓存优先）
    for (const s of selected) {
      if (!s.name) {
        s.name = await resolveStockName(s.code);
        if (!s.name && /^\d{6}$/.test(s.code)) s.name = await resolveStockName(s.code, "fund"); // 6 位纯数字可能是场外基金
      }
    }
    const updated = updateGroup(id, { addItems: selected });
    if (!updated) return c.json({ ok: false, message: "补充失败" }, 500);
    kvDelete(`watchlist:importPreview:${taskId}`); // 用后即焚
    return c.json({ ok: true, group: updated, items: resolveItems(updated), imported: selected.length });
  });
}
