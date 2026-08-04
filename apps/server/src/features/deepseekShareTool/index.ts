// ============================================================
// 业务模块：DeepSeek Share 提取（features/deepseek-share）
// - meta：工具注册信息
// - register：本工具的路由（薄包装）
// 依赖下层公共模块：core/deepseekShare（分享提取能力）
// ============================================================

import { Hono } from "hono";
import { API_PREFIX, type ToolMeta } from "@toolbox/shared";
import { extractShare } from "../../core/deepseekShare.js";

export const meta: ToolMeta = {
  id: "deepseek-share",
  name: "DeepSeek Share 提取",
  description: "从 DeepSeek 分享链接提取完整对话（含思考链）",
  path: "/tools/deepseek-share",
};

export function register(app: Hono): void {
  // DeepSeek 分享链接对话提取
  app.post(`${API_PREFIX}/tools/deepseek-share`, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    const url = raw?.url;
    if (typeof url !== "string" || url.trim() === "") {
      return c.json({ ok: false, message: "缺少 url 参数（DeepSeek 分享链接或 share id）" }, 400);
    }
    const result = await extractShare(url);
    return c.json(result, result.ok ? 200 : 400);
  });
}
