// ============================================================
// 服务端配置入口（apps/server/src/core/config.ts）
// ------------------------------------------------------------
// 单一来源：packages/shared/config.mjs（与 scripts/dev-utils 共用同一实现与默认值，
// 避免「服务端一份默认值、脚本一份」的配置漂移）。
//
// 规则：**业务代码一律从本模块取配置，禁止直接读 process.env.***
// （散落的 process.env 等于隐性配置，既不可见也不可治理）。
//
// 加载时机：模块首次 import 时读一次并校验（配置写错**启动即失败**，不静默降级）；
// 改动配置文件需重启服务（开发时 tsx watch 会自动重启）。
// ============================================================
import { loadConfig, type ResolvedConfig } from "@toolbox/shared/config.js";

/** 进程级配置（只读；结构化字段见 ResolvedConfig） */
export const config: ResolvedConfig = loadConfig();

export default config;
