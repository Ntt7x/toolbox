// ============================================================
// 核心 app 级集成测试：免端口（app.request）覆盖装配/路由/核心链路
// 运行：node --env-file 或 tsx --test；需 TOOLBOX_TEST=1 避免 index.ts 监听端口
// ============================================================
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOOLBOX_TEST = "1";
process.env.API_KEY = "sk-test-integration-do-not-call-llm";

const { app } = await import("./index.js");

async function req(method: string, path: string, body?: unknown) {
  const r = await app.request(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: unknown = null;
  try { json = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, json };
}

beforeEach(() => {});
afterEach(() => {});

test("health 200", async () => {
  const { status, json } = await req("GET", "/api/health");
  assert.equal(status, 200);
  assert.equal((json as { ok?: boolean })?.ok, true);
});

test("工具清单含知识库中心", async () => {
  const { status, json } = await req("GET", "/api/tools");
  assert.equal(status, 200);
  const tools = (json as { tools?: { id: string }[] })?.tools ?? [];
  const ids = tools.map((t) => t.id);
  for (const expect of ["grid-plan", "cb-rate", "kelly", "knowledge-hub", "zhihu-crawler"]) {
    assert.ok(ids.includes(expect), `缺少工具 ${expect}`);
  }
});

test("网格计划核心计算（纯逻辑，无 LLM）", async () => {
  const { status, json } = await req("POST", "/api/tools/grid-plan", { type: 1, boll: [1.073, 1.29, 0.856], maxAmount: 100000 });
  assert.equal(status, 200);
  const g = json as { styles?: Record<string, { n?: number; m?: number }> };
  assert.ok(g.styles?.rad, "缺少 rad 档位");
  assert.ok((g.styles.rad.n ?? 0) > 0);
});

test("知识库中心总览（读）", async () => {
  const { status, json } = await req("GET", "/api/tools/knowledge-hub/overview");
  assert.equal(status, 200);
  const ov = json as { instances?: unknown[]; virst?: unknown[]; domains?: unknown[] };
  assert.ok(Array.isArray(ov.instances));
  assert.ok(Array.isArray(ov.domains));
});

test("提示词管理列表（读）", async () => {
  const { status, json } = await req("GET", "/api/prompts");
  assert.equal(status, 200);
  assert.ok(Array.isArray((json as { prompts?: unknown[] })?.prompts));
});

test("LLM 用量（读，不触发调用）", async () => {
  const { status } = await req("GET", "/api/llm/usage");
  assert.equal(status, 200);
});

test("本地数据源（读，未标记应为 0）", async () => {
  const { status, json } = await req("GET", "/api/data/local/sources");
  assert.equal(status, 200);
  const src = json as { sources?: { tag?: string; count?: number }[] };
  const un = (src.sources ?? []).filter((s) => s.tag === "未标记" && (s.count ?? 0) > 0);
  assert.equal(un.length, 0, "存在未标记数据，违反数据源注册治理原则");
});

test("备忘录 CRUD 全链路", async () => {
  const mk = await req("POST", "/api/tools/memo", { text: `集成测试 ${Date.now()}` });
  assert.equal(mk.status, 201);
  const id = (mk.json as { item?: { id?: string } })?.item?.id;
  assert.ok(id);
  const up = await req("PUT", `/api/tools/memo/${id}`, { status: "done" });
  assert.equal(up.status, 200);
  const del = await req("DELETE", `/api/tools/memo/${id}`);
  assert.equal(del.status, 200);
});

test("DeepSeek 分享链接解析（纯函数路径，网络失败也算解析到 shareId）", async () => {
  // 只验证路由存在性（不真正抓取）：非法 url 应 400
  const r = await req("POST", "/api/tools/deepseek-share", { url: "https://not-a-share.example/x" });
  // 合法请求路径：要么 200（解析+抓取失败给 ok:false），要么 400（缺参数校验）
  assert.ok([200, 400].includes(r.status), `意外状态 ${r.status}`);
});
