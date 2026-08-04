// ============================================================
// 买断式逆回购数据（权威数据，用户提供，多轮修订整合）
// 来源：中国人民银行买断式逆回购业务公告 + 每日经济新闻公开报道（推算补充）
// - 逐笔操作流水：精确到年月日（43 笔，2024.10.28 启用 - 2026.08.05）
// - 月度汇总：当月投放 / 当月净投放 / 累计净投放（= 存量余额）
// 余额口径：存量余额 = 累计净投放（Σ投放 − Σ到期；2026-03 锚点 7.2 万亿，
// 与央行公告/每日经济新闻披露一致，2026-07 累计 6.2 万亿 ≈ 对话中存量 6.3 万亿）
// ============================================================

import type { ReverseRepoMonthlyRow, ReverseRepoOperation } from "@toolbox/shared";

/** 逐笔操作流水（精确到年月日；"月内"为央行公告未披露具体日期） */
export const REVERSE_REPO_OPERATIONS: ReverseRepoOperation[] = [
  { date: "2024-10-28", term: "6M", amount: 5000, source: "央行公告〔2024〕第1号" },
  { date: "2024-11-（月内）", term: "3M", amount: 8000, source: "央行公告〔2024〕第2号" },
  { date: "2024-12-（月内）", term: "3M", amount: 7000, source: "央行公告〔2024〕第3号" },
  { date: "2024-12-（月内）", term: "6M", amount: 7000, source: "央行公告〔2024〕第3号" },
  { date: "2025-01-（月内）", term: "3M", amount: 12000, source: "央行公告〔2025〕第1号" },
  { date: "2025-01-（月内）", term: "6M", amount: 5000, source: "央行公告〔2025〕第1号" },
  { date: "2025-02-（月内）", term: "3M", amount: 9000, source: "央行公告" },
  { date: "2025-02-（月内）", term: "6M", amount: 5000, source: "央行公告" },
  { date: "2025-03-（月内）", term: "3M", amount: 5000, source: "央行公告" },
  { date: "2025-03-（月内）", term: "6M", amount: 3000, source: "央行公告" },
  { date: "2025-04-（月内）", term: "3M", amount: 7000, source: "央行公告〔2025〕第4号" },
  { date: "2025-04-（月内）", term: "6M", amount: 5000, source: "央行公告〔2025〕第4号" },
  { date: "2025-05-（月内）", term: "3M", amount: 4000, source: "央行公告〔2025〕第5号" },
  { date: "2025-05-（月内）", term: "6M", amount: 3000, source: "央行公告〔2025〕第5号" },
  { date: "2025-06-06", term: "3M", amount: 10000, source: "央行公告（首次月内两次操作）" },
  { date: "2025-06-16", term: "6M", amount: 4000, source: "央行公告" },
  { date: "2025-07-（月内）", term: "3M", amount: 8000, source: "央行公告" },
  { date: "2025-07-（月内）", term: "6M", amount: 6000, source: "央行公告" },
  { date: "2025-08-08", term: "3M", amount: 7000, source: "央行公告" },
  { date: "2025-08-15", term: "6M", amount: 5000, source: "央行公告" },
  { date: "2025-09-05", term: "3M", amount: 10000, source: "央行公告" },
  { date: "2025-09-15", term: "6M", amount: 6000, source: "央行公告" },
  { date: "2025-10-09", term: "3M", amount: 11000, source: "人民网 / 央行公告" },
  { date: "2025-10-15", term: "6M", amount: 6000, source: "人民网 / 央行公告" },
  { date: "2025-11-17", term: "6M", amount: 8000, source: "公告〔2025〕第11号" },
  { date: "2025-12-05", term: "3M", amount: 10000, source: "公告〔2025〕第12号" },
  { date: "2025-12-15", term: "6M", amount: 6000, source: "央行公告" },
  { date: "2026-01-08", term: "3M", amount: 11000, source: "公告〔2026〕第1号" },
  { date: "2026-01-15", term: "6M", amount: 9000, source: "央行公告" },
  { date: "2026-02-04", term: "3M", amount: 8000, source: "央行公告" },
  { date: "2026-02-13", term: "6M", amount: 10000, source: "央行公告" },
  { date: "2026-03-06", term: "3M", amount: 8000, source: "公告〔2026〕第5号" },
  { date: "2026-03-16", term: "6M", amount: 5000, source: "央行公告" },
  { date: "2026-04-07", term: "3M", amount: 8000, source: "公告〔2026〕第7号" },
  { date: "2026-04-15", term: "6M", amount: 5000, source: "公告〔2026〕第8号" },
  { date: "2026-05-15", term: "6M", amount: 3000, source: "公告〔2026〕第10号" },
  { date: "2026-06-05", term: "3M", amount: 5000, source: "公告〔2026〕第11号" },
  { date: "2026-06-15", term: "6M", amount: 6000, source: "公告〔2026〕第12号" },
  { date: "2026-07-06", term: "3M", amount: 10000, source: "公告〔2026〕第13号" },
  { date: "2026-07-15", term: "6M", amount: 14000, source: "公告〔2026〕第14号" },
  { date: "2026-08-05", term: "3M", amount: 5000, source: "公告〔2026〕第15号（操作进行中）" },
];

/**
 * 月度汇总（每日经济新闻口径，推算补充）。
 * 累计净投放 = 存量余额（2026-03 锚点 7.2 万亿为每日经济新闻明确披露；此后逐月累加）。
 */
export const REVERSE_REPO_MONTHLY: ReverseRepoMonthlyRow[] = [
  { month: "2024-10", opDate: "10-28", operationTotal: 5000, m3: 0, m6: 5000, netChange: 5000, cumulativeNet: 5000, note: "工具启用，当月无到期" },
  { month: "2024-11", opDate: "月内", operationTotal: 8000, m3: 8000, m6: 0, netChange: 8000, cumulativeNet: 13000, note: "当月无到期" },
  { month: "2024-12", opDate: "月内", operationTotal: 14000, m3: 7000, m6: 7000, netChange: 14000, cumulativeNet: 27000, note: "当月无到期" },
  { month: "2025-01", opDate: "月内", operationTotal: 17000, m3: 12000, m6: 5000, netChange: 17000, cumulativeNet: 44000, note: "当月无到期" },
  { month: "2025-02", opDate: "月内", operationTotal: 14000, m3: 9000, m6: 5000, netChange: 14000, cumulativeNet: 58000, note: "当月无到期" },
  { month: "2025-03", opDate: "月内", operationTotal: 8000, m3: 5000, m6: 3000, netChange: 8000, cumulativeNet: 66000, note: "当月无到期" },
  { month: "2025-04", opDate: "月内", operationTotal: 12000, m3: 7000, m6: 5000, netChange: null, cumulativeNet: null, note: "4月开展12000亿元（净投放未披露）" },
  { month: "2025-05", opDate: "月内", operationTotal: 7000, m3: 4000, m6: 3000, netChange: null, cumulativeNet: null, note: "5月开展7000亿元（净投放未披露）" },
  { month: "2025-06", opDate: "6-06 / 6-16", operationTotal: 14000, m3: 10000, m6: 4000, netChange: 2000, cumulativeNet: null, note: "首次月内两次操作；6月 MLF 及买断式逆回购均维持净投放" },
  { month: "2025-07", opDate: "月内", operationTotal: 14000, m3: 8000, m6: 6000, netChange: 2000, cumulativeNet: null, note: "投放14000亿，到期12000亿" },
  { month: "2025-08", opDate: "8-08 / 8-15", operationTotal: 12000, m3: 7000, m6: 5000, netChange: 3000, cumulativeNet: null, note: "投放12000亿，实现净投放3000亿元" },
  { month: "2025-09", opDate: "9-05 / 9-15", operationTotal: 16000, m3: 10000, m6: 6000, netChange: null, cumulativeNet: null, note: "9月开展16000亿元（净投放未披露）" },
  { month: "2025-10", opDate: "10-09 / 10-15", operationTotal: 17000, m3: 11000, m6: 6000, netChange: null, cumulativeNet: null, note: "修正：原表误记'无操作'；10-09 投放11000亿(3M) + 10-15 投放6000亿(6M)" },
  { month: "2025-11", opDate: "11-17", operationTotal: 15000, m3: 0, m6: 15000, netChange: null, cumulativeNet: null, note: "修正：原表误记'无操作'；11月开展15000亿元（每日经济新闻口径；逐笔公告可查 11-17 6M 8000 亿）" },
  { month: "2025-12", opDate: "12-05 / 12-15", operationTotal: 16000, m3: 10000, m6: 6000, netChange: 2000, cumulativeNet: null, note: "修正：原表误记'无操作'；买断式逆回购、MLF 分别净投放5000亿、1000亿" },
  { month: "2026-01", opDate: "1-08 / 1-15", operationTotal: 20000, m3: 11000, m6: 9000, netChange: null, cumulativeNet: null, note: "1-08 投放11000亿(3M) + 1-15 投放9000亿(6M)" },
  { month: "2026-02", opDate: "2-04 / 2-13", operationTotal: 18000, m3: 8000, m6: 10000, netChange: 6000, cumulativeNet: null, note: "两个期限品种合计净投放6000亿元" },
  { month: "2026-03", opDate: "3-06 / 3-16", operationTotal: 13000, m3: 8000, m6: 5000, netChange: -3000, cumulativeNet: 72000, note: "3M缩量2000亿 + 6M缩量1000亿；累计净投放达7.2万亿元（每日经济新闻锚点）" },
  { month: "2026-04", opDate: "4-07 / 4-15", operationTotal: 13000, m3: 8000, m6: 5000, netChange: -4000, cumulativeNet: 68000, note: "当月净回笼4000亿元" },
  { month: "2026-05", opDate: "5-15", operationTotal: 3000, m3: 0, m6: 3000, netChange: -10000, cumulativeNet: 58000, note: "历史最大单月净回笼1万亿元；3M无操作，6M缩量续作" },
  { month: "2026-06", opDate: "6-05 / 6-15", operationTotal: 11000, m3: 5000, m6: 6000, netChange: -3000, cumulativeNet: 55000, note: "当月净回笼3000亿元" },
  { month: "2026-07", opDate: "7-06 / 7-15", operationTotal: 24000, m3: 10000, m6: 14000, netChange: 7000, cumulativeNet: 62000, note: "修正期限构成：7-06 投放10000亿(3M) + 7-15 投放14000亿(6M)；6M净投放5000亿，单月最大净投放" },
  { month: "2026-08", opDate: "8-05", operationTotal: 5000, m3: 5000, m6: 0, netChange: 2000, cumulativeNet: 64000, note: "当月操作进行中：投放5000亿(3M)，到期3000亿，净投放2000亿元" },
];

/** 数据来源说明（页面展示） */
export const REVERSE_REPO_SOURCE =
  "逐笔：央行买断式逆回购业务公告；月度投放/净投放：每日经济新闻公开报道（推算补充）；存量余额 = 累计净投放（2026-03 锚点 7.2 万亿元）";
