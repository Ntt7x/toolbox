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
  type TradePlanStrategy,
} from "@toolbox/shared";
import { registerDataSource } from "../../core/dataRegistry.js";
import { getQuoteSnapshot } from "../../core/quote.js";
import { applyItems, buildDeals, checkTradePlan } from "./compute.js";
import {
  createDay,
  createStrategy,
  deleteDay,
  deleteStrategy,
  appliedDayWarnings,
  getStrategy,
  listDays,
  listStrategies,
  migrateLegacyConfig,
  rebasePositions,
  replayBefore,
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

function num(v: unknown, allowNeg = false): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && (allowNeg || n >= 0) ? n : undefined;
}

export function register(app: Hono): void {
  migrateLegacyConfig();

  // ---------- 策略 ----------

  // 策略列表（附盈亏：最新价市值/浮动盈亏/盈亏率，负成本合法）
  app.get(`${API_PREFIX}/tools/trade-plan/strategies`, async (c: Context) => {
    const list = listStrategies();
    const out = await Promise.all(
      list.map(async (s) => {
        const full = getStrategy(s.id);
        const pnl = full ? await attachPnl(full) : null;
        // positionPct 统一为「最新价市值占比」（与详情/概览一致；store 内为成本口径兜底，这里覆盖）
        const positionPct = pnl && s.totalCapital > 0 ? Math.round((pnl.totalMv / s.totalCapital) * 1000) / 10 : s.positionPct;
        return { ...s, positionPct, pnl };
      }),
    );
    return c.json({ ok: true, strategies: out });
  });

  // 策略详情附盈亏：最新价 vs 成本价（负成本合法，盈亏率用成本绝对值）；行情走 KV 缓存，失败静默跳过
  async function attachPnl(st: TradePlanStrategy) {
    const byCode: Record<string, { latestPrice?: number; pnl?: number; pnlPct?: number; costNegative?: boolean }> = {};
    let totalPnl = 0;
    let totalCost = 0;
    let totalMv = 0;
    let negCount = 0;
    for (const p of st.positions) {
      if ((p.quantity || 0) <= 0 || typeof p.avgCost !== "number" || isNaN(p.avgCost)) continue;
      const costValue = p.quantity * p.avgCost;
      try {
        const q = await getQuoteSnapshot(p.code, {});
        if (q.ok && q.price && q.price > 0) {
          const mv = p.quantity * q.price;
          totalMv += mv;
          const pnl = mv - costValue;   // 盈亏金额（市值−成本，负成本同样可显示金额）
          const neg = costValue < 0;
          totalPnl += pnl;
          if (neg) negCount++;
          else totalCost += costValue;
          byCode[p.code] = neg
            ? { latestPrice: q.price, pnl, costNegative: true }   // 负成本：显示盈亏金额，盈亏率无意义
            : { latestPrice: q.price, pnl, pnlPct: costValue !== 0 ? (pnl / costValue) * 100 : 0 };
        } else {
          totalMv += Math.max(costValue, 0);   // 无行情：正成本计市值兜底，负成本不计
        }
      } catch { totalMv += Math.max(costValue, 0); }
    }
    return {
      byCode,
      totalPnl,
      totalCost,
      totalMv,
      negCount,
      // 总盈亏率：存在负成本标的一律不显示（负成本比例无意义）；无负成本时仅正成本统计
      totalPnlPct: negCount > 0 ? undefined : totalCost > 0 ? (totalPnl / totalCost) * 100 : undefined,
    };
  }

  // 单策略详情（附盈亏：最新价 vs 成本价 + 交易复盘 deals；行情走 KV 缓存，失败静默跳过）
  app.get(`${API_PREFIX}/tools/trade-plan/strategies/:id`, async (c: Context) => {
    const st = getStrategy(c.req.param("id")!);
    if (!st) return c.json({ ok: false, message: "策略不存在" }, 404);
    const deals = buildDeals(listDays(st.id));
    return c.json({ ok: true, strategy: st, pnl: await attachPnl(st), deals });
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
    // 服务端权威校验：maxWeightPct 越界 400（2026-08-10：此前 parseStocks 静默丢弃，违反 §6.7）
    if (Array.isArray(raw.stocks)) {
      for (const x of raw.stocks) {
        if (typeof x !== "object" || x === null) continue;
        const mw = (x as { maxWeightPct?: unknown }).maxWeightPct;
        if (mw !== undefined && mw !== null) {
          const n = Number(mw);
          if (!Number.isFinite(n) || n < 0 || n > 100) {
            const code = String((x as { code?: unknown }).code ?? "").trim();
            return c.json({ ok: false, message: `标的 ${code || "(未填代码)"} 的仓位上限需在 0-100% 之间` }, 400);
          }
        }
      }
    }
    // 服务端查重：同一策略不允许重复 code
    if (stocks && stocks.length > 0) {
      const seen = new Set<string>();
      const dup = stocks.find((x) => (seen.has(x.code) ? true : (seen.add(x.code), false)));
      if (dup) return c.json({ ok: false, message: `标的 ${dup.code} 重复，请合并为一行` }, 400);
    }
    const positions = raw.positions !== undefined ? parsePositions(raw.positions) : undefined;
    // 服务端校验：当前数量非零时成本价必填（金额 = 数量 × 成本价）
    if (positions) {
      const badPos = positions.find((p) => p.code && p.quantity > 0 && (typeof p.avgCost !== "number" || isNaN(p.avgCost)));   // 负数成本合法
      if (badPos) return c.json({ ok: false, message: `标的 ${badPos.code} 当前数量为 ${badPos.quantity}，成本价必填` }, 400);
    }
    // 手动保存仓位 → 固化为基线（差值法：只固化手动调整量，避免已应用日度计划重复计入，见 store.rebasePositions）
    // 注意：rebase 输入用「当前已加载的 cur」（getStrategy 结果），不能在 updateStrategy 返回值上自引用
    const newBase = positions !== undefined ? rebasePositions(cur.basePositions ?? cur.positions ?? [], replayPositions(cur), positions) : undefined;
    const st = updateStrategy(id, {
      name: typeof raw.name === "string" ? raw.name : undefined,
      totalCapital,
      dailyAddLimit,
      stocks,
      positions,
      ...(newBase !== undefined ? { basePositions: newBase } : {}),
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
    if (!items) return c.json({ ok: false, message: "计划条目无效（需含代码/操作/数量）" }, 400);
    const priceErr = itemsPriceError(items);
    if (priceErr) return c.json({ ok: false, message: `计划条目无效：${priceErr}` }, 400);
    const priceFallback = await buildPriceFallback(st, items);
    const result = checkTradePlan(st, items, { priceFallback });
    return c.json({ ok: result.ok, result, previewOnly: true });
  });

  // 创建日度计划（校验 → 保存 → 自动应用更新当前仓位；同日覆盖：before 只用该日之前状态，应用后全量重放）
  app.post(`${API_PREFIX}/tools/trade-plan/strategies/:id/day`, async (c: Context) => {
    const st = getStrategy(c.req.param("id")!);
    if (!st) return c.json({ ok: false, message: "策略不存在" }, 404);
    const raw = (await c.req.json().catch(() => null)) as { date?: unknown; items?: unknown } | null;
    const date = typeof raw?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : todayStr();
    const items = parseItems(raw?.items);
    if (!items || items.length === 0) return c.json({ ok: false, message: "计划条目无效（需至少一条）" }, 400);
    const priceErr = itemsPriceError(items);
    if (priceErr) return c.json({ ok: false, message: `计划条目无效：${priceErr}` }, 400);

    // 覆盖（重刷）语义（2026-08-10 修复）：before/校验基础 = 仅该日之前的仓位
    // （旧实现 replayPositions(st, date) 只剔除该日、会把该日之后计划重放进 before，
    //   导致校验持仓被未来计划污染、减仓误拦、快照错误）
    const positions = replayBefore(st, date);
    const checkConfig = { ...st, positions };
    const priceFallback = await buildPriceFallback(checkConfig, items);
    const result = checkTradePlan(checkConfig, items, { priceFallback });
    // 违反策略仓位管理（有 error 级告警）→ 拒绝保存；rejectReason 给出全部 error 具体原因（message + detail）
    if (!result.ok) {
      const errs = result.alerts.filter((a) => a.level === "error");
      return c.json({
        ok: false,
        message: "计划违反策略仓位管理，无法保存",
        result,
        rejectReason: errs.map((a) => (a.detail ? `${a.message}（${a.detail}）` : a.message)).join("；"),
      }, 400);
    }
    const before = positions;
    const after = applyItems(before, items);
    const now = new Date().toISOString();
    const day = createDay(st.id, date, items, result, { applied: true, before, after, appliedAt: now });
    // 当前仓位 = 全量重放（新计划已入 KV；含该日之后的后续计划，避免丢失后续日影响）
    const latest = getStrategy(st.id)!;
    updateStrategy(st.id, { positions: replayPositions(latest) });
    // 后续已应用计划链校验：无法完整执行的（如减仓超持仓）给出可见警告（不再静默截断）
    const chainWarnings = appliedDayWarnings(latest);
    return c.json({ ok: true, result, day, strategy: getStrategy(st.id), chainWarnings });
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
    for (const stSum of listStrategies()) {
      const st = getStrategy(stSum.id);
      if (!st) continue;
      for (const d of listDays(st.id)) {
        if (!d.date.startsWith(month)) continue;
        let entry = days.find((x) => x.date === d.date);
        if (!entry) {
          entry = { date: d.date, strategies: [] };
          days.push(entry);
        }
        entry.strategies.push({
          id: st.id,
          name: st.name,
          // 聚合时补股票名称（日历展示可读性；TradePlanItem.name 为展示字段）
          items: d.items.map((it) => ({
            ...it,
            name: st.stocks.find((x) => x.code === it.code)?.name ?? it.name,
          })),
          result: d.result,
        });
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
    // 删除后剩余计划链校验（S7：减仓超持仓等无法完整执行 → 可见警告）
    const chainWarnings = appliedDayWarnings(getStrategy(id)!, day.date);
    return c.json({ ok: true, chainWarnings });
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
      avgCost: num(x.avgCost, true) ?? 0,   // 成本价允许负数（融资/做空场景）
    }))
    .filter((x) => x.code);
}

export function parseItems(raw: unknown): TradePlanItemParsed[] | null {
  if (!Array.isArray(raw)) return null;
  const items: TradePlanItemParsed[] = [];
  for (const x of raw) {
    if (typeof x !== "object" || x === null) return null;
    const it = x as { code?: unknown; action?: unknown; amount?: unknown; cost?: unknown; note?: unknown };
    const code = typeof it.code === "string" ? it.code.trim() : "";
    const action = it.action === "reduce" ? "reduce" : it.action === "add" ? "add" : null;
    const amount = num(it.amount);
    // 任一条目非法（缺代码/操作/数量<=0/非整数股）→ 整批拒绝（2026-08-10：不再静默丢条目，用户能看到完整 400）
    if (!code || !action || amount === undefined || amount <= 0 || !Number.isInteger(amount)) return null;
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

/** 价格必填权威校验（新提交的日度计划）：加仓 = 买入价、减仓 = 卖出价，均须 >0。
 * 返回错误消息；全部合法返回 null。旧数据/纯函数层保持三源兜底，不受影响。 */
export function itemsPriceError(items: TradePlanItemParsed[]): string | null {
  for (const it of items) {
    if (typeof it.cost !== "number" || it.cost <= 0) {
      const label = it.action === "add" ? "买入价" : "卖出价";
      return `${it.code} 的操作缺少${label}：金额 = 数量 × 价格，请填写本次交易价格（>0）`;
    }
  }
  return null;
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
