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
  /** 任务指令模板指纹：首轮发完整 task；后续轮次模板未变则只发最小续问行 */
  taskFp?: string;
}

/** 轻量稳定指纹（渲染后引导词内容 hash；模板升级 → 指纹变化 → 重新发送引导） */
function fingerprint(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
}

/**
 * 构造 Reasonix user turn（引导词/任务指令去重）：
 *  - 首轮（新会话或指纹变化）：完整引导词 + 完整任务指令
 *  - 后续轮次（模板未变）：只发最小续问行（一行核心行为提示 + 动态内容）——历史已含完整指令，省每轮 ~200-400 token
 * 模板（引导/任务）任一部分升级 → 指纹变化 → 对应部分自动重发。
 */
/** 导出供单测（composePrompt 纯函数，无副作用） */
export function composePrompt(
  instance: string,
  guide: string,
  taskTemplate: string,
  renderTask: (tpl: string) => string,
  minTurn: (instance: string) => string,
  reg: KnowledgeSessionReg | null | undefined,
): { prompt: string; gFp: string; tFp: string } {
  const gFp = fingerprint(guide);
  const tFp = fingerprint(taskTemplate);
  const needGuide = reg?.guideFp !== gFp;
  const needTask = reg?.taskFp !== tFp;
  const parts: string[] = [];
  if (needGuide) parts.push(guide);
  if (needTask) parts.push(renderTask(taskTemplate));
  else parts.push(minTurn(instance));
  return { prompt: parts.join("\n"), gFp, tFp };
}

/** 记录本轮指纹（guide/task 已发送的内容标记，供下轮去重） */
/** 记录本轮指纹（guide/task 已发送的内容标记，供下轮去重） */
function rememberFingerprints(instance: string, gFp: string, tFp: string): void {
  const reg = kvGet<KnowledgeSessionReg>(sessionKey(instance)) ?? {
    regId: "",
    instance,
    createdAt: Date.now(),
    lastAt: Date.now(),
  };
  kvSet(sessionKey(instance), { ...reg, lastAt: Date.now(), guideFp: gFp, taskFp: tFp } satisfies KnowledgeSessionReg);
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
    } finally {
      // 无论 close 成功与否，都确保 reasonixSession 注册表条目被清理（close 内部删除幂等；失败也兜底）——不残留孤儿
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
/** 关闭某实例的会话并删注册表（本地数据管理清理用） */
export function dropKnowledgeSession(instance: string): void {
  dropSession(instance);
}
