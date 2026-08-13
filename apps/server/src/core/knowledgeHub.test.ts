import { test } from "node:test";
import assert from "node:assert/strict";
import { matchDomain, kbSet, kbGet, kbDelete, instanceNameOf } from "../core/knowledge.js";
import { createVirtKb, getVirtKb, listVirtKbs, deleteVirtKb, setDomainMeta, getDomainMeta, listDomains, migrateInstance, updateVirtKb, deleteDomain } from "../core/knowledgeHub.js";

test("matchDomain：内容含领域关键词 → 匹配该领域；无关键词 → null", () => {
  const domains = [
    { name: "medical", keywords: ["血压", "手术", "康复", "药物"] },
    { name: "trading", keywords: ["股票", "仓位", "利率", "基金"] },
  ];
  const m1 = matchDomain("术后血压监测与康复训练建议", domains);
  assert.ok(m1);
  assert.equal(m1!.domain, "medical");
  assert.ok(m1!.score >= 2);
  const m2 = matchDomain("股票仓位管理与基金定投策略", domains);
  assert.equal(m2!.domain, "trading");
  const m3 = matchDomain("今天的天气很好", domains);
  assert.equal(m3, null);
});

test("虚拟库 CRUD：创建/读取/列表/删除", () => {
  const name = `testvirt_${Date.now()}`;
  try {
    const r = createVirtKb(name, ["medical", "trading"], "综合知识库");
    assert.ok(r.ok);
    assert.deepEqual(r.virt!.domains, ["medical", "trading"]);
    assert.equal(getVirtKb(name)!.name, name);
    assert.ok(listVirtKbs().some((v) => v.name === name));
  } finally {
    deleteVirtKb(name);
  }
  assert.equal(getVirtKb(name), null);
});

test("虚拟库名称校验：非法字符拒绝", () => {
  const r = createVirtKb("中文名/非法", ["medical"]);
  assert.equal(r.ok, false);
  const r2 = createVirtKb("valid", []);
  assert.equal(r2.ok, false);
});

test("领域元数据 CRUD：set/get/list", () => {
  const name = `testdomain_${Date.now()}`;
  try {
    setDomainMeta(name, { desc: "医学领域", keywords: ["血压", "手术"] });
    const d = getDomainMeta(name);
    assert.equal(d!.desc, "医学领域");
    assert.deepEqual(d!.keywords, ["血压", "手术"]);
    assert.ok(listDomains().some((x) => x.name === name));
  } finally {
    // 注意：领域元数据用 deleteDomain 清理（清实例+元数据），勿用 deleteVirtKb（那是删 kbVirt: 前缀）
    deleteDomain(name);
  }
});

test("updateVirtKb：动态调整引用领域", () => {
  const name = `testvirt2_${Date.now()}`;
  try {
    createVirtKb(name, ["medical"], "初始");
    const r = updateVirtKb(name, { domains: ["medical", "trading"], desc: "已编辑" });
    assert.ok(r.ok);
    assert.deepEqual(r.virt!.domains, ["medical", "trading"]);
    assert.equal(r.virt!.desc, "已编辑");
    // 空领域拒绝
    const r2 = updateVirtKb(name, { domains: [] });
    assert.equal(r2.ok, false);
    // 不存在拒绝
    const r3 = updateVirtKb("__nope__", { domains: ["medical"] });
    assert.equal(r3.ok, false);
  } finally {
    deleteVirtKb(name);
  }
});

test("migrateInstance：源实例条目迁移到目标（冲突跳过）+ 只删迁移成功的源条目", () => {
  const src = `src_${Date.now()}`;
  const tgt = `tgt_${Date.now()}`;
  try {
    kbSet(`${src}.a`, "内容A");
    kbSet(`${src}.b`, "内容B");
    kbSet(`${tgt}.a`, "已存在A"); // 目标同 key 冲突
    const r = migrateInstance(src, tgt);
    assert.ok(r.ok);
    assert.equal(r.migrated, 1); // 只有 b 迁移
    assert.equal(r.skipped, 1); // a 冲突跳过
    assert.equal(kbGet(`${tgt}.b`)?.value, "内容B");
    // 2026-08 修复：只删迁移成功的源条目；冲突跳过（a）保留在源，防数据丢失
    assert.equal(kbGet(`${src}.a`)?.value, "内容A");
    assert.equal(kbGet(`${src}.b`), null);
    // 源/目标相同拒绝
    const r2 = migrateInstance(src, src);
    assert.equal(r2.ok, false);
  } finally {
    kbDelete(`${src}.a`);
    kbDelete(`${src}.b`);
    kbDelete(`${tgt}.a`);
    kbDelete(`${tgt}.b`);
  }
});
