// ============================================================
// 自选股 · 下沉分析（财报 / 新闻）——以标的为单位深挖
// 财报：LLM 联网搜索（后台任务 + 缓存），结果以标的为维度缓存（与分组无关）
// 新闻：确定性关键词匹配（零 LLM、零额外请求），扫描已启用新闻源
// ============================================================

import { useEffect, useState } from "react";
import { api, errMsg } from "../../api";
import type { WatchFundamentalResult, WatchNewsResult } from "@toolbox/shared";
import { useAsyncData } from "../../hooks/useAsyncData";
import {
  C, Caveats, Empty, ItemPicker, Loading, MetaBar, SectionTitle, SegTabs,
  btn, btnSmall, stockDetailUrl,
} from "./shared";

type SubTab = "report" | "news";

/** 用财报分析结论重写入选理由（LLM；须先跑过财报分析，服务端只读缓存不额外计费） */
function OptimizeReasonButton({
  code,
  name,
  onDone,
}: {
  code: string;
  name?: string;
  onDone: (reason: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.watchlistOptimizeReason(code);
      if (r.ok && r.reason) await onDone(r.reason);
      else setErr(r.message ?? "优化失败");
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
      <button type="button" style={{ ...btnSmall, background: "#fff", color: C.faint, border: `1px solid ${C.border}` }} onClick={() => void run()} disabled={busy}>
        {busy ? "优化中…" : `✨ 用分析结论优化${name ? `「${name}」` : ""}入选理由`}
      </button>
      {err ? <span style={{ color: "#b91c1c", fontSize: "0.78rem" }}>{err}</span> : null}
    </div>
  );
}

/** 财报分析结果卡片 */
function ReportCard({ r, onClose }: { r: WatchFundamentalResult; onClose: () => void }) {
  const kv = (label: string, v?: string) =>
    v ? (
      <div style={{ marginBottom: "0.45rem" }}>
        <span style={{ fontWeight: 600, color: "#334155" }}>{label}：</span>
        <span style={{ whiteSpace: "pre-wrap" }}>{v}</span>
      </div>
    ) : null;
  return (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: "0.9rem 1rem", marginTop: "0.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem", gap: "0.5rem" }}>
        <span style={{ fontWeight: 700 }}>
          🔍 {r.name ?? r.code} 财报分析
          {r.dataMode === "search" ? "（联网实时）" : "（知识）"}
          {r.fromCache ? " · 缓存" : ""}
        </span>
        <button style={btnSmall} onClick={onClose} type="button">收起</button>
      </div>
      {kv("概览", r.summary)}
      {kv("财务数据", r.financials)}
      {kv("核心看点", r.strengths)}
      {kv("主要风险", r.risks)}
      {kv("结论", r.conclusion)}
      {r.model ? <div style={{ color: C.faintest, fontSize: "0.75rem" }}>模型：{r.model}</div> : null}
    </div>
  );
}

export function DeepDivePanel({
  code,
  name,
  kind,
  onReason,
}: {
  code: string;
  name?: string;
  kind?: "stock" | "fund";
  /** 用财报结论回写入选理由（由父组件统一提交） */
  onReason?: (reason: string) => Promise<void>;
}) {
  const [sub, setSub] = useState<SubTab>("report");
  const [report, setReport] = useState<WatchFundamentalResult | null>(null);
  const [news, setNews] = useState<WatchNewsResult | null>(null);
  const [busy, setBusy] = useState<"" | "report">("");
  const [err, setErr] = useState<string | null>(null);

  // 切标的 → 重置结果（标的是本面板唯一的服务对象）
  useEffect(() => {
    setReport(null);
    setNews(null);
    setErr(null);
  }, [code]);

  // 新闻：随 sub === "news" + code 自动加载（switchMap 语义，切标的旧请求自动作废）
  const { data: newsData, loading: newsLoading, error: newsError, reload: reloadNews } = useAsyncData(
    () => api.watchlistNews(code),
    [code, sub],
  );

  useEffect(() => {
    if (sub !== "news") return;
    if (newsData) setNews(newsData);
    if (newsError) setErr(newsError);
  }, [newsData, newsError, sub]);

  const runReport = async (force = false) => {
    setBusy("report");
    setErr(null);
    try {
      const t = await api.watchlistFundamental(code, force);
      if (t.ok && t.status === "done" && t.result) setReport(t.result as WatchFundamentalResult);
      else if (t.ok && t.taskId) {
        // 后台任务轮询（LLM 分析通常 20-60s）
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const st = await api.dataInfraTask(t.taskId).catch(() => null);
          const dt = st?.ok ? st.task : undefined;
          if (!dt) continue;
          if (dt.status === "done") { setReport(dt.result as WatchFundamentalResult); break; }
          if (dt.status === "failed" || dt.status === "cancelled") { setErr(dt.lastResult || "分析失败"); break; }
        }
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy("");
    }
  };

  const runNews = () => reloadNews();

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <SegTabs
          value={sub}
          size="sm"
          options={[
            { value: "report", label: "📊 财报" },
            { value: "news", label: "📰 新闻" },
          ]}
          onChange={(v) => setSub(v as SubTab)}
        />
        <span style={{ flex: 1 }} />
        <a href={stockDetailUrl(code, kind)} target="_blank" rel="noreferrer" style={{ fontSize: "0.78rem", color: C.accent }}>
          {name ?? code} 详情页 ↗
        </a>
      </div>

      {err ? <div style={{ color: "#b91c1c", fontSize: "0.85rem", marginTop: "0.5rem" }}>{err}</div> : null}

      {sub === "report" ? (
        <div>
          <SectionTitle
            extra={
              <>
                <button type="button" style={btn} onClick={() => void runReport(false)} disabled={busy === "report"}>
                  {busy === "report" ? "分析中…" : report ? "重新分析" : "📊 开始分析"}
                </button>
                {report ? (
                  <button type="button" style={{ ...btnSmall, background: "#fff", color: C.faint, border: `1px solid ${C.border}` }} onClick={() => void runReport(true)} disabled={busy === "report"}>
                    🔄 强制刷新
                  </button>
                ) : null}
              </>
            }
          >
            财报分析
          </SectionTitle>
          <div style={{ fontSize: "0.75rem", color: C.faintest }}>
            LLM 联网检索该标的最新财报（缓存 2 年，以标的为维度，跨标签复用）；结果仅作参考，不构成投资建议。
          </div>
          {busy === "report" ? <Loading text="分析进行中（LLM 联网检索，约 20-60 秒）…" /> : null}
          {report && report.ok && onReason ? (
            <div style={{ marginTop: "0.4rem" }}>
              <OptimizeReasonButton code={code} name={name} onDone={onReason} />
            </div>
          ) : null}
          {report ? (
            report.ok ? (
              <ReportCard r={report} onClose={() => setReport(null)} />
            ) : (
              <div style={{ color: "#b91c1c", fontSize: "0.85rem", marginTop: "0.5rem" }}>{report.message}</div>
            )
          ) : busy !== "report" ? (
            <Empty>点击「开始分析」生成该标的的财报分析</Empty>
          ) : null}
        </div>
      ) : (
        <div>
          <SectionTitle
            extra={
              <button type="button" style={btn} onClick={runNews} disabled={newsLoading}>
                {newsLoading ? "加载中…" : "🔄 刷新新闻"}
              </button>
            }
          >
            相关新闻
          </SectionTitle>
          <div style={{ fontSize: "0.75rem", color: C.faintest }}>
            扫描已启用新闻源（新闻中心配置），按标的名称/代码做确定性关键词匹配；零 LLM、零额外请求。
          </div>
          {newsLoading ? <Loading text="扫描新闻源…" /> : null}
          {news ? (
            <>
              <Caveats meta={news.meta} />
              <MetaBar meta={news.meta} />
              {news.items.length === 0 ? (
                <Empty>未命中相关新闻（全市场快讯对个股提及有限，可到「新闻中心」启用更多数据源）</Empty>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                  {news.items.map((n, i) => (
                    <a
                      key={`${n.url}-${i}`}
                      href={n.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ display: "block", textDecoration: "none", color: "inherit", border: `1px solid ${C.border}`, borderRadius: 10, padding: "0.55rem 0.75rem", background: "#fff" }}
                    >
                      <div style={{ fontWeight: 600, fontSize: "0.86rem", lineHeight: 1.45 }}>{n.title}</div>
                      {n.digest ? (
                        <div style={{ color: C.faint, fontSize: "0.78rem", marginTop: "0.2rem", lineHeight: 1.5 }}>
                          {n.digest.length > 120 ? `${n.digest.slice(0, 120)}…` : n.digest}
                        </div>
                      ) : null}
                      <div style={{ display: "flex", gap: "0.6rem", marginTop: "0.25rem", fontSize: "0.72rem", color: C.faintest, flexWrap: "wrap" }}>
                        <span>{n.time}</span>
                        <span>{n.sourceName}</span>
                        <span>命中：{n.hits.join(" / ")}</span>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </>
          ) : !newsLoading ? (
            <Empty>点击「刷新新闻」扫描</Empty>
          ) : null}
        </div>
      )}
    </div>
  );
}
