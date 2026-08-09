// ============================================================
// 开发辅助脚本：通用 API 客户端（scripts/dev-utils）
// 用法（其他脚本/命令复用）：
//   import { call } from "./api.mjs";
//   const r = await call("/tools/trade-plan/strategies");       // GET
//   const r = await call("/xxx", "POST", { ... });              // 带 body
//   const r = await call("/xxx", "DELETE");
// 返回 { status, data }；失败抛出异常。BASE_URL 可用环境变量
// TOOLBOX_API 覆盖（默认 http://127.0.0.1:8787/api）。
// 这是对「反复手写 fetch+json 包装」（tmp_tp_e2e.mjs / tmp_srv_check.mjs 等）的固化。
// ============================================================
export const BASE = process.env.TOOLBOX_API || "http://127.0.0.1:8787/api";

/**
 * 通用 HTTP 调用：自动 JSON 序列化/解析、错误抛出（非 2xx 抛出带 message 的 Error）
 */
export async function call(path, method = "GET", body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = data?.message ?? data?.rejectReason ?? `HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return { status: r.status, data };
}

/** 便捷方法 */
export const get = (p) => call(p);
export const post = (p, b) => call(p, "POST", b);
export const put = (p, b) => call(p, "PUT", b);
export const del = (p) => call(p, "DELETE");
