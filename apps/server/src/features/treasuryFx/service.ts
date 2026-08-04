// ============================================================
// 业务模块：国债汇率分析（treasury-fx）：LLM 驱动
// 人民币短波段研判框架（汇率套利 + 债券信号）固化为提示词（存于本地设置数据），
// 复用公共 llm 模块（DeepSeek chat + 联网搜索）+ core/jsonParse 容错解析。
// ============================================================

import { chat } from "../../core/llm.js";
import { getPromptTemplate } from "../../core/prompts.js";
import { robustJsonParse } from "../../core/jsonParse.js";
import type { TreasuryFxRequest, TreasuryFxResult, TreasuryFxRow } from "@toolbox/shared";

/** 校验并归一化 days（1~10，默认 5） */
export function normalizeDays(v: unknown): number {
  const n = typeof v === "number" && Number.isInteger(v) ? v : 5;
  return Math.min(10, Math.max(1, n));
}

/** 构建 system prompt（从本地设置数据读模板；无占位符，原样返回） */
function buildSystemPrompt(): string {
  return getPromptTemplate("treasury-fx.system");
}

/** 构建 user prompt（占位符 {date} {days}） */
function buildUserPrompt(days: number): string {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return getPromptTemplate("treasury-fx.user").replace("{date}", today).replace("{days}", String(days));
}

/** 国债汇率分析（入口）：返回 ok:false 或结构化分析结果 */
export async function analyzeTreasuryFx(req: TreasuryFxRequest, signal?: AbortSignal): Promise<TreasuryFxResult> {
  const days = normalizeDays(req.days);
  const useSearch = req.search !== false; // 默认开启联网搜索
  const dataMode = useSearch ? "search" : "knowledge";

  const messages = [
    { role: "system" as const, content: buildSystemPrompt() },
    { role: "user" as const, content: buildUserPrompt(days) },
  ];

  const result = await chat(messages, {
    temperature: 0.3,
    ...(useSearch ? { search: true } : {}),
    ...(signal ? { signal } : {}),
  });
  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  const content = result.content.trim();
  const parsed = robustJsonParse(content);
  if (!parsed) {
    return { ok: false, message: `LLM 输出无法解析为结构化数据。原始输出（前 200 字）：${content.slice(0, 200)}` };
  }

  const p = parsed as Record<string, unknown>;
  // rows 规范化
  const rows: TreasuryFxRow[] = Array.isArray(p.rows)
    ? p.rows
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        .map((r) => ({
          date: typeof r.date === "string" ? r.date : "",
          ...(typeof r.usdjpy === "string" ? { usdjpy: r.usdjpy } : {}),
          ...(typeof r.usdcny === "string" ? { usdcny: r.usdcny } : {}),
          ...(typeof r.uj === "string" ? { uj: r.uj } : {}),
          ...(typeof r.uc === "string" ? { uc: r.uc } : {}),
          ...(typeof r.rank === "string" ? { rank: r.rank } : {}),
          ...(typeof r.jp10y === "string" ? { jp10y: r.jp10y } : {}),
          ...(typeof r.cn10y === "string" ? { cn10y: r.cn10y } : {}),
          ...(typeof r.spreadBp === "string" ? { spreadBp: r.spreadBp } : {}),
        }))
    : [];
  if (rows.length === 0) {
    return { ok: false, message: "LLM 未返回有效的行情数据行，请重试" };
  }

  const asOf = typeof p.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.asOf) ? p.asOf : "";
  const knowledgeCutoff =
    typeof p.knowledgeCutoff === "string" && /^\d{4}-\d{2}$/.test(p.knowledgeCutoff) ? p.knowledgeCutoff : undefined;

  return {
    ok: true,
    asOf,
    days,
    summary: typeof p.summary === "string" ? p.summary : "",
    rows,
    conclusion: typeof p.conclusion === "string" ? p.conclusion : "",
    model: result.model,
    dataMode,
    ...(dataMode === "knowledge" && knowledgeCutoff ? { knowledgeCutoff } : {}),
    ...(result.searchQueries && result.searchQueries.length > 0 ? { searchQueries: result.searchQueries } : {}),
    raw: content,
  };
}
