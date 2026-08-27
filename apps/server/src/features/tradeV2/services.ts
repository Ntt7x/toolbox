// ============================================================
// 仓位管理 v2：Cordis 服务层（@deepseek-ai/cordis 4.x，todoV3/docs 同模式）
//   - TradeV2GroupService    分组 CRUD（名称 + 总仓位/单日加仓上限/单标的上限）
//   - TradeV2LedgerService   交易账本 CRUD（增量；组内条目 = filter(groupId)）
//   - TradeV2AnalysisService 分析/校验（存量派生 + 复盘 + 约束校验 + 行情附加），
//                            消费 Group + Ledger，行情走 core/quote（KV 缓存）
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
  TradeV2Position,
} from "@toolbox/shared";
import { kvGet } from "../../core/kvStore.js";
import { fetchKlinesForCodes } from "../../core/kline.js";
import { getStockVolatilities } from "../../core/volatilityStore.js";

/** 公共：positions 附加行情字段（涨跌幅/今日盈亏/波动率分级）——分组/全局共用（DRY） */
async function enrichPositions(positions: TradeV2Position[]): Promise<TradeV2Position[]> {
  if (positions.length === 0) return positions;
  const codes = positions.map((p) => p.code);
  const vols = await getStockVolatilities(codes);
  const quotes = await getQuoteSnapshots(codes);
  const quoteOf = (code: string) => quotes.find((q) => q.code === code || q.code.endsWith(code) || code.endsWith(q.code.replace(/^[a-z]{2}/, "")));
  return positions.map((p) => {
    const v = vols.get(p.code);
    const q = quoteOf(p.code);
    const pct = typeof q?.pct === "number" ? Math.round(q.pct * 100) / 100 : undefined;
    const todayPnl = typeof q?.change === "number" ? Math.round(q.change * Math.abs(p.quantity) * 100) / 100 : undefined;
    return {
      ...p,
      ...(v && v.vol !== undefined ? { volatility: Math.round(v.vol * 100) / 100, volLevel: v.level } : {}),
      ...(pct !== undefined ? { changePct: pct } : {}),
      ...(todayPnl !== undefined ? { todayPnl } : {}),
    };
  });
}

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
import { getQuoteSnapshot, getQuoteSnapshots } from "../../core/quote.js";
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
  getGroupEntries,
  listEntries,
  listEntriesByGroup,
  listGroups,
  moveStock as moveStockEntries,
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

  create(name: string, infoType?: "info" | "noinfo", isPaper?: boolean, aggSources?: string[]): TradeV2Group {
    return createGroup(name, infoType, isPaper, aggSources);
  }

  update(id: string, patch: { name?: string; totalCapital?: number; dailyAddLimit?: number; stockLimits?: TradeV2Group["stockLimits"]; allowShort?: boolean; infoType?: "info" | "noinfo" | null }): TradeV2Group | null {
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
    // 聚合分组（aggSources）：来源分组条目递归并集；基础分组行为不变
    return getGroupEntries(groupId);
  }

  /** 组内标的列表（去重；供提交交易单空白补全——memo 补充：直接接口获取，前端不过滤） */
  async stocksOfGroup(groupId: string): Promise<{ code: string; name?: string }[]> {
    const map = new Map<string, { code: string; name?: string }>();
    for (const e of listEntriesByGroup(groupId)) {
      if (!map.has(e.code)) map.set(e.code, { code: e.code, name: e.name });
    }
    const unknown = [...map.values()].filter((s) => !s.name);
    if (unknown.length > 0) {
      const resolved = await Promise.all(unknown.map(async (s) => [s.code, await resolveStockNameCached(s.code)] as const));
      for (const [code, n] of resolved) {
        if (n && map.has(code)) map.get(code)!.name = n;
      }
    }
    return [...map.values()];
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

  /** 移动某标的（fromGroupId 内该 code 的全部交易）到 toGroupId；返回移动条数（memo mt2ttvqd） */
  moveStock(fromGroupId: string, code: string, toGroupId: string): number {
    return moveStockEntries(fromGroupId, code, toGroupId);
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
    const analysis = analyzeGroup(group, entries, prices, klines);
    // 附加行情字段（涨跌幅/今日盈亏/波动率——公共 enrichPositions，与全局共用）
    analysis.positions = await enrichPositions(analysis.positions);
    return { group, analysis };
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
      // 虚盘分组（isPaper）不参与「全部组合 / 实盘实际金额」计算（memo mtbjkyro），仅作独立分组展示；
      // 聚合分组（aggSources）是合并视图（标的来自来源分组），参与会与来源重复计算——同样排除（memo 新增）
      groups.filter((g) => !g.isPaper && !(Array.isArray(g.aggSources) && g.aggSources.length > 0)).map(async (g) => {
        let entries = this.ctx.tradeV2Ledger.listByGroup(g.id);
        entries = await this.ctx.tradeV2Ledger.enrichNames(entries, [g]);
        const latestPrices = await this.latestPrices(entries);
        const klines = await fetchKlinesForCodes(entries.map((e) => e.code));
        return { group: g, entries, latestPrices, klines };
      }),
    );
    const analysis = buildGlobalAnalysis(inputs);
    // 全局组合复用一般组合能力：positions 附加行情字段（公共 enrichPositions，与分组共用）
    analysis.positions = await enrichPositions(analysis.positions ?? []);
    // 全部组合首先是一般组合（mt52hjgp）：与分组同一数据结构 analyzeGroup 输出——
    // 合成组（无约束）+ 全部标的 entries，positions/dailySeries/monthlySeries/归因/指标/deals 全齐，零强转
    const allEntries: TradeV2Entry[] = [];
    const allLatest: Record<string, number> = {};
    const allKlines = new Map<string, Map<string, number>>();
    for (const { entries, latestPrices, klines } of inputs) {
      allEntries.push(...entries);
      Object.assign(allLatest, latestPrices);
      if (klines) for (const [code, m] of klines) allKlines.set(code, m);
    }
    const synthetic: TradeV2Group = {
      id: "all", name: "全部组合",
      totalCapital: Number.MAX_SAFE_INTEGER, dailyAddLimit: Number.MAX_SAFE_INTEGER,
      stockLimits: [], allowShort: true,
      createdAt: "", updatedAt: "",
    };
    const ga = analyzeGroup(synthetic, allEntries, allLatest, allKlines);
    ga.positions = analysis.positions ?? ga.positions; // 复用已附加行情字段的（避免二次行情）
    analysis.analysis = ga;
    return analysis;
  }

  /** 组摘要（列表接口用） */
  async groupSummary(group: TradeV2Group): Promise<ReturnType<typeof buildGroupSummary>> {
    const entries = this.ctx.tradeV2Ledger.listByGroup(group.id);
    const prices = await this.latestPrices(entries);
    return buildGroupSummary(group, entries, prices);
  }
}

// ============================================================
// ============================================================
// declare module：四个服务加入 Context 接口（编译时类型安全）
// ============================================================

declare module "@deepseek-ai/cordis" {
  interface Context {
    tradeV2Group: TradeV2GroupService;
    tradeV2Ledger: TradeV2LedgerService;
    tradeV2Analysis: TradeV2AnalysisService;
  }
}

