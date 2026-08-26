// ============================================================
// 数据工程基础设施（core/data-infra）——消息驱动工作流引擎统一出口
// 生命周期分层：
//   数据层（Data）     ：kvStore/tableStore（本项目统一 node:sqlite 存储）
//   消息层（Message）  ：queue.ts（轻量队列：至少一次投递 + 幂等消费）
//   任务层（Task）     ：taskRegistry.ts（注册表 + 生命周期状态机 + 执行历史）
//   调度层（Scheduler）：scheduler.ts（cron-parser + 自研调度循环 + missed 补跑）
//   派生层（Derivator）：derivator.ts（源事件 → 衍生消息：任务完成钩子 / 定时检查 / 手动）
//   执行层（Consumer） ：consumer.ts（消息 → FaaS：持续消费 + 失败重投 + 并发控制）
// 三原则：可观测（listTasks/derivators/consumers/queueStats）
//       · 可回溯（backfill 幂等重跑）· 幂等（handler/derive 重放安全）
// 组合工作流："调度器-任务-消息-FaaS" 与 "数据-任务-衍生数据-消息-FaaS"
// ============================================================
export * from "./queue.js";
export * from "./taskRegistry.js";
export * from "./scheduler.js";
export * from "./derivator.js";
export * from "./consumer.js";
export * from "./taskResult.js";

import { registerDataSource } from "../dataRegistry.js";
import { startConsumers, stopConsumers } from "./consumer.js";
import { derivatorIds, getDerivator, triggerDerivator } from "./derivator.js";
import { registerScheduledTask, startScheduler, stopScheduler } from "./scheduler.js";
import { kvDelete, kvListRaw } from "../kvStore.js";
import { PROG_PREFIX } from "./taskRegistry.js";

/** 装配数据源注册（本地数据管理可见） */
export function initDataInfra(): void {
  registerDataSource({
    kind: "kv",
    name: "dataInfra",
    page: "数据基础设施",
    tag: "运行状态",
    description: "消息队列（dataInfra:q:）、消费审计（dataInfra:qAudit:）、任务注册表（dataInfra:task:）、任务历史（dataInfra:taskHist:）、派生器运行记录（dataInfra:derivator:）",
  });
  // 启动清理：孤儿进度快照（进程被杀/崩溃残留——启动后无 running 任务，全部进度快照均为孤儿）
  for (const r of kvListRaw(PROG_PREFIX)) kvDelete(r.key);
  // 派生器自身 cron 统一注册为调度任务（调度层只认任务；handler 触发派生器）——
  // 从而自动获得 missed 补跑 / 运管可见 / 执行历史
  for (const id of derivatorIds()) {
    const def = getDerivator(id);
    if (def?.when.cron) {
      registerScheduledTask({
        id,
        type: "derivator",
        name: `派生器 ${def.id}（定时检查）`,
        cron: def.when.cron,
        handler: async () => {
          await triggerDerivator(id);
          return { ok: true, message: "派生器已触发" };
        },
      });
    }
  }
}

/** 启动消费循环（服务装配时调用；与调度器同生命周期） */
export function startDataInfraRuntime(): void {
  startScheduler();
  startConsumers();
  process.once("exit", () => {
    stopScheduler();
    stopConsumers();
  });
}
