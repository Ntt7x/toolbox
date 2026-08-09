// ============================================================
// 开发辅助脚本：改进备忘录 CLI（scripts/dev-utils/memo.mjs）
// 反复需求固化：每轮「处理备忘录」都要读 open 列表、批量标记 done。
// 用法（node scripts/dev-utils/memo.mjs ...）：
//   list                列出全部（默认只看非 done）
//   list --all          列出全部含 done
//   done <id> [id...]   批量标记 done
//   add <text>          新增一条（kind 默认 fix）
// 示例：
//   node scripts/dev-utils/memo.mjs list
//   node scripts/dev-utils/memo.mjs done abc123 def456
// ============================================================
import { call } from "./api.mjs";

const [cmd, ...rest] = process.argv.slice(2);

async function list(showAll) {
  const { data } = await call("/tools/memo");
  const items = (data.items ?? []).filter((i) => showAll || i.status !== "done");
  console.log(`${showAll ? "全部" : "open"}: ${items.length} 条`);
  for (const it of items) {
    console.log(`[${it.status}][${it.kind}] ${it.id} | ${it.text}`);
  }
}

async function done(ids) {
  for (const id of ids) {
    try {
      const { status } = await putMemo(id, { status: "done" });
      console.log(`${id} → ${status}`);
    } catch (e) {
      console.log(`${id} → ❌ ${e.message}`);
    }
  }
}

async function add(text) {
  const { data } = await call("/tools/memo", "POST", { text, kind: "fix" });
  console.log(`新增 ${data?.item?.id ?? "?"}: ${text}`);
}

function putMemo(id, body) {
  return call("/tools/memo/" + id, "PUT", body);
}

if (cmd === "list") list(rest.includes("--all"));
else if (cmd === "done") done(rest);
else if (cmd === "add") add(rest.join(" "));
else {
  console.log("用法: node scripts/dev-utils/memo.mjs {list [--all] | done <id>... | add <text>}");
  process.exit(1);
}
