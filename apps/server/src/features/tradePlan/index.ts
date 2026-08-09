// ============================================================
// 业务模块：交易规划（features/tradePlan）
// 多策略：每策略独立配置（总仓位/交易标的/单日加仓上限）+ 当前仓位（positions）。
// 日度计划保存即「应用」：自动按计划更新当前仓位（同日覆盖先回滚再重应用）。
// 校验日度交易计划是否符合策略配置与仓位控制，给出提醒与告警（纯程序，无 LLM）。
// ============================================================
import { Hono } from "hono";
import type { Context } from "hono";
import {
  API_PREFIX,
  type ToolMeta,
  type TradePlanCheckResult,
  type TradePlanItem,
  type TradePlanPosition,
  type TradePlanStockCfg,
} from "@toolbox/shared";
import { registerDataSource } from "../../core/dataRegistry.js";
import { getQuoteSnapshot } from "../../core/quote.js";
import { applyItems, checkTradePlan } from "./compute.js";
import {
  createDay,
  createStrategy,
  deleteDay,
  deleteStrategy,
  getStrategy,
  listDays,
  listStrategies,
  migrateLegacyConfig,
  replayPositions,
  updateStrategy,
} from "./store.js";

registerDataSource({
  kind: "kv",
  name: "tradePlan:",
  page: "策略仓位管理",
  tag: "交易数据",
  description: "交易规划：策略配置（tradePlan:strategy:）与日度交易计划（tradePlan:day:<策略>:）",
});

export const meta: ToolMeta = {
  id: "trade-plan",
  name: "策略仓位管理",
  description: "多策略配置（总仓位/标的/单日加仓上限）+ 当前仓位管理，校验并应用日度交易计划，给出提醒与告警",
  path: "/tools/trade-plan",
};

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function register(app: Hono): void {
  migrateLegacyConfig();

  // ---------- 策略 ----------

  // 策略列表
  app.get(`${API_PREFIX}/tools/trade-plan/strategies`, (c: Context) => {
    return c.json({ ok: true, strategies: listStrategies() });
  });

  // 单策略详情
  app.get(`${API_PREFIX}/tools/trade-plan/strategies/:id`, (c: Context) => {
    const st = getStrategy(c.req.param("id")!);
    if (!st) return c.json({ ok: false, message: "策略不存在" }, 404);
    return c.json({ ok: true, strategy: st });
  });

  // 新建策略（名称唯一）
  app.post(`${API_PREFIX}/tools/trade-plan/strategies`, async (c: Context) => {
    const raw = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    if (!name) return c.json({ ok: false, message: "策略名称不能为空" }, 400);
    if (listStrategies().some((s) => s.name === name)) {
      return c.json({ ok: false, message: `策略名称「${name}」已存在，请换一个名称` }, 400);
    }
    return c.json({ ok: true, strategy: createStrategy(name) });
  });

  // 更新策略（名称唯一，不含自己）
  app.put(`${API_PREFIX}/tools/trade-plan/strategies/:id`, async (c: Context) => {
    const id = c.req.param("id");
    if (!id) return c.json({ ok: false, message: "策略不存在" }, 404);
    const cur = getStrategy(id);
    if (!cur) return c.json({ ok: false, message: "策略不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      totalCapital?: unknown;
      dailyAddLimit?: unknown;
      stocks?: unknown;
      positions?: unknown;
    } | null;
    if (!raw || typeof raw !== "object") return c.json({ ok: false, message: "请求体无效" }, 400);
    if (typeof raw.name === "string" && raw.name.trim() && raw.name.trim() !== cur.name) {
      if (listStrategies().some((s) => s.name === raw.name!.toString().trim())) {
        return c.json({ ok: false, message: `策略名称「${raw.name}」已存在，请换一个名称` }, 400);
      }
    }
    const totalCapital = raw.totalCapital !== undefined ? num(raw.totalCapital) : undefined;
    const dailyAddLimit = raw.dailyAddLimit !== undefined ? num(raw.dailyAddLimit) : undefined;
    if (totalCapital === undefined && raw.totalCapital !== undefined) return c.json({ ok: false, message: "总仓位必须为非负数值" }, 400);
    if (dailyAddLimit === undefined && raw.dailyAddLimit !== undefined) return c.json({ ok: false, message: "单日加仓上限必须为非负数值" }, 400);
    const stocks = raw.stocks !== undefined ? parseStocks(raw.stocks) : undefined;
    // 服务端查重：同一策略不允许重复 code
    if (stocks && stocks.length > 0) {
      const seen = new Set<string>();
      const dup = stocks.find((x) => (seen.has(x.code) ? true : (seen.add(x.code), false)));
      if (dup) return c.json({ ok: false, message: `标的 ${dup.code} 重复，请合并为一行` }, 400);
    }
    const positions = raw.positions !== undefined ? parsePositions(raw.positions) : undefined;
    // 服务端校验：当前数量非零时成本价必填（金额 = 数量 × 成本价）
    if (positions) {
      const badPos = positions.find((p) => p.code && p.quantity > 0 && !(p.avgCost > 0));
      if (badPos) return c.json({ ok: false, message: `标的 ${badPos.code} 当前数量为 ${badPos.quantity}，成本价必填` }, 400);
    }
    const st = updateStrategy(id, {
      name: typeof raw.name === "string" ? raw.name : undefined,
      totalCapital,
      dailyAddLimit,
      stocks,
      positions,
      // 手动保存仓位 → 固化为基线（日度计划重放的起点）
      ...(positions !== undefined ? { basePositions: positions.map((p) => ({ ...p })) } : {}),
    });
    return c.json({ ok: true, strategy: st });
  });

  // 删除策略（连带日度计划）
  app.delete(`${API_PREFIX}/tools/trade-plan/strategies/:id`, (c: Context) => {
    const id = c.req.param("id");
    if (!id || !deleteStrategy(id)) return c.json({ ok: false, message: "策略不存在" }, 404);
    return c.json({ ok: true });
  });

  // ---------- 日度计划（按策略） ----------

  // 需要行情兜底的标的（无本次 cost 且无持仓均价）→ 批量取行情最新价
  const buildPriceFallback = async (st: { positions?: TradePlanPosition[] }, items: TradePlanItemParsed[]) => {
    const need: string[] = [];
    for (const it of items) {
      if (it.cost && it.cost > 0) continue;
      const pos = st.positions?.find((p) => p.code === it.code);
      if (pos?.avgCost && pos.avgCost > 0) continue;
      if (!need.includes(it.code)) need.push(it.code);
    }
    if (need.length === 0) return undefined;
    const map: Record<string, number> = {};
    for (const code of need) {
      try {
        const snap = await getQuoteSnapshot(code, {});
        const px = Number(snap?.price);
        if (px > 0) map[code] = px;
      } catch { /* 行情不可得则无 fallback（走 error 分支） */ }
    }
    return Object.keys(map).length > 0 ? map : undefined;
  };

  // 校验（preview，不入库）
  app.post(`${API_PREFIX}/tools/trade-plan/strategies/:id/check`, async (c: Context) => {
    const st = getStrategy(c.req.param("id")!);
    if (!st) return c.json({ ok: false, message: "策略不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { items?: unknown } | null;
    const items = parseItems(raw?.items);
    if (!items) return c.json({ ok: false, message: "计划条目无效（需含代码/操作/金额）" }, 400);
    const priceFallback = await buildPriceFallback(st, items);
    const result = checkTradePlan(st, items, { priceFallback });
    return c.json({ ok: result.ok, result, previewOnly: true });
  });

  // 创建日度计划（校验 → 保存 → 自动应用更新当前仓位；同日覆盖先回滚再重应用）
  app.post(`${API_PREFIX}/tools/trade-plan/strategies/:id/day`, async (c: Context) => {
    const st = getStrategy(c.req.param("id")!);
    if (!st) return c.json({ ok: false, message: "策略不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { date?: unknown; items?: unknown } | null;
    const date = typeof raw?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : todayStr();
    const items = parseItems(raw?.items);
    if (!items || items.length === 0) return c.json({ ok: false, message: "计划条目无效（需至少一条）" }, 400);

    // 仓位 = 基线重放（剔除该日后）→ 保证同日覆盖/多日链一致
    const positions = replayPositions(st, date);
    const checkConfig = { ...st, positions };
    const priceFallback = await buildPriceFallback(checkConfig, items);
    const result = checkTradePlan(checkConfig, items, { priceFallback });
    // 违反策略仓位管理（有 error 级告警）→ 拒绝保存
    if (!result.ok) {
      return c.json({ ok: false, message: "计划违反策略仓位管理，无法保存", result, rejectReason: result.alerts.find((a) => a.level === "error")?.message }, 400);
    }
    const before = positions;
    const after = applyItems(before, items);
    const now = new Date().toISOString();
    const day = createDay(st.id, date, items, result, { applied: true, before, after, appliedAt: now });
    updateStrategy(st.id, { positions: after }); // 自动更新当前仓位（基线不变）
    return c.json({ ok: true, result, day, strategy: getStrategy(st.id) });
  });

  // 历史列表
  app.get(`${API_PREFIX}/tools/trade-plan/strategies/:id/days`, (c: Context) => {
    const st = getStrategy(c.req.param("id")!);
    if (!st) return c.json({ ok: false, message: "策略不存在" }, 404);
    return c.json({ ok: true, days: listDays(st.id) });
  });

  // 日历总计划（跨策略聚合，按月）
  app.get(`${API_PREFIX}/tools/trade-plan/calendar`, (c: Context) => {
    const q = c.req.query("month") ?? todayStr().slice(0, 7);
    const month = /^\d{4}-\d{2}$/.test(q) ? q : todayStr().slice(0, 7);
    const days: { date: string; strategies: { id: string; name: string; items: TradePlanItem[]; result: TradePlanCheckResult }[] }[] = [];
    for (const st of listStrategies()) {
      for (const d of listDays(st.id)) {
        if (!d.date.startsWith(month)) continue;
        let entry = days.find((x) => x.date === d.date);
        if (!entry) {
          entry = { date: d.date, strategies: [] };
          days.push(entry);
        }
        entry.strategies.push({ id: st.id, name: st.name, items: d.items, result: d.result });
      }
    }
    days.sort((a, b) => (a.date < b.date ? -1 : 1));
    return c.json({ ok: true, month, days });
  });

  // 删除日度计划（已应用的：从基线重放剩余计划 → 保证多日链一致）
  app.delete(`${API_PREFIX}/tools/trade-plan/strategies/:id/day/:dayId`, (c: Context) => {
    const id = c.req.param("id");
    const dayId = c.req.param("dayId");
    if (!id || !dayId) return c.json({ ok: false, message: "计划不存在" }, 404);
    const st = getStrategy(id);
    const day = listDays(id).find((d) => d.id === dayId);
    if (!st || !day) return c.json({ ok: false, message: "计划不存在" }, 404);
    if (day.applied) {
      // 删除该日后，其余已应用计划按日期升序重放 → 一致性（不再简单回滚 before）
      const after = replayPositions(st, day.date);
      updateStrategy(id, { positions: after });
    }
    deleteDay(id, dayId);
    return c.json({ ok: true });
  });
}

// ---------- 解析 ----------

function parseStocks(raw: unknown): TradePlanStockCfg[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is { code?: unknown; name?: unknown; maxWeightPct?: unknown } => typeof x === "object" && x !== null)
    .map((x) => ({
      code: String(x.code ?? "").trim(),
      ...(typeof x.name === "string" && x.name.trim() ? { name: x.name.trim() } : {}),
      ...(num(x.maxWeightPct) !== undefined && num(x.maxWeightPct)! > 0 && num(x.maxWeightPct)! <= 100 ? { maxWeightPct: num(x.maxWeightPct) } : {}),
    }))
    .filter((x) => x.code);
}

function parsePositions(raw: unknown): TradePlanPosition[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is { code?: unknown; name?: unknown; quantity?: unknown; avgCost?: unknown } => typeof x === "object" && x !== null)
    .map((x) => ({
      code: String(x.code ?? "").trim(),
      ...(typeof x.name === "string" && x.name.trim() ? { name: x.name.trim() } : {}),
      quantity: num(x.quantity) ?? 0,
      avgCost: num(x.avgCost) ?? 0,
    }))
    .filter((x) => x.code);
}

function parseItems(raw: unknown): TradePlanItemParsed[] | null {
  if (!Array.isArray(raw)) return null;
  const items: TradePlanItemParsed[] = [];
  for (const x of raw) {
    if (typeof x !== "object" || x === null) continue;
    const it = x as { code?: unknown; action?: unknown; amount?: unknown; cost?: unknown; note?: unknown };
    const code = typeof it.code === "string" ? it.code.trim() : "";
    const action = it.action === "reduce" ? "reduce" : it.action === "add" ? "add" : null;
    const amount = num(it.amount);
    if (!code || !action || amount === undefined || amount <= 0) continue;
    const cost = num(it.cost);
    items.push({
      code,
      action,
      amount,
      ...(cost !== undefined && cost > 0 ? { cost } : {}),
      ...(typeof it.note === "string" && it.note.trim() ? { note: it.note.trim() } : {}),
    });
  }
  return items.length > 0 ? items : null;
}

interface TradePlanItemParsed {
  code: string;
  action: "add" | "reduce";
  amount: number;
  /** 本次成本价（可选） */
  cost?: number;
  note?: string;
}

function todayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}
