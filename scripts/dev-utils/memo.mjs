// ============================================================
// 开发辅助脚本：改进备忘录 CLI（scripts/dev-utils/memo.mjs）
// 反复需求固化：每轮「处理备忘录」都要读 open 列表、批量标记 done。
// 用法（node scripts/dev-utils/memo.mjs ...）：
//   list                列出全部（默认只看非 done，仅标题；--full 看全文）
//   list --all          列出全部含 done
//   done <id> [id...]   批量标记 done
//   add <text>          新增一条（kind 默认 fix）
//   stats               统计 open/doing/done + 未完成按页面分组（开工快速感知负载）
//   recent [N]          最近 N 条已处理（默认 5，了解进度）
//   bypage <关键词>     按页面关键词过滤未完成（聚焦某页面 memo）
// 示例：
//   node scripts/dev-utils/memo.mjs list
//   node scripts/dev-utils/memo.mjs done abc123 def456
//   node scripts/dev-utils/memo.mjs stats
//   node scripts/dev-utils/memo.mjs bypage 策略仓位管理
// ============================================================
import { call } from "./api.mjs";

const [cmd, ...rest] = process.argv.slice(2);

// cmd 下 `;` 不是命令分隔符，会原样粘进参数（如 `done id1; node x.mjs list` → 参数 "id1;"）。
// 防御：剥离分号后缀 + 只接受形如 memo id 的参数，其余跳过并警告（防止粘连参数误当 id）。
const STRIP_SEMI = (a) => (a.includes(";") ? (console.warn(`⚠️ 参数 "${a}" 含分号（cmd 下 ; 会粘进参数），已剥离为 "${a.split(";")[0]}"`), a.split(";")[0]) : a);
const ID_RE = /^[a-z0-9]{6,}-[a-z0-9]+$/i;

async function list(showAll, full) {
  const { data } = await call("/tools/memo");
  const items = (data.items ?? []).filter((i) => showAll || i.status !== "done");
  console.log(`${showAll ? "全部" : "open"}: ${items.length} 条${full ? "" : "（默认仅标题，--full 看全文，降本）"}`);
  for (const it of items) {
    const text = full ? it.text : it.text.split("\n")[0].slice(0, 80);
    console.log(`[${it.status}][${it.kind}] ${it.id} | ${text}`);
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

// 统计：open/doing/done 数量 + 未完成按页面分组（Agent 开工快速感知工作负载）
async function stats() {
  const { data } = await call("/tools/memo");
  const items = data.items ?? [];
  const by = { open: 0, doing: 0, done: 0 };
  const pages = new Map();
  for (const it of items) {
    if (it.status === "done") by.done++;
    else if (it.status === "doing") by.doing++;
    else by.open++;
    if (it.status !== "done") {
      const m = it.text.match(/^\[([^\]]+)\]/);
      const page = m ? m[1] : "（无页面标签）";
      pages.set(page, (pages.get(page) ?? 0) + 1);
    }
  }
  console.log(`memo 统计：open ${by.open} · doing ${by.doing} · done ${by.done}（共 ${items.length} 条）`);
  if (pages.size > 0) {
    console.log("未完成按页面分组：");
    for (const [p, n] of [...pages.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${p}: ${n} 条`);
  }
}

// 最近 N 条已处理（了解进度，默认 5）
async function recent(n) {
  const { data } = await call("/tools/memo");
  const doneItems = (data.items ?? []).filter((i) => i.status === "done").slice(0, n);
  console.log(`最近 done ${doneItems.length} 条:`);
  for (const it of doneItems) console.log(` * [${it.kind}] ${it.id} | ${it.text.split("\n")[0].slice(0, 80)}`);
}

// 按页面关键词过滤未完成（聚焦某页面 memo）
async function bypage(keyword) {
  const { data } = await call("/tools/memo");
  const items = (data.items ?? []).filter((i) => i.status !== "done" && i.text.includes(keyword));
  console.log(`页面含「${keyword}」未完成: ${items.length} 条`);
  for (const it of items) console.log(`[${it.status}][${it.kind}] ${it.id} | ${it.text.split("\n")[0]}`);
}

function putMemo(id, body) {
  return call("/tools/memo/" + id, "PUT", body);
}

if (cmd === "list") list(rest.includes("--all"), rest.includes("--full"));
else if (cmd === "done") done(rest);
else if (cmd === "add") add(rest.join(" "));
else if (cmd === "stats") stats();
else if (cmd === "recent") recent(parseInt(rest[0] ?? "5", 10) || 5);
else if (cmd === "bypage") bypage(rest.join(" "));
else {
  console.log("用法: node scripts/dev-utils/memo.mjs {list [--all] | done <id>... | add <text> | stats | recent [N] | bypage <关键词>}");
  process.exit(1);
}
