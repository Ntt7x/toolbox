// ============================================================
// 买断式逆回购月度操作与余额（权威数据，用户提供）
// 来源：中国人民银行官网公开市场买断式逆回购业务公告（2024.10-2026.8）
// 余额 = 上月余额 + 当月操作量 − 当月到期量（月末未到期存量）
// 本表为存量部分基准数据，前端据此绘制余额曲线；增量（每日变动）走 LLM 探查。
// ============================================================

import type { ReverseRepoMonthlyRow } from "@toolbox/shared";

/** 月度操作/余额表（金额单位：亿元）。2025-05 余额缺失（暂缺），2026-08 当月操作进行中。 */
export const REVERSE_REPO_MONTHLY: ReverseRepoMonthlyRow[] = [
  { month: "2024-10", operationTotal: 5000, m3: 0, m6: 5000, monthEndBalance: 5000, note: "2024-10-28 启用，6 个月期 5000 亿元" },
  { month: "2024-11", operationTotal: 8000, m3: 8000, m6: 0, monthEndBalance: 13000, note: "3 个月期 8000 亿元" },
  { month: "2024-12", operationTotal: 14000, m3: 7000, m6: 7000, monthEndBalance: 27000, note: "3M 7000 亿 + 6M 7000 亿" },
  { month: "2025-01", operationTotal: 17000, m3: 12000, m6: 5000, monthEndBalance: 44000, note: "3M 12000 亿 + 6M 5000 亿" },
  { month: "2025-02", operationTotal: 14000, m3: 9000, m6: 5000, monthEndBalance: 58000, note: "3M 9000 亿 + 6M 5000 亿" },
  { month: "2025-03", operationTotal: 8000, m3: 5000, m6: 3000, monthEndBalance: 66000, note: "3M 5000 亿 + 6M 3000 亿" },
  { month: "2025-04", operationTotal: 12000, m3: 7000, m6: 5000, monthEndBalance: 78000, note: "3M 7000 亿 + 6M 5000 亿" },
  { month: "2025-05", operationTotal: 7000, m3: 4000, m6: 3000, monthEndBalance: 85000, note: "3M 4000 亿 + 6M 3000 亿" },
  { month: "2025-06", operationTotal: 14000, m3: 10000, m6: 4000, monthEndBalance: 99000, note: "首次月内两次操作：6-6 投放 10000 亿(3M) + 6-16 投放 4000 亿(6M)" },
  { month: "2025-07", operationTotal: 14000, m3: 8000, m6: 6000, monthEndBalance: 113000, note: "3M 8000 亿 + 6M 6000 亿" },
  { month: "2025-08", operationTotal: 12000, m3: 7000, m6: 5000, monthEndBalance: 125000, note: "8-8 投放 7000 亿(3M) + 8-15 投放 5000 亿(6M)" },
  { month: "2025-09", operationTotal: 16000, m3: 10000, m6: 6000, monthEndBalance: 141000, note: "9-5 投放 10000 亿(3M) + 9-15 投放 6000 亿(6M)" },
  { month: "2025-10", operationTotal: 0, m3: 0, m6: 0, monthEndBalance: 141000, note: "当月无操作，余额持平" },
  { month: "2025-11", operationTotal: 0, m3: 0, m6: 0, monthEndBalance: 141000, note: "当月无操作，余额持平" },
  { month: "2025-12", operationTotal: 0, m3: 0, m6: 0, monthEndBalance: 141000, note: "当月无操作，余额持平" },
  { month: "2026-01", operationTotal: 20000, m3: 11000, m6: 9000, monthEndBalance: 161000, note: "3M 11000 亿 + 6M 9000 亿，加量续作" },
  { month: "2026-02", operationTotal: 18000, m3: 8000, m6: 10000, monthEndBalance: 179000, note: "3M 8000 亿 + 6M 10000 亿" },
  { month: "2026-03", operationTotal: 13000, m3: 8000, m6: 5000, monthEndBalance: 192000, note: "3M 8000 亿 + 6M 5000 亿" },
  { month: "2026-04", operationTotal: 13000, m3: 8000, m6: 5000, monthEndBalance: 205000, note: "3M 8000 亿 + 6M 5000 亿，余额峰值" },
  { month: "2026-05", operationTotal: 3000, m3: 0, m6: 3000, monthEndBalance: null, note: "当月 3M 无操作、6M 缩量续作；月末余额暂缺" },
  { month: "2026-06", operationTotal: 11000, m3: 5000, m6: 6000, monthEndBalance: 54000, note: "3M 5000 亿 + 6M 6000 亿；伴随大规模到期，余额显著回落" },
  { month: "2026-07", operationTotal: 24000, m3: 10000, m6: 14000, monthEndBalance: 61000, note: "7-6 投放 10000 亿(3M) + 7-15 投放 14000 亿(6M，单次规模新高)；单月净投放 7000 亿" },
  { month: "2026-08", operationTotal: 5000, m3: 5000, m6: 0, monthEndBalance: null, note: "当月操作 5000 亿(3M)，有 3000 亿到期，实现加量续作 2000 亿（月末余额进行中）" },
];
