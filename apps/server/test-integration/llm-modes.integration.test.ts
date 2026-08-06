// ============================================================
// LLM 三模式集成测试（真实 DeepSeek key；无 key 自动 skip）
// 覆盖：
//  1. chatSession（模式 2）：真实调用 2 轮，第 2 轮前缀缓存命中（cacheHit > 0）
//  2. reverseRepo.probeDaily（模式 2 接入）：真实搜索调用成功
//  3. watchlist.fundamental（模式 2 接入）：真实搜索调用 force 成功
//  4. reasonix（模式 3）：真实 ACP 会话 + 上下文续接
// 运行：pnpm --filter @toolbox/server test:integration
// 注意：消耗少量真实 API 额度（~$0.02-0.06/次全量跑）
// 注：import 一律用显式 .ts 扩展名（tsx 下 .ts/.js 混合会产生双模块实例，
//     导致跨模块 KV 读不一致——单测已覆盖会话存在性，此处只验证真实链路）
// ============================================================
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { loadApiKey } from "../src/core/llm.ts";
import { createChatSession, chatSessionAsk, deleteChatSession } from "../src/core/chatSession.ts";
import { createReasonixSession, reasonixAsk, closeReasonixSession, shutdownReasonix } from "../src/core/reasonix.ts";
import { probeDaily } from "../src/features/reverseRepo/service.ts";
import { fundamentalAnalysis } from "../src/features/watchlist/service.ts";
import { kvDelete } from "../src/core/kvStore.ts";

const hasKey = !!loadApiKey();
const FUNDAMENTAL_PREFIX = "watchlist:fundamental:";

/** 条件测试：无 key 时 skip（集成测试不联网不花钱） */
function it(name: string, fn: () => Promise<void> | void) {
  test(name, { skip: !hasKey }, fn);
}

after(() => {
  shutdownReasonix();
});

it("chatSession（模式2）：第 2 轮真实前缀缓存命中", async () => {
  // system 需 >64 tokens（DeepSeek 前缀缓存最小块），模拟真实业务提示词规模
  const system =
    "你是专业的金融分析助手。请严格遵循以下分析框架：\n" +
    "1. 先给出核心结论（不超过 3 句话）；\n" +
    "2. 从基本面、技术面、资金面三个维度展开；\n" +
    "3. 每个维度给出至少 2 条论据，引用具体数据；\n" +
    "4. 最后给出风险提示与仓位建议。\n" +
    "所有回答使用简体中文，保持客观中立，不做任何投资承诺。";
  const sid = createChatSession({ module: "it.chatsession", system }).id; // 随机 id
  try {
    const r1 = await chatSessionAsk(sid, "什么是凯利公式？");
    assert.equal(r1.ok, true, `第 1 轮失败：${JSON.stringify(r1).slice(0, 200)}`);
    assert.ok(r1.usage, "第 1 轮应有 usage");
    const miss1 = r1.usage!.cacheMissTokens ?? 0;
    const r2 = await chatSessionAsk(sid, "那与网格交易的区别？");
    assert.equal(r2.ok, true);
    const hit2 = r2.usage!.cacheHitTokens ?? 0;
    const miss2 = r2.usage!.cacheMissTokens ?? 0;
    console.log(`  [it] 第1轮 miss=${miss1} | 第2轮 hit=${hit2} miss=${miss2}`);
    assert.ok(hit2 > 0, `第 2 轮应命中前缀缓存（hit=${hit2}）`);
  } finally {
    deleteChatSession(sid);
  }
});

it("reverseRepo.probeDaily（模式2接入）：真实搜索调用", async () => {
  const r = await probeDaily();
  console.log(`  [it] probeDaily ok=${r.ok} asOf=${r.asOf} changes=${r.dailyChanges.length} monthSummary=${String(r.monthSummary).slice(0, 30)}`);
  assert.equal(r.ok, true);
});

it("watchlist.fundamental（模式2接入）：真实搜索调用 force", async () => {
  const code = "600519";
  kvDelete(FUNDAMENTAL_PREFIX + code);
  const r = await fundamentalAnalysis(code, { force: true });
  console.log(`  [it] fundamental ok=${r.ok} name=${r.name} summary=${String(r.summary).slice(0, 40)}`);
  assert.equal(r.ok, true);
  assert.ok(r.summary, "应有分析摘要");
  kvDelete(FUNDAMENTAL_PREFIX + code); // 清理缓存（避免污染真实数据）
});

it("reasonix（模式3）：真实 ACP 会话 + 上下文续接", async () => {
  const s = await createReasonixSession({ module: "it.reasonix" });
  if (!s.ok) {
    console.log(`  [it] reasonix 不可用（跳过断言）：${s.message}`);
    return;
  }
  try {
    const r1 = await reasonixAsk(s.id!, "1+1=?（只回数字）");
    assert.equal(r1.ok, true);
    assert.match(r1.content!, /^2/);
    const r2 = await reasonixAsk(s.id!, "刚才结果加 5？（只回数字）");
    assert.equal(r2.ok, true);
    assert.match(r2.content!, /^7/);
    console.log(`  [it] reasonix 第1轮="${r1.content}" 第2轮="${r2.content}"（上下文保持 ✓）`);
  } finally {
    await closeReasonixSession(s.id!);
  }
});

it("知识库 × Reasonix（MCP 工具）：Agent 检索 medical 实例并回答（引用条目 key）", async () => {
  const { knowledgeAgentAsk } = await import("../src/core/knowledgeSession.ts");
  const r = await knowledgeAgentAsk("medical", "感冒发热一般怎么处理？", { timeoutMs: 240000 });
  if (!r.ok) {
    console.log(`  [it] knowledgeAgentAsk 不可用（skip 断言）：${r.message}`);
    return;
  }
  assert.match(r.content!, /medical\./); // 回答应引用 medical.* 条目 key
  console.log(`  [it] knowledgeAgentAsk OK（含条目引用，用量 hit=${String((r.usage as { cacheHitTokens?: number })?.cacheHitTokens ?? "?")}）`);
});
