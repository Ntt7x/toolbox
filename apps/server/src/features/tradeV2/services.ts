// ============================================================
// 仓位管理 v2：Cordis 服务层（@deepseek-ai/cordis 4.x，todoV3/docs 同模式）
//   - TradeV2GroupService    分组 CRUD（名称 + 总仓位/单日加仓上限/单标的上限）
//   - TradeV2LedgerService   交易账本 CRUD（增量；组内条目 = filter(groupId)）
//   - TradeV2AnalysisService 分析/校验（存量派生 + 复盘 + 约束校验 + 行情附加），
//                            消费 Group + Ledger，行情走 core/quote（KV 缓存）
//   - TradeV2ImportService   V1（trade-plan）导入：读 trade-plan KV 直迁分组 + 期初建仓
//                            （不跨 feature import，保持 features→core 单向依赖）
// 存储：tradeV2:group:<id> / tradeV2:trade:<id> + 列表键（KV）
// ============================================================
import { Service, type Context } from "@deepseek-ai/cordis";
import type {
  TradeV2CheckResult,
  TradeV2Entry,
  TradeV2EntryDraft,
  TradeV2GlobalAnalysis,
  TradeV2Group,
  TradeV2ImportV1Result,
  TradeV2V1StrategyPreview,
} from "@toolbox/shared";
import { kvGet } from "../../core/kvStore.js";
import { fetchKlinesForCodes } from "../../core/kline.js";

// ---------- 名称解析（交易员可读性：代码 → 名称） ----------

/** 进程内名称缓存（行情 KV 缓存已有 5min；名称极少变化） */
const nameCache = new Map<string, string>();

/** 解析标的名称（core/quote 行情快照 name 字段；失败缓存空串防重复打接口） */
export async function resolveStockNameCached(code: string): Promise<string> {
  const hit = nameCache.get(code);
  if (hit !== undefined) return hit;
  try {
    const q = await getQuoteSnapshot(code);
    const name = q.ok && q.name ? q.name : "";
    nameCache.set(code, name);
    return name;
  } catch {
    nameCache.set(code, "");
    return "";
  }
}
import { getQuoteSnapshot } from "../../core/quote.js";
import {
  analyzeGroup,
  buildGlobalAnalysis,
  buildGroupSummary,
  checkEntry,
} from "./compute.js";
import {
  createEntry,
  createGroup,
  deleteEntry,
  deleteGroup,
  getEntry,
  getGroup,
  listEntries,
  listEntriesByGroup,
  listGroups,
  updateEntry,
  updateGroup,
} from "./store.js";

/** 交易条目输入 = shared TradeV2EntryDraft（路由解析产物；不含 id/时间戳） */
export type TradeV2EntryInput = TradeV2EntryDraft;

/** 解析并校验交易条目（纯整形 + 基础合法性；业务约束校验走 checkEntry）。
 * 返回 { ok:true, entry } 或 { ok:false, message }。 */
export function parseEntryInput(raw: unknown): { ok: true; entry: TradeV2EntryInput } | { ok: false; message: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, message: "请求体无效" };
  const x = raw as Record<string, unknown>;
  const groupId = typeof x.groupId === "string" ? x.groupId.trim() : "";
  if (!groupId) return { ok: false, message: "请选择所属分组" };
  const date = typeof x.date === "string" ? x.date.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, message: "日期格式应为 YYYY-MM-DD" };
  const code = typeof x.code === "string" ? x.code.trim() : "";
  if (!code) return { ok: false, message: "标的代码不能为空" };
  const action = x.action === "sell" ? "sell" : x.action === "buy" ? "buy" : null;
  if (!action) return { ok: false, message: "操作类型必须为 buy/sell" };
  const quantity = Number(x.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
    return { ok: false, message: "数量必须为正整数（股）" };
  }
  const isInitial = x.initial === true;
  const price = Number(x.price);
  if (!Number.isFinite(price)) return { ok: false, message: "成交价必须为数值" };
  // 期初建仓允许负价/零价（负成本基点：已回本/做空记账）；普通交易价格必须 > 0
  if (!isInitial && price <= 0) return { ok: false, message: "成交价必须大于 0" };
  if (isInitial && Math.abs(price) > 1e9) return { ok: false, message: "期初建仓价格超出合理范围" };
  let fee: number | undefined;
  if (x.fee !== undefined && x.fee !== null && x.fee !== "") {
    fee = Number(x.fee);
    if (!Number.isFinite(fee) || fee < 0) return { ok: false, message: "手续费必须为非负数值" };
    if (fee > 0) fee = Math.round(fee * 100) / 100;
  }
  const entry: TradeV2EntryInput = {
    groupId,
    date,
    code,
    action,
    quantity,
    price,
    ...(fee !== undefined && fee > 0 ? { fee } : {}),
    ...(x.initial === true ? { initial: true } : {}),
    ...(typeof x.name === "string" && x.name.trim() ? { name: x.name.trim().slice(0, 40) } : {}),
    ...(typeof x.note === "string" && x.note.trim() ? { note: x.note.trim().slice(0, 200) } : {}),
  };
  return { ok: true, entry };
}

/** 解析分组上限配置（code + 0~100 的 maxWeightPct；去重；仅保留 code 非空项） */
export function parseStockLimits(raw: unknown): TradeV2Group["stockLimits"] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: TradeV2Group["stockLimits"] = [];
  for (const x of raw) {
    if (typeof x !== "object" || x === null) continue;
    const s = x as Record<string, unknown>;
    const code = typeof s.code === "string" ? s.code.trim() : "";
    if (!code || seen.has(code)) continue;
    const mw = Number(s.maxWeightPct);
    if (!Number.isFinite(mw) || mw <= 0 || mw > 100) continue;
    seen.add(code);
    out.push({
      code,
      ...(typeof s.name === "string" && s.name.trim() ? { name: s.name.trim().slice(0, 40) } : {}),
      maxWeightPct: Math.round(mw * 10) / 10,
    });
  }
  return out;
}

// ============================================================
// 服务 1：TradeV2GroupService（分组 CRUD）
// ============================================================

export class TradeV2GroupService extends Service {
  constructor(ctx: Context) {
    super(ctx, "tradeV2Group");
  }

  list(): TradeV2Group[] {
    return listGroups();
  }

  get(id: string): TradeV2Group | null {
    return getGroup(id);
  }

  create(name: string): TradeV2Group {
    return createGroup(name);
  }

  update(id: string, patch: { name?: string; totalCapital?: number; dailyAddLimit?: number; stockLimits?: TradeV2Group["stockLimits"]; allowShort?: boolean }): TradeV2Group | null {
    return updateGroup(id, patch);
  }

  remove(id: string): boolean {
    return deleteGroup(id);
  }
}

// ============================================================
// 服务 2：TradeV2LedgerService（交易账本 CRUD）
// ============================================================

export class TradeV2LedgerService extends Service {
  constructor(ctx: Context) {
    super(ctx, "tradeV2Ledger");
  }

  /** 全部交易（最新在前，列表展示） */
  list(): TradeV2Entry[] {
    return listEntries();
  }

  /** 组内交易（日期升序，重放顺序） */
  listByGroup(groupId: string): TradeV2Entry[] {
    return listEntriesByGroup(groupId);
  }

  get(id: string): TradeV2Entry | null {
    return getEntry(id);
  }

  /** 补全条目名称（读路径兜底：先分组上限配置，再行情解析；不持久化） */
  async enrichNames(entries: TradeV2Entry[], groups?: TradeV2Group[]): Promise<TradeV2Entry[]> {
    const groupsList = groups ?? this.ctx.tradeV2Group.list();
    const limitName = new Map<string, string>();
    for (const g of groupsList) {
      for (const s of g.stockLimits) {
        if (s.name && !limitName.has(s.code)) limitName.set(s.code, s.name);
      }
    }
    const unknown: string[] = [];
    for (const e of entries) {
      if (e.name) continue;
      const n = limitName.get(e.code);
      if (n) e.name = n;
      else if (!unknown.includes(e.code)) unknown.push(e.code);
    }
    if (unknown.length > 0) {
      const resolved = await Promise.all(unknown.map(async (code) => [code, await resolveStockNameCached(code)] as const));
      for (const [code, n] of resolved) {
        if (!n) continue;
        for (const e of entries) if (e.code === code && !e.name) e.name = n;
      }
    }
    return entries;
  }

  create(input: TradeV2EntryInput, opts?: { createdAt?: string }): TradeV2Entry {
    return createEntry(input, opts);
  }

  update(id: string, patch: Partial<TradeV2EntryInput>): TradeV2Entry | null {
    return updateEntry(id, patch);
  }

  remove(id: string): boolean {
    return deleteEntry(id);
  }
}

// ============================================================
// 服务 3：TradeV2AnalysisService（分析/校验，消费 Group + Ledger）
// ============================================================

export class TradeV2AnalysisService extends Service {
  constructor(ctx: Context) {
    super(ctx, "tradeV2Analysis");
  }

  /** 批量取最新价（行情走 KV 缓存；失败静默跳过 → 按成本口径估算） */
  async latestPrices(entries: TradeV2Entry[]): Promise<Record<string, number>> {
    const codes = [...new Set(entries.map((e) => e.code))];
    const out: Record<string, number> = {};
    await Promise.all(
      codes.map(async (code) => {
        try {
          const q = await getQuoteSnapshot(code, {});
          const px = Number(q?.price);
          if (px > 0) out[code] = px;
        } catch {
          /* 行情不可得：按成本口径 */
        }
      }),
    );
    return out;
  }

  /** 组分析（含行情附加；条目先补全名称——交易员可读性） */
  async groupAnalysis(groupId: string): Promise<{ group: TradeV2Group; analysis: ReturnType<typeof analyzeGroup> } | null> {
    const group = this.ctx.tradeV2Group.get(groupId);
    if (!group) return null;
    let entries = this.ctx.tradeV2Ledger.listByGroup(groupId);
    entries = await this.ctx.tradeV2Ledger.enrichNames(entries, [group]);
    const prices = await this.latestPrices(entries);
    // 历史日 K（收益曲线真实市值口径）：组内全部标的并发拉取；无行情静默回退成本口径
    const klines = await fetchKlinesForCodes(entries.map((e) => e.code));
    return { group, analysis: analyzeGroup(group, entries, prices, klines) };
  }

  /** 约束校验（allEntries = 目标条目最终形态所在的全量列表） */
  async check(
    group: TradeV2Group,
    allEntries: TradeV2Entry[],
    targetDate?: string,
  ): Promise<TradeV2CheckResult> {
    const prices = await this.latestPrices(allEntries);
    return checkEntry(group, allEntries, { targetDate, latestPrices: prices });
  }

  /** 全局分析（跨组；条目补全名称） */
  async global(): Promise<TradeV2GlobalAnalysis> {
    const groups = this.ctx.tradeV2Group.list();
    const inputs = await Promise.all(
      groups.map(async (g) => {
        let entries = this.ctx.tradeV2Ledger.listByGroup(g.id);
        entries = await this.ctx.tradeV2Ledger.enrichNames(entries, [g]);
        const latestPrices = await this.latestPrices(entries);
        const klines = await fetchKlinesForCodes(entries.map((e) => e.code));
        return { group: g, entries, latestPrices, klines };
      }),
    );
    return buildGlobalAnalysis(inputs);
  }

  /** 组摘要（列表接口用） */
  async groupSummary(group: TradeV2Group): Promise<ReturnType<typeof buildGroupSummary>> {
    const entries = this.ctx.tradeV2Ledger.listByGroup(group.id);
    const prices = await this.latestPrices(entries);
    return buildGroupSummary(group, entries, prices);
  }
}

// ============================================================
// 服务 4：TradeV2ImportService（V1 trade-plan 导入）
// 读 V1 KV（tradePlan:strategy:<id> + tradePlan:strategies:list）直迁：
//   每个策略 → 一个同名 V2 分组（总仓位/日限/单标的上限迁移）；
//   每个当前持仓（quantity>0 且均价>0）→ 一笔 initial 期初建仓（日期可指定，默认今天）。
// 负成本/无有效成本持仓无法作为期初建仓（V2 要求价格>0）→ 跳过并报告。
// ============================================================

/** V1 键（不 import tradePlan feature，直读 KV） */
const V1_STRATEGY_LIST = "tradePlan:strategies:list";
const V1_STRATEGY_PREFIX = "tradePlan:strategy:";

interface V1StrategyNormalized {
  id: string;
  name: string;
  totalCapital: number;
  dailyAddLimit: number;
  stocks: { code: string; name?: string; maxWeightPct?: number }[];
  positions: { code: string; name?: string; quantity: number; avgCost: number }[];
}

/** 归一化 V1 策略（兼容旧数据：positions 缺失 → initialPositions → stocks 内联 initShares/initCost） */
function normalizeV1Strategy(raw: unknown): V1StrategyNormalized | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || typeof s.name !== "string") return null;
  const stocks: V1StrategyNormalized["stocks"] = [];
  if (Array.isArray(s.stocks)) {
    for (const x of s.stocks) {
      if (typeof x !== "object" || x === null) continue;
      const stk = x as Record<string, unknown>;
      const code = typeof stk.code === "string" ? stk.code.trim() : "";
      if (!code) continue;
      const mw = Number(stk.maxWeightPct);
      stocks.push({
        code,
        ...(typeof stk.name === "string" && stk.name.trim() ? { name: stk.name.trim() } : {}),
        ...(Number.isFinite(mw) && mw > 0 && mw <= 100 ? { maxWeightPct: Math.round(mw * 10) / 10 } : {}),
      });
    }
  }
  const normPos = (p: unknown): { code: string; name?: string; quantity: number; avgCost: number } | null => {
    if (typeof p !== "object" || p === null) return null;
    const pos = p as Record<string, unknown>;
    const code = typeof pos.code === "string" ? pos.code.trim() : "";
    if (!code) return null;
    const quantity = Number(pos.quantity ?? (pos as Record<string, unknown>).shares ?? 0);
    const avgCost = Number(pos.avgCost ?? (pos as Record<string, unknown>).cost ?? 0);
    if (!Number.isFinite(quantity) || quantity <= 0) return null;
    if (!Number.isFinite(avgCost)) return null;
    return {
      code,
      ...(typeof pos.name === "string" && pos.name.trim() ? { name: pos.name.trim() } : {}),
      quantity,
      avgCost,
    };
  };
  let positions: V1StrategyNormalized["positions"] = [];
  if (Array.isArray(s.positions)) positions = s.positions.map(normPos).filter((x): x is NonNullable<typeof x> => x !== null);
  if (positions.length === 0 && Array.isArray(s.initialPositions)) {
    positions = s.initialPositions.map(normPos).filter((x): x is NonNullable<typeof x> => x !== null);
  }
  // 最旧格式：stocks 内联 initShares/initCost——必须从「原始 stocks」读取（归一化会剥离内联字段）
  if (positions.length === 0 && Array.isArray(s.stocks)) {
    for (const x of s.stocks) {
      if (typeof x !== "object" || x === null) continue;
      const sc = x as Record<string, unknown>;
      const code = typeof sc.code === "string" ? sc.code.trim() : "";
      const shares = Number(sc.initShares);
      const cost = Number(sc.initCost);
      if (!code) continue;
      if (Number.isFinite(shares) && shares > 0 && Number.isFinite(cost) && cost > 0) {
        positions.push({
          code,
          ...(typeof sc.name === "string" && sc.name.trim() ? { name: sc.name.trim() } : {}),
          quantity: shares,
          avgCost: cost,
        });
      }
    }
  }
  return {
    id: s.id as string,
    name: (s.name as string).trim().slice(0, 30),
    totalCapital: Number(s.totalCapital) || 0,
    dailyAddLimit: Number(s.dailyAddLimit) || 0,
    stocks,
    positions,
  };
}

export class TradeV2ImportService extends Service {
  constructor(ctx: Context) {
    super(ctx, "tradeV2Import");
  }

  /** V1 策略预览（含同名冲突标记） */
  v1Preview(): TradeV2V1StrategyPreview[] {
    const list = kvGet<string[]>(V1_STRATEGY_LIST) ?? [];
    const existing = new Set(this.ctx.tradeV2Group.list().map((g) => g.name));
    const out: TradeV2V1StrategyPreview[] = [];
    for (const id of list) {
      const s = normalizeV1Strategy(kvGet(V1_STRATEGY_PREFIX + id));
      if (!s) continue;
      out.push({
        id: s.id,
        name: s.name,
        totalCapital: s.totalCapital,
        dailyAddLimit: s.dailyAddLimit,
        stockCount: s.stocks.length,
        positionCount: s.positions.length,
        importableCount: s.positions.filter((p) => p.quantity > 0 && p.avgCost > 0).length,
        conflict: existing.has(s.name),
      });
    }
    return out;
  }

  /** 执行导入：每个策略 → 分组 + 期初建仓（同名冲突跳过，幂等） */
  importV1(opts: { date: string; strategyIds?: string[] }): TradeV2ImportV1Result {
    const { date, strategyIds } = opts;
    const list = kvGet<string[]>(V1_STRATEGY_LIST) ?? [];
    const existing = new Set(this.ctx.tradeV2Group.list().map((g) => g.name));
    const created: TradeV2ImportV1Result["created"] = [];
    const skipped: TradeV2ImportV1Result["skipped"] = [];
    const skippedPositions: TradeV2ImportV1Result["skippedPositions"] = [];
    const ids = strategyIds && strategyIds.length > 0 ? list.filter((id) => strategyIds.includes(id)) : list;

    for (const id of ids) {
      const s = normalizeV1Strategy(kvGet(V1_STRATEGY_PREFIX + id));
      if (!s) {
        skipped.push({ name: id, reason: "V1 策略数据缺失" });
        continue;
      }
      if (existing.has(s.name)) {
        skipped.push({ name: s.name, reason: "V2 已有同名分组，已跳过（幂等保护）" });
        continue;
      }
      const group = createGroup(s.name);
      updateGroup(group.id, {
        totalCapital: s.totalCapital,
        dailyAddLimit: s.dailyAddLimit,
        stockLimits: s.stocks.map((x) => ({ code: x.code, ...(x.name ? { name: x.name } : {}), ...(x.maxWeightPct !== undefined ? { maxWeightPct: x.maxWeightPct } : {}) })),
      });
      existing.add(s.name);
      let entryCount = 0;
      for (const p of s.positions) {
        if (p.quantity <= 0) continue;
        // 负成本/零成本持仓：以均价为期初建仓价格（可为负——统一模型支持负成本基点）
        createEntry({
          groupId: group.id,
          date,
          code: p.code,
          ...(p.name ? { name: p.name } : {}),
          action: "buy",
          quantity: p.quantity,
          price: Math.round(p.avgCost * 1e6) / 1e6,
          initial: true,
          note: "V1 导入期初建仓",
        });
        entryCount++;
      }
      created.push({ groupId: group.id, name: s.name, entryCount });
    }
    return { ok: true, created, skipped, skippedPositions, date };
  }
}

// ============================================================
// declare module：四个服务加入 Context 接口（编译时类型安全）
// ============================================================

declare module "@deepseek-ai/cordis" {
  interface Context {
    tradeV2Group: TradeV2GroupService;
    tradeV2Ledger: TradeV2LedgerService;
    tradeV2Analysis: TradeV2AnalysisService;
    tradeV2Import: TradeV2ImportService;
  }
}

