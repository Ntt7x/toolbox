// ============================================================
// 业务模块：仓位管理 v2（features/tradeV2）——Hono 路由薄壳
// 业务全部走 ctx 上的 Cordis 服务（tradeV2Group / tradeV2Ledger / tradeV2Analysis）
// 单一数据源：仓位/复盘/汇总 = 账本重放派生；所有组约束校验服务端权威（§6.7）
// ============================================================
import { Hono } from "hono";
import type { Context } from "hono";
import { API_PREFIX, type ToolMeta, type TradeV2CheckResult, type TradeV2Entry } from "@toolbox/shared";
import { registerDataSource } from "../../core/dataRegistry.js";
import { getTradeV2Ctx } from "./context.js";
import { registerSnapshotTask } from "./snapshotTask.js";
import { parseEntryInput, parseStockLimits, resolveStockNameCached, type TradeV2EntryInput } from "./services.js";
import { listGroups } from "./store.js";
import { summarizeOrder, todayStr } from "./compute.js";

export const meta: ToolMeta = {
  id: "trade-v2",
  name: "仓位管理 v2",
  description: "逐笔交易账本 + 仓位明细（自动派生）+ 分组约束（总仓位/单日加仓/单标的上限）与分析复盘",
  path: "/tools/trade-v2",
};

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function registerTradeV2Feature(app: Hono) {
  registerDataSource({
    kind: "kv",
    name: "tradeV2:",
    page: meta.name,
    tag: "交易数据",
    description: "仓位管理 v2：分组（tradeV2:group:）与逐笔交易（tradeV2:trade:）",
  });

  // 净值快照任务（数据工程集成运用）：每日收盘后调度生成日终快照序列
  registerSnapshotTask(getTradeV2Ctx);

  // ---------- 总览：分组摘要 + 全部交易 ----------

  app.get(`${API_PREFIX}/tools/trade-v2`, async (c: Context) => {
    const ctx = await getTradeV2Ctx();
    const groups = ctx.tradeV2Group.list();
    const summaries = await Promise.all(groups.map((g) => ctx.tradeV2Analysis.groupSummary(g)));
    const entries = await ctx.tradeV2Ledger.enrichNames(ctx.tradeV2Ledger.list(), groups);
    return c.json({ ok: true, groups: summaries, entries });
  });

  // ---------- 分组 ----------

  app.get(`${API_PREFIX}/tools/trade-v2/groups/:id/stocks`, async (c: Context) => {
    const ctx = await getTradeV2Ctx();
    const id = c.req.param("id")!;
    const group = ctx.tradeV2Group.get(id);
    if (!group) return c.json({ ok: false, message: "分组不存在" }, 404);
    return c.json({ ok: true, stocks: await ctx.tradeV2Ledger.stocksOfGroup(id) });
  });
  app.get(`${API_PREFIX}/tools/trade-v2/groups/:id`, async (c: Context) => {
    const ctx = await getTradeV2Ctx();
    const r = await ctx.tradeV2Analysis.groupAnalysis(c.req.param("id")!);
    if (!r) return c.json({ ok: false, message: "分组不存在" }, 404);
    return c.json({ ok: true, group: r.group, analysis: r.analysis });
  });

  app.post(`${API_PREFIX}/tools/trade-v2/groups`, async (c: Context) => {
    const raw = (await c.req.json().catch(() => null)) as { name?: unknown; infoType?: unknown; isPaper?: unknown } | null;
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    if (!name) return c.json({ ok: false, message: "分组名称不能为空" }, 400);
    if (listGroups().some((g) => g.name === name)) {
      return c.json({ ok: false, message: `分组名称「${name}」已存在，请换一个名称` }, 400);
    }
    const ctx = await getTradeV2Ctx();
    const infoType = raw?.infoType === "info" || raw?.infoType === "noinfo" ? raw.infoType : undefined;
    const isPaper = raw?.isPaper === true;
    return c.json({ ok: true, group: ctx.tradeV2Group.create(name, infoType, isPaper) });
  });

  app.put(`${API_PREFIX}/tools/trade-v2/groups/:id`, async (c: Context) => {
    const id = c.req.param("id");
    if (!id) return c.json({ ok: false, message: "分组不存在" }, 404);
    const ctx = await getTradeV2Ctx();
    const cur = ctx.tradeV2Group.get(id);
    if (!cur) return c.json({ ok: false, message: "分组不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      totalCapital?: unknown;
      dailyAddLimit?: unknown;
      stockLimits?: unknown;
      allowShort?: unknown;
      infoType?: unknown;
      isPaper?: unknown;
    } | null;
    if (!raw || typeof raw !== "object") return c.json({ ok: false, message: "请求体无效" }, 400);
    if (typeof raw.name === "string" && raw.name.trim() && raw.name.trim() !== cur.name) {
      if (listGroups().some((g) => g.name === raw.name!.toString().trim())) {
        return c.json({ ok: false, message: `分组名称「${raw.name}」已存在，请换一个名称` }, 400);
      }
    }
    const totalCapital = raw.totalCapital !== undefined ? num(raw.totalCapital) : undefined;
    const dailyAddLimit = raw.dailyAddLimit !== undefined ? num(raw.dailyAddLimit) : undefined;
    if (totalCapital === undefined && raw.totalCapital !== undefined) return c.json({ ok: false, message: "总仓位必须为非负数值" }, 400);
    if (dailyAddLimit === undefined && raw.dailyAddLimit !== undefined) return c.json({ ok: false, message: "单日加仓上限必须为非负数值" }, 400);
    // 单标的上限：服务端权威校验（0~100，越界 400）
    if (Array.isArray(raw.stockLimits)) {
      for (const x of raw.stockLimits) {
        if (typeof x !== "object" || x === null) continue;
        const s = x as { code?: unknown; maxWeightPct?: unknown };
        if (s.maxWeightPct === undefined || s.maxWeightPct === null || s.maxWeightPct === "") continue;
        const n = Number(s.maxWeightPct);
        if (!Number.isFinite(n) || n <= 0 || n > 100) {
          return c.json({ ok: false, message: `标的 ${String(s.code ?? "").trim() || "(未填代码)"} 的仓位上限需在 0-100% 之间` }, 400);
        }
      }
    }
    const stockLimits = raw.stockLimits !== undefined ? parseStockLimits(raw.stockLimits) : undefined;
    const g = ctx.tradeV2Group.update(id, {
      name: typeof raw.name === "string" ? raw.name : undefined,
      totalCapital,
      dailyAddLimit,
      ...(stockLimits !== undefined ? { stockLimits } : {}),
      ...(typeof raw.allowShort === "boolean" ? { allowShort: raw.allowShort } : {}),
      ...(typeof raw.isPaper === "boolean" ? { isPaper: raw.isPaper } : {}),
      ...(raw.infoType === "info" || raw.infoType === "noinfo" || raw.infoType === null ? { infoType: raw.infoType } : {}),
    });
    return c.json({ ok: true, group: g });
  });

  // 删除分组（连带其全部交易；需用户确认由前端发起）
  app.delete(`${API_PREFIX}/tools/trade-v2/groups/:id`, async (c: Context) => {
    const id = c.req.param("id");
    const ctx = await getTradeV2Ctx();
    if (!id || !ctx.tradeV2Group.remove(id)) return c.json({ ok: false, message: "分组不存在" }, 404);
    return c.json({ ok: true });
  });

  // ---------- 交易账本 ----------

  // 校验（preview，不入库）——静态路由必须在 /entries/:id 之前注册
  app.post(`${API_PREFIX}/tools/trade-v2/entries/check`, async (c: Context) => {
    const ctx = await getTradeV2Ctx();
    const raw = await c.req.json().catch(() => null);
    const parsed = parseEntryInput(raw);
    if (!parsed.ok) return c.json({ ok: false, message: parsed.message }, 400);
    const group = ctx.tradeV2Group.get(parsed.entry.groupId);
    if (!group) return c.json({ ok: false, message: "分组不存在" }, 400);
    const base = ctx.tradeV2Ledger.listByGroup(group.id);
    const all = withTempEntry(base, parsed.entry);
    const result = await ctx.tradeV2Analysis.check(group, all, parsed.entry.date);
    // 校验接口不因未通过而 400（前端展示明细）；保存类接口才 reject
    return c.json({ ok: true, result });
  });

  // 每日交易单批量提交（整批校验 → 入库；逐标的净归并汇总；createdAt 阶梯化保持行序）——静态路由
  app.post(`${API_PREFIX}/tools/trade-v2/entries/batch`, async (c: Context) => {
    const ctx = await getTradeV2Ctx();
    const raw = (await c.req.json().catch(() => null)) as { items?: unknown; preview?: unknown } | null;
    const preview = raw?.preview === true;
    const itemsRaw = Array.isArray(raw?.items) ? raw.items : null;
    if (!itemsRaw || itemsRaw.length === 0) return c.json({ ok: false, message: "交易单为空（至少一行）" }, 400);
    if (itemsRaw.length > 200) return c.json({ ok: false, message: "交易单行数过多（上限 200）" }, 400);
    const parsed = itemsRaw.map((x) => parseEntryInput(x));
    const bad = parsed.find((r) => !r.ok);
    if (bad && !bad.ok) return c.json({ ok: false, message: bad.message }, 400);
    const items = parsed.map((r) => (r as { ok: true; entry: TradeV2EntryInput }).entry);
    const group = ctx.tradeV2Group.get(items[0]!.groupId);
    if (!group) return c.json({ ok: false, message: "分组不存在" }, 400);
    const date = items[0]!.date;
    // 整批校验：全量条目 = 现有 + 本单（createdAt 阶梯化保持行内顺序，同日期买卖不误判）
    const base = ctx.tradeV2Ledger.listByGroup(group.id);
    const now = Date.now();
    const temp: TradeV2Entry[] = items.map((it, i) => ({
      ...it,
      id: `__batch_${i}`,
      createdAt: new Date(now + i).toISOString(),
      updatedAt: new Date(now + i).toISOString(),
    }));
    const result = await ctx.tradeV2Analysis.check(group, [...base, ...temp], date);
    const daySummary = summarizeOrder(base, items);
    // 校验预览：即使未通过也返回完整 result（前端展示明细并禁用提交，体验优于 400 报错）
    if (preview) return c.json({ ok: true, createdCount: 0, result, daySummary, preview: true });
    if (!result.ok) return reject(c, result);
    // 名称补全（交易员可读性）：条目名称 → 分组上限配置 → 行情解析（同 code 只解析一次）
    const limitName = new Map<string, string>();
    for (const s of group.stockLimits) if (s.name && !limitName.has(s.code)) limitName.set(s.code, s.name);
    const missing = [...new Set(items.filter((it) => !it.name && !limitName.get(it.code)).map((it) => it.code))];
    const resolved = new Map<string, string>();
    for (const code of missing) {
      const n = await resolveStockNameCached(code);
      if (n) resolved.set(code, n);
    }
    // 入库（createdAt 阶梯化 → 重放顺序 = 行序）
    let createdCount = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const name = it.name ?? limitName.get(it.code) ?? resolved.get(it.code);
      ctx.tradeV2Ledger.create(name ? { ...it, name } : it, { createdAt: new Date(now + i).toISOString() });
      createdCount++;
    }
    return c.json({ ok: true, createdCount, result, daySummary });
  });

  // 新增交易（校验 → 入库）
  app.post(`${API_PREFIX}/tools/trade-v2/entries`, async (c: Context) => {
    const ctx = await getTradeV2Ctx();
    const raw = await c.req.json().catch(() => null);
    const parsed = parseEntryInput(raw);
    if (!parsed.ok) return c.json({ ok: false, message: parsed.message }, 400);
    const group = ctx.tradeV2Group.get(parsed.entry.groupId);
    if (!group) return c.json({ ok: false, message: "分组不存在" }, 400);
    const base = ctx.tradeV2Ledger.listByGroup(group.id);
    const all = withTempEntry(base, parsed.entry);
    const result = await ctx.tradeV2Analysis.check(group, all, parsed.entry.date);
    if (!result.ok) return reject(c, result);
    // 名称补全（交易员可读性）：条目名称 → 分组上限配置 → 行情解析
    const limitName = group.stockLimits.find((s) => s.code === parsed.entry.code)?.name;
    const resolvedName = parsed.entry.name ?? limitName ?? ((await resolveStockNameCached(parsed.entry.code)) || undefined);
    const entry = ctx.tradeV2Ledger.create({ ...parsed.entry, ...(resolvedName ? { name: resolvedName } : {}) });
    return c.json({ ok: true, entry, result });
  });

  // 编辑交易（校验 → 更新；重放自动重算全部派生）
  app.put(`${API_PREFIX}/tools/trade-v2/entries/:id`, async (c: Context) => {
    const id = c.req.param("id");
    const ctx = await getTradeV2Ctx();
    const cur = ctx.tradeV2Ledger.get(id!);
    if (!cur) return c.json({ ok: false, message: "交易不存在" }, 404);
    const raw = await c.req.json().catch(() => null);
    const parsed = parseEntryInput(raw);
    if (!parsed.ok) return c.json({ ok: false, message: parsed.message }, 400);
    const group = ctx.tradeV2Group.get(parsed.entry.groupId);
    if (!group) return c.json({ ok: false, message: "分组不存在" }, 400);
    const base = ctx.tradeV2Ledger.listByGroup(group.id).filter((e) => e.id !== id);
    const all = withTempEntry(base, parsed.entry);
    const result = await ctx.tradeV2Analysis.check(group, all, parsed.entry.date);
    if (!result.ok) return reject(c, result);
    const limitName = group.stockLimits.find((s) => s.code === parsed.entry.code)?.name;
    const entry = ctx.tradeV2Ledger.update(id!, {
      ...parsed.entry,
      ...(!parsed.entry.name && limitName ? { name: limitName } : {}),
    });
    return c.json({ ok: true, entry, result });
  });

  // 删除交易（删除后剩余条目仍需自洽——卖出不能无买入支撑；违规则拒绝）
  app.delete(`${API_PREFIX}/tools/trade-v2/entries/:id`, async (c: Context) => {
    const id = c.req.param("id");
    const ctx = await getTradeV2Ctx();
    const cur = ctx.tradeV2Ledger.get(id!);
    if (!cur) return c.json({ ok: false, message: "交易不存在" }, 404);
    const group = ctx.tradeV2Group.get(cur.groupId);
    if (!group) return c.json({ ok: false, message: "分组不存在" }, 404);
    const remaining = ctx.tradeV2Ledger.listByGroup(group.id).filter((e) => e.id !== id);
    const result = await ctx.tradeV2Analysis.check(group, remaining);
    if (!result.ok) return reject(c, result);
    ctx.tradeV2Ledger.remove(id!);
    return c.json({ ok: true });
  });

  // ---------- 标的移动分组（memo mt2ttvqd） ----------

  app.post(`${API_PREFIX}/tools/trade-v2/move-stock`, async (c: Context) => {
    const ctx = await getTradeV2Ctx();
    const body = await c.req.json().catch(() => null);
    const code = String(body?.code ?? "").trim();
    const fromGroupId = String(body?.fromGroupId ?? "");
    const toGroupId = String(body?.toGroupId ?? "");
    if (!code || !fromGroupId || !toGroupId) return c.json({ ok: false, message: "缺少参数（code/fromGroupId/toGroupId）" }, 400);
    if (fromGroupId === toGroupId) return c.json({ ok: false, message: "目标分组不能与原分组相同" }, 400);
    const from = ctx.tradeV2Group.get(fromGroupId);
    const to = ctx.tradeV2Group.get(toGroupId);
    if (!from || !to) return c.json({ ok: false, message: "分组不存在" }, 404);
    const moved = ctx.tradeV2Ledger.moveStock(fromGroupId, code, toGroupId);
    return c.json({ ok: true, moved });
  });

  // ---------- 全局分析（跨组） ----------

  app.get(`${API_PREFIX}/tools/trade-v2/analysis`, async (c: Context) => {
    const ctx = await getTradeV2Ctx();
    return c.json({ ok: true, analysis: await ctx.tradeV2Analysis.global() });
  });
}

/** 把待校验条目并入全量列表（临时对象仅用于校验；不入库） */
function withTempEntry(base: TradeV2Entry[], entry: TradeV2EntryInput): TradeV2Entry[] {
  const now = new Date().toISOString();
  return [...base, { ...entry, id: "__pending__", createdAt: now, updatedAt: now }];
}

function reject(c: Context, result: TradeV2CheckResult): Response {
  const errs = result.alerts.filter((a) => a.level === "error");
  const reason = errs.map((a) => (a.detail ? `${a.message}（${a.detail}）` : a.message)).join("；");
  return c.json({ ok: false, message: "交易违反分组仓位管理，无法保存", result, rejectReason: reason }, 400);
}
