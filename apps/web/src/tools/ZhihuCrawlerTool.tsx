// ============================================================
// 知乎爬虫（小工具）：授权登录（浏览器内/Cookie）后以人类频率抓取
// 某用户的时间降序创作内容（回答/文章/想法），转 markdown；
// 支持：作者参与讨论的评论抓取、历史结果持久化、导入知识库
// ============================================================
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useDataInfraTask } from "../hooks/useDataInfraTask";
import type { ZhihuCrawlItem, ZhihuCrawlKind, ZhihuCrawlRequest, ZhihuComment, ZhihuUserInfo } from "@toolbox/shared";
import { card, PageHeader } from "../ui";
import { MarkdownView } from "../MarkdownView";

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
  openFirst,
}: {
  items: ZhihuCrawlItem[];
  selectable?: boolean;
  selected?: Set<number>;
  onToggle?: (i: number) => void;
  openFirst?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
      {items.map((it, i) => (
        <details key={i} open={openFirst && i === 0} style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: "0.6rem 0.9rem", background: "#fafbfc" }}>
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
          <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.7rem 0.9rem", margin: "0.6rem 0 0.2rem" }}>
            <MarkdownView>{it.content || "（无文字内容）"}</MarkdownView>
          </div>
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

/** 可读化知乎目标（URL → @句柄；裸句柄原样返回） */
const humanTarget = (t: string): string => {
  if (!t) return "";
  const m = t.match(/zhihu\.com\/(?:people|org|company|zvideo)\/([\w-]+)/);
  if (m) return "@" + m[1];
  const u = t.match(/zhihu\.com\/[\w-]+$/);
  if (u) return t.split("/").filter(Boolean).pop() ?? t;
  return t;
};

export default function ZhihuCrawlerTool() {
  const [cookie, setCookie] = useState("");
  const [cookieOk, setCookieOk] = useState(false);
  const [authMsg, setAuthMsg] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [target, setTarget] = useState("");
  const [user, setUser] = useState<ZhihuUserInfo | null>(null);
  const [userErr, setUserErr] = useState("");
  const [favorites, setFavorites] = useState<{ token: string; name: string; ts: string }[]>([]);
  const [datePreset, setDatePreset] = useState("7d");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [types, setTypes] = useState<ZhihuCrawlKind[]>(["answer", "article", "pin"]);
  const [limit, setLimit] = useState(20);
  const [history, setHistory] = useState<{ id: string; target: string; name: string; ts: string; total: number; resultId?: string }[]>([]);
  // 导入知识库
  const [instances, setInstances] = useState<{ instance: string; count: number }[]>([]);
  const [instance, setInstance] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importMsg, setImportMsg] = useState("");
  // 历史结果查看
  const [viewResultId, setViewResultId] = useState<string | null>(null);
  const [viewItems, setViewItems] = useState<ZhihuCrawlItem[] | null>(null);
  const [resultOpenFirst, setResultOpenFirst] = useState(false); // 展开历史结果时自动打开第一篇

  type CrawlResultT = { ok: boolean; user?: { name: string; urlToken: string; headline?: string }; items?: ZhihuCrawlItem[]; total?: number; resultId?: string; partial?: boolean; paused?: boolean; cancelled?: boolean; progressId?: string; warnings?: string[]; message?: string };
  const runSpecRef = useRef<{ action: "crawl" | "resume"; req?: Parameters<typeof api.zhihuCrawl>[0]; pid?: string } | null>(null);
  const task = useDataInfraTask<CrawlResultT>({
    storageKey: "zhihuCrawlTaskId",
    create: async () => {
      const spec = runSpecRef.current;
      if (!spec) throw new Error("未指定爬取动作");
      const t = spec.action === "crawl" ? await api.zhihuCrawl(spec.req!) : await api.zhihuResume(spec.pid!);
      if (!t.ok) throw new Error((t as { message?: string }).message ?? "任务失败");
      return { taskId: t.taskId };
    },
    fetchResult: (taskId) => api.dataInfraResult<CrawlResultT>(taskId),
    cancel: (taskId) => api.cancelTask(taskId),
  });
  const running = task.state.status === "running";

  const refreshInstances = () => {
    api.zhihuInstances().then((r) => {
      const list = r.instances as { instance: string; count: number; type?: string }[];
      setInstances(list);
      // 默认选中「我的」虚拟库（若存在），否则第一个
      if (!instance) {
        const mine = list.find((i) => i.instance === "我的");
        if (mine) setInstance(mine.instance);
        else if (list.length > 0) setInstance(list[0].instance);
      }
    }).catch(() => {});
  };

    // 挂载恢复：跨页/刷新后继续等待 data-infra 任务
  useEffect(() => { task.resumeIfPending(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
useEffect(() => {
    api.zhihuCookie().then((r) => setCookieOk(r.configured)).catch(() => {});
    api.zhihuHistory().then((r) => setHistory(r.items)).catch(() => {});
    api.zhihuFavorites().then((r) => setFavorites(r.items)).catch(() => {});
    refreshInstances();
  }, []);

  // 任务完成时刷新实例（可能有新导入）与历史
  useEffect(() => {
    if (task.state.result?.ok && task.state.result.resultId) {
      api.zhihuHistory().then((r) => setHistory(r.items)).catch(() => {});
    }
  }, [task.state.result?.ok, task.state.result?.resultId]);

  const toggleType = (k: ZhihuCrawlKind) => {
    setTypes((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  };

  const handleVerify = async () => {
    if (!target.trim()) return;
    setUserErr("");
    setUser(null);
    const t = target.trim();
    // 非用户链接：调 resolve-link 解析类型+标题（链接目标显示带标题的超链接）
    if (/zhihu\.com\/(question|answer|p|pin|zhuanlan|collection)/.test(t)) {
      try {
        setUser({ ok: true, name: "正在解析链接标题…", urlToken: "link" });
        const r = await api.zhihuResolveLink(t);
        if (r.ok) {
          const kindLabel = r.kind === "question" ? "问题" : r.kind === "article" ? "文章" : r.kind === "answer" ? "回答" : r.kind === "user" ? "用户" : "内容";
          setUser({
            ok: true,
            name: r.title ?? `将抓取「${kindLabel}」`,
            headline: `类型：${kindLabel}${r.url ? `（${r.url.slice(0, 60)}）` : ""}`,
            urlToken: r.url ? r.url : "link",
          });
        } else {
          setUser({ ok: true, name: `将抓取「${kindLabelOf(t)}」`, urlToken: "link" });
        }
      } catch {
        setUser({ ok: true, name: `将抓取「${kindLabelOf(t)}」`, urlToken: "link" });
      }
      return;
    }
    try {
      const r = await api.zhihuUser(t);
      if (r.ok) setUser(r);
      else setUserErr(r.message ?? "验证失败");
    } catch (e) {
      setUserErr(e instanceof Error ? e.message : String(e));
    }
  };
  const kindLabelOf = (t: string) => (t.includes("/answer/") ? "回答" : t.includes("/question/") ? "问题" : t.includes("/zhuanlan/") || t.includes("/p/") ? "文章" : t.includes("/pin/") ? "想法" : "内容");

  const handleStart = async () => {
    if (!target.trim() || types.length === 0) return;
    // 日期范围解析
    let from: string | undefined;
    let to: string | undefined;
    if (datePreset === "custom") {
      from = dateFrom || undefined;
      to = dateTo || undefined;
    } else if (datePreset !== "all") {
      const days = datePreset === "7d" ? 7 : datePreset === "30d" ? 30 : datePreset === "90d" ? 90 : 0;
      if (days > 0) {
        const d = new Date();
        d.setDate(d.getDate() - days);
        from = d.toISOString().slice(0, 10);
      }
    }
    const req: ZhihuCrawlRequest = { target: target.trim(), types, limit, ...(from ? { dateFrom: from } : {}), ...(to ? { dateTo: to } : {}) };
    // 2026-08-14：请求失败（未配置 cookie 等 400）给出可见错误，不再静默无反应
    runSpecRef.current = { action: "crawl", req };
    try {
      await task.run();
    } catch (e) {
      setImportMsg(e instanceof Error ? e.message : String(e));
      return;
    }
    setSelected(new Set());
    setImportMsg("");
  };

  const handleResume = async () => {
    const pid = task.state.result?.ok ? task.state.result.progressId : undefined;
    if (!pid) return;
    try {
      runSpecRef.current = { action: "resume", pid };
      await task.run();
      setImportMsg("");
    } catch (e) {
      setImportMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const items = task.state.result?.ok ? task.state.result.items ?? [] : [];
  const resultId = task.state.result?.ok ? task.state.result.resultId : undefined;

  const handleImport = async () => {
    if (!resultId || !instance) {
      setImportMsg("请选择目标知识库");
      return;
    }
    // 2026-08-14：与契约一致——不勾选 = 导入全部（此前文案误导且拦截空选择）
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
    const head = `# ${task.state.result?.user?.name ?? ""} 的知乎创作内容（共 ${items.length} 条）\n\n`;
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
  }, [items, task.state.result]);

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
            className="btn btn-primary"
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
            className="btn"
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
            placeholder="知乎链接或用户主页：支持 用户/问题/回答/文章/想法 链接，或粘贴包含知乎链接的文本（自动提取）"
            style={{ flex: 1, padding: "0.5rem 0.8rem", fontSize: "0.85rem", borderRadius: 8, border: "1px solid #cbd5e1" }}
          />
          <button onClick={handleVerify} className="btn" style={{ padding: "0.5rem 1rem", whiteSpace: "nowrap" }}>
            识别目标
          </button>
          <button
            onClick={async () => {
              if (!target.trim()) return;
              const name = user?.ok ? user.name : undefined;
              const r = await api.zhihuFavoriteAdd(target.trim(), name);
              setFavorites(r.favorites);
              alert("已收藏目标");
            }}
            className="btn"
            style={{ padding: "0.5rem 1rem", whiteSpace: "nowrap" }}
            title="收藏此爬取目标"
          >
            ⭐ 收藏
          </button>
        </div>
        {favorites.length > 0 && (
          <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: "0.75rem", color: "#94a3b8" }}>🕘 历史抓取目标：</span>
            {favorites.map((f) => (
              <span key={f.token} style={{ display: "inline-flex", alignItems: "center", gap: "0.2rem", background: "#f1f5f9", borderRadius: 999, padding: "0.15rem 0.6rem", fontSize: "0.75rem" }}>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    setTarget(f.token);
                    setUser(null);
                  }}
                  style={{ color: "#475569", textDecoration: "none" }}
                >
                  {f.name || f.token}
                </a>
                <button
                  onClick={async () => {
                    const r = await api.zhihuFavoriteDelete(f.token);
                    setFavorites(r.favorites);
                  }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#94a3b8", fontSize: "0.7rem", padding: 0 }}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        {userErr && <p style={{ color: "#b91c1c", fontSize: "0.8rem", margin: "0.4rem 0 0" }}>{userErr}</p>}
        {user?.ok && (
          <div style={{ fontSize: "0.85rem", marginTop: "0.5rem", color: "#334155" }}>
            {user.urlToken && user.urlToken !== "link" ? (
              <a
                href={user.urlToken.startsWith("http") ? user.urlToken : `https://www.zhihu.com/people/${user.urlToken}`}
                target="_blank"
                rel="noreferrer"
                style={{ fontWeight: 700, color: "#1d4ed8" }}
                title={user.urlToken}
              >
                🔗 {(user.name ?? "").slice(0, 60)}{(user.name ?? "").length > 60 ? "…" : ""}
              </a>
            ) : (
              <b>{user.name}</b>
            )}
            {user.headline ? ` · ${user.headline}` : ""}
            {user.urlToken === "link" && (
              <span style={{ color: "#64748b", marginLeft: "0.5rem" }}>回答 {user.answerCount ?? "?"} · 文章 {user.articleCount ?? "?"} · 想法 {user.pinCount ?? "?"}</span>
            )}
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
              min={1}
              max={10000}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(10000, Number(e.target.value) || 20)))}
              style={{ width: 80, padding: "0.3rem 0.5rem", borderRadius: 6, border: "1px solid #cbd5e1" }}
            />
          </label>
          <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.8rem", color: "#64748b" }}>日期范围：</span>
            {[
              ["all", "全部"],
              ["7d", "近7天"],
              ["30d", "近30天"],
              ["90d", "近90天"],
              ["custom", "自定义"],
            ].map(([v, label]) => (
              <button
                key={v}
                onClick={() => setDatePreset(v)}
                style={{
                  padding: "0.2rem 0.6rem",
                  fontSize: "0.75rem",
                  borderRadius: 999,
                  border: datePreset === v ? "1px solid #3b82f6" : "1px solid #cbd5e1",
                  background: datePreset === v ? "#eff6ff" : "#fff",
                  color: datePreset === v ? "#1d4ed8" : "#475569",
                }}
              >
                {label}
              </button>
            ))}
            {datePreset === "custom" && (
              <span style={{ display: "inline-flex", gap: "0.3rem", alignItems: "center", fontSize: "0.78rem" }}>
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ padding: "0.25rem 0.4rem", borderRadius: 6, border: "1px solid #cbd5e1", fontSize: "0.75rem" }} />
                <span style={{ color: "#94a3b8" }}>至</span>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ padding: "0.25rem 0.4rem", borderRadius: 6, border: "1px solid #cbd5e1", fontSize: "0.75rem" }} />
              </span>
            )}
          </div>
        </div>
        <div style={{ marginTop: "0.8rem" }}>
          <button
            onClick={handleStart}
            disabled={!target.trim() || types.length === 0 || running}
            className="btn btn-primary"
            style={{ padding: "0.5rem 1.4rem", fontSize: "0.9rem" }}
          >
            {running ? "抓取中…" : "🚀 开始抓取"}
          </button>
          {running && (
            <button onClick={() => task.cancel()} className="btn btn-danger" style={{ marginLeft: "0.6rem", padding: "0.5rem 1rem" }}>
              停止
            </button>
          )}
          {task.state.error && <p style={{ color: "#b91c1c", fontSize: "0.82rem", margin: "0.5rem 0 0" }}>❌ {task.state.error}</p>}
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
          {/* 暂停/取消状态提示 + 续爬 */}
          {task.state.result?.partial && (
            <div style={{ margin: "0.6rem 0", padding: "0.6rem 0.9rem", borderRadius: 10, background: task.state.result.cancelled ? "#fef2f2" : "#fffbeb", border: task.state.result.cancelled ? "1px solid #fecaca" : "1px solid #fde68a", display: "flex", gap: "0.8rem", alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: "0.85rem", color: task.state.result.cancelled ? "#b91c1c" : "#92400e" }}>
                {task.state.result.cancelled ? `⏹ 已取消（已抓取 ${items.length} 条已保留）` : `⏸ 已暂停（${items.length >= (task.state.result.total ?? 20) ? "达到数量上限" : "超过单次 20 分钟超时"}，已抓取 ${items.length} 条已保存）`}
              </span>
              <button onClick={handleResume} disabled={running} style={{ padding: "0.4rem 1rem", fontSize: "0.82rem" }}>
                {running ? "续爬中…" : "▶ 继续爬取（断点续爬）"}
              </button>
              <span style={{ fontSize: "0.72rem", color: "#94a3b8" }}>单次上限 100 条 / 20 分钟，超出自动暂停并保存进度；可多次续爬直至完成。</span>
            </div>
          )}
          {/* 诊断信息：失败/0 结果原因 */}
          {task.state.result?.ok && task.state.result.warnings && task.state.result.warnings.length > 0 && (
            <div style={{ margin: "0.6rem 0", padding: "0.6rem 0.9rem", borderRadius: 10, background: "#fffbeb", border: "1px solid #fde68a", fontSize: "0.8rem", color: "#92400e", lineHeight: 1.7 }}>
              {task.state.result.total === 0 ? <b>⚠ 未获取到内容：</b> : <b>⚠ 部分类型未获取到内容：</b>}
              {task.state.result.warnings.map((w, i) => (
                <div key={i} style={{ marginTop: "0.15rem" }}>· {w}</div>
              ))}
            </div>
          )}

          {/* 导入知识库工具条 */}
          <div style={{ margin: "0.7rem 0", padding: "0.6rem 0.9rem", background: "#f1f5f9", borderRadius: 10, display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "#475569" }}>📥 导入知识库：</span>
            <select value={instance} onChange={(e) => setInstance(e.target.value)} style={{ padding: "0.35rem 0.6rem", borderRadius: 6, border: "1px solid #cbd5e1", fontSize: "0.82rem" }}>
              {instances.length === 0 && <option value="">（暂无知识库实例，先创建：medical/trading/mine…）</option>}
              {instances.map((ins) => (
                <option key={ins.instance} value={ins.instance}>
                  {(ins as { type?: string }).type === "virt" ? "🧩" : "🏷️"} {ins.instance}（{ins.count} 条）
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
                <Fragment key={h.id}>
                <tr
                  style={{ borderBottom: "1px solid #f1f5f9", cursor: h.resultId ? "pointer" : "default" }}
                  onClick={async () => {
                    if (!h.resultId) return;
                    const same = viewResultId === h.resultId;
                    setViewResultId(same ? null : (h.resultId ?? null));
                    setResultOpenFirst(false);
                    if (same) {
                      setViewItems(null);
                    } else {
                      try {
                        const r = await api.zhihuResult(h.resultId!);
                        setViewItems(r.ok ? (r.items ?? []) : null);
                        setResultOpenFirst(true); // 展开后自动打开第一篇
                      } catch {
                        setViewItems(null);
                      }
                    }
                  }}
                  title={h.resultId ? "点击展开/收起抓取结果" : ""}
                >
                  <td style={{ padding: "0.4rem 0.5rem" }}>
                    <b>{h.name || humanTarget(h.target)}</b>
                    {h.name ? <span style={{ color: "#94a3b8", fontSize: "0.72rem", marginLeft: "0.5rem" }}>{humanTarget(h.target)}</span> : null}
                    {viewResultId === h.resultId && (
                      <span style={{ fontSize: "0.7rem", color: "#2563eb", marginLeft: "0.4rem" }}>▼ 已展开</span>
                    )}
                  </td>
                  <td style={{ padding: "0.4rem 0.5rem", color: "#64748b" }}>{h.total} 条</td>
                  <td style={{ padding: "0.4rem 0.5rem", color: "#94a3b8", fontSize: "0.72rem" }}>{new Date(h.ts).toLocaleString()}</td>
                  <td style={{ padding: "0.4rem 0.5rem", textAlign: "right", whiteSpace: "nowrap" }}>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        await api.zhihuHistoryDelete(h.id);
                        setHistory((prev) => prev.filter((x) => x.id !== h.id));
                        if (viewResultId === h.resultId) {
                          setViewResultId(null);
                          setViewItems(null);
                        }
                      }}
                      className="btn btn-danger btn-sm"
                      style={{ fontSize: "0.72rem", padding: "0.2rem 0.6rem" }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
                {/* 该行原地向下展开结果（非弹窗/非列表底部） */}
                {viewResultId === h.resultId && viewItems && (
                  <tr style={{ background: "#f8faff" }}>
                    <td colSpan={4} style={{ padding: "0.6rem 0.9rem", borderBottom: "1px solid #f1f5f9" }}>
                      <div style={{ maxHeight: "55vh", overflowY: "auto" }}>
                        <ResultItems items={viewItems} openFirst={resultOpenFirst} />
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
