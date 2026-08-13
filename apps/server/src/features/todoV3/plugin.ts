// ============================================================
// 待办清单 v3：Cordis 插件（挂载三个服务到 Context）
// 参照教程 01/02：插件是函数/对象，ctx.plugin() 挂载；服务注册属于 effect，
// 卸载（fiber.dispose）时自动移除——热替换/重新加载无需手动清理
// ============================================================
import type { Context } from "@deepseek-ai/cordis";
import { TodoStoreService, TodoSchedulerService, TodoResolverService } from "./services.js";

export const name = "todo-v3";

export function apply(ctx: Context) {
  // 挂载顺序决定服务注册顺序（Cordis 按依赖而非文件顺序决定启动）
  // npm 4.0.1 签名 plugin(plugin, config)——文档示例（vendor 版本）只需 1 参；服务类挂载用 as any 兼容
  ctx.plugin(TodoStoreService as any);
  ctx.plugin(TodoSchedulerService as any);
  ctx.plugin(TodoResolverService as any);
}
