// ============================================================
// 开发辅助脚本：通用 API 客户端（scripts/dev-utils）
// 用法（其他脚本/命令复用）：
//   import { call } from "./api.mjs";
//   const r = await call("/tools/trade-plan/strategies");       // GET
//   const r = await call("/xxx", "POST", { ... });              // 带 body
//   const r = await call("/xxx", "DELETE");
// 返回 { status, data }；失败抛出异常。BASE_URL 可用环境变量
// TOOLBOX_API 覆盖（默认：按当前 git 分支解析环境 → prod 8787 / dev 8800+slot）。
// 环境感知（2026-09-02）：在 dev 分支跑脚本自动打到该分支的 server，无需手工改端口。
// 这是对「反复手写 fetch+json 包装」（tmp_tp_e2e.mjs / tmp_srv_check.mjs 等）的固化。
// ============================================================
import { resolveEnv } from "./env.mjs";

/** 当前 API 所指向的环境（供错误信息给出可执行的修复建议） */
const ENV = resolveEnv();
export const BASE = process.env.TOOLBOX_API || ENV.urls.api;

/**
 * 通用 HTTP 调用：自动 JSON 序列化/解析、错误抛出（非 2xx 抛出带 message 的 Error）
 * 连接失败（ECONNREFUSED）时给出「环境未启动 + 启动命令」的可执行提示——
 * 多环境并存后最容易踩的坑就是「脚本打到了没启动的那个环境」（2026-09-02）。
 */
export async function call(path, method = "GET", body) {
  let r;
  try {
    r = await fetch(BASE + path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const cause = e?.cause ?? e;
    const refused = cause?.code === "ECONNREFUSED" || /ECONNREFUSED/.test(String(cause?.message ?? ""));
    if (refused) {
      throw new Error(
        `连不上 ${ENV.name} 环境服务（${ENV.urls.server}；分支 ${ENV.branch}）→ 先启动：\`toolbox env start\`（等价 \`toolbox dev start\`）`,
      );
    }
    throw e;
  }
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
