// ============================================================
// 自选股 · 逻辑确认：入选理由与预期 随时间是否成立
// 设计（dev.md §6.2 防「裁判兼运动员」假收敛）：
//   确定性锚（非 LLM）：基准价→当前价涨跌幅、目标价达成度、相关新闻条数
//   LLM 定性判定     ：理由是否成立 / 预期是否达成（输入为服务端真实采集事实）
//   成本原则         ：仅用户点击触发；同日同标的复用结论（强制复核可绕过）
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { api, errMsg } from "../../api";
import type { WatchItem, WatchLogicItem, WatchLogicReview } from "@toolbox/shared";
import {
  C, Caveats, Empty, Loading, MetaBar, SectionTitle,
  btn, btnSmall, fmtPct, fmtPrice, input, pctColor, stockDetailUrl, thTd,
} from "./shared";

const PREMISE_TEXT: Record<WatchLogicReview["premise"], string> = {
  holds: "成立",
  partial: "部分成立",
  broken: "已证伪",
};
const PREMISE_COLOR: Record<WatchLogicReview["premise"], string> = {
  holds: C.loss,
  partial: C.warn,
  broken: C.gain,
};
const EXPECT_TEXT: Record<WatchLogicReview["expectation"], string> = {
  met: "已达成",
  pending: "待兑现",
  failed: "未达成",
};
const EXPECT_COLOR: Record<WatchLogicReview["expectation"], string> = {
  met: C.loss,
  pending: C.faint,
  failed: C.gain,
};
const SUGGEST_TEXT: Record<WatchLogicReview["suggestion"], string> = {
  hold: "继续跟踪",
  review: "需人工复核",
  exit: "建议移出",
};
const SUGGEST_COLOR: Record<WatchLogicReview["suggestion"], string> = {
  hold: C.loss,
  review: C.warn,
  exit: C.gain,
};

/** 单标的的逻辑确认卡（理由 / 预期 / 锚点 / 最近复核 / 操作） */
function LogicCard({
  item,
  groupId,
  onReviewed,
}: {
  item: WatchLogicItem;
  groupId: string;
  onReviewed: () => void;
}) {
  const [reviewing, setReviewing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [expectation, setExpectation] = useState(item.expectation ?? "");
  const [targetPrice, setTargetPrice] = useState(item.targetPrice ? String(item.targetPrice) : "");
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<WatchLogicReview[] | null>(null);

  const r = item.review;
  const a = item.anchors;

  const review = async (force = false) => {
    setReviewing(true);
    setErr(null);
    try {
      const t = await api.watchlistLogicReview(groupId, item.code, force);
      if (t.ok && t.status === "done") { onReviewed(); return; }
      if (t.ok && t.taskId) {
        for (let i = 0; i < 90; i++) {
          await new Promise((res) => setTimeout(res, 3000));
          const st = await api.dataInfraTask(t.taskId).catch(() => null);
          const dt = st?.ok ? st.task : undefined;
          if (!dt) continue;
          if (dt.status === "done") { onReviewed(); return; }
          if (dt.status === "failed" || dt.status === "cancelled") { setErr(dt.lastResult || "复核失败"); return; }
        }
        setErr("复核超时");
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setReviewing(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const tp = targetPrice.trim() ? Number(targetPrice) : undefined;
      const r2 = await api.watchlistUpdate(groupId, {
        updateItems: [{
          code: item.code,
          ...(item.name ? { name: item.name } : {}),
          ...(item.kind ? { kind: item.kind } : {}),
          reason: item.reason,
          ...(expectation.trim() ? { expectation: expectation.trim() } : {}),
          ...(typeof tp === "number" && Number.isFinite(tp) && tp > 0 ? { targetPrice: tp } : {}),
          addedAt: item.addedAt,
        }],
      });
      if (r2.ok) {
        setEditing(false);
        onReviewed();
      } else setErr(r2.message ?? "保存失败");
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const loadHistory = async () => {
    if (history) { setHistory(null); return; }
    try {
      const r3 = await api.watchlistLogicHistory(groupId, item.code);
      if (r3.ok) setHistory(r3.reviews.filter((x): x is WatchLogicReview => !!x));
    } catch {
      setHistory([]);
    }
  };

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: "0.85rem 1rem", marginBottom: "0.7rem", background: "#fff" }}>
      {/* 头部：标的 + 状态徽标 + 操作 */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.4rem" }}>
        <a href={stockDetailUrl(item.code, item.kind)} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "none", fontWeight: 700 }}>
          {item.name ?? item.code} <span style={{ color: C.accent, fontSize: "0.75rem", fontWeight: 400 }}>{item.code} ↗</span>
        </a>
        <span style={{ color: C.faintest, fontSize: "0.72rem" }}>入选 {(item.addedAt ?? "").slice(0, 10)}</span>
        {r ? (
          <span style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
            <span style={{ background: PREMISE_COLOR[r.premise], color: "#fff", borderRadius: 999, padding: "0.08rem 0.5rem", fontSize: "0.7rem", fontWeight: 700 }} title="入选理由（前提）是否仍成立">
              理由 {PREMISE_TEXT[r.premise]}
            </span>
            <span style={{ background: EXPECT_COLOR[r.expectation], color: "#fff", borderRadius: 999, padding: "0.08rem 0.5rem", fontSize: "0.7rem", fontWeight: 700 }} title="预期是否达成">
              预期 {EXPECT_TEXT[r.expectation]}
            </span>
            <span style={{ background: SUGGEST_COLOR[r.suggestion], color: "#fff", borderRadius: 999, padding: "0.08rem 0.5rem", fontSize: "0.7rem", fontWeight: 700 }} title="建议动作">
              {SUGGEST_TEXT[r.suggestion]}
            </span>
          </span>
        ) : (
          <span style={{ background: C.bg, color: C.faint, border: `1px solid ${C.border}`, borderRadius: 999, padding: "0.08rem 0.5rem", fontSize: "0.7rem" }}>未复核</span>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" style={btnSmall} onClick={() => void review(false)} disabled={reviewing}>
          {reviewing ? "复核中…" : r ? "🔄 再次复核" : "🔍 逻辑复核"}
        </button>
        {r ? (
          <button type="button" style={{ ...btnSmall, background: "#fff", color: C.faint, border: `1px solid ${C.border}` }} onClick={() => void review(true)} disabled={reviewing}>
            强制
          </button>
        ) : null}
        <button type="button" style={{ ...btnSmall, background: "#fff", color: C.faint, border: `1px solid ${C.border}` }} onClick={() => setEditing((v) => !v)}>
          ✏️ 预期
        </button>
        {item.reviewCount > 0 ? (
          <button type="button" style={{ ...btnSmall, background: "#fff", color: C.faint, border: `1px solid ${C.border}` }} onClick={() => void loadHistory()}>
            {history ? "收起历史" : `历史 ${item.reviewCount}`}
          </button>
        ) : null}
      </div>

      {/* 入选理由（前提） */}
      <div style={{ fontSize: "0.84rem", lineHeight: 1.6, marginBottom: "0.35rem" }}>
        <span style={{ fontWeight: 600, color: C.faint }}>入选理由：</span>
        <span style={{ whiteSpace: "pre-wrap" }}>{item.reason || <span style={{ color: C.faintest }}>（未填写）</span>}</span>
      </div>

      {/* 预期编辑 / 展示 */}
      {editing ? (
        <div style={{ background: C.bg, borderRadius: 8, padding: "0.6rem 0.7rem", marginBottom: "0.4rem" }}>
          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginBottom: "0.4rem" }}>
            <input
              style={{ ...input, flex: 1, minWidth: 220, fontSize: "0.82rem" }}
              placeholder="预期（可验证的目标描述，如：Q3 业绩兑现 / 半年内估值修复到 25x）"
              value={expectation}
              onChange={(e) => setExpectation(e.target.value)}
            />
            <input
              style={{ ...input, width: 120, fontSize: "0.82rem" }}
              placeholder="目标价（可选）"
              type="number"
              value={targetPrice}
              onChange={(e) => setTargetPrice(e.target.value)}
            />
          </div>
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <button type="button" style={btnSmall} onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "✓ 保存"}</button>
            <button type="button" style={{ ...btnSmall, background: "#fff", color: C.faint, border: `1px solid ${C.border}` }} onClick={() => setEditing(false)}>取消</button>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: "0.84rem", lineHeight: 1.6, marginBottom: "0.35rem" }}>
          <span style={{ fontWeight: 600, color: C.faint }}>预期：</span>
          <span style={{ whiteSpace: "pre-wrap" }}>{item.expectation || <span style={{ color: C.faintest }}>（未填写，点击「✏️ 预期」补充，便于判定是否达成）</span>}</span>
          {typeof item.targetPrice === "number" ? <span style={{ color: C.accent }}> ｜目标价 {item.targetPrice}</span> : null}
        </div>
      )}

      {/* 确定性锚（非 LLM 的客观事实） */}
      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", fontSize: "0.78rem", color: C.faint, background: C.bg, borderRadius: 8, padding: "0.35rem 0.6rem", marginBottom: r ? "0.4rem" : 0 }}>
        <span title="入选日当天或之前最近的收盘价">基准 {fmtPrice(a.basePrice)}</span>
        <span title="实时快照">现价 {fmtPrice(a.price)}</span>
        <span title="入选以来的涨跌幅（确定性计算，非 LLM 推断）">
          入选以来 <b style={{ color: pctColor(a.sinceAddPct) }}>{fmtPct(a.sinceAddPct)}</b>
        </span>
        {typeof a.targetProgressPct === "number" ? (
          <span title="当前价 / 目标价 × 100（≥100% 即达成）">
            目标达成度 <b style={{ color: a.targetProgressPct >= 100 ? C.loss : C.faint }}>{a.targetProgressPct.toFixed(1)}%</b>
          </span>
        ) : null}
        <span title="扫描已启用新闻源命中的相关新闻条数（证据计数，确定性匹配）">相关新闻 {a.newsCount ?? 0} 条</span>
      </div>

      {/* 最近一次复核结论 */}
      {r ? (
        <div style={{ borderLeft: `3px solid ${SUGGEST_COLOR[r.suggestion]}`, background: C.bg, borderRadius: 8, padding: "0.5rem 0.7rem", fontSize: "0.82rem", lineHeight: 1.65 }}>
          <div style={{ color: C.faintest, fontSize: "0.72rem", marginBottom: "0.2rem" }}>
            最近复核 {(r.at ?? "").slice(0, 10)}{r.fromCache ? "（复用当日结论）" : ""}
          </div>
          <div><span style={{ fontWeight: 600 }}>证据：</span><span style={{ whiteSpace: "pre-wrap" }}>{r.evidence || "—"}</span></div>
          {r.note ? <div><span style={{ fontWeight: 600 }}>观察：</span><span style={{ whiteSpace: "pre-wrap" }}>{r.note}</span></div> : null}
        </div>
      ) : null}

      {/* 历史（时间序列） */}
      {history ? (
        <div style={{ marginTop: "0.5rem" }}>
          <SectionTitle>复核历史（{history.length}）</SectionTitle>
          {history.length === 0 ? (
            <Empty>暂无历史</Empty>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
              <thead>
                <tr>
                  <th style={{ ...thTd, background: "#f1f5f9", fontWeight: 600 }}>时间</th>
                  <th style={{ ...thTd, background: "#f1f5f9", fontWeight: 600 }}>理由</th>
                  <th style={{ ...thTd, background: "#f1f5f9", fontWeight: 600 }}>预期</th>
                  <th style={{ ...thTd, background: "#f1f5f9", fontWeight: 600 }}>建议</th>
                  <th style={{ ...thTd, background: "#f1f5f9", fontWeight: 600, textAlign: "left" }}>证据</th>
                </tr>
              </thead>
              <tbody>
                {[...history].reverse().map((h, i) => (
                  <tr key={i}>
                    <td style={{ ...thTd, whiteSpace: "nowrap" }}>{(h.at ?? "").slice(0, 10)}</td>
                    <td style={{ ...thTd, color: PREMISE_COLOR[h.premise], fontWeight: 600 }}>{PREMISE_TEXT[h.premise]}</td>
                    <td style={{ ...thTd, color: EXPECT_COLOR[h.expectation], fontWeight: 600 }}>{EXPECT_TEXT[h.expectation]}</td>
                    <td style={{ ...thTd, color: SUGGEST_COLOR[h.suggestion], fontWeight: 600 }}>{SUGGEST_TEXT[h.suggestion]}</td>
                    <td style={{ ...thTd, textAlign: "left", maxWidth: 420 }}><span style={{ whiteSpace: "pre-wrap" }}>{h.evidence}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      {err ? <div style={{ color: "#b91c1c", fontSize: "0.8rem", marginTop: "0.3rem" }}>{err}</div> : null}
    </div>
  );
}

export default function LogicPanel({ groupId, items }: { groupId: string; items: WatchItem[] }) {
  const [data, setData] = useState<import("@toolbox/shared").WatchLogicResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "pending" | "risk">("all");

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.watchlistLogic(groupId, force);
      if (r.ok) setData(r);
      else setErr(r.message ?? "加载失败");
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  if (loading && !data) return <Loading text="加载逻辑确认（采集行情锚点与新闻证据）…" />;
  if (err) return <div style={{ color: "#b91c1c", fontSize: "0.85rem" }}>{err}</div>;
  if (!data) return null;

  const risky = (it: WatchLogicItem) => !!it.review && it.review.suggestion !== "hold";
  const pending = (it: WatchLogicItem) => !it.review && !!(it.reason || it.expectation);
  const list = data.items.filter((it) => (filter === "pending" ? pending(it) : filter === "risk" ? risky(it) : true));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: "0.3rem" }}>
          {([
            { value: "all", label: `全部（${data.items.length}）` },
            { value: "pending", label: `待复核（${data.items.filter(pending).length}）` },
            { value: "risk", label: `逻辑动摇（${data.items.filter(risky).length}）` },
          ] as const).map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setFilter(o.value)}
              style={{
                padding: "0.28rem 0.7rem",
                borderRadius: 999,
                border: filter === o.value ? `1px solid ${C.accentBorder}` : "1px solid transparent",
                background: filter === o.value ? C.accentBg : "transparent",
                color: filter === o.value ? C.accent : C.faint,
                fontSize: "0.78rem",
                fontWeight: filter === o.value ? 700 : 500,
                cursor: "pointer",
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <button type="button" style={{ ...btnSmall, background: "#fff", color: C.faint, border: `1px solid ${C.border}` }} onClick={() => void load(true)} disabled={loading}>
          🔄 刷新
        </button>
      </div>

      <Caveats meta={data.meta} />
      <MetaBar meta={data.meta} />

      {items.length === 0 ? (
        <Empty>该分组暂无标的</Empty>
      ) : list.length === 0 ? (
        <Empty>没有符合该筛选条件的标的</Empty>
      ) : (
        list.map((it) => <LogicCard key={it.code} item={it} groupId={groupId} onReviewed={() => void load()} />)
      )}

      <SectionTitle>说明</SectionTitle>
      <div style={{ fontSize: "0.76rem", color: C.faint, lineHeight: 1.7 }}>
        · <b>确定性锚</b>（基准价、入选以来涨跌幅、目标达成度、相关新闻条数）由服务端采集计算，不经过 LLM，避免「裁判兼运动员」假收敛。<br />
        · <b>LLM 仅做定性判定</b>（理由是否成立 / 预期是否达成），输入为服务端采集的真实事实，禁止其自造数据。<br />
        · 每次复核落库形成<b>时间序列</b>，体现逻辑「随时间」的变化；同日同标的复用结论，节省成本（可强制复核）。
      </div>
    </div>
  );
}
