// ============================================================
// 自选股·左侧筛选区（下）：标的列表（以标的为核心）
// ------------------------------------------------------------
// 每行 = 一个标的：名称/代码 + 现价/涨跌 + 待复核/已触发徽章 + 移除
// 点击行 → 右侧展示该标的的四个功能面（标的是操作主体，tag 只是筛选条件）
// 添加标的：代码输入（联想补全）+ 理由，默认挂到当前筛选的 tag
// ============================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { WATCH_ROOT_TAG, type WatchItemRow, type WatchTagNode } from "@toolbox/shared";
import { C, Empty, Loading, input, pctColor, fmtPct, fmtPrice } from "./shared";
import { ConfirmButton } from "./ui";

/** 标签 id → 名称映射（显示用；未命中的 id 原样返回，便于发现脏数据） */
export function tagNameMap(nodes: WatchTagNode[], out: Map<string, string> = new Map()): Map<string, string> {
  for (const n of nodes) {
    out.set(n.id, n.name);
    tagNameMap(n.children, out);
  }
  return out;
}

// ---------- 排序 ----------

/** 排序键：仅按涨跌幅（列表核心诉求是「今天谁涨谁跌」） */
type SortKey = "pct";

const SORT_DESC_STORE = "watchlist:sortDesc";

/**
 * 按日涨跌幅排序（纯前端；列表规模有限，避免为排序再打一次接口）。
 * 无行情的恒排最后（不参与方向翻转），避免 undefined 参与比较产生 NaN 序。
 */
function sortItems(list: WatchItemRow[], desc: boolean): WatchItemRow[] {
  const dir = desc ? -1 : 1;
  const out = [...list];
  out.sort((a, b) => {
    const av = typeof a.pct === "number";
    const bv = typeof b.pct === "number";
    if (!av && !bv) return 0;
    if (!av) return 1;
    if (!bv) return -1;
    return ((a.pct as number) - (b.pct as number)) * dir;
  });
  return out;
}

export function ItemList({
  items,
  allTags,
  selectedCode,
  tagName,
  onSelect,
  onAdd,
  onUpdateTags,
}: {
  items: WatchItemRow[];
  allTags: WatchTagNode[];
  selectedCode: string;
  tagName: string;
  onSelect: (code: string) => void;
  onAdd: (payload: {
    code: string;
    name?: string;
    kind?: "stock" | "fund";
    reason?: string;
    expectation?: string;
    targetPrice?: number;
    tags?: string[];
  }) => Promise<void>;
  onUpdateTags: (code: string, tags: string[]) => Promise<void>;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState<"stock" | "fund">("stock");
  const [candidates, setCandidates] = useState<{ code: string; name: string; market: string; type: string }[]>([]);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState("");
  const searchTimer = useRef<number | null>(null);
  // 排序偏好（仅升/降序，localStorage 记忆）
  const [sortDesc, setSortDesc] = useState<boolean>(() => localStorage.getItem(SORT_DESC_STORE) !== "0");

  const sorted = useMemo(() => sortItems(items, sortDesc), [items, sortDesc]);

  /** 点击「涨跌」切换升/降序 */
  const toggleSort = () => {
    const next = !sortDesc;
    setSortDesc(next);
    localStorage.setItem(SORT_DESC_STORE, next ? "1" : "0");
  };

  // 代码联想（防抖 + 竞态保护：只接受最后一次请求的结果）
  useEffect(() => {
    const q = code.trim();
    if (q.length === 0) {
      setCandidates([]);
      return;
    }
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      let alive = true;
      api
        .watchlistSearchStock(q, 8)
        .then((r) => {
          if (alive) setCandidates(r.items ?? []);
        })
        .catch(() => {
          if (alive) setCandidates([]);
        });
      // 竞态保护：后续 effect 会把 alive 置 false（闭包捕获，见 frontend-experience §6.1）
      return () => {
        alive = false;
      };
    }, 260);
    return () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current);
    };
  }, [code]);

  const currentTagId = useMemo(() => {
    // 当前筛选的 tag（用于「添加到当前标签」）；根 tag 下新增的标的仅属「全部」
    const find = (nodes: WatchTagNode[]): WatchTagNode | null => {
      for (const n of nodes) {
        if (n.name === tagName) return n;
        const hit = find(n.children);
        if (hit) return hit;
      }
      return null;
    };
    const hit = find(allTags);
    return hit && hit.id !== WATCH_ROOT_TAG ? hit.id : null;
  }, [allTags, tagName]);

  /** 标签 id → 名称（列表/徽章一律显示名称，不显示 id 编码） */
  const nameById = useMemo(() => tagNameMap(allTags), [allTags]);

  const submit = async () => {
    const c = code.trim();
    if (!c) {
      setErr("请输入标的代码");
      return;
    }
    setAdding(true);
    setErr("");
    try {
      await onAdd({
        code: c,
        kind,
        reason: reason.trim() || undefined,
        tags: currentTagId ? [currentTagId] : [],
      });
      setCode("");
      setReason("");
      setCandidates([]);
      setShowAdd(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const pick = (c: { code: string; name: string }) => {
    setCode(c.code);
    setCandidates([]);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      {/* 行内「移出标签」按钮平时隐藏，悬停整行才出现，避免窄栏拥挤 */}
      <style>{`.wl-itemrow .wl-rowacts{opacity:0;transition:opacity .12s} .wl-itemrow:hover .wl-rowacts{opacity:1}`}</style>
      <div style={{ display: "flex", alignItems: "center", gap: "0.3rem", padding: "0.3rem 0.5rem", borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <span style={{ width: 3, height: 12, borderRadius: 999, background: C.accent, flexShrink: 0 }} />
        <span style={{ fontWeight: 700, fontSize: "0.82rem", color: C.text }}>🎯 标的</span>
        <span style={{ fontSize: "0.72rem", color: C.faintest, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${tagName} · ${items.length} 只`}>
          {tagName} · {items.length}
        </span>
        <span style={{ flex: 1 }} />
        {/* 排序：仅按涨跌幅，点击切升/降序 */}
        <button
          type="button"
          title={sortDesc ? "当前：涨幅从高到低，点击切换为从低到高" : "当前：涨幅从低到高，点击切换为从高到低"}
          onClick={toggleSort}
          style={{
            border: "none",
            background: C.accentBg,
            color: C.accent,
            fontWeight: 700,
            fontSize: "0.72rem",
            padding: "0.05rem 0.35rem",
            borderRadius: 999,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          涨跌{sortDesc ? "↓" : "↑"}
        </button>
        <button
          type="button"
          title="添加标的"
          onClick={() => setShowAdd((v) => !v)}
          style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: "0.95rem", color: C.accent, padding: "0 0.2rem", lineHeight: 1 }}
        >
          ✚
        </button>
      </div>

      {showAdd ? (
        <div style={{ padding: "0.5rem 0.6rem", borderBottom: `1px solid ${C.border}`, flexShrink: 0, background: "#fcfdff" }}>
          <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
            <select value={kind} onChange={(e) => setKind(e.target.value as "stock" | "fund")} style={{ ...input, width: 74, fontSize: "0.78rem", padding: "0.25rem 0.3rem" }}>
              <option value="stock">股票/ETF</option>
              <option value="fund">场外基金</option>
            </select>
            <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
              <input
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                  if (e.key === "Escape") setShowAdd(false);
                }}
                placeholder="代码或名称（如 600519 / 茅台）"
                style={{ ...input, width: "100%", fontSize: "0.8rem", padding: "0.25rem 0.45rem" }}
              />
              {candidates.length > 0 ? (
                <div
                  style={{
                    position: "absolute",
                    zIndex: 30,
                    top: "100%",
                    left: 0,
                    right: 0,
                    background: "#fff",
                    border: `1px solid ${C.border}`,
                    borderRadius: 8,
                    boxShadow: "0 6px 18px rgba(15,23,42,0.12)",
                    maxHeight: 200,
                    overflowY: "auto",
                  }}
                >
                  {candidates.map((c) => (
                    <div
                      key={c.code}
                      onMouseDown={(e) => {
                        e.preventDefault(); // 先于 blur 触发，避免候选被清空
                        pick(c);
                      }}
                      style={{ padding: "0.3rem 0.5rem", fontSize: "0.78rem", cursor: "pointer", borderBottom: `1px solid #f1f5f9` }}
                    >
                      <span style={{ color: C.text, fontWeight: 600 }}>{c.name}</span>
                      <span style={{ color: C.faintest, marginLeft: "0.4rem", fontFamily: "ui-monospace, monospace" }}>{c.code}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") setShowAdd(false);
            }}
            placeholder="入选理由（可选）"
            style={{ ...input, width: "100%", marginTop: "0.35rem", fontSize: "0.78rem", padding: "0.25rem 0.45rem" }}
          />
          <div style={{ display: "flex", gap: "0.35rem", marginTop: "0.35rem", alignItems: "center" }}>
            <button
              type="button"
              disabled={adding}
              onClick={() => void submit()}
              style={{
                border: "none",
                background: C.accent,
                color: "#fff",
                borderRadius: 6,
                padding: "0.28rem 0.7rem",
                fontSize: "0.78rem",
                fontWeight: 600,
                cursor: "pointer",
                opacity: adding ? 0.55 : 1,
              }}
            >
              {adding ? "添加中…" : "添加"}
            </button>
            <button
              type="button"
              onClick={() => setShowAdd(false)}
              style={{ border: `1px solid ${C.border}`, background: "#fff", color: C.faint, borderRadius: 6, padding: "0.28rem 0.7rem", fontSize: "0.78rem", cursor: "pointer" }}
            >
              收起
            </button>
            <span style={{ fontSize: "0.72rem", color: C.faintest }}>
              {currentTagId ? `将加入「${tagName}」` : "将只属于「全部」"}
            </span>
          </div>
          {err ? <div style={{ color: "#dc2626", fontSize: "0.75rem", marginTop: "0.3rem" }}>{err}</div> : null}
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {sorted.length === 0 ? (
          <Empty>该标签下暂无标的</Empty>
        ) : (
          sorted.map((it) => {
            const active = it.code === selectedCode;
            // 该标的的其它标签名（当前筛选标签之外的；显示名称而非 id）
            const otherNames = it.tags
              .filter((t) => t !== currentTagId)
              .map((t) => nameById.get(t) ?? t)
              .slice(0, 2);

            return (
              <div
                key={it.code}
                onClick={() => onSelect(it.code)}
                className="wl-itemrow"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.3rem",
                  padding: "0.2rem 0.5rem",
                  cursor: "pointer",
                  borderBottom: `1px solid #f1f5f9`,
                  background: active ? C.accentBg : "transparent",
                  borderLeft: active ? `3px solid ${C.accent}` : "3px solid transparent",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "0.78rem", fontWeight: active ? 700 : 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {it.name || it.code}
                    {it.reviewCount ? <span style={{ marginLeft: "0.25rem", fontSize: "0.66rem" }} title="待逻辑复核">🧭</span> : null}
                    {it.alertCount ? <span style={{ marginLeft: "0.15rem", fontSize: "0.66rem" }} title="已触发提醒">🔔{it.alertCount}</span> : null}
                  </div>
                  <div style={{ fontSize: "0.66rem", color: C.faintest, display: "flex", gap: "0.25rem", alignItems: "center", minWidth: 0 }}>
                    <span style={{ fontFamily: "ui-monospace, monospace" }}>{it.code}</span>
                    {otherNames.length > 0 ? (
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`同时属于：${otherNames.join("、")}`}>
                        · {otherNames.join("、")}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: "0.78rem", fontWeight: 600, color: pctColor(it.pct) }}>{fmtPrice(it.price)}</div>
                  <div style={{ fontSize: "0.68rem", color: pctColor(it.pct) }}>{fmtPct(it.pct)}</div>
                </div>
                {currentTagId ? (
                  <span className="wl-rowacts" style={{ flexShrink: 0 }}>
                    <ConfirmButton
                      title="移出当前标签"
                      confirmText="移出"
                      description={
                        <>
                          将 <b>{it.name || it.code}</b> 从标签 <b>{tagName}</b> 中移出。
                          <br />
                          标的本身<b>不会被删除</b>，仍保留在它所属的其它标签下。
                        </>
                      }
                      onConfirm={() => onUpdateTags(it.code, it.tags.filter((t) => t !== currentTagId))}
                    >
                      ✕
                    </ConfirmButton>
                  </span>
                ) : (
                  <span style={{ width: 6 }} />
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** 列表加载态（供外部按需使用） */
export function ItemListLoading() {
  return <Loading text="加载标的…" />;
}
