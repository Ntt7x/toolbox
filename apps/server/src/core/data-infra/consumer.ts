// ============================================================
// 下层公共模块：消费者（数据工程-消息执行端 / FaaS）
// 职责："接受消息产生衍生数据或执行具体逻辑"——订阅队列，持续消费并执行 handler。
// 生命周期：register（定义）→ start（拉起消费循环）→ dequeue（取消息）→ handler（执行）→ ack（确认/重投）
// 语义：至少一次投递 + 幂等消费（handler 必须幂等；失败自动重投，超最大尝试由队列层丢弃）
// 并发：每个队列 concurrency 个并行消费循环（默认 1）；无消息时 50ms 小睡防忙轮询
// ============================================================
import { ack, dequeue, listQueues, requeueStale } from "./queue.js";

export interface ConsumerMessage {
  id: string;
  type?: string;
  payload?: unknown;
}

export interface ConsumerDef {
  /** 订阅的队列名 */
  queue: string;
  name: string;
  /** 并行消费数（默认 1） */
  concurrency?: number;
  /** 单条消息处理超时（ms，默认 120s；超时视为失败重投——防 fetch 挂起卡死消费循环） */
  handlerTimeoutMs?: number;
  /** 消费逻辑（必须幂等：同消息重复执行结果一致） */
  handler: (msg: ConsumerMessage) => Promise<void> | void;
}

export interface ConsumerInfo {
  queue: string;
  name: string;
  concurrency: number;
  running: boolean;
  /** 最近一次消费错误（可观测） */
  lastError?: string;
  /** 累计成功消费数（进程内） */
  processedCount: number;
  /** 最近一次消费时间 */
  lastConsumedAt?: number;
}

const consumers = new Map<string, ConsumerDef>();
const loops = new Map<string, boolean>();
const errors = new Map<string, string>();
const stats = new Map<string, { processed: number; lastAt?: number }>();
let started = false;

export function registerConsumer(def: ConsumerDef): void {
  consumers.set(def.queue, def);
  if (started) startQueueLoop(def.queue);
}

let staleTimer: ReturnType<typeof setInterval> | undefined;

export function startConsumers(): void {
  started = true;
  // 崩溃恢复：把已注册消费者队列里"处理超时"的 processing 消息恢复为 pending（至少一次投递语义）
  for (const q of consumers.keys()) requeueStale(q);
  for (const def of consumers.values()) startQueueLoop(def.queue);
  // 周期恢复：运行中 processing 卡住（fetch 挂起/进程内 handler 超时未回收）也能自动恢复——
  // requeueStale 默认 5min 阈值，60s 扫描一次
  if (!staleTimer) {
    staleTimer = setInterval(() => {
      for (const q of consumers.keys()) requeueStale(q);
    }, 60_000);
    staleTimer.unref?.(); // 不阻止进程退出（测试环境关键：node --test 不被 interval 挂起）
  }
}

export function stopConsumers(): void {
  started = false;
  loops.clear();
  if (staleTimer) { clearInterval(staleTimer); staleTimer = undefined; }
}

function startQueueLoop(queue: string): void {
  const def = consumers.get(queue);
  if (!def || loops.get(queue)) return;
  loops.set(queue, true);
  const n = def.concurrency ?? 1;
  for (let i = 0; i < n; i++) void loopOnce(queue);
}

async function loopOnce(queue: string): Promise<void> {
  const def = consumers.get(queue);
  if (!def || !loops.get(queue)) return;
  try {
    const msg = dequeue<Record<string, unknown>>(queue);
    if (msg) {
      try {
        const { type, ...rest } = msg.payload ?? {};
        // handler 级超时兜底（2026-08-26 数据工程用例教训：fetch 在 Windows DNS/连接阶段可能不响应
        // AbortSignal 挂起，导致消费循环停摆——超时视为失败重投；消费端幂等兜底）
        const timeoutMs = def.handlerTimeoutMs ?? 120_000;
        await Promise.race([
          def.handler({ id: msg.id, type: type as string | undefined, payload: Object.keys(rest).length ? rest : undefined }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`handler 超时（>${timeoutMs}ms）`)), timeoutMs)),
        ]);
        ack(queue, msg.id, true);
        // 消费统计（可观测）
        const st = stats.get(queue) ?? { processed: 0 };
        st.processed += 1;
        st.lastAt = Date.now();
        stats.set(queue, st);
      } catch (e) {
        ack(queue, msg.id, false); // 失败重投（attempts+1，超最大尝试由队列层丢弃）
        const err = e instanceof Error ? e.message : String(e);
        errors.set(queue, err);
        console.error(`[consumer:${queue}] 消息 ${msg.id} 处理失败（将重投）: ${err}`);
      }
    }
  } catch {
    // dequeue 读取异常不中断循环
  }
  if (loops.get(queue)) {
    setTimeout(() => void loopOnce(queue), 50);
  }
}

/** 消费者清单（运管） */
export function listConsumers(): ConsumerInfo[] {
  return [...consumers.values()].map((c) => {
    const st = stats.get(c.queue);
    return {
      queue: c.queue,
      name: c.name,
      concurrency: c.concurrency ?? 1,
      running: started && !!loops.get(c.queue),
      lastError: errors.get(c.queue),
      processedCount: st?.processed ?? 0,
      ...(st?.lastAt ? { lastConsumedAt: st.lastAt } : {}),
    };
  });
}

/** 未被消费的队列（有积压但无消费者订阅——运管诊断；listQueues 已去前缀） */
export function orphanQueues(): string[] {
  const consumed = new Set(consumers.keys());
  return listQueues().filter((q) => !consumed.has(q));
}
