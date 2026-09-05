// ============================================================
// Effect 运行时（core/effect/runtime）
// ------------------------------------------------------------
// 全进程**唯一**运行时：Effect 程序在这里落地为 Promise，供 Hono 路由 await。
// 为什么要有这层（而不是到处 Effect.runPromise）：
//   · ManagedRuntime 持有可复用资源（后续接 Layer 时无需改调用方）
//   · 统一把 Cause（缺陷/中断/失败）收敛成可抛的 EffectFailure，
//     路由层 catch 到的是普通 Error，错误信息走 describeError 的中文口径
// 何时不该用：纯函数/同步逻辑不要为了用而用 Effect，直接写函数即可。
// ============================================================

import { Cause, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { describeError } from "./errors.js";

/** 进程级运行时（当前无依赖服务；接入 Layer 时在此替换） */
export const runtime = ManagedRuntime.make(Layer.empty);

/**
 * Effect 失败抛出的普通 Error。
 * - `message`：中文可读文案（前端可直接展示）
 * - `failure`：原始类型化错误（需要按 _tag 分支时用）
 * - `cause` ：完整 Cause（中断/缺陷排查用）
 */
export class EffectFailure extends Error {
  readonly failure: unknown;
  readonly cause: Cause.Cause<unknown>;

  constructor(failure: unknown, cause: Cause.Cause<unknown>) {
    super(describeError(failure));
    this.name = "EffectFailure";
    this.failure = failure;
    this.cause = cause;
  }
}

/**
 * 执行 Effect 并返回 Promise；失败时抛 EffectFailure。
 * 用法：`const rows = await runEffect(loadRows(items));`
 */
export async function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await runtime.runPromiseExit(effect);
  if (Exit.isFailure(exit)) {
    const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
    throw new EffectFailure(failure, exit.cause);
  }
  return exit.value;
}

/**
 * 执行 Effect 并把结果收敛成「值 or 中文错误串」——用于**允许降级**的旁路取数
 * （如列表页补名称：失败不阻塞主流程，只记一条 caveat）。
 */
export async function runEffectOrMessage<A, E>(effect: Effect.Effect<A, E>): Promise<{ ok: true; value: A } | { ok: false; message: string }> {
  const exit = await runtime.runPromiseExit(effect);
  if (Exit.isFailure(exit)) {
    const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
    return { ok: false, message: describeError(failure) };
  }
  return { ok: true, value: exit.value };
}

/**
 * 外部任务信号 → Effect 中断。
 * 数据工程任务（core/data-infra）给的是 AbortSignal，Effect 侧是 Fiber 中断，
 * 两者在这里桥接：信号触发时中断 Effect，资源随 Fiber 释放（不再留悬空请求）。
 */
export function interruptOn(signal?: AbortSignal): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    if (!signal) return effect;
    // 永不成功、仅在 signal 触发时中断的 Effect（类型 never 保证不污染原结果类型）
    const abort: Effect.Effect<never, never> = Effect.async<never, never>((resume) => {
      if (signal.aborted) {
        resume(Effect.interrupt);
        return Effect.void;
      }
      const onAbort = (): void => resume(Effect.interrupt);
      signal.addEventListener("abort", onAbort, { once: true });
      return Effect.sync(() => signal.removeEventListener("abort", onAbort));
    });
    return Effect.raceFirst(effect, abort);
  };
}
