// ============================================================
// core/prompts 单测：注册表完整性 / 场景分组 / 模板渲染
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { listPrompts, getPromptTemplate, updatePrompt, resetPrompt, promptGroup, promptPage } from "./prompts.js";

test("注册表：全部提示词带场景分组与归属页面（无'通用'漏配）", () => {
  const ps = listPrompts();
  assert.ok(ps.length >= 15);
  for (const p of ps) {
    assert.ok(p.group && p.group !== "通用", `${p.id} 应配置场景分组`);
    assert.ok(p.page, `${p.id} 应配置归属页面`);
    assert.ok(p.template.length > 0, `${p.id} 应有模板`);
  }
});

test("updatePrompt / resetPrompt：编辑与恢复默认", () => {
  const id = "knowledge.ask";
  assert.equal(updatePrompt(id, "自定义模板"), true);
  assert.equal(getPromptTemplate(id), "自定义模板");
  assert.equal(resetPrompt(id), true);
  assert.notEqual(getPromptTemplate(id), "自定义模板");
  assert.equal(updatePrompt("no-such-id", "x"), false);
  assert.equal(resetPrompt("no-such-id"), false);
});

test("场景分组查询：promptGroup/promptPage", () => {
  assert.equal(promptGroup("cb-rate.system"), "交易");
  assert.equal(promptPage("cb-rate.system"), "央行利率分析");
  assert.equal(promptGroup("knowledge.ask"), "知识库");
  assert.equal(promptGroup("unknown.id"), "通用"); // 未知 id 兜底
});
