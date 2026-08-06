// ============================================================
// 公共模块：知识库 MCP Server（stdio transport）
// 由 Reasonix ACP 会话挂载（session/new 的 mcpServers），
// Agent 经 mcp__kb__* 工具直接读写知识库 SQLite KV（无文件视图）。
//
// 工具清单：
//   kb_list(instance, q?, limit?)      — 列出条目（key/value/source/updatedAt）
//   kb_get(key)                        — 单条详情
//   kb_search(question, instance?)     — 检索（拆词/2-gram，限定实例前缀）→ 知识文本
//   kb_set(key, value, source?)        — 写入（实例配额校验）
//   kb_delete(key)                     — 删除
//   kb_count(instance?)                — 条目数统计
// ============================================================
import readline from "node:readline";
import { kbGet, kbSet, kbDelete, kbList, kbCount, kbCountInstance, assertValidKey, instanceNameOf } from "./knowledge.js";

/** MCP 工具 schema（Reasonix 自动发现 + Agent 按描述调用） */
const TOOLS = [
  {
    name: "kb_list",
    description: "列出知识库条目。instance 为实例名（如 medical），q 为关键词过滤（key/value 包含），limit 默认 100。返回 key/source/updatedAt 列表。",
    inputSchema: {
      type: "object",
      properties: {
        instance: { type: "string", description: "实例名（key 首段），如 medical" },
        q: { type: "string", description: "关键词过滤" },
        limit: { type: "number", description: "返回条数上限" },
      },
    },
  },
  {
    name: "kb_get",
    description: "按完整 key 获取知识条目（含 value 全文）。key 形如 medical.cold-treatment.fever。",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "kb_search",
    description: "知识检索：对问题拆词后匹配知识库条目（限定实例前缀），返回最相关条目的完整文本。用于知识问答前检索。",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "问题或关键词" },
        instance: { type: "string", description: "限定实例名（推荐，避免跨库串扰）" },
      },
      required: ["question"],
    },
  },
  {
    name: "kb_set",
    description: "写入/覆盖知识条目。key 必须分层点分隔（实例名.主题.子主题），value 为事实文本（简洁、完整、可独立理解）。source 可选标注来源（如分享链接）。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "完整 key，首段为实例名（如 medical.fever.treatment）" },
        value: { type: "string", description: "知识事实文本" },
        source: { type: "string", description: "来源标注" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "kb_delete",
    description: "按完整 key 删除知识条目。",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "kb_count",
    description: "统计知识库条目数（可限定实例）。",
    inputSchema: {
      type: "object",
      properties: { instance: { type: "string" } },
    },
  },
];

function reply(id: unknown, payload: { result?: unknown; error?: unknown }): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
}

/** 执行一个工具调用（与 transport 无关，便于单测） */
export function callTool(name: string, args: Record<string, unknown>): { content: { type: "text"; text: string }[]; isError: boolean } {
  try {
    switch (name) {
      case "kb_list": {
        const instance = String(args.instance ?? "").trim();
        const q = String(args.q ?? "").trim();
        const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500);
        const entries = kbList({ prefix: instance ? `${instance}.` : "", q: q || undefined, limit });
        const text = entries.map((e) => `- ${e.key}  [${e.source ?? "?"} ${new Date(e.updatedAt).toISOString().slice(0, 10)}]`).join("\n") || "（空）";
        return { content: [{ type: "text", text: `${entries.length} 条：\n${text}` }], isError: false };
      }
      case "kb_get": {
        const key = String(args.key ?? "");
        if (!key) return err("缺少 key");
        const e = kbGet(key);
        if (!e) return err(`条目不存在：${key}`);
        return { content: [{ type: "text", text: `key: ${e.key}\n来源: ${e.source ?? "?"}\n更新时间: ${new Date(e.updatedAt).toISOString()}\n内容:\n${e.value}` }], isError: false };
      }
      case "kb_search": {
        const question = String(args.question ?? "").trim();
        const instance = String(args.instance ?? "").trim();
        if (!question) return err("缺少 question");
        // 拆词 + 2-gram 检索（限定实例前缀）
        const tokens = new Set<string>();
        for (const t of question.split(/[\s,，。.;；:：、/\\()（）\-—_]+/)) {
          const clean = t.trim();
          if (clean.length >= 2) tokens.add(clean);
        }
        if (tokens.size < 2) {
          for (let i = 0; i < question.length - 1; i++) tokens.add(question.slice(i, i + 2));
        }
        const prefix = instance ? `${instance}.` : "";
        const all = kbList({ prefix, limit: 2000 });
        const scored = all
          .map((e) => {
            const hay = `${e.key} ${e.value}`;
            let score = 0;
            for (const t of tokens) if (hay.includes(t)) score += t.length;
            return { e, score };
          })
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 8);
        if (scored.length === 0) return { content: [{ type: "text", text: "（知识库无匹配条目）" }], isError: false };
        const text = scored.map(({ e }) => `【${e.key}】\n${e.value}`).join("\n\n---\n\n");
        return { content: [{ type: "text", text: text }], isError: false };
      }
      case "kb_set": {
        const key = String(args.key ?? "");
        const value = String(args.value ?? "");
        if (!key || !value) return err("缺少 key/value");
        assertValidKey(key);
        const e = kbSet(key, value, args.source ? String(args.source) : undefined);
        return { content: [{ type: "text", text: `已写入 ${e.key}（实例 ${instanceNameOf(key)}；共 ${kbCountInstance(instanceNameOf(key))} 条）` }], isError: false };
      }
      case "kb_delete": {
        const key = String(args.key ?? "");
        if (!key) return err("缺少 key");
        const ok = kbDelete(key);
        return { content: [{ type: "text", text: ok ? `已删除 ${key}` : `条目不存在：${key}` }], isError: false };
      }
      case "kb_count": {
        const instance = String(args.instance ?? "").trim();
        const n = instance ? kbCountInstance(instance) : kbCount();
        return { content: [{ type: "text", text: `知识库共 ${n} 条${instance ? `（实例 ${instance}）` : ""}` }], isError: false };
      }
      default:
        return err(`未知工具 ${name}`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

function err(message: string): { content: { type: "text"; text: string }[]; isError: boolean } {
  return { content: [{ type: "text", text: `错误：${message}` }], isError: true };
}

// ---- stdio transport（作为子进程被 Reasonix spawn；import 时不启动，避免测试进程挂起） ----
if (import.meta.main) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === "initialize") {
      reply(msg.id, {
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "toolbox-knowledge-mcp", version: "1.0.0" },
        },
      });
    } else if (msg.method === "notifications/initialized") {
      // 通知：无响应
    } else if (msg.method === "tools/list") {
      reply(msg.id, { result: { tools: TOOLS } });
    } else if (msg.method === "tools/call") {
      const name = msg.params?.name as string;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const out = callTool(name, args);
      if (out.isError) {
        reply(msg.id, { error: { code: -32603, message: out.content[0].text } });
      } else {
        reply(msg.id, { result: out });
      }
    } else if (msg.method === "ping") {
      reply(msg.id, { result: {} });
    }
  });
}
