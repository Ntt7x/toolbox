// ============================================================
// 实验分组：3 个量化分析框架页面（memo msvwslfq，plan 见 docs/for_agent/plans/experiment-group.md）
//   framework : 通用投资框架（e-梯队衰减仓位模型）
//   ec        : 欧元/日元泡沫预警（B/Ω/CVAS/CCV）
//   bmpi      : 化债牛市进度指数（R/L/S1/S2/S3 + BMPI 合成）
// 复用：LLM 三模式（core/llm）、行情工具（core/quote）、提示词管理（core/prompts）、任务/SSE
// ============================================================
import { Hono } from "hono";
import { registerExperimentFramework } from "./framework.js";
import { registerExperimentEc } from "./ec.js";
import { registerExperimentBmpi } from "./bmpi.js";

export const meta = [
  { id: "framework", name: "实验·投资框架", description: "通用投资框架：主题 → 哲学/战略/战术/批判 4 层分析 + e-梯队仓位", path: "/experiment/framework" },
  { id: "ec", name: "实验·ec 泡沫预警", description: "欧元/日元全球套利拥挤度预警：B/Ω/CVAS/CCV 指标 + 每日研判", path: "/experiment/ec" },
  { id: "bmpi", name: "实验·BMPI 化债牛市", description: "化债牛市进度指数：R/L/S1/S2/S3 五指数 + BMPI 合成预警", path: "/experiment/bmpi" },
];

export function register(app: Hono) {
  registerExperimentFramework(app);
  registerExperimentEc(app);
  registerExperimentBmpi(app);
}
