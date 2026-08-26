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

export type TaskStatus = "queued" | "running" | "done" | "failed" | "paused" | "cancelled";

export interface TaskRunOptions {
  /** 调度来源：cron / manual / backfill */
  trigger?: "cron" | "manual" | "backfill";
  /** 回溯范围（backfill 用） */
  range?: { from?: string; to?: string };
  /** 强制重建（忽略缓存） */
  force?: boolean;
  /** 取消信号（手动/超时）——runTask 自动注入，handler 内传 LLM/IO */
  signal?: AbortSignal;
  /** 当前任务 id（runTask 自动注入；ephemeral/动态注册任务 handler 用它写业务结果） */
  taskId?: string;
  /** 进度上报（handler 调）：进度快照落 KV（dataInfra:taskProg:<id>），SSE/轮询可读 */
  progress?: (msg: string, detail?: unknown) => void;
  /** 失败自动重试次数（默认 0 不重试；幂等任务可设——快照/采集类；LLM 任务谨慎） */
  maxRetries?: number;
  /** 任务超时（毫秒；默认 0 = 不超时。调度任务建议设防挂死——如 60min；LLM 长任务谨慎） */
  timeoutMs?: number;
}

export interface TaskHandlerResult {
  ok: boolean;
  message?: string;
  /** 结构化结果（统一模式：分析任务把完整结果挂任务记录，前端 done 后经详情 API 读取） */
  result?: unknown;
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
  /** 一次性任务标记（ephemeral——终态后自动清定义；KV 记录受保留上限治理） */
  ephemeral?: boolean;
  lastRunAt?: number;
  lastResult?: string;
  /** 最近一次结构化结果（统一模式：分析结果挂任务记录，前端经详情 API 读取） */
  result?: unknown;
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
export const PROG_PREFIX = "dataInfra:taskProg:";
const HIST_LIMIT = 50;

const defs = new Map<string, TaskDef>();
const running = new Map<string, boolean>();
/** 一次性任务 id 集合（终态后自动清定义，KV 记录保留） */
const ephemeralDefs = new Set<string>();
/** 运行中的取消控制器（cancelTask → abort → handler 收到 signal） */
const runControllers = new Map<string, AbortController>();

/** 任务进度快照（SSE/轮询读） */
export interface TaskProgress {
  progress: string;
  detail?: unknown;
  updatedAt: number;
}
export function getTaskProgress(id: string): TaskProgress | null {
  return kvGet<TaskProgress>(PROG_PREFIX + id);
}

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

/** 注册任务定义（幂等：同 id 覆盖定义，保留已存在状态）。
 *  ephemeral：一次性任务（动态注册——分析请求每次新建 id）；终态后自动清定义（KV 记录/历史保留，运管可见） */
export function registerTask(def: TaskDef, opts?: { ephemeral?: boolean }): void {
  defs.set(def.id, def);
  if (opts?.ephemeral) {
    ephemeralDefs.add(def.id);
    trimEphemeral(); // 注册即治理（防连续运行永不触发 cleanupRun 裁剪）
  }
  const existing = readTask(def.id);
  if (!existing) {
    writeTask({
      id: def.id,
      type: def.type,
      name: def.name,
      cron: def.cron,
      status: "queued", // 默认可执行（手动/回溯/调度均可触发）；用户可主动 pause
      ephemeral: opts?.ephemeral === true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  } else {
    // 定义更新：同步 name/cron（保留状态与时间）
    existing.name = def.name;
    existing.cron = def.cron;
    if (opts?.ephemeral === true) existing.ephemeral = true;
    existing.updatedAt = Date.now();
    writeTask(existing);
  }
}

/** 任务列表（运管） */
export function listTasks(): RegisteredTask[] {
  return kvListRaw(PREFIX).map((r) => kvGet<RegisteredTask>(r.key)).filter(Boolean) as RegisteredTask[];
}

/** 单个任务详情（运管/前端轮询） */
export function getTask(id: string): RegisteredTask | null {
  return readTask(id);
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

  // 运行上下文：取消控制器 + 进度上报（handler 可用 opts.signal/opts.progress）
  const controller = new AbortController();
  const externalSignal = opts.signal;
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", () => controller.abort(), { once: true });
  runControllers.set(id, controller);
  const runOpts: TaskRunOptions = {
    ...opts,
    taskId: id,
    signal: controller.signal,
    progress: (msg: string, detail?: unknown) => {
      kvSet(PROG_PREFIX + id, { progress: msg, detail, updatedAt: Date.now() } satisfies TaskProgress);
    },
  };

  running.set(id, true);
  task.status = "running";
  task.updatedAt = Date.now();
  writeTask(task);
  const startedAt = Date.now();
  const maxRetries = opts.maxRetries ?? 0; // 失败自动重试（幂等任务可设；重试期间状态保持 running）
  try {
    for (let attempt = 0; ; attempt++) {
      if (controller.signal.aborted) {
        return finishCancelled(task, id, runOpts, startedAt, controller);
      }
      let r: TaskHandlerResult;
      try {
        // 超时防护：handler 挂死（不响应 abort）时 race 超时，终态 failed（可靠性——DDIA 第 2 章容错）
        const timeoutMs = opts.timeoutMs ?? 0;
        if (timeoutMs > 0) {
          const timeoutErr = { ok: false as const, message: `任务超时（${Math.round(timeoutMs / 1000)}s）已终止` };
          r = await Promise.race([
            def.handler(runOpts),
            new Promise<typeof timeoutErr>((res) => setTimeout(() => res(timeoutErr), timeoutMs)),
          ]);
        } else {
          r = await def.handler(runOpts);
        }
      } catch (e) {
        if (controller.signal.aborted) return finishCancelled(task, id, runOpts, startedAt, controller);
        r = { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
      if (controller.signal.aborted) {
        return finishCancelled(task, id, runOpts, startedAt, controller);
      }
      if (r.ok) {
        task.status = "done";
        task.lastResult = r.message;
        task.result = r.result;
        task.lastRunAt = Date.now();
        task.updatedAt = Date.now();
        writeTask(task);
        pushHistory(id, { at: Date.now(), trigger: opts.trigger ?? "manual", status: "done", message: r.message, durationMs: Date.now() - startedAt });
        emitFinished(id, "done", r);
        cleanupRun(id, controller);
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
      cleanupRun(id, controller);
      return r;
    }
  } finally {
    running.delete(id);
  }
}

function finishCancelled(task: RegisteredTask, id: string, opts: TaskRunOptions, startedAt: number, controller: AbortController): TaskHandlerResult {
  task.status = "cancelled";
  task.updatedAt = Date.now();
  writeTask(task);
  pushHistory(id, { at: Date.now(), trigger: opts.trigger ?? "manual", status: "cancelled", message: "已取消", durationMs: Date.now() - startedAt });
  const r: TaskHandlerResult = { ok: false, message: "已取消" };
  emitFinished(id, "cancelled", r);
  cleanupRun(id, controller);
  return r;
}

/** 一次性任务 KV 保留上限（防分析请求累积失控；超限清理最旧的终态记录） */
const EPHEMERAL_LIMIT = 100;

function trimEphemeral(): void {
  const all = kvListRaw(PREFIX)
    .map((r) => kvGet<RegisteredTask>(r.key))
    .filter((t): t is RegisteredTask => t?.ephemeral === true && (t.status === "done" || t.status === "failed" || t.status === "cancelled"));
  if (all.length <= EPHEMERAL_LIMIT) return;
  const excess = all.sort((a, b) => a.createdAt - b.createdAt).slice(0, all.length - EPHEMERAL_LIMIT);
  for (const t of excess) {
    kvDelete(PREFIX + t.id);
    kvDelete(HIST_PREFIX + t.id);
  }
}

function cleanupRun(id: string, controller: AbortController): void {
  kvDelete(PROG_PREFIX + id);
  runControllers.delete(id);
  controller.abort(); // 释放外部监听
  // 一次性任务：终态后清定义（KV 记录保留，运管可见）+ 触发保留上限治理
  if (ephemeralDefs.has(id)) {
    ephemeralDefs.delete(id);
    defs.delete(id);
  }
  if (ephemeralDefs.size === 0) trimEphemeral();
}

/** 取消执行中的任务（handler 收到 abort signal → 中断 LLM/IO）；非运行中返回 false */
export function cancelTask(id: string): boolean {
  const ctrl = runControllers.get(id);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

/** 异步启动任务（业务路由用——fire-and-forget，状态/结果经 KV 查询） */
export function startTask(id: string, opts: TaskRunOptions = {}): void {
  runTask(id, opts).catch(() => {
    // runTask 内部已 try-catch 兜底，此处仅防 writeTask 等 IO 异常
  });
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
