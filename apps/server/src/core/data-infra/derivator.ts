// ============================================================
// 下层公共模块：派生器（数据工程-消息生成端）
// 职责："从源数据生成衍生消息"——源事件（任务完成/定时检查/手动）发生时，
//       检查源数据并投递衍生消息到队列，供消费者（FaaS）订阅执行。
// 生命周期：register（定义）→ when 命中（触发）→ derive（派生）→ enqueue（投递）→ 队列
// 幂等：derive 必须是纯派生（可重放——同触发点多次执行产生同批消息，由消费端幂等兜底）
// 存储：KV（node:sqlite）dataInfra:derivator:<id> → { items: DerivatorRun[] }（运行记录，上限 50）
// ============================================================
import { kvGet, kvSet } from "../kvStore.js";
import { enqueue, listQueues } from "./queue.js";
import { onTaskFinished, type TaskHandlerResult, type TaskStatus } from "./taskRegistry.js";

export type DerivatorTrigger = "task.done" | "task.failed" | "cron" | "manual";

export interface DerivatorContext {
  trigger: DerivatorTrigger;
  /** 触发源任务 id（task.done/task.failed 时有） */
  taskId?: string;
  taskResult?: TaskHandlerResult;
  force?: boolean;
}

export interface DerivedMessage {
  type: string;
  payload: unknown;
  /** 投递到指定队列（缺省用派生器默认 queue） */
  queue?: string;
  ttlMs?: number;
}

export interface DerivatorDef {
  id: string;
  /** 触发条件（至少一项） */
  when: {
    /** 这些任务 done 时触发 */
    taskDone?: string[];
    /** 这些任务 failed 时触发 */
    taskFailed?: string[];
    /** 自调度 cron（派生器自身定时检查源数据） */
    cron?: string;
  };
  /** 默认投递队列 */
  queue: string;
  /** 派生逻辑：源事件 → 衍生消息数组（可重放） */
  derive: (ctx: DerivatorContext) => DerivedMessage[] | Promise<DerivedMessage[]>;
}

export interface DerivatorRun {
  at: number;
  trigger: DerivatorTrigger;
  taskId?: string;
  messages: number;
  ok: boolean;
  error?: string;
}

const PREFIX = "dataInfra:derivator:";
const RUN_LIMIT = 50;

const defs = new Map<string, DerivatorDef>();
const subscribed = new Set<string>(); // 已订阅的派生器 id（防同 id 重复注册重复订阅）

export function registerDerivator(def: DerivatorDef): void {
  defs.set(def.id, def);
  if (subscribed.has(def.id)) return;
  subscribed.add(def.id);
  // 订阅任务完成事件（task.done/task.failed 命中时）——每个派生器独立订阅，不按任务去重
  const watchIds = new Set([...(def.when.taskDone ?? []), ...(def.when.taskFailed ?? [])]);
  for (const tid of watchIds) {
    onTaskFinished((id, status, result) => {
      const isDone = def.when.taskDone?.includes(id) && status === "done";
      const isFailed = def.when.taskFailed?.includes(id) && status === "failed";
      if (!isDone && !isFailed) return;
      void fireDerivator(def.id, status === "done" ? "task.done" : "task.failed", { taskId: id, taskResult: result });
    });
  }
}

async function fireDerivator(id: string, trigger: DerivatorTrigger, ctx: Omit<DerivatorContext, "trigger">): Promise<void> {
  const def = defs.get(id);
  if (!def) return;
  let run: DerivatorRun;
  try {
    const messages = await def.derive({ ...ctx, trigger });
    let count = 0;
    for (const m of messages) {
      enqueue(m.queue ?? def.queue, { type: m.type, ...(typeof m.payload === "object" && m.payload !== null ? m.payload : { value: m.payload }) }, { ttlMs: m.ttlMs });
      count += 1;
    }
    run = { at: Date.now(), trigger, taskId: ctx.taskId, messages: count, ok: true };
  } catch (e) {
    run = { at: Date.now(), trigger, taskId: ctx.taskId, messages: 0, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const key = PREFIX + id;
  const cur = kvGet<{ items: DerivatorRun[] }>(key)?.items ?? [];
  cur.push(run);
  if (cur.length > RUN_LIMIT) cur.splice(0, cur.length - RUN_LIMIT);
  kvSet(key, { items: cur });
}

/** 手动触发派生器（运管/测试） */
export async function triggerDerivator(id: string, opts?: { force?: boolean }): Promise<{ ok: boolean; message: string }> {
  if (!defs.has(id)) return { ok: false, message: "派生器未注册" };
  await fireDerivator(id, "manual", { force: opts?.force });
  return { ok: true, message: `派生器 ${id} 已触发（见运行记录）` };
}

/** 派生器清单（运管） */
export function listDerivators(): Array<DerivatorDef & { runs: DerivatorRun[] }> {
  return [...defs.values()].map((d) => ({ ...d, runs: kvGet<{ items: DerivatorRun[] }>(PREFIX + d.id)?.items ?? [] }));
}

/** 按 id 取派生器定义（供调度层检查 cron） */
export function getDerivator(id: string): DerivatorDef | undefined {
  return defs.get(id);
}

/** 全部派生器 id（供调度层 cron 触发） */
export function derivatorIds(): string[] {
  return [...defs.keys()];
}

/** 队列完整性检查：所有派生器目标队列已存在（运管诊断） */
export function checkDerivatorQueues(): string[] {
  const queues = new Set(listQueues());
  const missing: string[] = [];
  for (const d of defs.values()) if (!queues.has(d.queue)) missing.push(`${d.id} → ${d.queue}`);
  return missing;
}
