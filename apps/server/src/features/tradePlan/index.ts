// ============================================================
// 业务模块：交易规划（features/tradePlan）
// 用户预先配置交易策略（总仓位/交易标的/单日加仓上限/起始持仓），
// 策略参数保护仓位不失控；每日输入日度交易计划 → 服务端校验是否符合
// 策略配置与仓位控制，计算执行后仓位，给出提醒与告警。
// - 配置存 KV tradePlan:config（本地设置数据）
// - 日度计划存 KV tradePlan:days:<id>（列表键 tradePlan:days:list）
// - 校验为纯程序计算（无 LLM）
// ============================================================
import { Hono } from "hono";
import type { Context } from "hono";
import { API_PREFIX, type ToolMeta } from "@toolbox/shared";
import { registerDataSource } from "../../core/dataRegistry.js";
import { checkTradePlan } from "./compute.js";
import { createDay, deleteDay, getConfig, listDays, saveConfig } from "./store.js";

registerDataSource({
  kind: "kv",
  name: "tradePlan:",
  page: "交易规划",
  tag: "交易数据",
  description: "交易规划：策略配置（tradePlan:config）与日度交易计划（tradePlan:days:）",
});

export const meta: ToolMeta = {
  id: "trade-plan",
  name: "交易规划",
  description: "配置交易策略（总仓位/标的/单日加仓上限/起始持仓），校验日度交易计划是否符合仓位控制，给出提醒与告警",
  path: "/tools/trade-plan",
};

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function register(app: Hono): void {
  // 读取配置（无则返回默认空配置）
  app.get(`${API_PREFIX}/tools/trade-plan/config`, (c: Context) => {
    return c.json({ ok: true, config: getConfig() });
  });

  // 保存配置
  app.put(`${API_PREFIX}/tools/trade-plan/config`, async (c: Context) => {
    const raw = (await c.req.json().catch(() => null)) as {
      totalCapital?: unknown;
      dailyAddLimit?: unknown;
      stocks?: unknown;
      initialPositions?: unknown;
    } | null;
    if (!raw || typeof raw !== "object") return c.json({ ok: false, message: "请求体无效" }, 400);
    const totalCapital = num(raw.totalCapital);
    const dailyAddLimit = num(raw.dailyAddLimit);
    if (totalCapital === undefined || dailyAddLimit === undefined) {
      return c.json({ ok: false, message: "总仓位与单日加仓上限必须为非负数值" }, 400);
    }
    const stocks = Array.isArray(raw.stocks)
      ? raw.stocks
          .filter((x): x is { code?: unknown; name?: unknown; maxWeightPct?: unknown } => typeof x === "object" && x !== null)
          .map((x) => ({
            code: String(x.code ?? "").trim(),
            ...(typeof x.name === "string" && x.name.trim() ? { name: x.name.trim() } : {}),
            ...(num(x.maxWeightPct) !== undefined && num(x.maxWeightPct)! > 0 && num(x.maxWeightPct)! <= 100 ? { maxWeightPct: num(x.maxWeightPct) } : {}),
          }))
          .filter((x) => x.code)
      : [];
    const initialPositions = Array.isArray(raw.initialPositions)
      ? raw.initialPositions
          .filter((x): x is { code?: unknown; shares?: unknown; cost?: unknown } => typeof x === "object" && x !== null)
          .map((x) => ({
            code: String(x.code ?? "").trim(),
            shares: num(x.shares) ?? 0,
            cost: num(x.cost) ?? 0,
          }))
          .filter((x) => x.code)
      : [];
    const config = saveConfig({ totalCapital, dailyAddLimit, stocks, initialPositions });
    return c.json({ ok: true, config });
  });

  // 校验日度计划（previewOnly，不入库）——「分析」按钮
  app.post(`${API_PREFIX}/tools/trade-plan/check`, async (c: Context) => {
    const raw = (await c.req.json().catch(() => null)) as { items?: unknown } | null;
    const items = parseItems(raw?.items);
    if (!items) return c.json({ ok: false, message: "计划条目无效（需含代码/操作/金额）" }, 400);
    const result = checkTradePlan(getConfig(), items);
    return c.json({ ok: result.ok, result, previewOnly: true });
  });

  // 创建日度计划（自动校验并保存结果快照）
  app.post(`${API_PREFIX}/tools/trade-plan/day`, async (c: Context) => {
    const raw = (await c.req.json().catch(() => null)) as { date?: unknown; items?: unknown } | null;
    const date = typeof raw?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : todayStr();
    const items = parseItems(raw?.items);
    if (!items || items.length === 0) return c.json({ ok: false, message: "计划条目无效（需至少一条）" }, 400);
    const result = checkTradePlan(getConfig(), items);
    const day = createDay(date, items, result);
    return c.json({ ok: true, result, day });
  });

  // 历史列表（时间倒序）
  app.get(`${API_PREFIX}/tools/trade-plan/days`, (c: Context) => {
    return c.json({ ok: true, days: listDays() });
  });

  // 删除日度计划
  app.delete(`${API_PREFIX}/tools/trade-plan/day/:id`, (c: Context) => {
    const id = c.req.param("id");
    if (!id || !deleteDay(id)) return c.json({ ok: false, message: "计划不存在" }, 404);
    return c.json({ ok: true });
  });
}

/** 解析计划条目列表（非法条目剔除） */
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
