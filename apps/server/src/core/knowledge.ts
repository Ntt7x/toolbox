// ============================================================
// 下层公共模块：知识库（core/knowledge）
// 去 RAG 化的极简设计（对齐「对话即知识」思路）：
// - 存储：复用 SQLite KV（前缀 knowledge:），value = { value, source, updatedAt }
// - 检索：精确 key + 包含匹配（key/value 关键词），不做向量化
// - 内化：kbImportFromChat —— DeepSeek 分享对话 → LLM 提取 {key,value} 事实 → 批量写入
// - 问答：kbAsk —— 按问题关键词检索相关条目 → 知识注入提示词 → LLM 回答
// 成本：提取/问答按需调 LLM；平时只读 KV 零成本。
// ============================================================

import { kvGet, kvSet, kvDelete, kvListRaw, kvCount } from "./kvStore.js";
import { chat } from "./llm.js";
import { getPromptTemplate } from "./prompts.js";
import { robustJsonParse } from "./jsonParse.js";
import { extractShare } from "./deepseekShare.js";
import { registerDataSource } from "./dataRegistry.js";
import type { KnowledgeAskResult, KnowledgeEntry, KnowledgeErrorResult, KnowledgeImportResult } from "@toolbox/shared";

// 数据源注册（本地数据管理可见；知识库为服务端公共数据）
registerDataSource({
  kind: "kv",
  name: "knowledge:",
  page: "知识库",
  tag: "知识数据",
  description: "知识库条目（SQLite KV 精确存储；Chat 链接导入内化 + 检索问答）",
});

/** KV 前缀（数据源注册名） */
export const KB_PREFIX = "knowledge:";

/** 每实例条目上限（资源隔离；root 实例同样受限；测试可临时调整） */
export let INSTANCE_LIMIT = 500;

/** 测试注入：临时调整实例上限（finally 恢复） */
export function setInstanceLimit(v: number): void {
  INSTANCE_LIMIT = v;
}

/** 全量扫描上限（知识条目数远超此值需调整；kvListRaw 单次 LIMIT） */
const KB_SCAN_LIMIT = 5000;

/** 知识库真实目录：项目根 /.file/k（git 隔离；Agent 的 /k/{key} 映射到此） */
/** key 规范：分层点分隔（project.module.attribute）；仅字母数字._-；禁连续点/边界点（防 ../ 语义与脏 key） */
const KEY_RE = /^(?!\.)(?!.*\.\.)(?!.*\.$)[a-zA-Z0-9._-]{1,120}$/;

function keyOf(key: string): string {
  return `${KB_PREFIX}${key}`;
}

/** 校验 key 规范（不合法抛错） */
export function assertValidKey(key: string): void {
  if (!key || !KEY_RE.test(key)) {
    throw new Error(`知识 key 必须为分层点分隔（如 project.module.attribute），仅允许字母数字._-，当前：${key}`);
  }
}

/** 读取全部知识条目（KV 扫描 + 解析，损坏条目跳过）——实例统计/列举共用 */
function readAllEntries(): KnowledgeEntry[] {
  const out: KnowledgeEntry[] = [];
  for (const r of kvListRaw(KB_PREFIX, KB_SCAN_LIMIT)) {
    try {
      const e = JSON.parse(r.value) as KnowledgeEntry;
      if (e && typeof e.key === "string" && typeof e.value === "string") out.push(e);
    } catch {
      // 损坏条目跳过
    }
  }
  return out;
}

// ---------- 实例模型 ----------
// 实例 = key 的顶层段（第一个 "." 之前）；无 "." 的 key 属于 root 实例（""）。
// 例：cbRate.rate.fed → 实例 "cbRate"；abc → root。
// 实例级管理（list/stats/clear）与资源隔离（配额）基于此模型。

/** 取 key 所属实例名（无 "." → root 实例 ""） */
export function instanceNameOf(key: string): string {
  const i = key.indexOf(".");
  return i < 0 ? "" : key.slice(0, i);
}

/** 单实例条目数（root 实例 = 单段 key 数） */
export function instanceCount(name: string): number {
  let n = 0;
  for (const e of readAllEntries()) {
    if (instanceNameOf(e.key) === name) n++;
  }
  return n;
}

/** 实例统计（供管理界面）：条目数 / 总字节 / 最近更新 */
export function instanceStats(name: string): { name: string; count: number; bytes: number; lastUpdated: string } {
  let count = 0;
  let bytes = 0;
  let lastUpdated = "";
  for (const e of readAllEntries()) {
    if (instanceNameOf(e.key) !== name) continue;
    count++;
    bytes += Buffer.byteLength(e.value, "utf8");
    if (e.updatedAt > lastUpdated) lastUpdated = e.updatedAt;
  }
  return { name, count, bytes, lastUpdated };
}

/** 全部实例列表（root 实例名为 ""，按条数倒序） */
export function listInstances(): { name: string; count: number; bytes: number; lastUpdated: string }[] {
  const map = new Map<string, { count: number; bytes: number; lastUpdated: string }>();
  for (const e of readAllEntries()) {
    const name = instanceNameOf(e.key);
    const m = map.get(name) ?? { count: 0, bytes: 0, lastUpdated: "" };
    m.count++;
    m.bytes += Buffer.byteLength(e.value, "utf8");
    if (e.updatedAt > m.lastUpdated) m.lastUpdated = e.updatedAt;
    map.set(name, m);
  }
  return [...map.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.count - a.count);
}

/** 清空某实例全部条目（root 实例 name="" 清单段 key）；返回删除数 */
export function clearInstance(name: string): number {
  let n = 0;
  for (const e of readAllEntries()) {
    if (instanceNameOf(e.key) === name) {
      kvDelete(keyOf(e.key));
      n++;
    }
  }
  return n;
}

/** 配额校验：新增 key 时实例条数上限；覆盖已存在 key 不计数 */
export function assertInstanceQuota(key: string): void {
  if (kbGet(key)) return; // 覆盖不新增
  const name = instanceNameOf(key);
  if (instanceCount(name) >= INSTANCE_LIMIT) {
    throw new Error(`知识实例「${name || "root"}」已达上限（${INSTANCE_LIMIT} 条），请清理后再新增`);
  }
}

/** 写入/覆盖一条知识（key 冲突默认覆盖，Agent 纠错场景直接替换；新增时校验实例配额） */
export function kbSet(key: string, value: string, source?: string): KnowledgeEntry {
  assertValidKey(key);
  assertInstanceQuota(key);
  const entry: KnowledgeEntry = {
    key,
    value: value.trim(),
    ...(source && source.trim() ? { source: source.trim() } : {}),
    updatedAt: new Date().toISOString(),
  };
  kvSet(keyOf(key), entry);
  return entry;
}

/** 读取一条知识；不存在返回 null */
export function kbGet(key: string): KnowledgeEntry | null {
  return kvGet<KnowledgeEntry>(keyOf(key));
}

/** 删除一条知识 */
export function kbDelete(key: string): boolean {
  if (!kvGet(keyOf(key))) return false;
  kvDelete(keyOf(key));
  return true;
}

/** 列举知识（prefix 实例过滤 / q 模糊搜索；limit 上限） */
export function kbList(opts: { prefix?: string; q?: string; limit?: number } = {}): KnowledgeEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), KB_SCAN_LIMIT);
  const q = (opts.q ?? "").trim().toLowerCase();
  const prefix = opts.prefix ?? "";
  const out: KnowledgeEntry[] = [];
  for (const e of readAllEntries()) {
    if (prefix && !e.key.startsWith(prefix)) continue;
    if (q) {
      const hay = `${e.key} ${e.value} ${e.source ?? ""}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/** 批量写入（import 用；返回实际写入条数） */
export function kbSetMany(items: { key: string; value: string; source?: string }[]): number {
  let n = 0;
  for (const it of items) {
    try {
      kbSet(it.key, it.value, it.source);
      n++;
    } catch {
      // 单条 key 非法跳过（不影响整体）
    }
  }
  return n;
}

/** 知识总数（供数据源展示；kvCount 直接 SQL COUNT，不解析 value） */
export function kbCount(): number {
  return kvCount(KB_PREFIX);
}

/** 某实例条目数（key 首段 = instance 的行数；SQL COUNT） */
export function kbCountInstance(instance: string): number {
  return kvCount(`${KB_PREFIX}${instance}.`);
}

/** 知识库实例信息（供「导入知识库」等选择目标实例） */
export interface KnowledgeInstanceInfo {
  instance: string;
  count: number;
  updatedAt?: string;
}

/** 列举全部知识库实例（key 首段去重 + 计数 + 最近更新时间） */
export function kbListInstances(): KnowledgeInstanceInfo[] {
  const map = new Map<string, { count: number; updatedAt?: string }>();
  for (const e of readAllEntries()) {
    const seg = e.key.split(".")[0];
    if (!seg) continue;
    const cur = map.get(seg) ?? { count: 0 };
    cur.count += 1;
    if (!cur.updatedAt || (e.updatedAt ?? "") > cur.updatedAt) cur.updatedAt = e.updatedAt;
    map.set(seg, cur);
  }
  return [...map.entries()]
    .map(([instance, v]) => ({ instance, count: v.count, ...(v.updatedAt ? { updatedAt: v.updatedAt } : {}) }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 知识问答：检索与问题相关条目 → 知识注入提示词 → LLM 回答。
 * 检索策略：问题按分隔符拆词，取命中的条目（key 匹配优先，其次 value 包含）；
 * 最多注入 topN 条。question 保留原文供 LLM 判断。
 */
export async function kbAsk(
  question: string,
  opts: { signal?: AbortSignal; topN?: number; instance?: string; instances?: string[]; module?: string } = {},
): Promise<KnowledgeAskResult | KnowledgeErrorResult> {
  const q = question.trim();
  if (!q) return { ok: false, message: "请输入问题" };
  const topN = Math.min(Math.max(opts.topN ?? 6, 1), 20);
  // 实例限定检索（如 medical 实例 → 只搜 medical.* 前缀；instances 数组 → 多领域聚合；缺省全库）
  const prefixes = (opts.instances?.length ? opts.instances : opts.instance ? [opts.instance] : [])
    .filter((i) => i)
    .map((i) => `${i}.`);

  // 1) 检索：拆词（中英文/数字）→ 词集；中文长词补 2-gram 滑动片段（提升命中率）
  const rawTokens = q.toLowerCase().split(/[\s,，。.!！?？;；:：、/\\()（）[\]{}"']+/).filter((t) => t.length >= 2);
  const tokens = new Set<string>();
  for (const t of rawTokens) {
    tokens.add(t);
    // 中文长词拆 2 字窗口（如「央行利率分析」→ 央行/行利/利率/率分/分析）
    if (/[\u4e00-\u9fff]/.test(t) && t.length >= 4) {
      for (let i = 0; i <= t.length - 2; i++) tokens.add(t.slice(i, i + 2));
    }
  }
  const all = prefixes.length > 0 ? readAllEntries().filter((e) => prefixes.some((p) => e.key.startsWith(p))) : kbList({ limit: KB_SCAN_LIMIT });
  const scored: { e: KnowledgeEntry; score: number }[] = [];
  for (const e of all) {
    const keyL = e.key.toLowerCase();
    const valL = e.value.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (keyL.includes(t)) score += 5;
      else if (valL.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const used = scored.slice(0, topN).map((s) => s.e);

  // 2) 组装知识上下文 + 提问
  const knowledgeText =
    used.length > 0
      ? used.map((e) => `- [${e.key}]${e.source ? `（来源：${e.source}）` : ""}\n  ${e.value}`).join("\n")
      : "（知识库中未检索到相关内容，请如实说明）";
  const system = getPromptTemplate(opts.instance === "medical" ? "medical-kb.ask" : "knowledge.ask");
  const userMsg = `【问题】\n${q}\n\n【知识库检索结果】\n${knowledgeText}`;

  const result = await chat(
    [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ],
    { temperature: 0.3, module: opts.module ?? "knowledge.ask" },
  );
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, answer: result.content.trim(), used };
}

/**
 * 知识内化：从 DeepSeek 分享对话提取事实知识入库。
 * 链路：extractShare（对话原文）→ LLM 提取 {key,value} 事实列表 → 批量写入。
 * 返回写入条数 + 提取结果；失败抛错（调用方兜底）。
 */
/** 静态领域匹配（低成本；内容 → 领域库，关键词打分）；无关键词命中返回 null */
export function matchDomain(text: string, domains: { name: string; keywords: string[] }[]): { domain: string; score: number } | null {
  const t = text.toLowerCase();
  let best: { domain: string; score: number } | null = null;
  for (const d of domains) {
    let s = 0;
    for (const kw of d.keywords) {
      const k = kw.toLowerCase();
      if (k && t.includes(k)) s += 1;
    }
    if (!best || s > best.score) best = { domain: d.name, score: s };
  }
  return best && best.score > 0 ? best : null;
}

export async function kbImportFromChat(
  url: string,
  opts: { signal?: AbortSignal; instance?: string; module?: string; conflict?: "skip" | "overwrite" | "merge"; matchDomains?: { name: string; keywords: string[] }[] } = {},
): Promise<KnowledgeImportResult> {
  const extracted = await extractShare(url);
  if (!extracted.ok || !Array.isArray(extracted.messages) || extracted.messages.length === 0) {
    throw new Error(!extracted.ok && "message" in extracted ? extracted.message : "对话提取为空，请检查链接");
  }
  const text = extracted.messages
    .map((m) => {
      const c = Array.isArray(m.content) ? m.content.map((x) => x.text ?? "").join(" ") : String(m.content ?? "");
      return `【${m.role === "user" ? "用户" : "助手"}】\n${c}`;
    })
    .join("\n\n")
    .slice(0, 30000); // 截断防超长

  const template = getPromptTemplate(opts.instance === "medical" ? "medical-kb.extract" : "knowledge.extract");
  const result = await chat(
    [
      { role: "system", content: template },
      { role: "user", content: text },
    ],
    { temperature: 0.2, json: true, module: opts.module ?? "knowledge.import" },
  );
  if (!result.ok) throw new Error(result.message);

  const parsed = robustJsonParse(result.content.trim());
  const facts = (Array.isArray(parsed) ? parsed : [])
    .filter((f): f is { key?: unknown; value?: unknown } => !!f && typeof f === "object")
    .map((f) => ({
      key: typeof f.key === "string" ? f.key.trim() : "",
      value: typeof f.value === "string" ? f.value.trim() : "",
      ...(typeof f.source === "string" && f.source.trim() ? { source: f.source.trim() } : {}),
    }))
    .filter((f) => f.key && f.value);

  const source = extracted.title && extracted.title !== "Shared Conversation" ? extracted.title : extracted.shareId;
  // 实例前缀（如 medical 实例 → medical.<原始key>），实现特定业务知识库隔离；
  // matchDomains（虚拟库导入）→ 逐条静态匹配领域前缀，无匹配归 other
  const prefix = opts.instance ? `${opts.instance}.` : "";
  const instFacts = facts.map((f) => {
    let k = prefix + f.key;
    if (!opts.instance && opts.matchDomains?.length) {
      const m = matchDomain(`${f.value} ${f.key}`, opts.matchDomains);
      k = `${m?.domain ?? "other"}.${f.key}`;
    }
    return { key: k, value: f.value, source: f.source ?? source };
  });
  // 去重 + 冲突检测/解决：key 已存在 → 冲突（按策略处理）；value 与实例内已有条目重复 → 跳过
  const strategy = opts.conflict ?? "skip";
  const existing = readAllEntries().filter((e) => e.key.startsWith(prefix));
  const existingValues = new Set(existing.map((e) => e.value.trim()));
  const existingKeys = new Set(existing.map((e) => e.key));
  let imported = 0;
  let skipped = 0;
  let conflicts = 0;
  for (const it of instFacts) {
    try {
      if (existingKeys.has(it.key)) {
        // key 冲突
        if (strategy === "skip") {
          conflicts++;
          continue;
        }
        const old = kbGet(it.key);
        if (strategy === "merge" && old) {
          kbSet(it.key, `${old.value}\n${it.value}`, it.source);
        } else {
          kbSet(it.key, it.value, it.source);
        }
        imported++;
        conflicts++;
        continue;
      }
      // 内容去重（value 与实例内已有条目一致）
      if (existingValues.has(it.value.trim())) {
        skipped++;
        continue;
      }
      kbSet(it.key, it.value, it.source);
      existingKeys.add(it.key);
      existingValues.add(it.value.trim());
      imported++;
    } catch {
      // 单条 key 非法跳过（不影响整体）
      skipped++;
    }
  }
  return { ok: true, imported, skipped, conflicts, strategy, facts: instFacts, title: extracted.title, shareId: extracted.shareId };
}
