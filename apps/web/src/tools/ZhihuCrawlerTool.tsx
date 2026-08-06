// ============================================================
// 知乎爬虫（小工具）：授权登录（cookie）后以人类频率抓取
// 某用户的时间降序创作内容（回答/文章/想法），转 markdown
// ============================================================
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAsyncTask } from "../hooks/useAsyncTask";
import type { ZhihuCrawlItem, ZhihuCrawlKind, ZhihuCrawlRequest, ZhihuUserInfo } from "@toolbox/shared";
import { card, ErrorCard, PageHeader } from "../ui";

const KIND_LABEL: Record<ZhihuCrawlKind, string> = { answer: "回答", article: "文章", pin: "想法" };

export default function ZhihuCrawlerTool() {
  const [cookie, setCookie] = useState("");
  const [cookieOk, setCookieOk] = useState(false);
  const [target, setTarget] = useState("");
  const [user, setUser] = useState<ZhihuUserInfo | null>(null);
  const [userErr, setUserErr] = useState("");
  const [types, setTypes] = useState<ZhihuCrawlKind[]>(["answer", "article", "pin"]);
  const [limit, setLimit] = useState(0);
  const [history, setHistory] = useState<{ id: string; target: string; name: string; ts: string; total: number }[]>([]);

  const task = useAsyncTask<{ ok: boolean; user?: { name: string; urlToken: string; headline?: string }; items?: ZhihuCrawlItem[]; total?: number; message?: string }>(
    "zhihuCrawlTaskId",
    (id) => api.taskStatus<{ ok: boolean; user?: { name: string; urlToken: string; headline?: string }; items?: ZhihuCrawlItem[]; total?: number; message?: string }>(id),
    api.cancelTask,
  );

  useEffect(() => {
    api.zhihuCookie().then((r) => setCookieOk(r.configured)).catch(() => {});
    api.zhihuHistory().then((r) => setHistory(r.items)).catch(() => {});
  }, []);

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
  };

  const items = task.result?.ok ? task.result.items ?? [] : [];

  const markdownText = useMemo(() => {
    if (items.length === 0) return "";
    const head = `# ${task.result?.user?.name ?? ""} 的知乎创作内容（共 ${items.length} 条）\n\n`;
    const body = items
      .map((it, i) => {
        const kind = KIND_LABEL[it.kind];
        const date = new Date(it.createdAt).toISOString().slice(0, 10);
        const votes = it.voteupCount !== undefined ? ` · ${it.voteupCount} 赞` : "";
        return `## ${i + 1}. [${kind}] ${it.title}\n\n> ${date}${votes} · ${it.url}\n\n${it.content}`;
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
        desc="授权登录（浏览器 Cookie）后，以人类频率（3~6s/请求）慢慢抓取某用户的时间降序创作内容，仅文字并转为 Markdown。请仅用于个人备份等合法用途。"
      />

      {/* 登录态授权 */}
      <div style={card}>
        <h3 style={{ margin: "0 0 0.5rem" }}>🔑 登录态授权（Cookie）</h3>
        <p style={{ fontSize: "0.8rem", color: "#64748b", margin: "0 0 0.5rem" }}>
          在浏览器登录知乎后，按 F12 → Network 任选请求 → 复制 <code>Cookie</code> 请求头粘贴于此（本地保存，仅服务端使用）。
        </p>
        <textarea
          value={cookie}
          onChange={(e) => setCookie(e.target.value)}
          placeholder="粘贴 Cookie…（例如 d_c0=xxx; _zap=xxx; …）"
          rows={3}
          style={{ width: "100%", boxSizing: "border-box", padding: "0.6rem 0.8rem", fontSize: "0.8rem", borderRadius: 8, border: "1px solid #cbd5e1" }}
        />
        <div style={{ marginTop: "0.6rem", display: "flex", gap: "0.6rem", alignItems: "center" }}>
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
            {cookieOk ? "✓ 已配置登录态" : "未配置（回答/文章抓取需登录态）"}
          </span>
        </div>
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
            说明：抓取在服务端后台逐步进行（3~6s/请求）。回答/文章来自 SSR 首页数据；想法可完整翻页。页面切换不会中断。
          </p>
        </div>
      </div>

      {/* 结果 */}
      {items.length > 0 && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>
              📄 抓取结果（{items.length} 条，时间降序）
            </h3>
            <button onClick={copyMarkdown} style={{ padding: "0.4rem 1rem" }}>
              复制全部 Markdown
            </button>
          </div>
          <div style={{ marginTop: "0.8rem", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            {items.map((it, i) => (
              <details key={i} style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: "0.6rem 0.9rem", background: "#fafbfc" }}>
                <summary style={{ cursor: "pointer", fontSize: "0.88rem", fontWeight: 600 }}>
                  <span style={{ color: "#3b82f6" }}>[{KIND_LABEL[it.kind]}]</span> {it.title}
                  <span style={{ color: "#94a3b8", fontWeight: 400, marginLeft: "0.6rem", fontSize: "0.75rem" }}>
                    {new Date(it.createdAt).toISOString().slice(0, 10)}
                    {it.voteupCount !== undefined ? ` · ${it.voteupCount} 赞` : ""}
                  </span>
                </summary>
                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "0.8rem", lineHeight: 1.7, margin: "0.6rem 0 0.2rem", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.7rem 0.9rem" }}>
                  {it.content || "（无文字内容）"}
                </pre>
                <a href={it.url} target="_blank" rel="noreferrer" style={{ fontSize: "0.75rem", color: "#3b82f6" }}>
                  查看原文 ↗
                </a>
              </details>
            ))}
          </div>
        </div>
      )}

      {/* 历史 */}
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
                  <td style={{ padding: "0.4rem 0.5rem", textAlign: "right" }}>
                    <button
                      onClick={async () => {
                        await api.zhihuHistoryDelete(h.id);
                        setHistory((prev) => prev.filter((x) => x.id !== h.id));
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
        </div>
      )}
    </div>
  );
}
