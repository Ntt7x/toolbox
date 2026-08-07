// ============================================================
// 业务模块：交易规划（features/tradePlan）
// 多策略：每策略独立配置（总仓位/交易标的/单日加仓上限/起始持仓）+ 日度计划。
// 校验日度交易计划是否符合策略配置与仓位控制，给出提醒与告警（纯程序，无 LLM）。
// ============================================================
import { Hono } from "hono";
import type { Context } from "hono";
import { API_PREFIX, type ToolMeta } from "@toolbox/shared";
import { registerDataSource } from "../../core/dataRegistry.js";
import { checkTradePlan } from "./compute.js";
import {
  createDay,
  createStrategy,
  deleteDay,
  deleteStrategy,
  getStrategy,
  listDays,
  listStrategies,
  migrateLegacyConfig,
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
  description: "多策略配置（总仓位/标的/单日加仓上限/起始持仓），校验日度交易计划是否符合仓位控制，给出提醒与告警",
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
      initialPositions?: unknown;
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
    const initialPositions = raw.initialPositions !== undefined ? parsePositions(raw.initialPositions) : undefined;
    const st = updateStrategy(id, {
      name: typeof raw.name === "string" ? raw.name : undefined,
      totalCapital,
      dailyAddLimit,
      stocks,
      initialPositions,
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

  // 校验（preview，不入库）
  app.post(`${API_PREFIX}/tools/trade-plan/strategies/:id/check`, async (c: Context) => {
    const st = getStrategy(c.req.param("id")!);
    if (!st) return c.json({ ok: false, message: "策略不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { items?: unknown } | null;
    const items = parseItems(raw?.items);
    if (!items) return c.json({ ok: false, message: "计划条目无效（需含代码/操作/金额）" }, 400);
    const result = checkTradePlan(st, items);
    return c.json({ ok: result.ok, result, previewOnly: true });
  });

  // 创建日度计划（自动校验并保存）
  app.post(`${API_PREFIX}/tools/trade-plan/strategies/:id/day`, async (c: Context) => {
    const st = getStrategy(c.req.param("id")!);
    if (!st) return c.json({ ok: false, message: "策略不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { date?: unknown; items?: unknown } | null;
    const date = typeof raw?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : todayStr();
    const items = parseItems(raw?.items);
    if (!items || items.length === 0) return c.json({ ok: false, message: "计划条目无效（需至少一条）" }, 400);
    const result = checkTradePlan(st, items);
    // 5. 违反策略仓位管理（有 error 级告警）→ 拒绝保存
    if (!result.ok) {
      return c.json({ ok: false, message: "计划违反策略仓位管理，无法保存", result, rejectReason: result.alerts.find((a) => a.level === "error")?.message }, 400);
    }
    const day = createDay(st.id, date, items, result);
    return c.json({ ok: true, result, day });
  });

  // 历史列表
  app.get(`${API_PREFIX}/tools/trade-plan/strategies/:id/days`, (c: Context) => {
    const st = getStrategy(c.req.param("id")!);
    if (!st) return c.json({ ok: false, message: "策略不存在" }, 404);
    return c.json({ ok: true, days: listDays(st.id) });
  });

  // 删除日度计划
  app.delete(`${API_PREFIX}/tools/trade-plan/strategies/:id/day/:dayId`, (c: Context) => {
    const id = c.req.param("id");
    const dayId = c.req.param("dayId");
    if (!id || !dayId || !deleteDay(id, dayId)) return c.json({ ok: false, message: "计划不存在" }, 404);
    return c.json({ ok: true });
  });
}

// ---------- 解析 ----------

function parseStocks(raw: unknown): { code: string; name?: string; maxWeightPct?: number; initShares?: number; initCost?: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is { code?: unknown; name?: unknown; maxWeightPct?: unknown; initShares?: unknown; initCost?: unknown } => typeof x === "object" && x !== null)
    .map((x) => ({
      code: String(x.code ?? "").trim(),
      ...(typeof x.name === "string" && x.name.trim() ? { name: x.name.trim() } : {}),
      ...(num(x.maxWeightPct) !== undefined && num(x.maxWeightPct)! > 0 && num(x.maxWeightPct)! <= 100 ? { maxWeightPct: num(x.maxWeightPct) } : {}),
      ...(num(x.initShares) !== undefined && num(x.initShares)! > 0 ? { initShares: num(x.initShares) } : {}),
      ...(num(x.initCost) !== undefined && num(x.initCost)! > 0 ? { initCost: num(x.initCost) } : {}),
    }))
    .filter((x) => x.code);
}

function parsePositions(raw: unknown): { code: string; shares: number; cost: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is { code?: unknown; shares?: unknown; cost?: unknown } => typeof x === "object" && x !== null)
    .map((x) => ({
      code: String(x.code ?? "").trim(),
      shares: num(x.shares) ?? 0,
      cost: num(x.cost) ?? 0,
    }))
    .filter((x) => x.code);
}

function parseItems(raw: unknown): TradePlanItemParsed[] | null {
  if (!Array.isArray(raw)) return null;
  const items: TradePlanItemParsed[] = [];
  for (const x of raw) {
    if (typeof x !== "object" || x === null) continue;
    const it = x as { code?: unknown; action?: unknown; amount?: unknown; note?: unknown };
    const code = typeof it.code === "string" ? it.code.trim() : "";
    const action = it.action === "reduce" ? "reduce" : it.action === "add" ? "add" : null;
    const amount = num(it.amount);
    if (!code || !action || amount === undefined || amount <= 0) continue;
    items.push({
      code,
      action,
      amount,
      ...(typeof it.note === "string" && it.note.trim() ? { note: it.note.trim() } : {}),
    });
  }
  return items.length > 0 ? items : null;
}

interface TradePlanItemParsed {
  code: string;
  action: "add" | "reduce";
  amount: number;
  note?: string;
}

function todayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}
