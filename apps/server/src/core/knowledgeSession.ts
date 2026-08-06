// ============================================================
// 公共模块：知识库 × Reasonix Agent 会话封装
// 知识管理执行者 = Reasonix Agent（会话持久、前缀缓存，成本低）：
//   - 会话挂载 stdio MCP（core/knowledgeMcp），Agent 经 mcp__kb__* 工具直接读写 KV（无文件视图）
//   - 实例级会话（knowledgeSession:<instance> 注册表 KV 持久化），同一实例多次问答/导入共享上下文
//   - Reasonix 不可用（二进制/API key 缺失）时调用方降级到服务端直调（kbAsk/kbImportFromChat）
// ============================================================
import { createReasonixSession, reasonixAsk, closeReasonixSession } from "./reasonix.js";
import { kvGet, kvSet, kvDelete } from "./kvStore.js";
import { extractShare } from "./deepseekShare.js";
import { registerDataSource } from "./dataRegistry.js";
import { kbCountInstance } from "./knowledge.js";
import { enabledMcpServers } from "./mcpConfig.js";
import { getPromptTemplate } from "./prompts.js";

export const KNOWLEDGE_SESSION_PREFIX = "knowledgeSession:";
registerDataSource({
  kind: "kv",
  name: "knowledgeSession:",
  page: "知识库",
  tag: "运行状态",
  description: "知识库实例的 Reasonix Agent 会话注册表（KV 持久化，续用/恢复）",
});

function sessionKey(instance: string): string {
  return `${KNOWLEDGE_SESSION_PREFIX}${instance}`;
}

/** 实例级串行队列：reasonix 会话同一时刻只能一个 prompt（并发冲突会报 "already has an active prompt"） */
const instanceQueues = new Map<string, Promise<unknown>>();
function enqueue<T>(instance: string, fn: () => Promise<T>): Promise<T> {
  const prev = instanceQueues.get(instance) ?? Promise.resolve();
  const next = prev.then(fn, fn); // 前一个失败不阻塞后续
  instanceQueues.set(
    instance,
    next.catch(() => {}), // 队列保持可继续
  );
  return next;
}

interface KnowledgeSessionReg {
  regId: string;
  instance: string;
  createdAt: number;
  lastAt: number;
  /** 引导词指纹：首轮发送后记录；后续轮次指纹相同则不再重复发送（省 token，历史已含引导） */
  guideFp?: string;
}

/** 轻量稳定指纹（渲染后引导词内容 hash；模板升级 → 指纹变化 → 重新发送引导） */
function fingerprint(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
}

/** 获取（或创建）某实例的 Reasonix 会话；失败返回 ok:false（调用方降级直调） */
export async function ensureKnowledgeSession(instance: string): Promise<{ ok: boolean; regId?: string; message?: string; created?: boolean }> {
  const key = sessionKey(instance);
  const existing = kvGet<KnowledgeSessionReg>(key);
  if (existing && typeof existing.regId === "string") {
    kvSet(key, { ...existing, lastAt: Date.now() }); // 访问即刷新（元数据）
    return { ok: true, regId: existing.regId, created: false };
  }
  return createNew();

  async function createNew() {
    const s = await createReasonixSession({ module: `knowledge.${instance}`, mcpServers: enabledMcpServers() });
    if (!s.ok || !s.id) return { ok: false, message: s.message ?? "reasonix 会话创建失败" };
    kvSet(key, { regId: s.id, instance, createdAt: Date.now(), lastAt: Date.now() } satisfies KnowledgeSessionReg);
    return { ok: true, regId: s.id, created: true };
  }
}

/**
 * 强制重建会话（会话失效时）：关闭旧会话释放资源 → 新建 → 更新注册表。
 * 保证同一实例注册表始终指向唯一活跃会话（不产生孤儿）。
 */
async function recreateSession(instance: string): Promise<{ ok: boolean; regId?: string; message?: string }> {
  const key = sessionKey(instance);
  const old = kvGet<KnowledgeSessionReg>(key);
  if (old?.regId) {
    kvDelete(key);
    try {
      await closeReasonixSession(old.regId);
    } catch {
      // 进程已不在/关闭失败：仅确保注册表清理（不残留孤儿）
      kvDelete(`reasonixSession:${old.regId}`);
    }
  }
  const s = await createReasonixSession({ module: `knowledge.${instance}`, mcpServers: enabledMcpServers() });
  if (!s.ok || !s.id) return { ok: false, message: s.message ?? "reasonix 会话重建失败" };
  kvSet(key, { regId: s.id, instance, createdAt: Date.now(), lastAt: Date.now() } satisfies KnowledgeSessionReg);
  return { ok: true, regId: s.id };
}

/** 会话注册表清理（dropKnowledgeSession 用） */
function dropSession(instance: string): void {
  kvDelete(sessionKey(instance));
}

/** Agent 引导词（模板渲染：知识工具约束 + 实例/任务说明；medical 实例用医学特化模板） */
function guideFor(instance: string, action: string): string {
  const id = instance === "medical" ? "medical-kb.agent.guide" : "knowledge.agent.guide";
  return getPromptTemplate(id).replace("{instance}", instance).replace("{action}", action);
}

/** 问答/导入任务指令模板 id（medical 实例用医学特化模板） */
function taskTemplateId(instance: string, task: "ask" | "import"): string {
  return instance === "medical" ? `medical-kb.agent.${task}` : `knowledge.agent.${task}`;
}

/**
 * 知识问答（Reasonix 执行）：Agent 用 kb_search/kb_get 检索实例知识后回答。
 * 失败时返回 { ok:false, fallback:true }，调用方降级 kbAsk。
 */
export async function knowledgeAgentAsk(
  instance: string,
  question: string,
  opts: { timeoutMs?: number; module?: string } = {},
): Promise<{ ok: boolean; content?: string; usage?: unknown; message?: string; fallback?: boolean }> {
  return enqueue(instance, () => doAsk(instance, question, opts));
}

/** 用量归属 module：业务调用方必须传业务场景 module（如 medical-kb.ask）；未传时归「未标注」并告警，避免技术 module 混入用量 */
function usageModule(opts: { module?: string }, instance: string): string {
  if (opts.module) return opts.module;
  console.warn(`[knowledgeSession] 实例 ${instance} 的 LLM 调用未传业务 module（用量将归入 knowledge.unknown）——调用方应透传业务场景 module`);
  return "knowledge.unknown";
}

async function doAsk(
  instance: string,
  question: string,
  opts: { timeoutMs?: number; module?: string },
): Promise<{ ok: boolean; content?: string; usage?: unknown; message?: string; fallback?: boolean }> {
  const s = await ensureKnowledgeSession(instance);
  if (!s.ok || !s.regId) return { ok: false, message: s.message, fallback: true };
  const module = usageModule(opts, instance);
  const guide = guideFor(instance, "回答用户问题");
  const task = getPromptTemplate(taskTemplateId(instance, "ask")).replace("{instance}", instance).replace("{question}", question);
  // 引导词去重：首轮（新会话/引导词指纹变化）才发送；后续轮次历史已含引导，只发任务指令（省 token、前缀更干净）
  const reg = kvGet<KnowledgeSessionReg>(sessionKey(instance));
  const fp = fingerprint(guide);
  const needGuide = !reg?.guideFp || reg.guideFp !== fp;
  const prompt = needGuide ? `${guide}\n${task}` : task;
  if (needGuide) kvSet(sessionKey(instance), { ...reg!, instance, lastAt: Date.now(), guideFp: fp });
  let r = await reasonixAsk(s.regId, prompt, { ...opts, module });
  // 会话失效（reasonix 进程重启/会话丢失，unknown session 等）：重建会话后重试一次（不再 drop，避免孤儿堆积）
  if (!r.ok && r.sessionGone) {
    const s2 = await recreateSession(instance);
    if (s2.ok && s2.regId) {
      // 重建后是新会话（无历史），必须带引导词
      const prompt2 = `${guide}\n${task}`;
      r = await reasonixAsk(s2.regId, prompt2, { ...opts, module });
    }
  }
  if (!r.ok) {
    return { ok: false, message: r.message, fallback: true }; // 临时错误（超时等）保留会话复用
  }
  return { ok: true, content: r.content, usage: r.usage };
}

/**
 * 知识导入（Reasonix 执行）：服务端取分享对话原文 → Agent 整理为条目 → kb_set 写入实例。
 * 失败时返回 { ok:false, fallback:true }，调用方降级 kbImportFromChat。
 */
export async function knowledgeAgentImport(
  instance: string,
  shareUrl: string,
  opts: { timeoutMs?: number; module?: string } = {},
): Promise<{ ok: boolean; imported?: number; message?: string; fallback?: boolean }> {
  return enqueue(instance, () => doImport(instance, shareUrl, opts));
}

async function doImport(
  instance: string,
  shareUrl: string,
  opts: { timeoutMs?: number; module?: string },
): Promise<{ ok: boolean; imported?: number; message?: string; fallback?: boolean }> {
  const conv = await extractShare(shareUrl);
  if (!conv.ok || !Array.isArray(conv.messages) || conv.messages.length === 0) {
    return { ok: false, message: "分享链接对话提取失败", fallback: true };
  }
  const s = await ensureKnowledgeSession(instance);
  if (!s.ok || !s.regId) return { ok: false, message: s.message, fallback: true };
  const before = kbCountInstance(instance);
  const dialog = conv.messages
    .map((m, i) => `${i + 1}. [${m.role}] ${typeof m.content === "string" ? m.content.slice(0, 2000) : JSON.stringify(m.content).slice(0, 2000)}`)
    .join("\n");
  const module = usageModule(opts, instance);
  const guide = guideFor(instance, "把对话内容整理为知识条目并写入知识库");
  const task = getPromptTemplate(taskTemplateId(instance, "import")).replaceAll("{instance}", instance).replace("{dialog}", dialog);
  // 引导词去重：首轮（新会话/引导词指纹变化）才发送
  const reg = kvGet<KnowledgeSessionReg>(sessionKey(instance));
  const fp = fingerprint(guide);
  const needGuide = !reg?.guideFp || reg.guideFp !== fp;
  const prompt = needGuide ? `${guide}\n${task}` : task;
  if (needGuide) kvSet(sessionKey(instance), { ...reg!, instance, lastAt: Date.now(), guideFp: fp });
  let r = await reasonixAsk(s.regId, prompt, { timeoutMs: opts.timeoutMs ?? 5 * 60 * 1000, module });
  if (!r.ok) {
    if (r.sessionGone) {
      // 会话失效：重建会话后重试一次（不再 drop，避免孤儿堆积）；重建后是新会话，必须带引导词
      const s2 = await recreateSession(instance);
      if (s2.ok && s2.regId) {
        const prompt2 = `${guide}\n${task}`;
        r = await reasonixAsk(s2.regId, prompt2, { timeoutMs: opts.timeoutMs ?? 5 * 60 * 1000, module });
      }
    }
    if (!r.ok) return { ok: false, message: r.message, fallback: true };
  }
  const after = kbCountInstance(instance);
  return { ok: true, imported: Math.max(after - before, 0), message: r.content };
}

/** 关闭某实例的会话并删注册表（本地数据管理清理用） */
export function dropKnowledgeSession(instance: string): void {
  dropSession(instance);
}
