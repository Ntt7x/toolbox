// ============================================================
// 配置库（scripts/dev-utils/config.mjs）—— 脚本侧取配置的唯一入口
// ------------------------------------------------------------
// 实现在 packages/shared/config.mjs（与服务端共用同一份默认值与校验规则，
// 杜绝「服务端一份、脚本一份」的配置漂移）。本文件只做两件事：
//   1. 固定仓库根（ROOT）传给内核
//   2. 转发导出，脚本一律 `import { loadConfig } from "./config.mjs"`
//
// 为什么不直接 import "@toolbox/shared/config.js"：仓库根 node_modules 里没有
// @toolbox/shared（只有 apps/* 下有 workspace 链接），脚本是纯 node 运行、
// 走不了 TS 解析 → 用相对路径引内核的纯 JS 实现。
// ============================================================
import { ROOT } from "./_lib.mjs";
import {
  loadConfig as loadShared,
  DEFAULT_CONFIG,
  CONFIG_FILE_NAME,
  LOCAL_CONFIG_FILE_NAME,
} from "../../packages/shared/config.mjs";

export { DEFAULT_CONFIG, CONFIG_FILE_NAME, LOCAL_CONFIG_FILE_NAME };

/**
 * 加载配置（每次调用重新读取——脚本都是短命进程，成本可忽略，
 * 且能吃到 dev.mjs 在 import 之后回填的环境变量）。
 */
export function loadConfig(opts = {}) {
  return loadShared({ root: ROOT, ...opts });
}
