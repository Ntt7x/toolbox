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
} from "@toolbox/shared";
import { REVERSE_REPO_MONTHLY, REVERSE_REPO_OPERATIONS, REVERSE_REPO_SOURCE } from "./monthlyData.js";

function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** 存量数据：逐笔流水 + 月度汇总（投放/净投放/累计净投放）+ 余额曲线（累计净投放 = 存量余额） */
export function getMonthlyData(): ReverseRepoMonthlyResponse {
  const series = REVERSE_REPO_MONTHLY
    .filter((r) => r.cumulativeNet !== null && r.cumulativeNet !== undefined)
    .map((r) => ({ month: r.month, balance: r.cumulativeNet as number }));
  const last = REVERSE_REPO_MONTHLY[REVERSE_REPO_MONTHLY.length - 1];
  return {
    ok: true,
    source: REVERSE_REPO_SOURCE,
    operations: REVERSE_REPO_OPERATIONS,
    rows: REVERSE_REPO_MONTHLY,
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
