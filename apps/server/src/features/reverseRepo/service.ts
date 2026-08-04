// ============================================================
// 业务模块：逆回购余额跟踪（reverse-repo）
// 存量：月度操作/余额表（权威数据种子 monthlyData.ts，可直接读取）
// 增量：每日变动探查（LLM 搜索）+ 当月变动量说明
// 提示词存于本地设置数据（prompts 注册表），LLM JSON 用 core/jsonParse 容错。
// ============================================================

import { chat } from "../../core/llm.js";
import { getPromptTemplate } from "../../core/prompts.js";
import { robustJsonParse } from "../../core/jsonParse.js";
import type {
  ReverseRepoDailyResult,
  ReverseRepoMonthlyResponse,
  ReverseRepoMonthlyRow,
} from "@toolbox/shared";
import { REVERSE_REPO_MONTHLY } from "./monthlyData.js";

function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** 月度存量数据：月度表 + 余额序列（余额非空的月份）+ 截至月份 */
export function getMonthlyData(): ReverseRepoMonthlyResponse {
  const rows: ReverseRepoMonthlyRow[] = REVERSE_REPO_MONTHLY;
  const series = rows
    .filter((r) => r.monthEndBalance !== null && r.monthEndBalance !== undefined)
    .map((r) => ({ month: r.month, balance: r.monthEndBalance as number }));
  const last = rows[rows.length - 1];
  return {
    ok: true,
    source: "权威数据（中国人民银行买断式逆回购业务公告，2024.10-2026.8）",
    rows,
    series,
    asOf: last?.month ?? todayStr(),
  };
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
