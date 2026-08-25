// ============================================================
// 下层公共模块：调度器（数据工程-调度层）
// 只回答"何时"：cron-parser 解析 → setTimeout 到下一触发点 → 分发 runTask
// 生命周期：register（cron 定义）→ fire（触发）→ dispatch（分发）→ stop（优雅退出）
// 持久化：nextRunAt 存任务注册表（KV）；服务重启时 missed 检测补跑
// ============================================================
import { CronExpressionParser } from "cron-parser";
import { listTasks, registerTask, runTask, setTaskNextRun } from "./taskRegistry.js";

const timers = new Map<string, NodeJS.Timeout>();
const MS = 1000;

function nextFromCron(cron: string, after = new Date()): Date | null {
  try {
    const it = CronExpressionParser.parse(cron, { currentDate: after });
    return it.next().toDate();
  } catch {
    return null;
  }
}

/** 触发任务并排下次（回调里跑完再排下次，避免重叠） */
function fire(id: string, cron: string): void {
  const runAt = Date.now();
  void runTask(id, { trigger: "cron" }).then(() => {
    // 排下一次（从触发时间起算，missed 由下次启动/周期覆盖）
    const next = nextFromCron(cron, new Date(runAt));
    setTaskNextRun(id, next ? next.getTime() : undefined);
    if (next) {
      const delay = Math.max(0, next.getTime() - Date.now());
      const t = setTimeout(() => fire(id, cron), delay);
      timers.set(id, t);
    }
  });
}

/**
 * 启动调度：扫描已注册的 cron 任务，计算下次触发并挂定时器。
 * missed 检测：nextRunAt 已过期（服务停机期间错过）→ 补跑一次再排下次。
 */
export function startScheduler(): void {
  for (const task of listTasks()) {
    if (!task.cron || task.status === "paused") continue;
    // 防重复定时器：registerScheduledTask/scheduleTask 可能已设过（模块顶层注册先于 startScheduler）
    const existing = timers.get(task.id);
    if (existing) clearTimeout(existing);
    const now = Date.now();
    const missed = typeof task.nextRunAt === "number" && task.nextRunAt <= now;
    if (missed) {
      // 停机错过 → 立即补跑一次（幂等，安全）
      void runTask(task.id, { trigger: "cron" }).then(() => {
        const next = nextFromCron(task.cron!, new Date(now));
        setTaskNextRun(task.id, next ? next.getTime() : undefined);
        if (next) {
          const t = setTimeout(() => fire(task.id, task.cron!), Math.max(0, next.getTime() - Date.now()));
          timers.set(task.id, t);
        }
      });
      continue;
    }
    const next = nextFromCron(task.cron);
    setTaskNextRun(task.id, next ? next.getTime() : undefined);
    if (next) {
      const t = setTimeout(() => fire(task.id, task.cron!), Math.max(0, next.getTime() - Date.now()));
      timers.set(task.id, t);
    }
  }
}

/** 调度单个任务（注册后调用：立即计算下次） */
export function scheduleTask(id: string): void {
  const task = listTasks().find((t) => t.id === id);
  if (!task || !task.cron || task.status === "paused") return;
  const existing = timers.get(id);
  if (existing) clearTimeout(existing);
  const next = nextFromCron(task.cron);
  setTaskNextRun(id, next ? next.getTime() : undefined);
  if (next) {
    const t = setTimeout(() => fire(id, task.cron!), Math.max(0, next.getTime() - Date.now()));
    timers.set(id, t);
  }
}

/** 优雅退出：清全部定时器 */
export function stopScheduler(): void {
  for (const [, t] of timers) clearTimeout(t);
  timers.clear();
}

// 便捷：注册任务定义 + 立即调度（供业务一行接入）
export function registerScheduledTask(def: Parameters<typeof registerTask>[0]): void {
  registerTask(def);
  // 测试环境（app.integration 免端口装配）不挂定时器——否则模块顶层注册的任务定时器卡测试进程
  if (process.env.TOOLBOX_TEST !== "1") scheduleTask(def.id);
}
