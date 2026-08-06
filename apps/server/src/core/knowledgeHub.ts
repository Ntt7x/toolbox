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
import { kbAsk, kbImportFromChat, matchDomain } from "./knowledge.js";
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

// ---------- 虚拟库聚合问答（多实例检索 → 单次 LLM） ----------
export async function askVirtKb(
  name: string,
  question: string,
  opts: { signal?: AbortSignal; topN?: number; module?: string } = {},
): Promise<{ ok: boolean; answer?: string; message?: string }> {
  const virt = getVirtKb(name);
  if (!virt) return { ok: false, message: `虚拟知识库「${name}」不存在` };
  if (virt.domains.length === 0) return { ok: false, message: "虚拟知识库未包含任何领域库" };
  const r = await kbAsk(question, { ...opts, instances: virt.domains, module: opts.module ?? "knowledge-hub.ask" });
  return r.ok ? { ok: true, answer: r.answer } : { ok: false, message: r.message };
}

// ---------- 虚拟库导入（自动匹配领域） ----------
/** 导入分享链接到虚拟库：每条事实经静态关键词匹配写入对应领域库；无匹配归 other */
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
  // 若领域均无关键词配置 → 全部写入第一个领域（退化为单领域导入）
  const matchDomains = domains.length > 0 ? domains : undefined;
  return kbImportFromChat(url, {
    ...opts,
    instance: matchDomains ? undefined : virt.domains[0],
    matchDomains,
    module: opts.module ?? "knowledge-hub.import",
  });
}
