// ============================================================
// 知乎爬虫（小工具）：授权登录（浏览器内/Cookie）后以人类频率抓取
// 某用户的时间降序创作内容（回答/文章/想法），转 markdown；
// 支持：作者参与讨论的评论抓取、历史结果持久化、导入知识库
// ============================================================
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAsyncTask } from "../hooks/useAsyncTask";
import type { ZhihuCrawlItem, ZhihuCrawlKind, ZhihuCrawlRequest, ZhihuComment, ZhihuUserInfo } from "@toolbox/shared";
import { card, PageHeader } from "../ui";

const KIND_LABEL: Record<ZhihuCrawlKind, string> = { answer: "回答", article: "文章", pin: "想法" };

/** 评论树渲染（作者参与的讨论，带回复上下文） */
function CommentTree({ comments, indent = 0 }: { comments: ZhihuComment[]; indent?: number }) {
  return (
    <div style={{ marginLeft: indent > 0 ? "1.2rem" : 0, borderLeft: indent > 0 ? "2px solid #e2e8f0" : "none", paddingLeft: indent > 0 ? "0.6rem" : 0 }}>
      {comments.map((cm) => (
        <div key={cm.id} style={{ padding: "0.3rem 0" }}>
          <span style={{ fontSize: "0.78rem", color: "#475569" }}>
            <b>{cm.author}</b>
            {cm.replyTo ? <span style={{ color: "#94a3b8" }}> 回复 {cm.replyTo}</span> : null}
            <span style={{ color: "#94a3b8", marginLeft: "0.5rem", fontSize: "0.7rem" }}>{cm.createdAt.slice(0, 10)}</span>
          </span>
          <div style={{ fontSize: "0.8rem", color: "#334155", marginTop: "0.15rem", whiteSpace: "pre-wrap" }}>{cm.content}</div>
          {cm.children && cm.children.length > 0 && <CommentTree comments={cm.children} indent={indent + 1} />}
        </div>
      ))}
    </div>
  );
}

/** 结果条目列表（可复用于当前结果 / 历史结果查看） */
function ResultItems({
  items,
  selectable,
  selected,
  onToggle,
}: {
  items: ZhihuCrawlItem[];
  selectable?: boolean;
  selected?: Set<number>;
  onToggle?: (i: number) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
      {items.map((it, i) => (
        <details key={i} style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: "0.6rem 0.9rem", background: "#fafbfc" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.88rem", fontWeight: 600, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            {selectable && onToggle && (
              <input type="checkbox" checked={selected?.has(i) ?? false} onClick={(e) => e.stopPropagation()} onChange={() => onToggle(i)} />
            )}
            <span style={{ color: "#3b82f6" }}>[{KIND_LABEL[it.kind]}]</span>
            <span>{it.title}</span>
            <span style={{ color: "#94a3b8", fontWeight: 400, fontSize: "0.75rem", marginLeft: "auto", whiteSpace: "nowrap" }}>
              {it.createdAt.slice(0, 10)}
              {it.voteupCount !== undefined ? ` · ${it.voteupCount} 赞` : ""}
              {it.comments?.length ? ` · ${it.comments.length} 条作者讨论` : ""}
            </span>
          </summary>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "0.8rem", lineHeight: 1.7, margin: "0.6rem 0 0.2rem", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.7rem 0.9rem" }}>
            {it.content || "（无文字内容）"}
          </pre>
          {it.comments && it.comments.length > 0 && (
            <div style={{ marginTop: "0.5rem", background: "#f1f5f9", borderRadius: 8, padding: "0.5rem 0.8rem" }}>
              <div style={{ fontSize: "0.75rem", fontWeight: 700, color: "#475569", marginBottom: "0.2rem" }}>💬 作者参与的评论（含上下文）</div>
              <CommentTree comments={it.comments} />
            </div>
          )}
          <a href={it.url} target="_blank" rel="noreferrer" style={{ fontSize: "0.75rem", color: "#3b82f6", display: "inline-block", marginTop: "0.4rem" }}>
            查看原文 ↗
          </a>
        </details>
      ))}
    </div>
  );
}

export default function ZhihuCrawlerTool() {
  const [cookie, setCookie] = useState("");
  const [cookieOk, setCookieOk] = useState(false);
  const [authMsg, setAuthMsg] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [target, setTarget] = useState("");
  const [user, setUser] = useState<ZhihuUserInfo | null>(null);
  const [userErr, setUserErr] = useState("");
  const [types, setTypes] = useState<ZhihuCrawlKind[]>(["answer", "article", "pin"]);
  const [limit, setLimit] = useState(0);
  const [history, setHistory] = useState<{ id: string; target: string; name: string; ts: string; total: number; resultId?: string }[]>([]);
  // 导入知识库
  const [instances, setInstances] = useState<{ instance: string; count: number }[]>([]);
  const [instance, setInstance] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importMsg, setImportMsg] = useState("");
  // 历史结果查看
  const [viewResultId, setViewResultId] = useState<string | null>(null);
  const [viewItems, setViewItems] = useState<ZhihuCrawlItem[] | null>(null);

  const task = useAsyncTask<{ ok: boolean; user?: { name: string; urlToken: string; headline?: string }; items?: ZhihuCrawlItem[]; total?: number; resultId?: string; message?: string }>(
    "zhihuCrawlTaskId",
    (id) => api.taskStatus<{ ok: boolean; user?: { name: string; urlToken: string; headline?: string }; items?: ZhihuCrawlItem[]; total?: number; resultId?: string; message?: string }>(id),
    api.cancelTask,
  );

  const refreshInstances = () => {
    api.zhihuInstances().then((r) => {
      setInstances(r.instances);
      if (!instance && r.instances.length > 0) setInstance(r.instances[0].instance);
    }).catch(() => {});
  };

  useEffect(() => {
    api.zhihuCookie().then((r) => setCookieOk(r.configured)).catch(() => {});
    api.zhihuHistory().then((r) => setHistory(r.items)).catch(() => {});
    refreshInstances();
  }, []);

  // 任务完成时刷新实例（可能有新导入）与历史
  useEffect(() => {
    if (task.result?.ok && task.result.resultId) {
      api.zhihuHistory().then((r) => setHistory(r.items)).catch(() => {});
    }
  }, [task.result?.ok, task.result?.resultId]);

  const toggleType = (k: ZhihuCrawlKind) => {
    setTypes((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  };

  const handleVerify = async () => {
    if (!target.trim()) return;
    setUserErr("");
    setUser(null);
    try {
      const r = await api.zhihuUser(target.trim());
      if (r.ok) setUser(r);
      else setUserErr(r.message ?? "验证失败");
    } catch (e) {
      setUserErr(e instanceof Error ? e.message : String(e));
    }
  };

  const handleStart = async () => {
    if (!target.trim() || types.length === 0) return;
    const req: ZhihuCrawlRequest = { target: target.trim(), types, limit };
    const t = await api.zhihuCrawl(req);
    task.watch(t.taskId, t as never);
    setSelected(new Set());
    setImportMsg("");
  };

  const items = task.result?.ok ? task.result.items ?? [] : [];
  const resultId = task.result?.ok ? task.result.resultId : undefined;

  const handleImport = async () => {
    if (!resultId || !instance) {
      setImportMsg("请选择目标知识库");
      return;
    }
    if (selected.size === 0) {
      setImportMsg("请勾选要导入的条目（不勾选则导入全部）");
      return;
    }
    try {
      const r = await api.zhihuImport({ resultId, instance, indexes: [...selected].sort((a, b) => a - b) });
      if (r.ok) {
        setImportMsg(`✓ 已导入 ${r.imported} 条到知识库「${r.instance}」`);
        refreshInstances();
      } else {
        setImportMsg(`✗ ${r.message}`);
      }
    } catch (e) {
      setImportMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const markdownText = useMemo(() => {
    if (items.length === 0) return "";
    const head = `# ${task.result?.user?.name ?? ""} 的知乎创作内容（共 ${items.length} 条）\n\n`;
    const body = items
      .map((it, i) => {
        const kind = KIND_LABEL[it.kind];
        const date = it.createdAt.slice(0, 10);
        const votes = it.voteupCount !== undefined ? ` · ${it.voteupCount} 赞` : "";
        let s = `## ${i + 1}. [${kind}] ${it.title}\n\n> ${date}${votes} · ${it.url}\n\n${it.content}`;
        if (it.comments?.length) {
          s += `\n\n### 作者参与的评论\n`;
          for (const cm of it.comments) {
            s += `- **${cm.author}**${cm.replyTo ? ` 回复 ${cm.replyTo}` : ""}：${cm.content}\n`;
            for (const ch of cm.children ?? []) s += `  - ↳ **${ch.author}**${ch.replyTo ? ` 回复 ${ch.replyTo}` : ""}：${ch.content}\n`;
          }
        }
        return s;
      })
      .join("\n\n---\n\n");
    return head + body;
  }, [items, task.result]);

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(markdownText);
      alert("已复制全部内容（markdown）");
    } catch {
      alert("复制失败，请手动选择复制");
    }
  };

  return (
    <div style={{ maxWidth: 1000 }}>
      <PageHeader
        title="知乎爬虫"
        desc="授权登录（浏览器内或 Cookie）后，以人类频率（1.5~3s/请求）慢慢抓取某用户的时间降序创作内容（回答/文章/想法 + 作者参与讨论的评论），仅文字转 Markdown；可导入知识库。请仅用于个人备份等合法用途。"
      />

      {/* 登录态授权 */}
      <div style={card}>
        <h3 style={{ margin: "0 0 0.5rem" }}>🔑 登录态授权</h3>
        <p style={{ fontSize: "0.8rem", color: "#64748b", margin: "0 0 0.5rem" }}>
          推荐「🖥 浏览器登录授权」：弹出本机浏览器窗口，登录一次自动保存；也可手动粘贴 Cookie（F12 → Network → 复制 Cookie 请求头）。
        </p>
        <div style={{ marginTop: "0.4rem", display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
          <button
            onClick={async () => {
              setAuthBusy(true);
              setAuthMsg("正在启动浏览器…");
              try {
                const t = await api.zhihuAuth();
                let final: { ok?: boolean; name?: string; message?: string } | null = null;
                for (let i = 0; i < 180 && !final; i++) {
                  await new Promise((r) => setTimeout(r, 2000));
                  const st = await api.taskStatus<{ ok?: boolean; name?: string; message?: string }>(t.taskId).catch(() => null);
                  const body = st && "result" in st ? (st as { result?: unknown }).result : null;
                  if (body && typeof body === "object" && "ok" in (body as object)) final = body as { ok?: boolean; name?: string; message?: string };
                }
                if (final?.ok) {
                  setAuthMsg(`✓ 授权成功${final.name ? `（${final.name}）` : ""}`);
                  setCookieOk(true);
                } else setAuthMsg(`✗ ${final?.message ?? "授权失败或超时"}`);
              } catch (e) {
                setAuthMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
              } finally {
                setAuthBusy(false);
              }
            }}
            disabled={authBusy}
            style={{ padding: "0.4rem 1rem" }}
          >
            {authBusy ? "授权中…（请在弹窗内登录）" : "🖥 浏览器登录授权"}
          </button>
          <button
            onClick={async () => {
              if (!cookie.trim()) return;
              const r = await api.zhihuSaveCookie(cookie.trim());
              setCookieOk(r.configured);
              alert(r.configured ? "Cookie 已保存" : "保存失败");
            }}
            style={{ padding: "0.4rem 1rem" }}
          >
            保存 Cookie
          </button>
          <span style={{ fontSize: "0.8rem", color: cookieOk ? "#16a34a" : "#b91c1c" }}>
            {cookieOk ? "✓ 已配置登录态" : "未配置（需登录态才能抓取）"}
          </span>
          {authMsg && <span style={{ fontSize: "0.8rem", color: "#475569" }}>{authMsg}</span>}
        </div>
        <textarea
          value={cookie}
          onChange={(e) => setCookie(e.target.value)}
          placeholder="（可选）手动粘贴 Cookie…"
          rows={2}
          style={{ width: "100%", boxSizing: "border-box", padding: "0.5rem 0.8rem", fontSize: "0.8rem", borderRadius: 8, border: "1px solid #cbd5e1", marginTop: "0.6rem" }}
        />
      </div>

      {/* 目标与参数 */}
      <div style={card}>
        <h3 style={{ margin: "0 0 0.5rem" }}>🎯 抓取目标</h3>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="知乎主页 URL 或 urlToken，如 https://www.zhihu.com/people/xxx"
            style={{ flex: 1, padding: "0.5rem 0.8rem", fontSize: "0.85rem", borderRadius: 8, border: "1px solid #cbd5e1" }}
          />
          <button onClick={handleVerify} style={{ padding: "0.5rem 1rem", whiteSpace: "nowrap" }}>
            验证用户
          </button>
        </div>
        {userErr && <p style={{ color: "#b91c1c", fontSize: "0.8rem", margin: "0.4rem 0 0" }}>{userErr}</p>}
        {user?.ok && (
          <div style={{ fontSize: "0.85rem", marginTop: "0.5rem", color: "#334155" }}>
            <b>{user.name}</b>
            {user.headline ? ` · ${user.headline}` : ""}
            <span style={{ color: "#64748b", marginLeft: "0.5rem" }}>
              回答 {user.answerCount ?? "?"} · 文章 {user.articleCount ?? "?"} · 想法 {user.pinCount ?? "?"}
            </span>
          </div>
        )}
        <div style={{ marginTop: "0.8rem", display: "flex", gap: "1.2rem", alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: "0.8rem" }}>
            {(Object.keys(KIND_LABEL) as ZhihuCrawlKind[]).map((k) => (
              <label key={k} style={{ fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "0.3rem" }}>
                <input type="checkbox" checked={types.includes(k)} onChange={() => toggleType(k)} />
                {KIND_LABEL[k]}
              </label>
            ))}
          </div>
          <label style={{ fontSize: "0.85rem", display: "flex", alignItems: "center", gap: "0.3rem" }}>
            每类上限
            <input
              type="number"
              min={0}
              max={500}
              value={limit || ""}
              placeholder="不限"
              onChange={(e) => setLimit(e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)))}
              style={{ width: 70, padding: "0.3rem 0.5rem", borderRadius: 6, border: "1px solid #cbd5e1" }}
            />
          </label>
        </div>
        <div style={{ marginTop: "0.8rem" }}>
          <button
            onClick={handleStart}
            disabled={!target.trim() || types.length === 0 || task.running}
            style={{ padding: "0.5rem 1.4rem", fontSize: "0.9rem" }}
          >
            {task.running ? "抓取中…" : "🚀 开始抓取"}
          </button>
          {task.running && (
            <button onClick={() => task.cancel()} style={{ marginLeft: "0.6rem", padding: "0.5rem 1rem" }}>
              停止
            </button>
          )}
          {task.error && <p style={{ color: "#b91c1c", fontSize: "0.82rem", margin: "0.5rem 0 0" }}>❌ {task.error}</p>}
          <p style={{ fontSize: "0.78rem", color: "#64748b", margin: "0.4rem 0 0" }}>
            回答/文章/想法后台逐步抓取；自动附带「作者参与讨论的评论」（前 10 条内容）。结果持久化保存，可随时回来查看或导入知识库。
          </p>
        </div>
      </div>

      {/* 结果 + 导入知识库 */}
      {items.length > 0 && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
            <h3 style={{ margin: 0 }}>📄 抓取结果（{items.length} 条，时间降序）</h3>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <button onClick={copyMarkdown} style={{ padding: "0.4rem 1rem" }}>
                复制全部 Markdown
              </button>
              <button onClick={() => setSelected(new Set(items.map((_, i) => i)))} style={{ padding: "0.4rem 0.8rem", fontSize: "0.78rem" }}>
                全选
              </button>
            </div>
          </div>

          {/* 导入知识库工具条 */}
          <div style={{ margin: "0.7rem 0", padding: "0.6rem 0.9rem", background: "#f1f5f9", borderRadius: 10, display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "#475569" }}>📥 导入知识库：</span>
            <select value={instance} onChange={(e) => setInstance(e.target.value)} style={{ padding: "0.35rem 0.6rem", borderRadius: 6, border: "1px solid #cbd5e1", fontSize: "0.82rem" }}>
              {instances.length === 0 && <option value="">（暂无知识库实例，先创建：medical/trading/mine…）</option>}
              {instances.map((ins) => (
                <option key={ins.instance} value={ins.instance}>
                  {ins.instance}（{ins.count} 条）
                </option>
              ))}
            </select>
            <input
              value={instance}
              onChange={(e) => setInstance(e.target.value)}
              placeholder="或输入新实例名（字母数字._-）"
              style={{ padding: "0.35rem 0.6rem", borderRadius: 6, border: "1px solid #cbd5e1", fontSize: "0.82rem", width: 180 }}
            />
            <button onClick={handleImport} style={{ padding: "0.35rem 1rem", fontSize: "0.82rem" }}>
              导入勾选项（{selected.size}）
            </button>
            {importMsg && <span style={{ fontSize: "0.78rem", color: importMsg.startsWith("✓") ? "#16a34a" : "#b91c1c" }}>{importMsg}</span>}
          </div>

          <ResultItems items={items} selectable onToggle={(i) => setSelected((prev) => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; })} selected={selected} />
        </div>
      )}

      {/* 历史（含结果查看） */}
      {history.length > 0 && (
        <div style={card}>
          <h3 style={{ margin: "0 0 0.6rem" }}>🕘 抓取历史</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "0.4rem 0.5rem" }}>
                    <b>{h.name || h.target}</b>
                    <span style={{ color: "#94a3b8", fontSize: "0.72rem", marginLeft: "0.5rem" }}>{h.target}</span>
                  </td>
                  <td style={{ padding: "0.4rem 0.5rem", color: "#64748b" }}>{h.total} 条</td>
                  <td style={{ padding: "0.4rem 0.5rem", color: "#94a3b8", fontSize: "0.72rem" }}>{new Date(h.ts).toLocaleString()}</td>
                  <td style={{ padding: "0.4rem 0.5rem", textAlign: "right", whiteSpace: "nowrap" }}>
                    {h.resultId && (
                      <button
                        onClick={async () => {
                          setViewResultId(h.resultId ?? null);
                          try {
                            const r = await api.zhihuResult(h.resultId!);
                            setViewItems(r.ok ? (r.items ?? []) : null);
                          } catch {
                            setViewItems(null);
                          }
                        }}
                        style={{ fontSize: "0.72rem", padding: "0.2rem 0.6rem", marginRight: "0.3rem" }}
                      >
                        查看结果
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        await api.zhihuHistoryDelete(h.id);
                        setHistory((prev) => prev.filter((x) => x.id !== h.id));
                        if (viewResultId === h.resultId) {
                          setViewResultId(null);
                          setViewItems(null);
                        }
                      }}
                      style={{ fontSize: "0.72rem", padding: "0.2rem 0.6rem" }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {viewItems && (
            <div style={{ marginTop: "0.8rem", borderTop: "1px solid #e2e8f0", paddingTop: "0.8rem" }}>
              <h4 style={{ margin: "0 0 0.6rem", fontSize: "0.9rem" }}>📄 历史结果（{viewItems.length} 条）</h4>
              <ResultItems items={viewItems} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
