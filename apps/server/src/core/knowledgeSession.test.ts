// ============================================================
// core/knowledgeSession 单测：Reasonix 不可用时的降级路径（fallback）
// 不触网、不 spawn 真实 ACP（坏路径配置强制二进制解析失败）
// ============================================================
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setSetting, deleteSetting } from "./settingsStore.js";
import { knowledgeAgentAsk, knowledgeAgentImport, dropKnowledgeSession, KNOWLEDGE_SESSION_PREFIX } from "./knowledgeSession.js";
import { kvListRaw } from "./kvStore.js";

beforeEach(() => {
  setSetting("llm.reasonixBin", "C:\\__no_such_reasonix__\\reasonix.exe");
});

afterEach(() => {
  deleteSetting("llm.reasonixBin");
  // 清理测试会话注册表
  for (const r of kvListRaw(KNOWLEDGE_SESSION_PREFIX, 200)) {
    dropKnowledgeSession(r.key.slice(KNOWLEDGE_SESSION_PREFIX.length));
  }
});

test("Reasonix 不可用：knowledgeAgentAsk 返回 fallback:true（调用方降级直调）", async () => {
  const r = await knowledgeAgentAsk("itest", "测试问题");
  assert.equal(r.ok, false);
  assert.equal(r.fallback, true);
  assert.ok(r.message);
});

test("Reasonix 不可用：knowledgeAgentImport 返回 fallback:true（不触网提取对话）", async () => {
  const r = await knowledgeAgentImport("itest", "https://chat.deepseek.com/share/u5myqtvktzo5gal4qi");
  assert.equal(r.ok, false);
  assert.equal(r.fallback, true);
});
