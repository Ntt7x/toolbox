// ============================================================
// 业务模块：逆回购余额跟踪（reverse-repo）
// 存量：月度操作/余额表（默认种子 monthlyData.ts → 幂等 seed 进本地数据管理 KV，
//       运行时从 KV 读取；用户可在「本地数据管理」页编辑/删除，删除后自动重新 seed）
// 增量：每日变动探查（LLM 搜索）+ 当月变动量说明
// 提示词存于本地设置数据（prompts 注册表），LLM JSON 用 core/jsonParse 容错。
// ============================================================

import { chat } from "../../core/llm.js";
import { getPromptTemplate } from "../../core/prompts.js";
import { robustJsonParse } from "../../core/jsonParse.js";
import { kvGet, kvHas, kvSet } from "../../core/kvStore.js";
import type {
  ReverseRepoDailyResult,
  ReverseRepoMonthlyResponse,
  ReverseRepoMonthlyRow,
  ReverseRepoMonthlyUpdateStatus,
  ReverseRepoOperation,
} from "@toolbox/shared";
import { REVERSE_REPO_MONTHLY, REVERSE_REPO_OPERATIONS, REVERSE_REPO_SOURCE } from "./monthlyData.js";

function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** 存量数据 KV key（本地数据管理：可查看/编辑/删除；删除后下次访问自动重新 seed） */
export const MONTHLY_KEY = "reverseRepo:monthly";

/** 月度更新任务状态 KV key */
export const UPDATE_STATE_KEY = "reverseRepo:monthlyUpdate";

interface MonthlyPayload {
  source: string;
  operations: ReverseRepoMonthlyResponse["operations"];
  rows: ReverseRepoMonthlyResponse["rows"];
  seededAt: string;
}

/** 幂等 seed：仅当 KV 无该 key 时写入默认数据，绝不覆盖用户编辑 */
export function seedMonthlyData(): void {
  if (!kvHas(MONTHLY_KEY)) {
    kvSet(MONTHLY_KEY, {
      source: REVERSE_REPO_SOURCE,
      operations: REVERSE_REPO_OPERATIONS,
      rows: REVERSE_REPO_MONTHLY,
      seededAt: new Date().toISOString(),
    } satisfies MonthlyPayload);
  }
}

/** 存量数据：逐笔流水 + 月度汇总（投放/净投放/累计净投放）+ 余额曲线（累计净投放 = 存量余额） */
export function getMonthlyData(): ReverseRepoMonthlyResponse {
  seedMonthlyData();
  const saved = kvGet<MonthlyPayload>(MONTHLY_KEY);
  const rows = saved?.rows && saved.rows.length > 0 ? saved.rows : REVERSE_REPO_MONTHLY;
  const operations = saved?.operations && saved.operations.length > 0 ? saved.operations : REVERSE_REPO_OPERATIONS;
  const series = rows
    .filter((r) => r.cumulativeNet !== null && r.cumulativeNet !== undefined)
    .map((r) => ({ month: r.month, balance: r.cumulativeNet as number }));
  const last = rows[rows.length - 1];
  return {
    ok: true,
    source: saved?.source ?? REVERSE_REPO_SOURCE,
    operations,
    rows,
    series,
    asOf: last?.month ?? todayStr(),
  };
}

// ============================================================
// 触发式月度更新：若存在「上个月及更远」未更新的月份，服务端触发 LLM 搜索补全
// ============================================================

/** 当前年月 YYYY-MM（本地时区） */
function currentMonth(): string {
  return todayStr().slice(0, 7);
}

/** 上个月 YYYY-MM */
function prevMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 2, 1); // 月份减 1：m-1 月的 1 号
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 下一个月份 YYYY-MM */
function nextMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m, 1); // m+1 月的 1 号
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * 缺失月份列表：从最新数据月的下一个月 到 上个月（含上个月）。
 * 最新数据月 = rows 里最大的 month；若最新已 ≥ 上个月则无缺失（当月进行中不要求）。
 */
export function missingMonths(rows: ReverseRepoMonthlyResponse["rows"], now = new Date()): string[] {
  if (!rows || rows.length === 0) return [];
  const maxMonth = rows.map((r) => r.month).sort().at(-1)!;
  const target = prevMonth(currentMonth()); // 上个月
  if (maxMonth >= target) return [];
  const out: string[] = [];
  for (let m = nextMonth(maxMonth); m <= target; m = nextMonth(m)) out.push(m);
  return out;
}

interface UpdateState {
  state: "idle" | "running" | "done" | "failed";
  months?: string[];
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  updated?: ReverseRepoMonthlyUpdateStatus["updated"];
}

/** 读取当前月度更新状态（无记录视为 idle） */
export function getUpdateState(): UpdateState {
  return kvGet<UpdateState>(UPDATE_STATE_KEY) ?? { state: "idle" };
}

/** 执行月度数据更新（LLM 搜索补全缺失月份）；成功返回更新摘要，失败抛错 */
export async function runMonthlyUpdate(months: string[], signal?: AbortSignal): Promise<UpdateState> {
  const startedAt = new Date().toISOString();
  kvSet(UPDATE_STATE_KEY, { state: "running", months, startedAt } satisfies UpdateState);

  try {
    const template = getPromptTemplate("reverse-repo.monthly-update");
    const messages = [
      { role: "system" as const, content: template.replace("{months}", months.join("、")) },
      { role: "user" as const, content: "请联网搜索并输出缺失月份的买断式逆回购数据 JSON。" },
    ];
    const result = await chat(messages, { temperature: 0.2, search: true, ...(signal ? { signal } : {}) });
    if (!result.ok) throw new Error(result.message);

    const parsed = robustJsonParse(result.content.trim());
    if (!parsed) throw new Error(`LLM 输出无法解析为结构化数据。原始输出（前 200 字）：${result.content.trim().slice(0, 200)}`);

    const p = parsed as Record<string, unknown>;
    const updated = mergeMonthlyUpdate(p, months);
    if (updated.length === 0) throw new Error("LLM 未返回任何有效的新月份数据");

    const state: UpdateState = {
      state: "done",
      months,
      startedAt,
      finishedAt: new Date().toISOString(),
      message: `已补全 ${updated.map((u) => u.month).join("、")}`,
      updated,
    };
    kvSet(UPDATE_STATE_KEY, state);
    return state;
  } catch (err) {
    const state: UpdateState = {
      state: "failed",
      months,
      startedAt,
      finishedAt: new Date().toISOString(),
      message: err instanceof Error ? err.message : String(err),
    };
    kvSet(UPDATE_STATE_KEY, state);
    return state;
  }
}

/** 校验 + 合并 LLM 返回的月度更新进 KV（返回实际写入的月份） */
function mergeMonthlyUpdate(p: Record<string, unknown>, expected: string[]): NonNullable<UpdateState["updated"]> {
  seedMonthlyData();
  const saved = kvGet<MonthlyPayload>(MONTHLY_KEY);
  const rows = (saved?.rows && saved.rows.length > 0 ? saved.rows : REVERSE_REPO_MONTHLY).slice();
  const operations = (saved?.operations && saved.operations.length > 0 ? saved.operations : REVERSE_REPO_OPERATIONS).slice();
  const maxMonth = rows.map((r) => r.month).sort().at(-1) ?? "";

  const written: NonNullable<UpdateState["updated"]> = [];
  const newRows = Array.isArray(p.months) ? p.months.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];

  for (const r of newRows) {
    const month = typeof r.month === "string" && /^\d{4}-\d{2}$/.test(r.month) ? r.month : "";
    if (!month) continue;
    // 只接受缺失月份（> 现有最大月，且在本次 expected 内），防止乱序/重复
    if (!(month > maxMonth) || !expected.includes(month)) continue;
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    const row: ReverseRepoMonthlyRow = {
      month,
      opDate: typeof r.opDate === "string" ? r.opDate : "",
      operationTotal: num(r.operationTotal),
      m3: num(r.m3),
      m6: num(r.m6),
      netChange: typeof r.netChange === "number" && Number.isFinite(r.netChange) ? r.netChange : null,
      cumulativeNet: typeof r.cumulativeNet === "number" && Number.isFinite(r.cumulativeNet) ? r.cumulativeNet : null,
      note: typeof r.note === "string" ? r.note : "",
    };
    rows.push(row);
    written.push({ month, operationTotal: row.operationTotal, netChange: row.netChange, cumulativeNet: row.cumulativeNet });
  }

  // 逐笔操作（去重：date+term 相同则替换）
  const opRows = Array.isArray(p.operations) ? p.operations.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
  for (const o of opRows) {
    const date = typeof o.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : "";
    const term = typeof o.term === "string" ? o.term : "";
    const amount = typeof o.amount === "number" && Number.isFinite(o.amount) && o.amount > 0 ? o.amount : 0;
    if (!date || !term || amount <= 0) continue;
    const idx = operations.findIndex((x) => x.date === date && x.term === term);
    const op: ReverseRepoOperation = {
      date,
      term: term === "3M" || term === "6M" ? term : "6M",
      amount,
      source: typeof o.source === "string" ? o.source : "触发式月度更新",
    };
    if (idx >= 0) operations[idx] = op;
    else operations.push(op);
  }

  if (written.length === 0) return written;

  rows.sort((a, b) => (a.month < b.month ? -1 : 1));
  operations.sort((a, b) => (a.date < b.date ? -1 : 1));
  const source =
    (saved?.source ?? REVERSE_REPO_SOURCE) +
    (typeof p.source === "string" && p.source.trim() ? `；${p.source.trim()}` : "");
  kvSet(MONTHLY_KEY, { source, operations, rows, seededAt: saved?.seededAt ?? new Date().toISOString() } satisfies MonthlyPayload);
  return written;
}

/** 每日变动探查（增量）：LLM 搜索当日/最近变动 + 当月说明 */
export async function probeDaily(signal?: AbortSignal): Promise<ReverseRepoDailyResult> {
  const messages = [
    { role: "system" as const, content: getPromptTemplate("reverse-repo.daily").replace("{date}", todayStr()) },
    { role: "user" as const, content: "请按上述要求执行探查并输出 JSON。" },
  ];
  const result = await chat(messages, { temperature: 0.2, search: true, ...(signal ? { signal } : {}) });
  if (!result.ok) return { ok: false, message: result.message };

  const content = result.content.trim();
  const parsed = robustJsonParse(content);
  if (!parsed) {
    return { ok: false, message: `LLM 输出无法解析为结构化数据。原始输出（前 200 字）：${content.slice(0, 200)}` };
  }

  const p = parsed as Record<string, unknown>;
  const dailyChanges = (Array.isArray(p.dailyChanges) ? p.dailyChanges : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((c) => ({
      date: typeof c.date === "string" ? c.date : "",
      type: typeof c.type === "string" ? c.type : "",
      kind: typeof c.kind === "string" ? c.kind : "",
      ...(typeof c.term === "string" && c.term ? { term: c.term } : {}),
      amount: typeof c.amount === "number" && Number.isFinite(c.amount) ? c.amount : 0,
      desc: typeof c.desc === "string" ? c.desc : "",
    }));

  return {
    ok: true,
    asOf: typeof p.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.asOf) ? p.asOf : todayStr(),
    dailyChanges,
    monthSummary: typeof p.monthSummary === "string" ? p.monthSummary : "",
    ...(typeof p.currentBalance === "number" && Number.isFinite(p.currentBalance) ? { currentBalance: p.currentBalance } : {}),
    model: result.model,
    raw: content,
  };
}
