// ============================================================
// 央行利率分析（cb-rate）：LLM 驱动
// 复用公共 llm 模块（DeepSeek chat + JSON 输出模式），
// 固化「九大央行利率政策时间线」分析提示词，输出结构化 JSON。
// ============================================================

import { chat, DEFAULT_MODEL } from "../../core/llm.js";
import { getPromptTemplate } from "../../core/prompts.js";
import { robustJsonParse } from "../../core/jsonParse.js";
import type {
  CbAction,
  CbRateBank,
  CbRatePeriod,
  CbRateRequest,
  CbRateResult,
} from "@toolbox/shared";

/** 九大央行稳定清单（白名单校验用；提示词 {banksText} 由 prompts 注册表提供） */
const BANKS: { id: string; name: string }[] = [
  { id: "fed", name: "美联储" },
  { id: "ecb", name: "欧洲央行" },
  { id: "boj", name: "日本央行" },
  { id: "boe", name: "英国央行" },
  { id: "boc", name: "加拿大央行" },
  { id: "rba", name: "澳大利亚央行" },
  { id: "rbnz", name: "新西兰央行" },
  { id: "snb", name: "瑞士央行" },
  { id: "norges", name: "挪威央行" },
];

const VALID_ACTIONS: CbAction[] = ["hike", "cut", "hold", "mixed"];

/** 基于「本地设置数据」中的提示词模板构建 system prompt（占位符替换，支持 search/日历四组合） */
function buildSystemPrompt(_withCalendar: boolean, withSearch: boolean): string {
  // 成本原则：system 仅按 search 模式 2 变体（banks/日历/日期全部在 user 消息，保持前缀缓存命中）
  return getPromptTemplate("cb-rate.system").replace(
    "{searchNote}",
    withSearch ? getPromptTemplate("cb-rate.note.search") : getPromptTemplate("cb-rate.note.knowledge"),
  );
}

function buildUserPrompt(period: CbRatePeriod, banks?: string[], month?: string, withCalendar = false): string {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  let periodLabel: string;
  if (month) {
    const [y, m] = month.split("-");
    periodLabel = `${y}年${Number(m)}月`;
  } else {
    periodLabel = period === "month" ? "本月" : "今年以来";
  }
  const scope = banks && banks.length > 0
    ? `指定央行：${banks.map((id) => BANKS.find((b) => b.id === id)?.name ?? id).join("、")}`
    : "九大央行";
  const timeNote = month
    ? `${periodLabel}当月（自然月，截至月末）`
    : `${periodLabel}（截至今天 ${today}）`;
  // 成本原则：banks 固定清单与日历指令放 user（system 保持固定，前缀缓存命中）
  const bankList = `九大央行：${BANKS.map((b) => `${b.id}=${b.name}`).join(" | ")}`;
  const calendarNote = withCalendar ? "\n请附 calendar 字段：本分析期内各央行议息会议时间表（含未来 2 个月内）。" : "";
  return (
    getPromptTemplate("cb-rate.user")
      .replace("{date}", today)
      .replace("{timeNote}", timeNote)
      .replace("{scope}", scope) + `\n${bankList}${calendarNote}`
  );
}

/** 规范化 LLM 返回的银行列表：过滤未知 id、校验 action（不静默篡改，异常加 flags）、补齐名称 */
export function normalizeBanks(raw: unknown, allowedIds: string[]): CbRateBank[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(allowedIds);
  const seen = new Set<string>();
  const out: CbRateBank[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    const id = typeof b.id === "string" ? b.id : "";
    if (!allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    const action = b.action;
    const flags: string[] = [];
    let finalAction: CbAction;
    if (VALID_ACTIONS.includes(action as CbAction)) {
      finalAction = action as CbAction;
    } else {
      // 不静默篡改：降级为 hold 展示，但明确标记数据异常
      finalAction = "hold";
      flags.push(`action「${String(action ?? "空")}」无法识别，已按 hold 展示`);
    }
    const bank: CbRateBank = {
      id,
      name: typeof b.name === "string" ? b.name : BANKS.find((x) => x.id === id)?.name ?? id,
      latestRate: typeof b.latestRate === "string" ? b.latestRate : "",
      action: finalAction,
      actionDesc: typeof b.actionDesc === "string" ? b.actionDesc : "",
      ...(typeof b.details === "string" && b.details ? { details: b.details } : {}),
      ...(typeof b.nextMeeting === "string" && b.nextMeeting ? { nextMeeting: b.nextMeeting } : {}),
      ...(typeof b.outlook === "string" && b.outlook ? { outlook: b.outlook } : {}),
      ...(typeof b.updatedAt === "string" && b.updatedAt ? { updatedAt: b.updatedAt } : {}),
    };
    if (flags.length > 0) bank.flags = flags;
    out.push(bank);
  }
  return out;
}

/** 计算请求了但 LLM 未返回的央行 id */
export function missingBanks(returned: CbRateBank[], allowedIds: string[]): string[] {
  const got = new Set(returned.map((b) => b.id));
  return allowedIds.filter((id) => !got.has(id));
}

/** 校验月份格式：YYYY-MM（过去 24 个月内） */
export function isValidMonth(v: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(v)) return false;
  const [y, m] = v.split("-").map(Number);
  if (m < 1 || m > 12) return false;
  const now = new Date();
  const cur = now.getFullYear() * 12 + now.getMonth();
  const target = y * 12 + (m - 1);
  return target <= cur && target > cur - 24;
}

/** 央行利率分析（入口） */
export async function analyzeCentralBankRates(
  req: CbRateRequest,
  signal?: AbortSignal,
): Promise<CbRateResult> {
  const period = req.period ?? "month";
  const month = req.month && isValidMonth(req.month) ? req.month : undefined;
  if (req.month && !month) {
    return { ok: false, message: "month 格式应为 YYYY-MM 且在过去 24 个月内" };
  }
  // 2026-08-14：未知央行 id 直接 400（此前静默过滤，缓存 key 与结果不对齐）
  if (req.banks && req.banks.length > 0) {
    const unknown = req.banks.filter((id) => !BANKS.some((b) => b.id === id));
    if (unknown.length > 0) {
      return { ok: false, message: `未知央行 id：${unknown.join("、")}（支持：${BANKS.map((b) => b.id).join("/")}）` };
    }
  }
  const allowedIds = req.banks && req.banks.length > 0
    ? BANKS.map((b) => b.id).filter((id) => req.banks!.includes(id))
    : BANKS.map((b) => b.id);

  const useSearch = req.search !== false; // 默认开启联网搜索
  const dataMode = useSearch ? "search" : "knowledge";

  const messages = [
    { role: "system" as const, content: buildSystemPrompt(req.withCalendar === true, useSearch) },
    { role: "user" as const, content: buildUserPrompt(period, allowedIds, month, req.withCalendar === true) },
  ];
  const result = await chat(messages, {
    model: DEFAULT_MODEL,
    json: true,
    module: "cb-rate",
    ...(useSearch ? { search: true } : {}),
    ...(signal ? { signal } : {}),
  });

  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  // 解析 JSON（多层容错：直接 parse → 提取最外层 → 修复值内裸引号）
  const content = result.content.trim();
  const parsed = robustJsonParse(content);
  if (!parsed) {
    return {
      ok: false,
      message: `LLM 输出无法解析为结构化数据。原始输出（前 200 字）：${content.slice(0, 200)}`,
    };
  }

  const p = parsed as Record<string, unknown>;
  const banks = normalizeBanks(p.banks, allowedIds);
  if (banks.length === 0) {
    return { ok: false, message: "LLM 未返回有效的央行数据，请重试" };
  }
  const missing = missingBanks(banks, allowedIds);

  const asOf = typeof p.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.asOf) ? p.asOf : "";
  const knowledgeCutoff =
    typeof p.knowledgeCutoff === "string" && /^\d{4}-\d{2}$/.test(p.knowledgeCutoff) ? p.knowledgeCutoff : undefined;
  const calendar = Array.isArray(p.calendar)
    ? p.calendar
        .filter((c) => c && typeof c === "object")
        .map((c) => {
          const cc = c as Record<string, unknown>;
          return {
            date: typeof cc.date === "string" ? cc.date : "",
            bank: typeof cc.bank === "string" ? cc.bank : "",
            desc: typeof cc.desc === "string" ? cc.desc : "",
          };
        })
        .filter((c) => c.date && c.bank)
    : undefined;

  return {
    ok: true,
    asOf,
    period,
    summary: typeof p.summary === "string" ? p.summary : "",
    banks,
    ...(calendar && calendar.length > 0 ? { calendar } : {}),
    model: result.model,
    dataMode,
    ...(dataMode === "knowledge" && knowledgeCutoff ? { knowledgeCutoff } : {}),
    ...(missing.length > 0 ? { missingBanks: missing } : {}),
    ...(result.searchQueries && result.searchQueries.length > 0 ? { searchQueries: result.searchQueries } : {}),
    raw: content,
  };
}
