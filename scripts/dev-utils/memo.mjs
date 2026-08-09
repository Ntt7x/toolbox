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

// cmd 下 `;` 不是命令分隔符，会原样粘进参数（如 `done id1; node x.mjs list` → 参数 "id1;"）。
// 防御：剥离分号后缀 + 只接受形如 memo id 的参数，其余跳过并警告（防止粘连参数误当 id）。
const STRIP_SEMI = (a) => (a.includes(";") ? (console.warn(`⚠️ 参数 "${a}" 含分号（cmd 下 ; 会粘进参数），已剥离为 "${a.split(";")[0]}"`), a.split(";")[0]) : a);
const ID_RE = /^[a-z0-9]{6,}-[a-z0-9]+$/i;

async function list(showAll) {
  const { data } = await call("/tools/memo");
  const items = (data.items ?? []).filter((i) => showAll || i.status !== "done");
  console.log(`${showAll ? "全部" : "open"}: ${items.length} 条`);
  for (const it of items) {
    console.log(`[${it.status}][${it.kind}] ${it.id} | ${it.text}`);
  }
}

async function done(ids) {
  const valid = ids.map(STRIP_SEMI).filter((id) => ID_RE.test(id));
  const skipped = ids.map(STRIP_SEMI).filter((id) => !ID_RE.test(id));
  if (skipped.length > 0) console.warn(`⚠️ 忽略非 memo ID 参数（cmd 分号粘连或误传）：${skipped.join(" ")}`);
  for (const id of valid) {
    try {
      const { status } = await putMemo(id, { status: "done" });
      console.log(`${id} → ${status}`);
    } catch (e) {
      console.log(`${id} → ❌ ${e.message}`);
    }
  }
  if (valid.length === 0) console.log("没有可标记的 memo ID");
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
