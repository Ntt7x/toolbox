// ============================================================
// 下层公共模块：任务注册表 + 生命周期状态机（数据工程-任务层）
// 生命周期：register（定义）→ queued（排队）→ running（执行）→ done/failed（终态）→ history（归档）
// 幂等是第一原则：任务可 retry/backfill 重跑（handler 必须幂等，重跑安全）
// 存储：KV（node:sqlite）：
//   dataInfra:task:<id>      → RegisteredTask（含状态）
//   dataInfra:taskHist:<id>  → { entries: TaskHistoryEntry[] }（执行历史，上限 50）
// ============================================================
import { randomUUID } from "node:crypto";
import { kvDelete, kvGet, kvListRaw, kvSet } from "../kvStore.js";

export type TaskStatus = "queued" | "running" | "done" | "failed" | "paused";

export interface TaskRunOptions {
  /** 调度来源：cron / manual / backfill */
  trigger?: "cron" | "manual" | "backfill";
  /** 回溯范围（backfill 用） */
  range?: { from?: string; to?: string };
  /** 强制重建（忽略缓存） */
  force?: boolean;
  /** 取消信号（手动/超时） */
  signal?: AbortSignal;
  /** 失败自动重试次数（默认 0 不重试；幂等任务可设——快照/采集类；LLM 任务谨慎） */
  maxRetries?: number;
  /** 任务超时（毫秒；默认 0 = 不超时。调度任务建议设防挂死——如 60min；LLM 长任务谨慎） */
  timeoutMs?: number;
}

export interface TaskHandlerResult {
  ok: boolean;
  message?: string;
}

export type TaskHandler = (ctx: TaskRunOptions) => Promise<TaskHandlerResult>;

export interface TaskDef {
  id: string;
  type: string;
  name: string;
  /** cron 表达式；缺省 = 仅手动/回溯触发 */
  cron?: string;
  handler: TaskHandler;
}

export interface RegisteredTask {
  id: string;
  type: string;
  name: string;
  cron?: string;
  status: TaskStatus;
  lastRunAt?: number;
  lastResult?: string;
  nextRunAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskHistoryEntry {
  at: number;
  trigger: TaskRunOptions["trigger"];
  status: TaskStatus;
  message?: string;
  durationMs?: number;
}

const PREFIX = "dataInfra:task:";
const HIST_PREFIX = "dataInfra:taskHist:";
const HIST_LIMIT = 50;

const defs = new Map<string, TaskDef>();
const running = new Map<string, boolean>();

// 任务完成事件（供派生器等上层订阅；不反向依赖，保持 taskRegistry 纯净）
export type TaskFinishedListener = (id: string, status: TaskStatus, result: TaskHandlerResult) => void;
const finishedListeners = new Set<TaskFinishedListener>();
export function onTaskFinished(cb: TaskFinishedListener): void {
  finishedListeners.add(cb);
}
function emitFinished(id: string, status: TaskStatus, result: TaskHandlerResult): void {
  for (const cb of finishedListeners) {
    try { cb(id, status, result); } catch { /* 监听器异常不影响任务状态机 */ }
  }
}

function readTask(id: string): RegisteredTask | null {
  return kvGet<RegisteredTask>(PREFIX + id);
}

function writeTask(t: RegisteredTask): void {
  kvSet(PREFIX + t.id, t);
}

function pushHistory(id: string, entry: TaskHistoryEntry): void {
  const key = HIST_PREFIX + id;
  const cur = kvGet<{ entries: TaskHistoryEntry[] }>(key)?.entries ?? [];
  cur.push(entry);
  if (cur.length > HIST_LIMIT) cur.splice(0, cur.length - HIST_LIMIT);
  kvSet(key, { entries: cur });
}

/** 注册任务定义（幂等：同 id 覆盖定义，保留已存在状态） */
export function registerTask(def: TaskDef): void {
  defs.set(def.id, def);
  const existing = readTask(def.id);
  if (!existing) {
    writeTask({
      id: def.id,
      type: def.type,
      name: def.name,
      cron: def.cron,
      status: "queued", // 默认可执行（手动/回溯/调度均可触发）；用户可主动 pause
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  } else {
    // 定义更新：同步 name/cron（保留状态与时间）
    existing.name = def.name;
    existing.cron = def.cron;
    existing.updatedAt = Date.now();
    writeTask(existing);
  }
}

/** 任务列表（运管） */
export function listTasks(): RegisteredTask[] {
  return kvListRaw(PREFIX).map((r) => kvGet<RegisteredTask>(r.key)).filter(Boolean) as RegisteredTask[];
}

/** 执行历史（运管） */
export function listTaskHistory(id: string): TaskHistoryEntry[] {
  return kvGet<{ entries: TaskHistoryEntry[] }>(HIST_PREFIX + id)?.entries ?? [];
}

/** 执行任务（手动/调度/回溯统一入口）。幂等：同一任务不并发（running 中直接返回） */
export async function runTask(id: string, opts: TaskRunOptions = {}): Promise<TaskHandlerResult> {
  const def = defs.get(id);
  const task = readTask(id);
  if (!def || !task) return { ok: false, message: "任务未注册" };
  if (task.status === "paused") return { ok: false, message: "任务已暂停" };
  if (running.get(id)) return { ok: false, message: "任务执行中（防并发）" };

  running.set(id, true);
  task.status = "running";
  task.updatedAt = Date.now();
  writeTask(task);
  const startedAt = Date.now();
  const maxRetries = opts.maxRetries ?? 0; // 失败自动重试（幂等任务可设；重试期间状态保持 running）
  try {
    for (let attempt = 0; ; attempt++) {
      let r: TaskHandlerResult;
      try {
        // 超时防护：handler 挂死（不响应 abort）时 race 超时，终态 failed（可靠性——DDIA 第 2 章容错）
        const timeoutMs = opts.timeoutMs ?? 0;
        if (timeoutMs > 0) {
          const timeoutErr = { ok: false as const, message: `任务超时（${Math.round(timeoutMs / 1000)}s）已终止` };
          r = await Promise.race([
            def.handler(opts),
            new Promise<typeof timeoutErr>((res) => setTimeout(() => res(timeoutErr), timeoutMs)),
          ]);
        } else {
          r = await def.handler(opts);
        }
      } catch (e) {
        r = { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
      if (r.ok) {
        task.status = "done";
        task.lastResult = r.message;
        task.lastRunAt = Date.now();
        task.updatedAt = Date.now();
        writeTask(task);
        pushHistory(id, { at: Date.now(), trigger: opts.trigger ?? "manual", status: "done", message: r.message, durationMs: Date.now() - startedAt });
        emitFinished(id, "done", r);
        return r;
      }
      // 失败：记录本次尝试；未达重试上限则继续（幂等前提，重放安全）
      task.lastResult = r.message;
      task.updatedAt = Date.now();
      writeTask(task);
      if (attempt < maxRetries) {
        pushHistory(id, { at: Date.now(), trigger: opts.trigger ?? "manual", status: "failed", message: `${r.message}（第 ${attempt + 1} 次尝试，自动重试）`, durationMs: Date.now() - startedAt });
        continue;
      }
      task.status = "failed";
      task.lastRunAt = Date.now();
      task.updatedAt = Date.now();
      writeTask(task);
      pushHistory(id, { at: Date.now(), trigger: opts.trigger ?? "manual", status: "failed", message: r.message, durationMs: Date.now() - startedAt });
      emitFinished(id, "failed", r);
      return r;
    }
  } finally {
    running.delete(id);
  }
}

/** 暂停/恢复/删除（运管） */
export function setTaskStatus(id: string, status: TaskStatus): boolean {
  const task = readTask(id);
  if (!task) return false;
  task.status = status;
  task.updatedAt = Date.now();
  writeTask(task);
  return true;
}

/** 登记外部托管任务（运行由 core/tasks 前台 SSE 管理；data-infra 仅记录生命周期，运管可见 + 历史归档）。
 *  id 建议用 module（固定）；多次登记覆盖状态（"最近一次"语义）。 */
export function registerExternalTask(def: { id: string; name: string }): void {
  registerTask({
    id: def.id,
    type: "external",
    name: def.name,
    handler: async () => ({ ok: true, message: "外部托管任务（core/tasks 前台 SSE 管理，data-infra 仅记录生命周期）" }),
  });
}

/** 外部任务生命周期同步（core/tasks 调）：状态 + lastResult + 历史归档 */
export function recordExternalRun(id: string, status: TaskStatus, result?: TaskHandlerResult): void {
  const task = readTask(id);
  if (!task) return;
  task.status = status;
  task.updatedAt = Date.now();
  if (result) task.lastResult = result.message ?? "ok";
  if (status === "done" || status === "failed") task.lastRunAt = Date.now();
  writeTask(task);
  if (status === "done" || status === "failed" || status === "paused") {
    pushHistory(id, { at: Date.now(), trigger: "manual", status, message: result?.message, durationMs: 0 });
  }
}

export function deleteTask(id: string): boolean {
  const existed = kvGet(PREFIX + id) != null;
  kvDelete(PREFIX + id);
  kvDelete(HIST_PREFIX + id);
  defs.delete(id);
  return existed;
}

/** 更新下次调度时间（调度层调用） */
export function setTaskNextRun(id: string, nextRunAt?: number): void {
  const task = readTask(id);
  if (!task) return;
  task.nextRunAt = nextRunAt;
  task.updatedAt = Date.now();
  writeTask(task);
}

/** 生成新任务 id（供业务注册唯一任务） */
export function newTaskId(prefix: string): string {
  return prefix + "-" + randomUUID().slice(0, 8);
}
