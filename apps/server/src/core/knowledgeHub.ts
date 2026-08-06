// ============================================================
// 公共模块：知识库中心（core/knowledgeHub）
// 虚拟知识库 = 多个领域知识库的集合（如「综合」= 医学+交易+杂项）
// - 虚拟库 CRUD（KV：kbVirt:<name>）
// - 领域库元数据（描述/关键词，用于自动匹配导入；KV：kbDomain:<name>）
// - 虚拟库聚合问答（多实例检索 → 单次 LLM）
// - 虚拟库导入：静态关键词匹配领域（低成本）→ 写入对应领域库；无匹配归 other
// 依赖：core/knowledge（kbAsk/kbImportFromChat/kbListInstances）
// ============================================================
import { kvGet, kvSet, kvDelete, kvListRaw } from "./kvStore.js";
import { registerDataSource } from "./dataRegistry.js";
import { kbAsk, kbImportFromChat, matchDomain, clearInstance, kbList, kbGet, kbSet } from "./knowledge.js";
import { chat } from "./llm.js";
import { robustJsonParse } from "./jsonParse.js";
import { MEDICAL_KB_ASK, MEDICAL_KB_EXTRACT } from "./prompts.js";
import type { KnowledgeImportResult } from "@toolbox/shared";

registerDataSource({
  kind: "kv",
  name: "kbVirt:",
  page: "知识库中心",
  tag: "知识数据",
  description: "虚拟知识库配置（kbVirt:<name>，多个领域知识库的集合）",
});
registerDataSource({
  kind: "kv",
  name: "kbDomain:",
  page: "知识库中心",
  tag: "知识数据",
  description: "领域知识库元数据（kbDomain:<name>，描述+关键词，用于自动匹配导入）",
});
registerDataSource({
  kind: "kv",
  name: "kbImport:",
  page: "知识库中心",
  tag: "运行记录",
  description: "知识库导入历史（kbImport:history，批量导入的逐条结果与分发统计）",
});

const VIRT_PREFIX = "kbVirt:";
const DOMAIN_PREFIX = "kbDomain:";

export interface VirtKb {
  name: string;
  domains: string[];
  desc?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DomainMeta {
  name: string;
  desc: string;
  keywords: string[];
  /** 领域特化问答模板（覆盖默认；空则用通用/医学默认） */
  askTemplate?: string;
  /** 领域特化导入提取模板 */
  extractTemplate?: string;
}

// ---------- 虚拟库 CRUD ----------
export function listVirtKbs(): VirtKb[] {
  const out: VirtKb[] = [];
  for (const r of kvListRaw(VIRT_PREFIX, 200)) {
    try {
      const v = JSON.parse(r.value) as VirtKb;
      if (v?.name) out.push(v);
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getVirtKb(name: string): VirtKb | null {
  return kvGet<VirtKb>(`${VIRT_PREFIX}${name}`) ?? null;
}

export function createVirtKb(name: string, domains: string[], desc?: string): { ok: boolean; message?: string; virt?: VirtKb } {
  const n = name.trim();
  if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(n)) return { ok: false, message: "虚拟库名称仅允许中英文/数字/._-" };
  const uniqDomains = [...new Set(domains.map((d) => d.trim()).filter(Boolean))];
  if (uniqDomains.length === 0) return { ok: false, message: "至少选择一个领域知识库" };
  const now = Date.now();
  const virt: VirtKb = { name: n, domains: uniqDomains, ...(desc?.trim() ? { desc: desc.trim() } : {}), createdAt: now, updatedAt: now };
  kvSet(`${VIRT_PREFIX}${n}`, virt);
  return { ok: true, virt };
}

export function deleteVirtKb(name: string): void {
  kvDelete(`${VIRT_PREFIX}${name}`);
}

// ---------- 领域元数据 ----------
export function getDomainMeta(name: string): DomainMeta | null {
  return kvGet<DomainMeta>(`${DOMAIN_PREFIX}${name}`) ?? null;
}

export function setDomainMeta(name: string, meta: { desc?: string; keywords?: string[]; askTemplate?: string; extractTemplate?: string }): DomainMeta {
  const old = getDomainMeta(name);
  const d: DomainMeta = {
    name,
    desc: meta.desc?.trim() || old?.desc || "",
    keywords: meta.keywords?.map((k) => k.trim()).filter(Boolean) || old?.keywords || [],
    ...(meta.askTemplate !== undefined ? { askTemplate: meta.askTemplate } : old?.askTemplate ? { askTemplate: old.askTemplate } : {}),
    ...(meta.extractTemplate !== undefined ? { extractTemplate: meta.extractTemplate } : old?.extractTemplate ? { extractTemplate: old.extractTemplate } : {}),
  };
  kvSet(`${DOMAIN_PREFIX}${name}`, d);
  return d;
}

/** 新建领域知识库：创建领域元数据（显式建库；空库也可先建后导入） */
export function createDomain(name: string, meta: { desc?: string; keywords?: string[] } = {}): { ok: boolean; message?: string; domain?: DomainMeta } {
  const n = name.trim();
  if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(n)) return { ok: false, message: "领域名称仅允许中英文/数字/._-" };
  if (getDomainMeta(n)) return { ok: false, message: `领域「${n}」已存在` };
  const d: DomainMeta = {
    name: n,
    desc: meta.desc?.trim() ?? "",
    keywords: meta.keywords?.map((k) => k.trim()).filter(Boolean) ?? [],
  };
  kvSet(`${DOMAIN_PREFIX}${n}`, d);
  return { ok: true, domain: d };
}

/** LLM 生成领域特化提示词模板（一次调用产出 问答/导入 两个 system 模板；失败抛错由调用方降级） */
export async function generateDomainTemplates(info: { name: string; desc?: string; keywords: string[] }): Promise<{ askTemplate: string; extractTemplate: string }> {
  const sys =
    "你是资深提示词工程师。根据给定领域信息，生成两个知识库 system 提示词模板，输出 JSON：\n" +
    '{"askTemplate": "...", "extractTemplate": "..."}\n' +
    "askTemplate：知识库问答助手 system——约束：只依据「知识库检索结果」回答、检索无相关内容时如实说明不编造、必要时建议咨询专业人士、按领域专业规范回答；" +
    "extractTemplate：知识导入提取助手 system——约束：从对话中提取有长期价值的领域知识，输出 JSON 数组（每项 {key, value, source?}），key 用点分短标识、value 精炼完整。两个模板都要自然融入领域角色定位，直接输出 JSON 本身，不要 markdown 代码块。";
  const user = `领域名称：${info.name}\n领域描述：${info.desc?.trim() || "（无）"}\n领域关键词：${info.keywords.join("、") || "（无）"}`;
  const r = await chat([{ role: "system", content: sys }, { role: "user", content: user }], {
    temperature: 0.4,
    json: true,
    module: "knowledge-hub.gen-template",
  });
  if (!r.ok) throw new Error(r.message);
  const p = robustJsonParse(r.content.trim()) as { askTemplate?: unknown; extractTemplate?: unknown };
  const askTemplate = typeof p?.askTemplate === "string" ? p.askTemplate.trim() : "";
  const extractTemplate = typeof p?.extractTemplate === "string" ? p.extractTemplate.trim() : "";
  if (!askTemplate || !extractTemplate) throw new Error("模板生成结果不完整（缺 askTemplate/extractTemplate）");
  return { askTemplate, extractTemplate };
}

/** 删除领域知识库：清空该实例全部条目 + 删元数据（即使无元数据也强制清空隐式实例）；
 *  级联：所有虚拟库移除对该领域的引用，引用清空的虚拟库一并删除。返回删除条目数 */
export function deleteDomain(name: string): { ok: boolean; removedEntries: number; cleanedVirts?: number } {
  const removedEntries = clearInstance(name);
  kvDelete(`${DOMAIN_PREFIX}${name}`);
  let cleanedVirts = 0;
  for (const v of listVirtKbs()) {
    if (v.domains.includes(name)) {
      const rest = v.domains.filter((d) => d !== name);
      if (rest.length === 0) {
        kvDelete(`${VIRT_PREFIX}${v.name}`);
        cleanedVirts++;
      } else {
        kvSet(`${VIRT_PREFIX}${v.name}`, { ...v, domains: rest, updatedAt: Date.now() });
      }
    }
  }
  return { ok: true, removedEntries, ...(cleanedVirts ? { cleanedVirts } : {}) };
}

/** 动态调整虚拟库引用的领域库（domains 增删/替换；desc 更新） */
export function updateVirtKb(name: string, patch: { domains?: string[]; desc?: string }): { ok: boolean; message?: string; virt?: VirtKb } {
  const v = getVirtKb(name);
  if (!v) return { ok: false, message: `虚拟知识库「${name}」不存在` };
  const domains = patch.domains ? [...new Set(patch.domains.map((d) => d.trim()).filter(Boolean))] : v.domains;
  if (domains.length === 0) return { ok: false, message: "至少保留一个领域" };
  const virt: VirtKb = { ...v, domains, ...(patch.desc !== undefined ? { desc: patch.desc.trim() || undefined } : {}), updatedAt: Date.now() };
  kvSet(`${VIRT_PREFIX}${name}`, virt);
  return { ok: true, virt };
}

export function listDomains(): DomainMeta[] {
  const out: DomainMeta[] = [];
  for (const r of kvListRaw(DOMAIN_PREFIX, 200)) {
    try {
      const v = JSON.parse(r.value) as DomainMeta;
      if (v?.name) out.push(v);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** 医学领域模板 seed：幂等初始化 kbDomain:medical 的 ask/extract 模板（默认不覆盖用户已编辑内容；force 强制重置为内置模板） */
export function seedMedicalTemplates(force = false): void {
  const old = getDomainMeta("medical");
  const d: DomainMeta = {
    name: "medical",
    desc: old?.desc || "医学知识库",
    keywords: old?.keywords?.length ? old.keywords : ["血压", "手术", "康复", "药物", "治疗", "疾病", "训练", "肌肉", "症状", "诊断"],
    askTemplate: !old?.askTemplate || force ? MEDICAL_KB_ASK : old.askTemplate,
    extractTemplate: !old?.extractTemplate || force ? MEDICAL_KB_EXTRACT : old.extractTemplate,
  };
  kvSet(`${DOMAIN_PREFIX}medical`, d);
}

/** 领域模板解析：kbDomain 配置 → 领域特化模板；未配置返回 undefined（调用方回退 medical/通用） */
export function getInstanceTemplate(kind: "ask" | "extract", instance?: string): string | undefined {
  if (instance) {
    const meta = getDomainMeta(instance);
    if (meta) {
      const t = kind === "ask" ? meta.askTemplate : meta.extractTemplate;
      if (t && t.trim()) return t;
    }
  }
  return undefined;
}

// ---------- 虚拟库聚合问答（综合匹配：先领域路由 → 只检索最相关领域；未路由 → 全领域降级） ----------
export async function askVirtKb(
  name: string,
  question: string,
  opts: { signal?: AbortSignal; topN?: number; module?: string } = {},
): Promise<{ ok: boolean; answer?: string; routed?: string; message?: string }> {
  const virt = getVirtKb(name);
  if (!virt) return { ok: false, message: `虚拟知识库「${name}」不存在` };
  if (virt.domains.length === 0) return { ok: false, message: "虚拟知识库未包含任何领域库" };
  // 综合匹配（低成本，纯静态）：问题关键词路由到最相关领域 → 只检索该领域（省 token、回答聚焦）；
  // 无关键词命中 → 降级全领域检索（保证覆盖面）
  const domains = virt.domains
    .map((d) => ({ name: d, keywords: getDomainMeta(d)?.keywords ?? [] }))
    .filter((d) => d.keywords.length > 0);
  const routed = domains.length > 0 ? matchDomain(question, domains)?.domain : undefined;
  const instances = routed ? [routed] : virt.domains;
  const r = await kbAsk(question, { ...opts, instances, module: opts.module ?? "knowledge-hub.ask" });
  return r.ok ? { ok: true, answer: r.answer, ...(routed ? { routed } : {}) } : { ok: false, message: r.message };
}

// ---------- 虚拟库导入（自动匹配领域） ----------
/** 导入分享链接到虚拟库：每条事实经静态关键词匹配写入对应领域库；
 *  无匹配归虚拟库的「杂项」领域（名字含 other/杂项/misc，如 my-other）；无杂项领域则归第一个领域 */
export async function importToVirtKb(
  name: string,
  url: string,
  opts: { signal?: AbortSignal; module?: string } = {},
): Promise<KnowledgeImportResult> {
  const virt = getVirtKb(name);
  if (!virt) throw new Error(`虚拟知识库「${name}」不存在`);
  const domains = virt.domains
    .map((d) => ({ name: d, keywords: getDomainMeta(d)?.keywords ?? [] }))
    .filter((d) => d.keywords.length > 0);
  // 无匹配兜底：虚拟库杂项领域（other/杂项/misc）优先，其次第一个领域
  const fallbackDomain =
    virt.domains.find((d) => /other|杂项|misc|miscellaneous/i.test(d)) ??
    virt.domains.find((d) => !/^(?:medical|trading|math|crypto|ai|my)$/i.test(d)) ??
    virt.domains[0];
  // 若领域均无关键词配置 → 全部写入第一个领域（退化为单领域导入）
  const matchDomains = domains.length > 0 ? domains : undefined;
  return kbImportFromChat(url, {
    ...opts,
    instance: matchDomains ? undefined : virt.domains[0],
    matchDomains,
    fallbackDomain: matchDomains ? fallbackDomain : undefined,
    module: opts.module ?? "knowledge-hub.import",
  });
}

/** 实例迁移：把 source 实例的全部条目迁移到 target 实例（key 冲突跳过），迁移后清空 source；返回迁移条数 */
export function migrateInstance(source: string, target: string): { ok: boolean; migrated: number; skipped: number; message?: string } {
  if (!source || !target || source === target) return { ok: false, migrated: 0, skipped: 0, message: "源/目标实例无效" };
  const srcPrefix = `${source}.`;
  const tgtPrefix = `${target}.`;
  let migrated = 0;
  let skipped = 0;
  for (const e of kbList({ prefix: srcPrefix, limit: 5000 })) {
    const newKey = tgtPrefix + e.key.slice(srcPrefix.length);
    if (kbGet(newKey)) {
      skipped++;
      continue;
    }
    kbSet(newKey, e.value, e.source);
    migrated++;
  }
  if (migrated > 0 || skipped > 0) clearInstance(source);
  return { ok: true, migrated, skipped };
}

// ---------- 批量导入 + 历史记录 ----------
export interface ImportRecordItem {
  url: string;
  ok: boolean;
  imported: number;
  skipped?: number;
  conflicts?: number;
  title?: string;
  message?: string;
}

export interface ImportRecord {
  time: number;
  target: string; // 知识库名
  targetType: "domain" | "virt";
  items: ImportRecordItem[];
  totalImported: number;
  /** 虚拟库分发统计：领域 → 条数（从 facts key 首段聚合） */
  distribution?: Record<string, number>;
}

const IMPORT_HISTORY_KEY = "kbImport:history";
const IMPORT_HISTORY_LIMIT = 50;

function distributionOf(result: KnowledgeImportResult): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const f of result.facts ?? []) {
    const seg = f.key.split(".")[0] || "other";
    dist[seg] = (dist[seg] ?? 0) + 1;
  }
  return dist;
}

function readImportHistory(): ImportRecord[] {
  const raw = kvGet<ImportRecord[]>(IMPORT_HISTORY_KEY);
  return Array.isArray(raw) ? raw : [];
}

function pushImportHistory(rec: ImportRecord): void {
  const list = [rec, ...readImportHistory()].slice(0, IMPORT_HISTORY_LIMIT);
  kvSet(IMPORT_HISTORY_KEY, list);
}

export function listImportHistory(): ImportRecord[] {
  return readImportHistory();
}

export function clearImportHistory(): void {
  kvDelete(IMPORT_HISTORY_KEY);
}

/** 批量导入领域库：逐条导入并聚合逐条结果 + 写历史 */
export async function importBatchToDomain(
  name: string,
  urls: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<{ ok: boolean; items: ImportRecordItem[]; totalImported: number; message?: string }> {
  const items: ImportRecordItem[] = [];
  let totalImported = 0;
  for (const url of urls) {
    if (opts.signal?.aborted) break;
    try {
      const r = await kbImportFromChat(url, { instance: name, module: "knowledge-hub.import" });
      items.push({ url, ok: true, imported: r.imported, skipped: r.skipped, conflicts: r.conflicts, title: r.title });
      totalImported += r.imported;
    } catch (e) {
      items.push({ url, ok: false, imported: 0, message: e instanceof Error ? e.message : String(e) });
    }
  }
  pushImportHistory({ time: Date.now(), target: name, targetType: "domain", items, totalImported });
  return { ok: true, items, totalImported };
}

/** 批量导入虚拟库：逐条导入（自动匹配领域）并聚合逐条结果 + 分发统计 + 写历史 */
export async function importBatchToVirt(
  name: string,
  urls: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<{ ok: boolean; items: ImportRecordItem[]; totalImported: number; distribution?: Record<string, number>; message?: string }> {
  const items: ImportRecordItem[] = [];
  let totalImported = 0;
  const distribution: Record<string, number> = {};
  for (const url of urls) {
    if (opts.signal?.aborted) break;
    try {
      const r = await importToVirtKb(name, url);
      items.push({ url, ok: true, imported: r.imported, skipped: r.skipped, conflicts: r.conflicts, title: r.title });
      totalImported += r.imported;
      const d = distributionOf(r);
      for (const [k, v] of Object.entries(d)) distribution[k] = (distribution[k] ?? 0) + v;
    } catch (e) {
      items.push({ url, ok: false, imported: 0, message: e instanceof Error ? e.message : String(e) });
    }
  }
  pushImportHistory({ time: Date.now(), target: name, targetType: "virt", items, totalImported, distribution });
  return { ok: true, items, totalImported, distribution };
}
