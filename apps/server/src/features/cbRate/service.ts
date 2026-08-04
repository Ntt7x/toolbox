// ============================================================
// 央行利率分析（cb-rate）：LLM 驱动
// 复用公共 llm 模块（DeepSeek chat + JSON 输出模式），
// 固化「九大央行利率政策时间线」分析提示词，输出结构化 JSON。
// ============================================================

import { chat, DEFAULT_MODEL } from "../../core/llm.js";
import type {
  CbAction,
  CbRateBank,
  CbRatePeriod,
  CbRateRequest,
  CbRateResult,
} from "@toolbox/shared";

/** 九大央行稳定清单（提示词与白名单共用） */
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

function buildSystemPrompt(withCalendar: boolean, withSearch: boolean): string {
  const banksText = BANKS.map((b) => `${b.id} ${b.name}`).join(" | ");
  const searchNote = withSearch
    ? "4. 本次调用已启用联网搜索：优先采用搜索结果中的最新信息；回答中若引用搜索来源，保留类似 [reference:N] 的引用标记。\n5. 必须明确标注数据截至日期 asOf（YYYY-MM-DD），即搜索结果中最新的信息日期。"
    : "4. 数据基于你的训练知识，必须明确标注数据截至日期 asOf（YYYY-MM-DD，即你知识的最新日期）。\n5. 数据时效有限，若不确定最新情况，在 summary 中注明。";
  return `你是一个央行利率政策分析助手，专精于全球主要央行的利率政策时间线。
九大央行固定清单（必须全部覆盖，除非用户指定部分）：${banksText}

要求：
1. 基于你的知识给出最准确、最新的信息；不确定的字段明确省略或标注"不确定"。
2. 必须明确标注数据截至日期 asOf（YYYY-MM-DD）。
3. 输出必须是合法 JSON 对象（不要输出任何其它文字），结构严格如下：
{
  "asOf": "YYYY-MM-DD",
  "summary": "政策取向小结：按【已加息 / 多次加息后暂停 / 按兵不动】分类，并提示近期会议观察窗口",
  "banks": [
    {
      "id": "fed",
      "name": "美联储",
      "latestRate": "3.50%–3.75%",
      "action": "hike|cut|hold|mixed",
      "actionDesc": "决策描述（含日期与基点数），如：7月30日维持利率不变（连续第五次按兵不动）",
      "details": "决议详情：投票结果、内部分歧、行长表态（有则填，无则省略）",
      "nextMeeting": "下次会议时间（有则填，无则省略）",
      "outlook": "前瞻指引 / 市场预期（有则填，无则省略）",
      "updatedAt": "YYYY-MM-DD 最新一次利率变动日期（本月/今年无变动可省略）"
    }
  ]${withCalendar ? ',\n  "calendar": [{"date": "YYYY-MM-DD", "bank": "美联储", "desc": "议息会议"}]' : ""}
}
${searchNote}
6. action 取值：hike=加息，cut=降息，hold=按兵不动，mixed=方向混合（如既有加息又有降息）。
7. ${withCalendar ? "calendar 列出近期（未来 2 个月内）各央行议息会议日历。" : "不要输出 calendar 字段。"}
8. banks 至少覆盖用户要求的所有央行（默认全部九家）。`;
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
  return `今天是 ${today}。分析${timeNote}${scope}的关键利率政策时间线（加息、降息），输出 JSON。`;
}

/** 规范化 LLM 返回的银行列表：过滤未知 id、校验 action、补齐名称 */
function normalizeBanks(raw: unknown, allowedIds: string[]): CbRateBank[] {
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
    const action = VALID_ACTIONS.includes(b.action as CbAction) ? (b.action as CbAction) : "hold";
    out.push({
      id,
      name: typeof b.name === "string" ? b.name : BANKS.find((x) => x.id === id)?.name ?? id,
      latestRate: typeof b.latestRate === "string" ? b.latestRate : "",
      action,
      actionDesc: typeof b.actionDesc === "string" ? b.actionDesc : "",
      ...(typeof b.details === "string" && b.details ? { details: b.details } : {}),
      ...(typeof b.nextMeeting === "string" && b.nextMeeting ? { nextMeeting: b.nextMeeting } : {}),
      ...(typeof b.outlook === "string" && b.outlook ? { outlook: b.outlook } : {}),
      ...(typeof b.updatedAt === "string" && b.updatedAt ? { updatedAt: b.updatedAt } : {}),
    });
  }
  return out;
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
export async function analyzeCentralBankRates(req: CbRateRequest): Promise<CbRateResult> {
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

  const messages = [
    { role: "system" as const, content: buildSystemPrompt(req.withCalendar === true, useSearch) },
    { role: "user" as const, content: buildUserPrompt(period, allowedIds, month) },
  ];
  const result = await chat(messages, {
    model: DEFAULT_MODEL,
    json: true,
    ...(useSearch ? { search: true } : {}),
  });

  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  // 解析 JSON（容忍 LLM 偶尔包裹代码块/前后杂质）
  let parsed: unknown = null;
  const content = result.content.trim();
  try {
    parsed = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== "object") {
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

  const asOf = typeof p.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.asOf) ? p.asOf : "";
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
    ...(result.searchQueries && result.searchQueries.length > 0 ? { searchQueries: result.searchQueries } : {}),
    raw: content,
  };
}
