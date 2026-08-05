// ============================================================
// 业务模块：凯利仓位助手（features/kelly）
// - meta：工具注册信息
// - register：计算（纯程序，忠实实现提示词公式）+ 历史记录（KV 持久化）
// - 提示词存于本地设置数据（kelly.position），前端「查看提示词」读取展示
// 依赖下层公共模块：core/kvStore、core/dataRegistry
// ============================================================

import { Hono } from "hono";
import {
  API_PREFIX,
  type KellyHistoryDeleteResult,
  type KellyHistoryDetailResult,
  type KellyHistoryListResult,
  type KellyRequest,
  type KellyResult,
  type ToolMeta,
} from "@toolbox/shared";
import { registerDataSource } from "../../core/dataRegistry.js";
import { computeKelly } from "./compute.js";
import { deleteHistory, getHistory, HISTORY_KEY, listHistory, saveHistory } from "./history.js";

// 注册数据源：凯利仓位助手（本地数据管理页展示 tag 用）
registerDataSource({
  kind: "kv",
  name: "kelly:",
  page: "凯利仓位助手",
  tag: "历史记录",
  description: "凯利仓位计算历史（kelly:history，上限 50 条）",
});

export const meta: ToolMeta = {
  id: "kelly",
  name: "凯利仓位助手",
  description: "按凯利公式计算建议仓位（盈亏比/期望优势/分数凯利方案），忠实实现提示词",
  path: "/tools/kelly",
};

/** 校验请求体（数值有限） */
function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function register(app: Hono): void {
  // 计算（同步；成功后自动保存历史）
  app.post(`${API_PREFIX}/tools/kelly/calculate`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Partial<KellyRequest> | null;
    if (!raw || typeof raw !== "object") return c.json({ ok: false, message: "请求体无效" }, 400);
    const price = num(raw.price);
    const takeProfit = num(raw.takeProfit);
    const stopLoss = num(raw.stopLoss);
    const winRate = num(raw.winRate);
    const maxAmount = num(raw.maxAmount);
    if (price === undefined || takeProfit === undefined || stopLoss === undefined || winRate === undefined || maxAmount === undefined) {
      return c.json({ ok: false, message: "请输入有效的数值参数（当前价格/上止盈/下止损/胜率/可用金额）" }, 400);
    }
    const req: KellyRequest = {
      price,
      takeProfit,
      stopLoss,
      winRate,
      maxAmount,
      ...(typeof raw.code === "string" && raw.code.trim() ? { code: raw.code.trim() } : {}),
      ...(typeof raw.name === "string" && raw.name.trim() ? { name: raw.name.trim() } : {}),
    };
    const result: KellyResult = computeKelly(req);
    if (result.ok) saveHistory(req, result);
    return c.json(result, result.ok ? 200 : 400);
  });

  // 历史列表（摘要）
  app.get(`${API_PREFIX}/tools/kelly/history`, (c) => {
    const body: KellyHistoryListResult = { ok: true, entries: listHistory() };
    return c.json(body);
  });

  // 历史详情
  app.get(`${API_PREFIX}/tools/kelly/history/:id`, (c) => {
    const entry = getHistory(c.req.param("id"));
    if (!entry) return c.json({ ok: false, message: "历史不存在" }, 404);
    const body: KellyHistoryDetailResult = { ok: true, entry };
    return c.json(body);
  });

  // 删除历史
  app.delete(`${API_PREFIX}/tools/kelly/history/:id`, (c) => {
    const ok = deleteHistory(c.req.param("id"));
    if (!ok) return c.json({ ok: false, message: "历史不存在" }, 404);
    const body: KellyHistoryDeleteResult = { ok: true, deleted: 1 };
    return c.json(body);
  });

  // 历史数据源 key（本地数据管理兼容引用，避免未标记）
  void HISTORY_KEY;
}
