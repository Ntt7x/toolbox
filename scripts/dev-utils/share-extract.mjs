// 分享链接对话提取 CLI（memo msvpddmz 固化为脚本）
// 用法：
//   node --import ./scripts/dev-utils/ts-resolve-hook.mjs scripts/dev-utils/share-extract.mjs <url|id> [--json]
// 输出：默认 markdown 渲染；--json 输出原始消息结构。退出码 0=成功 1=失败。
import { parseShareId, extractShare } from "../../apps/server/src/core/deepseekShare.ts";

function renderMarkdown(msgs) {
  const out = ["# 对话提取", `> 消息数：${msgs.length}`, ""];
  for (const m of msgs) {
    const role = m.role === "user" ? "🧑 用户" : "🤖 助手";
    out.push(`## ${role}`);
    if (m.thinking) out.push(`<details><summary>🧠 思考过程</summary>\n\n${m.thinking}\n\n</details>`, "");
    out.push(m.content ?? "", "");
  }
  return out.join("\n");
}

const argv = process.argv.slice(2);
const flagIdx = argv.indexOf("--json");
const asJson = flagIdx >= 0;
if (flagIdx >= 0) argv.splice(flagIdx, 1);
const raw = argv[0];
if (!raw) {
  console.error("用法: share-extract <url|shareId> [--json]");
  process.exit(1);
}

const id = parseShareId(raw);
if (!id) {
  console.error(`❌ 无法从输入识别 share id: ${raw}`);
  process.exit(1);
}

const r = await extractShare(id);
if (!r.ok || !Array.isArray(r.messages)) {
  console.error(`❌ 提取失败: ${r.error ?? "未知错误"} (id=${id})`);
  process.exit(1);
}
if (asJson) {
  console.log(JSON.stringify({ id, ok: true, messages: r.messages }, null, 2));
} else {
  console.log(renderMarkdown(r.messages));
}
// 自然退出（避免 process.exit 与未闭合 fetch 连接的 libuv 断言冲突）
