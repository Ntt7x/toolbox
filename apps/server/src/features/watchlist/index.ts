// ============================================================
// 业务模块：自选股（features/watchlist）
// - meta：工具注册信息
// - register：tag 树 CRUD + 标的 CRUD + 四个功能面（行情跟踪 / 下沉分析 / 提醒设置 / 逻辑确认）
// ------------------------------------------------------------
// 概念模型（2026-09-02 二次重构）：标的为核心，多级 tag 为筛选维度。
// 四个功能面的服务对象一律是「单一标的」（不是分组、也不是 tag）。
// 依赖下层公共模块：core/kvStore、core/cache、core/data-infra（统一任务）、
//   core/quote（行情快照）、core/kline（日 K）、core/llm、core/prompts
// 本文件只做「路由 + 参数解析 + 编排」；业务规则在 store / track / alerts / logic（可单测）
// ============================================================

import { Hono } from "hono";
import { getIntraday, getKlineBars, supportedPeriods } from "../../core/kline.js";
import {
  API_PREFIX,
  MINUTE_KLINE_PERIODS,
  WATCH_KLINE_PERIOD_LABEL,
  WATCH_KLINE_PERIODS,
  WATCH_ROOT_TAG,
  type ToolMeta,
  type WatchAlertRule,
  type WatchDataMeta,
  type WatchIntradayResult,
  type WatchItem,
  type WatchItemRow,
  type WatchItemUpdateRequest,
  type WatchKlineBar,
  type WatchKlinePeriod,
  type WatchKlineResult,
  type WatchTagNode,
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
  ITEM_PREFIX,
  LOGIC_PREFIX,
  PREFIX,
  TAG_PREFIX,
  createItem,
  createTag,
  deleteItem,
  deleteTag,
  ensureReady,
  filterItemsByTag,
  getAlertHits,
  getAlertRules,
  getItem,
  getReviews,
  getTag,
  listItems,
  saveAlertHits,
  saveAlertRules,
  tagTree,
  updateItem,
  updateTag,
} from "./store.js";
import {
  fundamentalAnalysis,
  importFromChat,
  optimizeReason,
  parseImportFromChat,
  resolveStockName,
  extendPrompt,
} from "./service.js";
import { loadTrack, toAlertContexts } from "./track.js";
import { applyOnceFired, evaluateRules, mergeHits, sanitizeRule, validateRule } from "./alerts.js";
import { loadNews } from "./news.js";
import { loadLogic, reviewItem } from "./logic.js";

// ---------- 数据源注册（本地数据管理页可见/可编辑/可删除） ----------
registerDataSource({
  kind: "kv",
  name: TAG_PREFIX,
  page: "自选股",
  tag: "自选数据",
  description: "自选股多级 tag（树形筛选标签，「全部」为预置根）",
});
registerDataSource({
  kind: "kv",
  name: ITEM_PREFIX,
  page: "自选股",
  tag: "自选数据",
  description: "自选股标的（代码 + 入选理由 + 预期 + 所属 tag）",
});
registerDataSource({
  kind: "kv",
  name: ALERT_PREFIX,
  page: "自选股",
  tag: "自选数据",
  description: "标的提醒规则（价格点位 / 涨跌幅 / 振幅，券商式提醒；挂标的，跨 tag 复用）",
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
  description: "标的时间序列逻辑复核历史（watchlist:logic:<code>）",
});
registerDataSource({
  kind: "kv",
  name: "watchlist:migrated",
  page: "自选股",
  tag: "运行状态",
  description: "历史「分组」数据升级标记（记录升级时间与统计；删掉会触发重新升级，幂等）",
});
registerDataSource({
  kind: "kv",
  name: "watchlist:importPreview:",
  page: "自选股",
  tag: "分析数据",
  description: "Chat 导入预览候选（用后即焚，确认导入后自动删除）",
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
  description: "标的财报分析结果缓存（LLM 驱动，按标的维度）",
});

export const meta: ToolMeta = {
  id: "watchlist",
  name: "自选股",
  description: "以标的为核心、多级 tag 为筛选维度：行情跟踪（日/周/月）· 下沉分析（财报/新闻）· 提醒设置（点位）· 逻辑确认",
  path: "/tools/watchlist",
};

/** 标的代码校验（sh/sz/hk/bj 前缀或 5-6 位纯数字） */
function isValidCode(code: string): boolean {
  return /^(sh|sz|hk|bj)?\d{5,6}$/i.test(code);
}

/** 券商式 K 线默认拉取根数（≈两年交易日） */
const KLINE_COUNT = 500;

/** Chat 分享链接格式校验 */
const SHARE_URL_RE = /^https:\/\/chat\.deepseek\.com\/share\/[A-Za-z0-9_-]+$/;

/** 单次行情批量上限（与公共行情接口一致） */
const QUOTES_BATCH = 40;

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * 标的列表装配：批量行情快照 + 待复核/已触发提醒计数。
 * 一次性批量取数（避免 N 次单标的请求）；取数失败的标的缺省处理（不静默置 0）。
 */
async function toRows(items: WatchItem[]): Promise<{ rows: WatchItemRow[]; triggeredByCode: Map<string, number> }> {
  if (items.length === 0) return { rows: [], triggeredByCode: new Map() };
  const stockCodes = [...new Set(items.filter((i) => i.kind !== "fund").map((i) => i.code))];
  const fundCodes = [...new Set(items.filter((i) => i.kind === "fund").map((i) => i.code))];
  const [stockGroups, fundGroups] = await Promise.all([
    Promise.all(chunk(stockCodes, QUOTES_BATCH).map((c) => getQuoteSnapshots(c))),
    Promise.all(chunk(fundCodes, QUOTES_BATCH).map((c) => getFundSnapshots(c))),
  ]);
  // 索引：normCode（sh600519）+ 裸码（600519）双键 → 兼容用户输入的任意写法
  const snapByCode = new Map<string, { pct?: number; price?: number; name?: string }>();
  for (const q of [...stockGroups.flat(), ...fundGroups.flat()]) {
    if (!q.ok) continue;
    const price = (q as { price?: number }).price ?? (q as { nav?: number }).nav;
    const rec: { pct?: number; price?: number; name?: string } = {};
    if (typeof q.pct === "number") rec.pct = q.pct;
    if (typeof price === "number") rec.price = price;
    if (typeof q.name === "string" && q.name) rec.name = q.name;
    snapByCode.set(q.code, rec);
    const bare = q.code.replace(/^(sh|sz|hk|bj)/, "");
    if (bare !== q.code) snapByCode.set(bare, rec);
  }

  // 已触发提醒数：当前行情对该标的规则的命中条数（纯函数判定，不额外取数）
  const triggeredByCode = new Map<string, number>();
  for (const it of items) {
    const snap = snapByCode.get(it.code);
    const n = getAlertRules(it.code).filter((r) => {
      if (!r.enabled) return false;
      if (r.kind === "price") return typeof snap?.price === "number" && (r.dir === "up" ? snap.price >= r.threshold : snap.price <= r.threshold);
      if (typeof snap?.pct !== "number") return false;
      return r.dir === "up" ? snap.pct >= r.threshold : snap.pct <= -r.threshold;
    }).length;
    if (n > 0) triggeredByCode.set(it.code, n);
  }

  const rows: WatchItemRow[] = items.map((it) => {
    const snap = snapByCode.get(it.code);
    const history = getReviews(it.code);
    const last = history.length > 0 ? history[history.length - 1] : null;
    // 待复核：有理由/预期但从未复核，或最近一次结论非 hold
    const needReview = (it.reason || it.expectation) && (!last || last.suggestion !== "hold");
    // 缺名标的：先用本次已取的快照名回填（零额外成本），拿不到再走行情工具二次解析
    const resolvedName = !it.name ? snap?.name || "" : it.name;
    return {
      code: it.code,
      ...(resolvedName ? { name: resolvedName } : {}),
      ...(it.kind ? { kind: it.kind } : {}),
      reason: it.reason,
      ...(it.expectation ? { expectation: it.expectation } : {}),
      ...(typeof it.targetPrice === "number" ? { targetPrice: it.targetPrice } : {}),
      addedAt: it.addedAt,
      tags: it.tags,
      ...(typeof snap?.price === "number" ? { price: snap.price } : {}),
      ...(typeof snap?.pct === "number" ? { pct: snap.pct } : {}),
      ...(needReview ? { reviewCount: 1 } : {}),
      ...(triggeredByCode.has(it.code) ? { alertCount: triggeredByCode.get(it.code) as number } : {}),
    };
  });

  // 持久化缺名标的的解析结果（快照名优先；缺失则异步行情工具补，写回 KV 避免下次仍显示代码）。
  // 仅对确有名称可补的标的落库，避免空名覆盖/空写。
  await Promise.all(
    items
      .filter((it) => !it.name)
      .map(async (it) => {
        const fromSnap = snapByCode.get(it.code)?.name;
        const name = fromSnap || (await resolveStockName(it.code, it.kind));
        if (name) updateItem(it.code, { name });
      }),
  );

  return { rows, triggeredByCode };
}

/** tag 树（含标的数量统计） */
function tree(): WatchTagNode[] {
  return tagTree();
}

/**
 * 给 tag 树注入「含后代的等权平均日涨跌幅」。
 * 放在路由层而非 store：平均涨跌幅依赖实时行情快照（store 是同步纯存储层，不取数）。
 */
async function treeWithAvg(): Promise<WatchTagNode[]> {
  const nodes = tagTree();
  const items = listItems();
  const { rows } = await toRows(items);
  const pctByCode = new Map<string, number>();
  for (const r of rows) if (typeof r.pct === "number") pctByCode.set(r.code, r.pct);

  // 预计算每个 tag 的后代集合（避免对每个节点重复遍历树）
  const descCache = new Map<string, Set<string>>();
  const attach = (n: WatchTagNode): void => {
    const ids = new Set<string>();
    const stack = [n];
    while (stack.length) {
      const cur = stack.pop() as WatchTagNode;
      ids.add(cur.id);
      for (const c of cur.children) stack.push(c);
    }
    descCache.set(n.id, ids);
    for (const c of n.children) attach(c);
  };
  for (const n of nodes) attach(n);

  const fill = (n: WatchTagNode): WatchTagNode => {
    const ids = descCache.get(n.id) ?? new Set([n.id]);
    const seen = new Set<string>();
    let sum = 0;
    let count = 0;
    for (const it of items) {
      if (seen.has(it.code)) continue;
      if (!it.tags.some((t) => ids.has(t))) continue;
      const pct = pctByCode.get(it.code);
      if (typeof pct !== "number") continue;
      seen.add(it.code); // 同一标的在多个子 tag 下只计一次（去重）
      sum += pct;
      count++;
    }
    return {
      ...n,
      ...(count > 0 ? { avgPct: sum / count, avgCount: count } : {}),
      children: n.children.map(fill),
    };
  };
  return nodes.map(fill);
}

export function register(app: Hono): void {
  // 任意读路径前确保：根 tag 存在 + 历史「分组」数据已升级为 tag/标的
  ensureReady();

  // ---------- tag 树 ----------

  // tag 树（含平均涨跌幅）+ 全量标的（首屏一次拿齐，之后局部刷新走 /items）
  app.get(`${API_PREFIX}/tools/watchlist/tags`, async (c) => {
    const items = listItems();
    const [tags, { rows }] = await Promise.all([treeWithAvg(), toRows(items)]);
    return c.json({ ok: true, tags, items: rows });
  });

  // 新建 tag（parentId 缺省 →「全部」下）
  app.post(`${API_PREFIX}/tools/watchlist/tags`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { name?: unknown; parentId?: unknown } | null;
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    if (!name) return c.json({ ok: false, message: "缺少 tag 名称" }, 400);
    const parentId = typeof raw?.parentId === "string" && raw.parentId ? raw.parentId : WATCH_ROOT_TAG;
    if (!getTag(parentId)) return c.json({ ok: false, message: "父 tag 不存在" }, 404);
    const tag = createTag(name, parentId);
    if (!tag) return c.json({ ok: false, message: "创建失败" }, 500);
    return c.json({ ok: true, tag, tags: tree() }, 201);
  });

  // 更新 tag：改名 / 移动（换父）/ 排序
  app.put(`${API_PREFIX}/tools/watchlist/tags/:id`, async (c) => {
    const id = c.req.param("id");
    if (!getTag(id)) return c.json({ ok: false, message: "tag 不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { name?: unknown; parentId?: unknown; sort?: unknown } | null;
    if (!raw || typeof raw !== "object") return c.json({ ok: false, message: "请求体无效" }, 400);
    if (id === WATCH_ROOT_TAG && raw.parentId !== undefined && raw.parentId !== null) {
      return c.json({ ok: false, message: "根 tag「全部」不可移动" }, 400);
    }
    const patch: { name?: string; parentId?: string | null; sort?: number } = {};
    if (typeof raw.name === "string") patch.name = raw.name;
    if (raw.parentId !== undefined) {
      const pid = typeof raw.parentId === "string" && raw.parentId ? raw.parentId : WATCH_ROOT_TAG;
      if (!getTag(pid)) return c.json({ ok: false, message: "目标父 tag 不存在" }, 404);
      patch.parentId = pid;
    }
    if (raw.sort !== undefined) {
      const n = Number(raw.sort);
      if (Number.isFinite(n)) patch.sort = n;
    }
    const tag = updateTag(id, patch);
    if (!tag) return c.json({ ok: false, message: "更新失败（可能是把 tag 移到了自己的子级下）" }, 400);
    return c.json({ ok: true, tag, tags: tree() });
  });

  // 删除 tag：promote（默认，子级与标的提升到父级）/ cascade（连同子 tag 一起删）
  app.delete(`${API_PREFIX}/tools/watchlist/tags/:id`, async (c) => {
    const id = c.req.param("id");
    if (!getTag(id)) return c.json({ ok: false, message: "tag 不存在" }, 404);
    if (id === WATCH_ROOT_TAG) return c.json({ ok: false, message: "根 tag「全部」不可删除" }, 400);
    const mode = c.req.query("mode") === "cascade" ? "cascade" : "promote";
    const r = deleteTag(id, mode);
    if (!r) return c.json({ ok: false, message: "删除失败" }, 500);
    return c.json({ ok: true, deletedTags: r.deletedTags, affectedItems: r.affectedItems, tags: tree() });
  });

  // ---------- 标的（核心实体） ----------

  // 标的列表（按 tag 筛选；tag 缺省 = 全部）
  app.get(`${API_PREFIX}/tools/watchlist/items`, async (c) => {
    const tagId = c.req.query("tag")?.trim() ?? "";
    if (tagId && !getTag(tagId)) return c.json({ ok: false, message: "tag 不存在" }, 404);
    const items = filterItemsByTag(tagId || null);
    const { rows } = await toRows(items);
    return c.json({ ok: true, items: rows, tagId: tagId || null });
  });

  // 新增标的
  app.post(`${API_PREFIX}/tools/watchlist/items`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as {
      code?: unknown; name?: unknown; kind?: unknown; reason?: unknown;
      expectation?: unknown; targetPrice?: unknown; tags?: unknown;
    } | null;
    const code = typeof raw?.code === "string" ? raw.code.trim() : "";
    if (!isValidCode(code)) return c.json({ ok: false, message: "标的代码格式无效（如 sh600519/sz000001/hk00700/600519）" }, 400);
    for (const t of Array.isArray(raw?.tags) ? raw!.tags! : []) {
      if (typeof t === "string" && t && !getTag(t)) return c.json({ ok: false, message: `tag 不存在：${t}` }, 400);
    }
    const item = createItem({
      code,
      ...(typeof raw?.name === "string" ? { name: raw.name } : {}),
      ...(raw?.kind === "fund" ? { kind: "fund" as const } : {}),
      ...(typeof raw?.reason === "string" ? { reason: raw.reason } : {}),
      ...(typeof raw?.expectation === "string" ? { expectation: raw.expectation } : {}),
      ...(typeof raw?.targetPrice === "number" ? { targetPrice: raw.targetPrice } : {}),
      ...(Array.isArray(raw?.tags) ? { tags: raw!.tags!.filter((x): x is string => typeof x === "string") } : {}),
    });
    const [row] = (await toRows([item])).rows;
    return c.json({ ok: true, item: row, tags: tree() }, 201);
  });

  // 更新标的（理由 / 预期 / 目标价 / tag 归属）
  app.put(`${API_PREFIX}/tools/watchlist/items/:code`, async (c) => {
    const code = c.req.param("code");
    if (!getItem(code)) return c.json({ ok: false, message: "标的不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as WatchItemUpdateRequest | null;
    if (!raw || typeof raw !== "object") return c.json({ ok: false, message: "请求体无效" }, 400);
    if (Array.isArray(raw.tags)) {
      for (const t of raw.tags) {
        if (typeof t !== "string" || !getTag(t)) return c.json({ ok: false, message: `tag 不存在：${String(t)}` }, 400);
      }
    }
    const item = updateItem(code, {
      ...(typeof raw.name === "string" ? { name: raw.name } : {}),
      ...(raw.kind === "fund" || raw.kind === "stock" ? { kind: raw.kind } : {}),
      ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
      ...(typeof raw.expectation === "string" ? { expectation: raw.expectation } : {}),
      ...(raw.targetPrice === null ? { targetPrice: null } : typeof raw.targetPrice === "number" ? { targetPrice: raw.targetPrice } : {}),
      ...(Array.isArray(raw.tags) ? { tags: raw.tags } : {}),
      ...(typeof raw.addedAt === "string" && raw.addedAt ? { addedAt: raw.addedAt } : {}),
    });
    if (!item) return c.json({ ok: false, message: "标的不存在" }, 404);
    const [row] = (await toRows([item])).rows;
    return c.json({ ok: true, item: row, tags: tree() });
  });

  // 删除标的（连带清理其提醒/命中/复核历史）
  app.delete(`${API_PREFIX}/tools/watchlist/items/:code`, (c) => {
    const ok = deleteItem(c.req.param("code"));
    if (!ok) return c.json({ ok: false, message: "标的不存在" }, 404);
    return c.json({ ok: true, code: c.req.param("code"), tags: tree() });
  });

  // ---------- 四个功能面（服务对象 = 单一标的） ----------

  // 行情跟踪：K 线序列（多周期：日/周/月 前复权 + 5/15/30/60 分钟 不复权）
  // K 线本身已表达 OHLC / 涨跌 / 成交量，故不再提供「周期聚合明细表」这类可被 K 线表达的冗余视图
  app.get(`${API_PREFIX}/tools/watchlist/items/:code/kline`, async (c) => {
    const code = c.req.param("code");
    const item = getItem(code);
    if (!item) return c.json({ ok: false, message: "标的不存在" }, 404);
    const force = c.req.query("force") === "1";
    const supported = supportedPeriods(code, item.kind);
    // 周期白名单校验：非法值静默回落日 K（不报错打断看图），并在 note 里回显实际周期
    const asked = c.req.query("period") as WatchKlinePeriod | undefined;
    const period: WatchKlinePeriod = asked && WATCH_KLINE_PERIODS.includes(asked) && asked !== "min" ? asked : "day";
    // count=500 ≈ 两年交易日（券商图默认跨度）；缓存增量合并，历史只增不减
    const raw = await getKlineBars(code, { period, count: KLINE_COUNT, force });
    // 旧缓存/部分行情源缺 OHLC → 过滤掉不成 K 的行（缺失即不画，不用快照伪造 K）
    const bars: WatchKlineBar[] = raw
      .filter((b) => typeof b.open === "number" && typeof b.high === "number" && typeof b.low === "number")
      .map((b) => ({
        date: b.date,
        ...(b.time ? { time: b.time } : {}),
        open: b.open as number,
        high: b.high as number,
        low: b.low as number,
        close: b.close,
        ...(typeof b.volume === "number" ? { volume: b.volume } : {}),
      }));
    const hasVolume = bars.some((b) => typeof b.volume === "number");
    const isMinute = MINUTE_KLINE_PERIODS.includes(period);
    const caveats: string[] = [];
    if (bars.length === 0) {
      caveats.push(
        item.kind === "fund"
          ? "场外基金为净值型，无 K 线数据"
          : isMinute
            ? "该标的无分钟 K 数据（行情源仅对沪深两市提供分钟 K）"
            : "无 K 线数据（数据源不可达或代码无行情）",
      );
    } else {
      // 复权口径必须显式标注：分钟 K 无复权，除权日会看到假跳空（用户最容易误读的点）
      if (isMinute) caveats.push("分钟 K 为不复权数据，除权除息日会出现跳空（非真实涨跌）");
      if (!hasVolume) caveats.push("该行情源未提供成交量，成交量副图不可绘制");
    }
    const meta: WatchDataMeta = {
      sources: ["tencent.kline"],
      fetchedAt: new Date().toISOString(),
      ...(caveats.length ? { caveats } : {}),
    };
    const label = WATCH_KLINE_PERIOD_LABEL[period];
    const unit = isMinute ? "根" : "个交易日";
    return c.json({
      ok: true,
      code,
      ...(item.name ? { name: item.name } : {}),
      ...(item.kind ? { kind: item.kind } : {}),
      period,
      bars,
      supported,
      note: `腾讯${label}（${isMinute ? "不复权" : "前复权"}）· 最近 ${bars.length} ${unit}`,
      meta,
    } satisfies WatchKlineResult);
  });

  // 行情跟踪：分时（1 分钟价格线 + 均价线 + 昨收基准；非交易日返回最近一个交易日）
  app.get(`${API_PREFIX}/tools/watchlist/items/:code/intraday`, async (c) => {
    const code = c.req.param("code");
    const item = getItem(code);
    if (!item) return c.json({ ok: false, message: "标的不存在" }, 404);
    const force = c.req.query("force") === "1";
    const data = await getIntraday(code, { force });
    const supported = supportedPeriods(code, item.kind);
    const caveats: string[] = [];
    if (!data || data.points.length === 0) {
      caveats.push(item.kind === "fund" ? "场外基金为净值型，无分时数据" : "无分时数据（数据源不可达或代码无行情）");
    } else if (!Number.isFinite(data.prevClose)) {
      caveats.push("行情源未提供昨收价，分时涨跌基准线不可绘制");
    }
    const meta: WatchDataMeta = {
      sources: ["tencent.kline"],
      fetchedAt: new Date().toISOString(),
      ...(data?.fromCache ? { fromCache: true } : {}),
      ...(caveats.length ? { caveats } : {}),
    };
    return c.json({
      ok: true,
      code,
      ...(item.name ? { name: item.name } : {}),
      ...(item.kind ? { kind: item.kind } : {}),
      date: data?.date ?? "",
      prevClose: data?.prevClose ?? Number.NaN,
      points: data?.points ?? [],
      supported,
      note: data?.date ? `腾讯分时（${data.date}）· ${data.points.length} 个分钟点` : "腾讯分时",
      meta,
    } satisfies WatchIntradayResult);
  });

  // 下沉分析·新闻（确定性关键词匹配，零 LLM）
  app.get(`${API_PREFIX}/tools/watchlist/items/:code/news`, async (c) => {
    const code = c.req.param("code");
    const item = getItem(code);
    if (!item) return c.json({ ok: false, message: "标的不存在" }, 404);
    return c.json(await loadNews(code, item.name));
  });

  // 下沉分析·财报（LLM，后台任务 + 缓存）
  app.post(`${API_PREFIX}/tools/watchlist/items/:code/fundamental`, async (c) => {
    const code = c.req.param("code");
    const item = getItem(code);
    if (!item) return c.json({ ok: false, message: "标的不存在" }, 404);
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
  app.get(`${API_PREFIX}/tools/watchlist/items/:code/alerts`, async (c) => {
    const code = c.req.param("code");
    const item = getItem(code);
    if (!item) return c.json({ ok: false, message: "标的不存在" }, 404);
    const rules = getAlertRules(code);
    const history = getAlertHits(code);
    const bundle = await loadTrack([item], "day");
    const triggered = evaluateRules(rules.filter((r) => r.enabled), toAlertContexts(bundle));
    const merged = mergeHits(history, triggered);
    if (merged.length !== history.length || triggered.length > 0) saveAlertHits(code, merged);
    const nextRules = applyOnceFired(rules, merged);
    if (nextRules.some((r, i) => r.enabled !== rules[i].enabled)) saveAlertRules(code, nextRules);
    return c.json({ ok: true, code, rules: nextRules, hits: merged.slice(0, 50), triggered, meta: bundle.meta });
  });

  // 提醒设置：全量覆盖保存规则（服务端权威校验）
  app.put(`${API_PREFIX}/tools/watchlist/items/:code/alerts`, async (c) => {
    const code = c.req.param("code");
    if (!getItem(code)) return c.json({ ok: false, message: "标的不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { rules?: unknown } | null;
    if (!raw || !Array.isArray(raw.rules)) return c.json({ ok: false, message: "请求体无效（rules 数组）" }, 400);
    const rules: WatchAlertRule[] = [];
    for (const r of raw.rules) {
      const rule = sanitizeRule(r);
      if (!rule) return c.json({ ok: false, message: "存在无效提醒规则（缺少标的代码/类型/阈值）" }, 400);
      if (rule.code !== code) return c.json({ ok: false, message: `规则的标的代码必须为 ${code}` }, 400);
      const err = validateRule(rule, new Set([code]));
      if (err) return c.json({ ok: false, message: err }, 400);
      rules.push(rule);
    }
    if (rules.length > 200) return c.json({ ok: false, message: "提醒规则过多（上限 200 条）" }, 400);
    return c.json({ ok: true, code, rules: saveAlertRules(code, rules) });
  });

  // 提醒设置：清空命中记录（规则保留）
  app.delete(`${API_PREFIX}/tools/watchlist/items/:code/alerts/hits`, (c) => {
    const code = c.req.param("code");
    if (!getItem(code)) return c.json({ ok: false, message: "标的不存在" }, 404);
    saveAlertHits(code, []);
    return c.json({ ok: true, deleted: 1 });
  });

  // 逻辑确认：单标的理由/预期 + 最新复核 + 确定性锚 + 复核历史
  app.get(`${API_PREFIX}/tools/watchlist/items/:code/logic`, async (c) => {
    const code = c.req.param("code");
    const item = getItem(code);
    if (!item) return c.json({ ok: false, message: "标的不存在" }, 404);
    const force = c.req.query("force") === "1";
    return c.json(await loadLogic(item, { force }));
  });

  // 逻辑确认：对单个标的做一次复核（LLM，用户点击触发）
  app.post(`${API_PREFIX}/tools/watchlist/items/:code/logic/review`, async (c) => {
    const code = c.req.param("code");
    const item = getItem(code);
    if (!item) return c.json({ ok: false, message: "标的不存在" }, 404);
    const force = c.req.query("force") === "1";
    const taskId = newTaskId("watchlist-logic");
    registerTask({
      id: taskId, type: "watchlist", name: `逻辑复核 · ${code}`,
      handler: async (ctx) => {
        const r = await reviewItem(item, { force, signal: ctx.signal ?? new AbortController().signal });
        if (!r.ok) throw new Error(r.message || "逻辑复核失败");
        return { ok: true, message: "复核完成", result: r };
      },
    }, { ephemeral: true });
    startTask(taskId, { trigger: "manual" });
    return c.json({ ok: true, taskId }, 202);
  });

  // 逻辑确认：复核历史（时间序列，体现「随时间」）
  app.get(`${API_PREFIX}/tools/watchlist/items/:code/logic/history`, (c) => {
    const code = c.req.param("code");
    if (!getItem(code)) return c.json({ ok: false, message: "标的不存在" }, 404);
    return c.json({ ok: true, code, reviews: getReviews(code) });
  });

  // 根据财报分析优化入选理由（LLM；须先有 fundamental 缓存）
  app.post(`${API_PREFIX}/tools/watchlist/items/:code/optimize-reason`, async (c) => {
    const code = c.req.param("code");
    const item = getItem(code);
    if (!item) return c.json({ ok: false, message: "标的不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { reason?: unknown } | null;
    const reason = typeof raw?.reason === "string" ? raw.reason : item.reason;
    const r = await optimizeReason(code, { reason, name: item.name });
    if (!r.ok) return c.json({ ok: false, message: r.message }, 400);
    const updated = updateItem(code, { reason: r.reason ?? item.reason });
    return c.json({ ok: true, reason: r.reason, item: updated });
  });

  // ---------- 辅助 / Chat 导入 ----------

  // 代码搜索（名称/拼音 → 候选；core/stockSearch，公共能力）
  app.get(`${API_PREFIX}/tools/watchlist/search-stock`, async (c) => {
    const name = (c.req.query("name") ?? "").trim();
    if (!name) return c.json({ ok: false, message: "请输入标的名称" }, 400);
    const limit = Math.min(10, Math.max(1, Number(c.req.query("limit") ?? 8) || 8));
    const items = await searchStock(name, limit);
    return c.json({ ok: true, items });
  });

  // 解析标的名称（标准行情工具）
  app.get(`${API_PREFIX}/tools/watchlist/resolve`, async (c) => {
    const code = c.req.query("code")?.trim() ?? "";
    const kind = c.req.query("kind")?.trim() ?? "stock";
    if (!code) return c.json({ ok: false, message: "缺少 code 参数" }, 400);
    const name = await resolveStockName(code, kind);
    return c.json({ ok: true, code, kind, name });
  });

  // 批量快照（标的列表展示；复用公共行情模块缓存）
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

  // 生成延续思路/扩展思考提示词（当前 tag 下的标的 → LLM；内容哈希版本化缓存）
  app.post(`${API_PREFIX}/tools/watchlist/extend-prompt`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { tagId?: unknown } | null;
    const tagId = typeof raw?.tagId === "string" && raw.tagId ? raw.tagId : WATCH_ROOT_TAG;
    const tag = getTag(tagId);
    if (!tag) return c.json({ ok: false, message: "tag 不存在" }, 404);
    const items = filterItemsByTag(tagId);
    const r = await extendPrompt({ name: tag.name, items });
    if (!r.ok) return c.json({ ok: false, message: r.message }, 400);
    return c.json({ ok: true, prompt: r.prompt });
  });

  // Chat 导入：分享链接 → 提取对话 → LLM 整理 → 建 tag 并挂标的（后台任务）
  app.post(`${API_PREFIX}/tools/watchlist/import`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { url?: unknown; tagId?: unknown } | null;
    const url = typeof raw?.url === "string" ? raw.url.trim() : "";
    if (!url) return c.json({ ok: false, message: "缺少 Chat 分享链接" }, 400);
    if (!SHARE_URL_RE.test(url)) return c.json({ ok: false, message: "链接格式无效，应为 https://chat.deepseek.com/share/<id>" }, 400);
    const tagId = typeof raw?.tagId === "string" && raw.tagId ? raw.tagId : undefined;
    if (tagId && !getTag(tagId)) return c.json({ ok: false, message: "tag 不存在" }, 404);
    const taskId = newTaskId("watchlist-import");
    registerTask({
      id: taskId, type: "watchlist", name: "自选股 Chat 导入",
      handler: async (ctx) => {
        const r = await importFromChat(url, ctx.signal ?? new AbortController().signal, tagId);
        return { ok: true, message: "导入完成", result: r };
      },
    }, { ephemeral: true });
    startTask(taskId, { trigger: "manual" });
    return c.json({ ok: true, taskId }, 202);
  });

  // Chat 导入预览：解析对话 → 候选标的（不落库；用户确认后才导入）
  app.post(`${API_PREFIX}/tools/watchlist/import/preview`, async (c) => {
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

  // Chat 导入确认：读取预览候选 → 批量建标的并挂到指定 tag
  app.post(`${API_PREFIX}/tools/watchlist/import/confirm`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { taskId?: unknown; tagId?: unknown; codes?: unknown } | null;
    const taskId = typeof raw?.taskId === "string" ? raw.taskId : "";
    if (!taskId) return c.json({ ok: false, message: "缺少预览任务 id" }, 400);
    const tagId = typeof raw?.tagId === "string" && raw.tagId ? raw.tagId : WATCH_ROOT_TAG;
    if (!getTag(tagId)) return c.json({ ok: false, message: "tag 不存在" }, 404);
    const preview = kvGet<{ name?: string; items?: WatchItem[] }>(`watchlist:importPreview:${taskId}`);
    if (!preview?.items?.length) return c.json({ ok: false, message: "预览结果不存在或已过期，请重新解析" }, 404);
    const codes = Array.isArray(raw?.codes) ? raw!.codes!.filter((x): x is string => typeof x === "string") : null;
    const selected = codes ? preview.items.filter((s) => codes.includes(s.code)) : preview.items;
    if (selected.length === 0) return c.json({ ok: false, message: "未选择任何标的" }, 400);
    // 补名：无 name 的候选用行情工具解析（A股/港股/ETF 名称，缓存优先）
    for (const s of selected) {
      if (!s.name) {
        s.name = await resolveStockName(s.code);
        if (!s.name && /^\d{6}$/.test(s.code)) s.name = await resolveStockName(s.code, "fund"); // 6 位纯数字可能是场外基金
      }
    }
    for (const s of selected) {
      if (!s.code) continue;
      const cur = getItem(s.code);
      const tags = Array.from(new Set([...(cur?.tags ?? []), tagId]));
      if (cur) updateItem(s.code, { tags, ...(s.reason ? { reason: s.reason } : {}) });
      else createItem({ ...s, tags });
    }
    kvDelete(`watchlist:importPreview:${taskId}`); // 用后即焚
    const { rows } = await toRows(filterItemsByTag(tagId));
    return c.json({ ok: true, items: rows, tags: tree(), imported: selected.length });
  });
}
