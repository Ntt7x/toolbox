// ============================================================
// 自选股·提醒设置：规则校验与命中判定的纯函数层
// 券商式提醒（价格点位 / 涨跌幅 / 周期涨跌幅 / 振幅）——判定必须确定性、可回放，
// 因此与持久化（alertStore.ts）分离，便于单测覆盖边界（阈值相等、方向、去重）。
// ============================================================
import type { WatchAlertHit, WatchAlertKind, WatchAlertRule, WatchPeriod } from "@toolbox/shared";

/** 判定上下文（由调用方从行情链路组装；缺失字段表示该项数据不可用） */
export interface AlertContext {
  code: string;
  name?: string;
  /** 当前交易日 YYYY-MM-DD（去重用） */
  date: string;
  /** 最新价 */
  last?: number;
  /** 当日涨跌幅 % */
  dayPct?: number;
  /** 周度涨跌幅 % */
  weekPct?: number;
  /** 月度涨跌幅 % */
  monthPct?: number;
  /** 当日振幅 % */
  amplitude?: number;
}

export const ALERT_KINDS: WatchAlertKind[] = ["price", "dayPct", "periodPct", "amplitude"];

/** 周期参数归一（periodPct 未指定周期时按周） */
export function rulePeriod(rule: Pick<WatchAlertRule, "period">): WatchPeriod {
  return rule.period === "day" || rule.period === "month" ? rule.period : "week";
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * 解析层整形：请求体 → 规则候选（只做 trim/类型转换/非法过滤，不做业务校验）。
 * 业务校验（标的归属、阈值正负）走 validateRule，见 dev.md §6.7 解析与校验分工。
 */
export function sanitizeRule(raw: unknown): WatchAlertRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const code = typeof r.code === "string" ? r.code.trim() : "";
  const kind = r.kind as WatchAlertKind;
  const threshold = Number(r.threshold);
  if (!code || !ALERT_KINDS.includes(kind) || !Number.isFinite(threshold)) return null;
  const dir = r.dir === "down" ? "down" : "up";
  const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : `al-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    code,
    ...(typeof r.name === "string" && r.name.trim() ? { name: r.name.trim() } : {}),
    kind,
    threshold,
    dir,
    ...(kind === "periodPct" ? { period: rulePeriod({ period: r.period as WatchPeriod | undefined }) } : {}),
    enabled: r.enabled !== false,
    repeat: r.repeat === "once" ? "once" : "always",
    createdAt: typeof r.createdAt === "string" && r.createdAt ? r.createdAt : new Date().toISOString(),
  };
}

/**
 * 服务端权威校验：非法规则直接拒绝并给出中文原因（前端校验只是 UX 辅助）。
 * knownCodes：所属分组（聚合分组为展开后）的标的代码集合——防止给不存在于分组的标的设提醒。
 */
export function validateRule(rule: WatchAlertRule, knownCodes: Set<string>): string | null {
  if (!rule.code) return "提醒规则缺少标的代码";
  if (!knownCodes.has(rule.code)) return `标的 ${rule.code} 不在该分组中`;
  if (!ALERT_KINDS.includes(rule.kind)) return `提醒类型无效：${String(rule.kind)}`;
  if (!Number.isFinite(rule.threshold) || rule.threshold <= 0) return "提醒阈值必须为正数";
  if (rule.kind === "price" && rule.threshold > 1_000_000) return "价格阈值超出合理范围";
  if (rule.kind !== "price" && rule.threshold > 100) return "百分比阈值不得大于 100";
  return null;
}

/** 取该规则关心的周期涨跌幅 */
function periodPctOf(ctx: AlertContext, period: WatchPeriod): number | undefined {
  if (period === "day") return ctx.dayPct;
  if (period === "month") return ctx.monthPct;
  return ctx.weekPct;
}

/**
 * 单规则判定：命中返回 WatchAlertHit，未命中/数据不足返回 null。
 * 边界：阈值相等即命中（券商惯例「触及即提醒」）。
 */
export function evaluateRule(rule: WatchAlertRule, ctx: AlertContext): WatchAlertHit | null {
  if (!rule.enabled) return null;
  if (rule.code !== ctx.code) return null;

  const at = new Date().toISOString();
  const base = { ruleId: rule.id, code: rule.code, ...(ctx.name ? { name: ctx.name } : {}) };

  if (rule.kind === "price") {
    if (typeof ctx.last !== "number") return null;
    const hit = rule.dir === "up" ? ctx.last >= rule.threshold : ctx.last <= rule.threshold;
    if (!hit) return null;
    return {
      ...base,
      date: ctx.date,
      value: round4(ctx.last),
      text: `${rule.dir === "up" ? "上破" : "下破"} ${rule.threshold}，现价 ${round4(ctx.last)}`,
      at,
    };
  }

  if (rule.kind === "amplitude") {
    if (typeof ctx.amplitude !== "number") return null;
    if (ctx.amplitude < rule.threshold) return null;
    return {
      ...base,
      date: ctx.date,
      value: round4(ctx.amplitude),
      text: `振幅达 ${round4(ctx.amplitude)}%（阈值 ${rule.threshold}%）`,
      at,
    };
  }

  const pct = rule.kind === "dayPct" ? ctx.dayPct : periodPctOf(ctx, rulePeriod(rule));
  if (typeof pct !== "number") return null;
  const hit = rule.dir === "up" ? pct >= rule.threshold : pct <= -rule.threshold;
  if (!hit) return null;

  const label = rule.kind === "dayPct" ? "日涨跌" : `${rulePeriod(rule) === "week" ? "周" : "月"}涨跌`;
  return {
    ...base,
    date: ctx.date,
    value: round4(pct),
    text: `${label} ${round4(pct)}%（${rule.dir === "up" ? "涨" : "跌"}破阈值 ${rule.threshold}%）`,
    at,
  };
}

/** 批量判定：规则 × 上下文（同一标的的多条规则各自独立判定） */
export function evaluateRules(rules: WatchAlertRule[], ctxs: AlertContext[]): WatchAlertHit[] {
  const byCode = new Map(ctxs.map((c) => [c.code, c]));
  const out: WatchAlertHit[] = [];
  for (const rule of rules) {
    const ctx = byCode.get(rule.code);
    if (!ctx) continue;
    const hit = evaluateRule(rule, ctx);
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * 命中去重合并：同一规则同一交易日只保留一条（后者覆盖），并按时间降序截断。
 * once 规则触发后由调用方依据 hits 停用（保持纯函数不写库）。
 */
export function mergeHits(history: WatchAlertHit[], incoming: WatchAlertHit[], limit = 50): WatchAlertHit[] {
  const map = new Map<string, WatchAlertHit>();
  for (const h of [...history, ...incoming]) map.set(`${h.ruleId}|${h.date}`, h);
  return [...map.values()]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, Math.max(1, limit));
}

/** once 规则在已有命中后应停用（供保存前计算最终规则状态） */
export function applyOnceFired(rules: WatchAlertRule[], hits: WatchAlertHit[]): WatchAlertRule[] {
  const fired = new Set(hits.filter((h) => h.date).map((h) => h.ruleId));
  return rules.map((r) => (r.repeat === "once" && fired.has(r.id) && r.enabled ? { ...r, enabled: false } : r));
}
