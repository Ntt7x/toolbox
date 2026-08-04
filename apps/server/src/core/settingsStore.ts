// ============================================================
// 下层公共模块：本地设置数据（Key-结构化 Value 的配置场景封装）
// 基于 kvStore，固定前缀 settings:，提供配置项 CRUD 与新增配置。
// 用法：
//   setSetting("llm.apiKey", "sk-xxx")       // 新增/更新配置
//   const k = getSetting<string>("llm.apiKey")
//   deleteSetting("llm.apiKey")
// 数据源注册后，本地数据管理页可见「本地设置数据」（tag）。
// ============================================================

import { registerDataSource, type DataSourceMeta } from "./dataRegistry.js";
import { kvDelete, kvGet, kvSet } from "./kvStore.js";

/** 固定前缀：settings: */
export const SETTINGS_PREFIX = "settings:";

function fullKey(key: string): string {
  if (!key || typeof key !== "string") throw new Error("设置 key 必须是字符串");
  return `${SETTINGS_PREFIX}${key}`;
}

/** 读取配置；不存在返回 null */
export function getSetting<T = unknown>(key: string): T | null {
  return kvGet<T>(fullKey(key));
}

/** 写入/新增配置（任意可 JSON 序列化值） */
export function setSetting<T = unknown>(key: string, value: T): void {
  kvSet(fullKey(key), value);
}

/** 删除配置 */
export function deleteSetting(key: string): void {
  kvDelete(fullKey(key));
}

// 注册数据源：本地数据管理页展示「本地设置数据」（页面 tag）
const settingSource: DataSourceMeta = {
  kind: "kv",
  name: SETTINGS_PREFIX,
  page: "本地设置",
  tag: "设置数据",
  description: "本地设置数据（Key-结构化 Value），配置项 CRUD",
};
registerDataSource(settingSource);
