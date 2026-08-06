// ============================================================
// 公共模块：Reasonix MCP 配置（存储于「本地设置数据」settings:mcp.servers）
// - 默认 seed 内置知识库 MCP（kb：stdio，直读写 SQLite KV）
// - 幂等：用户编辑过则尊重用户配置（绝不覆盖）
// - 页面可增删/启停 MCP server（Agent 会话管理 → MCP 配置）
// ============================================================
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getSetting, setSetting } from "./settingsStore.js";

export interface McpServerConfig {
  name: string;
  /** HTTP 用 url；stdio 用 command/args/env */
  url?: string;
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** 是否启用（reasonix 会话挂载时过滤） */
  enabled: boolean;
}

const SETTING_KEY = "mcp.servers";

const require_ = createRequire(import.meta.url);
/** tsx CLI（支持 .ts 直跑；./cli 为 exports 入口） */
const TSX_CLI = require_.resolve("tsx/cli");
/** 知识库 MCP 脚本（正斜杠路径：Windows 反斜杠会被 Node ESM loader 误判为 d: 协议；file:// URL 又会被 tsx 拼接错乱） */
const KB_MCP_SCRIPT = fileURLToPath(new URL("./knowledgeMcp.ts", import.meta.url)).replace(/\\/g, "/");

/** 默认 MCP 配置（仅内置知识库 MCP；新增业务 MCP 后续在此扩展或由页面配置） */
function defaultMcpServers(): McpServerConfig[] {
  return [
    {
      name: "kb",
      command: process.execPath,
      args: [TSX_CLI, KB_MCP_SCRIPT],
      env: { PATH: process.env.PATH ?? "" },
      enabled: true,
      transport: "stdio",
    },
  ];
}

/** 读取 MCP 配置（无配置时返回默认 seed；不落库，幂等） */
export function getMcpServers(): McpServerConfig[] {
  const raw = getSetting<McpServerConfig[]>(SETTING_KEY);
  if (!Array.isArray(raw) || raw.length === 0) return defaultMcpServers();
  // 兼容旧结构（缺 enabled 视为启用）
  return raw.map((s) => ({ ...s, enabled: s.enabled !== false }));
}

/** 保存 MCP 配置（整表覆盖；本地数据管理可见 settings:mcp.servers） */
export function setMcpServers(servers: McpServerConfig[]): McpServerConfig[] {
  const clean = servers.map((s) => ({
    name: s.name?.trim(),
    ...(s.url ? { url: s.url } : {}),
    ...(s.transport ? { transport: s.transport } : {}),
    ...(s.command ? { command: s.command } : {}),
    ...(Array.isArray(s.args) ? { args: s.args } : {}),
    ...(s.env && Object.keys(s.env).length > 0 ? { env: s.env } : {}),
    enabled: s.enabled !== false,
  }));
  const valid = clean.filter((s) => typeof s.name === "string" && s.name.length > 0) as McpServerConfig[];
  setSetting(SETTING_KEY, valid);
  return valid;
}

/** 启用的 MCP 列表（reasonix 会话挂载用；name 去重保序） */
export function enabledMcpServers(): McpServerConfig[] {
  const seen = new Set<string>();
  return getMcpServers().filter((s) => s.enabled && s.name && !seen.has(s.name) && seen.add(s.name));
}
