// ============================================================
// core/knowledgeSession 引导词/任务指令去重逻辑单测（纯函数 composePrompt）
// 三态验证：首轮完整 / 后续最小续问行 / 模板升级自动重发
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { composePrompt } from "./knowledgeSession.js";

const GUIDE = "你是知识库助手。{action} 引导词内容（较长）";
const TASK = "任务指令模板 {instance} 静态约束部分……\n【用户问题】\n{question}";
const renderTask = (tpl: string) => tpl.replace("{instance}", "medical").replace("{question}", "今天发烧怎么办？");
const minTurn = () => "回答前先用 kb_search 检索知识库（instance=medical），基于检索结果回答。\n\n【用户问题】\n今天发烧怎么办？";

test("首轮（无注册表）：发送完整引导词 + 完整任务指令", () => {
  const { prompt, gFp, tFp } = composePrompt("medical", GUIDE, TASK, renderTask, minTurn, undefined);
  assert.ok(prompt.includes("你是知识库助手"), "应含引导词");
  assert.ok(prompt.includes("任务指令模板"), "应含完整任务指令");
  assert.ok(prompt.includes("今天发烧怎么办？"), "应含问题");
  assert.ok(gFp && tFp, "应返回指纹");
});

test("后续轮次（指纹相同）：只发最小续问行，不含引导词与任务指令静态内容", () => {
  const first = composePrompt("medical", GUIDE, TASK, renderTask, minTurn, undefined);
  const reg = { regId: "rx-x", instance: "medical", createdAt: 1, lastAt: 1, guideFp: first.gFp, taskFp: first.tFp };
  const { prompt } = composePrompt("medical", GUIDE, TASK, renderTask, minTurn, reg);
  assert.ok(!prompt.includes("你是知识库助手"), "不应重复引导词");
  assert.ok(!prompt.includes("任务指令模板"), "不应重复完整任务指令");
  assert.ok(prompt.includes("今天发烧怎么办？"), "应含问题");
});

test("任务模板升级：重发完整任务指令（不重发引导词）", () => {
  const first = composePrompt("medical", GUIDE, TASK, renderTask, minTurn, undefined);
  const reg = { regId: "rx-x", instance: "medical", createdAt: 1, lastAt: 1, guideFp: first.gFp, taskFp: first.tFp };
  const newTask = "【升级后的任务模板】{instance}\n【用户问题】\n{question}";
  const { prompt, tFp } = composePrompt("medical", GUIDE, newTask, renderTask, minTurn, reg);
  assert.ok(prompt.includes("升级后的任务模板"), "应重发新任务指令");
  assert.ok(!prompt.includes("你是知识库助手"), "不应重复引导词");
  assert.ok(tFp !== first.tFp, "任务指纹应变化");
});

test("引导词模板升级：重发引导词（任务未变只发最小续问行）", () => {
  const first = composePrompt("medical", GUIDE, TASK, renderTask, minTurn, undefined);
  const reg = { regId: "rx-x", instance: "medical", createdAt: 1, lastAt: 1, guideFp: first.gFp, taskFp: first.tFp };
  const newGuide = "【升级后的引导词】{action}";
  const { prompt, gFp } = composePrompt("medical", newGuide, TASK, renderTask, minTurn, reg);
  assert.ok(prompt.includes("升级后的引导词"), "应重发新引导词");
  assert.ok(!prompt.includes("任务指令模板"), "任务未变不应重发完整任务指令");
  assert.ok(gFp !== first.gFp, "引导指纹应变化");
});
