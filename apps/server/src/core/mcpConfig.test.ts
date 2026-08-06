// ============================================================
// core/mcpConfig 单测：seed / 保存 / 空数组清空 / 损坏回退 / enabled 过滤
// 纯设置读写（settings:mcp.servers），不触网不 spawn
// ============================================================
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getMcpServers, setMcpServers, enabledMcpServers, type McpServerConfig } from "./mcpConfig.js";
import { deleteSetting, setSetting } from "./settingsStore.js";

const KEY = "mcp.servers";

beforeEach(() => {
  deleteSetting(KEY);
});

afterEach(() => {
  deleteSetting(KEY);
});

test("从未配置：返回默认 seed（含 kb 知识库 MCP）", () => {
  const s = getMcpServers();
  assert.ok(s.length > 0);
  assert.ok(s.some((x) => x.name === "kb" && x.enabled));
});

test("保存后读取：尊重用户配置（含空数组=清空 MCP）", () => {
  const saved = setMcpServers([{ name: "custom", command: "node", args: ["a"], enabled: true }]);
  assert.equal(saved.length, 1);
  assert.equal(getMcpServers()[0].name, "custom");
  // 清空：空数组保持（不再回退 seed）
  setMcpServers([]);
  assert.deepEqual(getMcpServers(), []);
});

test("数据损坏：回退默认 seed 不崩", () => {
  setSetting("mcp.servers", "not-array" as unknown as McpServerConfig[]); // 模拟 KV 损坏（非数组）
  const s = getMcpServers();
  assert.ok(s.some((x) => x.name === "kb"));
});

test("enabledMcpServers：过滤停用项 + name 去重保序", () => {
  setMcpServers([
    { name: "a", command: "x", enabled: true },
    { name: "b", command: "y", enabled: false },
    { name: "a", command: "dup", enabled: true },
  ]);
  const e = enabledMcpServers();
  assert.deepEqual(e.map((x) => x.name), ["a"]);
});
