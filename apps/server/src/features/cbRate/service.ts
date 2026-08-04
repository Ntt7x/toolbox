// ============================================================
// 央行利率分析（cb-rate）：LLM 驱动
// 复用公共 llm 模块（DeepSeek chat + JSON 输出模式），
// 固化「九大央行利率政策时间线」分析提示词，输出结构化 JSON。
// ============================================================

import { chat, DEFAULT_MODEL } from "../../core/llm.js";
import {
  CB_RATE_SEARCH_NOTE_DEFAULT,
  CB_RATE_SEARCH_NOTE_KNOWLEDGE,
  getPromptTemplate,
} from "../../core/prompts.js";
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
function buildSystemPrompt(withCalendar: boolean, withSearch: boolean): string {
  const banksText = BANKS.map((b) => `${b.id} ${b.name}`).join(" | ");
  return getPromptTemplate("cb-rate.system")
    .replace("{banksText}", banksText)
    .replace(
      "{calendarJson}",
      withCalendar ? ',\n  "calendar": [{"date": "YYYY-MM-DD", "bank": "美联储", "desc": "议息会议"}]' : "",
    )
    .replace("{searchNote}", withSearch ? CB_RATE_SEARCH_NOTE_DEFAULT : CB_RATE_SEARCH_NOTE_KNOWLEDGE)
    .replace(
      "{calendarRule}",
      withCalendar ? "calendar 列出近期（未来 2 个月内）各央行议息会议日历。" : "不要输出 calendar 字段。",
    );
}

function buildUserPrompt(period: CbRatePeriod, banks?: string[], month?: string): string {
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
  return getPromptTemplate("cb-rate.user")
    .replace("{date}", today)
    .replace("{timeNote}", timeNote)
    .replace("{scope}", scope);
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

// ============================================================
// LLM JSON 输出容错解析
// 逐级降级：直接 parse → 栈匹配提取最外层 JSON → 修复值内裸引号后 parse。
// LLM 常在字符串值内插入未转义的半角引号（如 "摘要"xxx"yyy"），
// 直接 JSON.parse 必然失败，需启发式修复。
// ============================================================

/** 提取从首个 { 到最外层配对的 } 的子串（跳过字符串内的 { }） */
export function extractOuterJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 修复字符串值内未转义的半角引号。
 * 两遍扫描：
 * 1) 第一遍定位字符串状态内所有裸引号，按后随字符分为"内容引号"与"结束候选"；
 * 2) 最后一个结束候选作为真正的字符串结束引号，其余（含全部内容引号）一律转义。
 * 覆盖 LLM 最常见的畸形模式：内容引号成对出现且与字符串结束挤在一起（如 "高"}"）。
 */
export function fixJsonQuotes(s: string): string {
  // 第一遍：标记
  const marks: { pos: number; kind: "content" | "end-cand" }[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') {
        const rest = s.slice(i + 1).replace(/^\s+/, "");
        const isEnd =
          rest.startsWith(",") || rest.startsWith("}") || rest.startsWith("]") || rest.startsWith(":");
        marks.push({ pos: i, kind: isEnd ? "end-cand" : "content" });
      }
    } else if (ch === '"') {
      inStr = true;
    }
  }
  const ends = marks.filter((m) => m.kind === "end-cand");
  const endPos = ends.length > 0 ? ends[ends.length - 1].pos : -1;
  const contentPos = new Set(marks.filter((m) => m.kind === "content").map((m) => m.pos));

  // 第二遍：重写（只转义 content 引号；键名闭合等合法结构引号保持原样）
  let out = "";
  inStr = false;
  esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
      } else if (ch === "\\") {
        out += ch;
        esc = true;
      } else if (ch === '"') {
        if (i === endPos) {
          out += ch;
          inStr = false;
        } else if (contentPos.has(i)) {
          out += '\\"';
        } else {
          out += ch;
          inStr = false;
        }
      } else {
        out += ch;
      }
    } else {
      out += ch;
      if (ch === '"') inStr = true;
    }
  }
  return out;
}

/** 多层容错解析：成功返回对象，失败返回 null */
export function robustJsonParse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  // 1. 直接解析
  let v = tryParse(trimmed);
  if (v) return v;
  // 2. 栈匹配提取最外层 JSON（容忍前后杂质/代码块；假设结构合法）
  const outer = extractOuterJson(trimmed);
  if (outer) {
    v = tryParse(outer);
    if (v) return v;
  }
  // 3. 修复值内裸引号后整体解析（fix 使引号恢复平衡）
  const fixed = fixJsonQuotes(trimmed);
  v = tryParse(fixed);
  if (v) return v;
  // 4. 修复后重新提取最外层再解析
  if (outer) {
    v = tryParse(fixJsonQuotes(outer));
    if (v) return v;
  }
  return null;
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
  const allowedIds = req.banks && req.banks.length > 0
    ? BANKS.map((b) => b.id).filter((id) => req.banks!.includes(id))
    : BANKS.map((b) => b.id);
  if (allowedIds.length === 0) {
    return { ok: false, message: "指定的央行不在九大央行清单中" };
  }

  const useSearch = req.search !== false; // 默认开启联网搜索
  const dataMode = useSearch ? "search" : "knowledge";

  const messages = [
    { role: "system" as const, content: buildSystemPrompt(req.withCalendar === true, useSearch) },
    { role: "user" as const, content: buildUserPrompt(period, allowedIds, month) },
  ];
  const result = await chat(messages, {
    model: DEFAULT_MODEL,
    json: true,
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
