// ============================================================
// 自选股：以「标的」为核心，以「多级 tag」为筛选维度
// ------------------------------------------------------------
// 三栏布局（视口级，页面不整体滚动）：
//   左栏 = 标签列表（TagTree，可整体收起，紧凑）
//   中栏 = 标的列表（ItemList，以标的为核心，紧凑）
//   右栏 = 单一标的的四个功能面：行情跟踪（日/周/月）· 下沉分析（财报/新闻）· 提醒设置 · 逻辑确认
// 关键：四个功能面的服务对象是**单一标的**（不是分组、也不是 tag）。
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type {
  WatchItemRow,
  WatchPeriod,
  WatchTagNode,
} from "@toolbox/shared";
import { WATCH_ROOT_TAG } from "@toolbox/shared";
import { C, Empty, Loading, SegTabs, btnSmall, input, pctColor, fmtPct, fmtPrice, stockDetailUrl } from "./watchlist/shared";
import { ConfirmButton } from "./watchlist/ui";
import { useQuoteStream, mergeLiveQuotes } from "../hooks/useQuoteStream";
import { TagTree } from "./watchlist/TagTree";
import { ItemList, tagNameMap } from "./watchlist/ItemList";
import { TrackPanel } from "./watchlist/TrackPanel";
import { DeepDivePanel } from "./watchlist/DeepDivePanel";
import { AlertsPanel } from "./watchlist/AlertsPanel";
import { LogicPanel } from "./watchlist/LogicPanel";

type TabKey = "track" | "deepdive" | "alerts" | "logic";

const TABS: { value: TabKey; label: string }[] = [
  { value: "track", label: "行情跟踪" },
  { value: "deepdive", label: "下沉分析" },
  { value: "alerts", label: "提醒设置" },
  { value: "logic", label: "逻辑确认" },
];

/** 左栏（标签树）宽度（localStorage 记忆，frontend-experience §4 侧边栏拉伸） */
const LEFT_W_KEY = "watchlist:leftWidth";
const LEFT_DEFAULT = 224;
const LEFT_MIN = 170;
const LEFT_MAX = 420;
/** 左栏整体收起后的窄条宽度 */
const LEFT_COLLAPSED_W = 34;

/** 中栏（标的列表）宽度（localStorage 记忆） */
const MID_W_KEY = "watchlist:midWidth";
const MID_DEFAULT = 288;
const MID_MIN = 220;
const MID_MAX = 460;

function readLeftWidth(): number {
  const n = Number(localStorage.getItem(LEFT_W_KEY));
  return Number.isFinite(n) && n >= LEFT_MIN && n <= LEFT_MAX ? n : LEFT_DEFAULT;
}
function readMidWidth(): number {
  const n = Number(localStorage.getItem(MID_W_KEY));
  return Number.isFinite(n) && n >= MID_MIN && n <= MID_MAX ? n : MID_DEFAULT;
}
/** 左栏整体收起（仅留窄条 + 展开按钮），给中栏更多横向空间 */
const LEFT_COLLAPSED_KEY = "watchlist:leftCollapsed";
function readLeftCollapsed(): boolean {
  return localStorage.getItem(LEFT_COLLAPSED_KEY) === "1";
}

/** 竖直分栏拖拽把手（左右调宽） */
function DragHandle({
  onStart,
  onDoubleClick,
  title,
}: {
  onStart: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  title: string;
}) {
  return (
    <div
      onMouseDown={onStart}
      onDoubleClick={onDoubleClick}
      title={title}
      style={{
        flexShrink: 0,
        background: "transparent",
        cursor: "col-resize",
        width: 5,
        borderLeft: `1px solid ${C.border}`,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = C.accentBorder)}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    />
  );
}

export function WatchlistTool() {
  const [tags, setTags] = useState<WatchTagNode[]>([]);
  const [items, setItems] = useState<WatchItemRow[]>([]);
  const [allItems, setAllItems] = useState<WatchItemRow[]>([]);
  const [selectedTag, setSelectedTag] = useState<string>(WATCH_ROOT_TAG);
  const [selectedCode, setSelectedCode] = useState<string>("");
  const [tab, setTab] = useState<TabKey>("track");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [leftWidth, setLeftWidth] = useState(readLeftWidth);
  const [midWidth, setMidWidth] = useState(readMidWidth);
  const [leftCollapsed, setLeftCollapsed] = useState(readLeftCollapsed);
  const dragRef = useRef<{ x: number; w: number; which: "left" | "mid" } | null>(null);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const midRef = useRef<HTMLDivElement | null>(null);

  const errOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  // ---------- 数据加载 ----------

  /** 首屏：tag 树 + 全量标的 */
  const loadAll = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const r = await api.watchlistTags();
      setTags(r.tags ?? []);
      setAllItems(r.items ?? []);
      if (r.tags && r.tags.length > 0 && !r.tags.some((t) => t.id === selectedTag)) {
        setSelectedTag(r.tags[0].id); // 默认落在根 tag「全部」
      }
    } catch (e) {
      setErr(`加载失败：${errOf(e)}`);
    } finally {
      setLoading(false);
    }
  }, [selectedTag]);

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 按 tag 刷新标的列表（tag 切换时触发） */
  const loadItems = useCallback(async (tagId: string) => {
    try {
      const r = await api.watchlistItems(tagId === WATCH_ROOT_TAG ? null : tagId);
      setItems(r.items ?? []);
    } catch (e) {
      setErr(`加载标的失败：${errOf(e)}`);
    }
  }, []);

  useEffect(() => {
    if (tags.length === 0) return;
    void loadItems(selectedTag);
  }, [selectedTag, tags.length, loadItems]);

  // ---------- 实时行情（SSE 流，多面板共享一条连接） ----------
  // 只订阅当前可见的标的：切 tag 后自动换成新的代码集合（旧集合随引用计数归零而停推）
  const visibleCodes = useMemo(() => items.map((i) => i.code), [items]);
  const live = useQuoteStream(visibleCodes);
  /** 列表数据 + 实时行情（实时值优先，列表自带的价/涨跌作为兜底） */
  const liveItems = useMemo(() => mergeLiveQuotes(items, live.quotes), [items, live.quotes]);
  const liveCurrent = useMemo(() => liveItems.find((x) => x.code === selectedCode) ?? null, [liveItems, selectedCode]);

  /** 选中项跟随列表：切 tag 后若当前标的已不在列表，默认选第一只 */
  const current = useMemo(() => items.find((x) => x.code === selectedCode) ?? null, [items, selectedCode]);
  useEffect(() => {
    if (items.length === 0) {
      if (selectedCode) setSelectedCode("");
      return;
    }
    if (!items.some((x) => x.code === selectedCode)) setSelectedCode(items[0].code);
  }, [items, selectedCode]);

  // ---------- 操作回调（成功后局部刷新，不整页重载） ----------

  const refreshTags = useCallback(async () => {
    const r = await api.watchlistTags();
    setTags(r.tags ?? []);
    setAllItems(r.items ?? []);
  }, []);

  /** 通用操作包装：错误统一提示，成功提示可选 */
  const run = useCallback(
    async (fn: () => Promise<unknown>, okMsg?: string) => {
      setErr("");
      try {
        await fn();
        if (okMsg) setInfo(okMsg);
        await refreshTags();
        await loadItems(selectedTag);
      } catch (e) {
        setErr(errOf(e));
        // 目标被删（404）等情况：回退到根 tag，避免停在空列表
        const status = (e as { status?: number } | null)?.status;
        if (status === 404) setSelectedTag(WATCH_ROOT_TAG);
      }
    },
    [refreshTags, loadItems, selectedTag],
  );

  const onCreateTag = (name: string, parentId: string) =>
    run(async () => {
      await api.watchlistTagCreate({ name, parentId });
    }, `已创建标签「${name}」`);

  const onRenameTag = (id: string, name: string) =>
    run(async () => {
      await api.watchlistTagUpdate(id, { name });
    }, "已重命名");

  const onMoveTag = (id: string, parentId: string) =>
    run(async () => {
      await api.watchlistTagUpdate(id, { parentId });
    }, "已移动标签");

  const onDeleteTag = (id: string, mode: "promote" | "cascade") =>
    run(async () => {
      const r = await api.watchlistTagDelete(id, mode);
      setInfo(`已删除 ${r.deletedTags ?? 1} 个标签（影响 ${r.affectedItems ?? 0} 个标的）`);
    });

  const onAddItem = async (payload: {
    code: string;
    name?: string;
    kind?: "stock" | "fund";
    reason?: string;
    expectation?: string;
    targetPrice?: number;
    tags?: string[];
  }) => {
    setErr("");
    try {
      await api.watchlistItemCreate(payload);
      setInfo(`已添加标的 ${payload.code}`);
      await refreshTags();
      await loadItems(selectedTag);
      setSelectedCode(payload.code);
    } catch (e) {
      setErr(errOf(e));
    }
  };

  /** 删除标的：连带清理其提醒规则/命中/复核历史（由 store.deleteItem 保证） */
  const onDeleteItem = (code: string) =>
    run(async () => {
      await api.watchlistItemDelete(code);
      setSelectedCode("");
    }, `已删除标的 ${code}`);

  const onUpdateItem = (code: string, patch: Parameters<typeof api.watchlistItemUpdate>[1]) =>
    run(async () => {
      await api.watchlistItemUpdate(code, patch);
    }, "已保存");

  // ---------- 左栏宽度 / 中栏宽度 拖拽 ----------
  const startDrag = (which: "left" | "mid") => (e: React.MouseEvent) => {
    dragRef.current = { x: e.clientX, w: which === "left" ? leftWidth : midWidth, which };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = e.clientX - d.x;
      if (d.which === "left") {
        setLeftWidth(Math.min(LEFT_MAX, Math.max(LEFT_MIN, d.w + delta)));
      } else {
        setMidWidth(Math.min(MID_MAX, Math.max(MID_MIN, d.w + delta)));
      }
    };
    const onUp = () => {
      if (!dragRef.current) return;
      const which = dragRef.current.which;
      dragRef.current = null;
      if (which === "left") localStorage.setItem(LEFT_W_KEY, String(leftWidth));
      else localStorage.setItem(MID_W_KEY, String(midWidth));
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [leftWidth, midWidth]);

  // ---------- 渲染 ----------

  const tagName = useMemo(() => {
    const find = (nodes: WatchTagNode[]): WatchTagNode | null => {
      for (const n of nodes) {
        if (n.id === selectedTag) return n;
        const hit = find(n.children);
        if (hit) return hit;
      }
      return null;
    };
    return find(tags)?.name ?? "全部";
  }, [tags, selectedTag]);

  return (
    <div style={{ height: "calc(100dvh - 56px)", display: "flex", flexDirection: "column", boxSizing: "border-box", overflow: "hidden" }}>
      <div style={{ padding: "0.5rem 1rem 0.6rem", flexShrink: 0 }}>
        <div style={{ fontSize: "1.05rem", fontWeight: 800, color: C.text }}>📌 自选股</div>
        <div style={{ fontSize: "0.78rem", color: C.faintest, marginTop: "0.1rem" }}>
          以标的为核心：左侧按多级 tag 筛选，右侧是单一标的的四个功能面
        </div>
      </div>

      {err ? (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", borderRadius: 8, padding: "0.5rem 0.8rem", fontSize: "0.83rem", marginBottom: "0.5rem" }}>
          {err}
        </div>
      ) : null}
      {info ? (
        <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#15803d", borderRadius: 8, padding: "0.5rem 0.8rem", fontSize: "0.83rem", marginBottom: "0.5rem" }}>
          ✅ {info}
        </div>
      ) : null}

      {/* 主区：左标签树 + 中标的数据列表 + 右单标的详情（各自独立滚动） */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "stretch", gap: 0 }}>
        {/* 左栏：标签树（可整体收起） */}
        {leftCollapsed ? (
          <div
            ref={leftRef}
            style={{
              width: LEFT_COLLAPSED_W,
              flexShrink: 0,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              borderRight: `1px solid ${C.border}`,
              background: "#fff",
              cursor: "pointer",
            }}
            title="展开标签树"
            onClick={() => {
              setLeftCollapsed(false);
              localStorage.setItem(LEFT_COLLAPSED_KEY, "0");
            }}
          >
            <div style={{ padding: "0.5rem 0", fontSize: "1rem", color: C.accent, writingMode: "vertical-rl", letterSpacing: "0.15rem" }}>
              🏷 标签
            </div>
          </div>
        ) : (
          <aside
            ref={leftRef}
            style={{
              width: leftWidth,
              flexShrink: 0,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              borderRight: `1px solid ${C.border}`,
              background: "#fff",
            }}
          >
            <TagTree
              tags={tags}
              selected={selectedTag}
              onCollapse={() => {
                setLeftCollapsed(true);
                localStorage.setItem(LEFT_COLLAPSED_KEY, "1");
              }}
              onSelect={setSelectedTag}
              onCreate={onCreateTag}
              onRename={onRenameTag}
              onMove={onMoveTag}
              onDelete={onDeleteTag}
            />
          </aside>
        )}

        {/* 左栏宽度拖拽把手（收起时隐藏） */}
        {leftCollapsed ? null : (
          <DragHandle onStart={startDrag("left")} onDoubleClick={() => setLeftWidth(LEFT_DEFAULT)} title="拖动调整标签树宽度（双击复位）" />
        )}

        {/* 中栏：标的列表（以标的为核心） */}
        <aside
          ref={midRef}
          style={{
            width: midWidth,
            flexShrink: 0,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            borderRight: `1px solid ${C.border}`,
            background: "#fff",
          }}
        >
          <ItemList
            items={liveItems}
            allTags={tags}
            selectedCode={selectedCode}
            tagName={tagName}
            live={live.connected}
            onSelect={setSelectedCode}
            onAdd={onAddItem}
            onUpdateTags={(code, nextTags) => onUpdateItem(code, { tags: nextTags })}
          />
        </aside>

        {/* 中栏宽度拖拽把手 */}
        <DragHandle onStart={startDrag("mid")} onDoubleClick={() => setMidWidth(MID_DEFAULT)} title="拖动调整标的列表宽度（双击复位）" />

        {/* 右栏：单一标的的四个功能面 */}
        <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {loading ? (
            <div style={{ padding: "1rem" }}>
              <Loading text="加载自选股…" />
            </div>
          ) : !liveCurrent ? (
            <div style={{ padding: "1rem" }}>
              <Empty>{items.length === 0 ? `「${tagName}」下暂无标的——先在中栏添加，或换个标签` : "请在中栏选择一个标的"}</Empty>
            </div>
          ) : (
            <ItemDetail
              item={liveCurrent}
              tab={tab}
              onTabChange={setTab}
              onUpdate={onUpdateItem}
              onDelete={onDeleteItem}
              allTags={tags}
            />
          )}
        </main>
      </div>
    </div>
  );
}

// ============================================================
// 右栏：单一标的的头部 + 四个功能面
// ============================================================

function ItemDetail({
  item,
  tab,
  onTabChange,
  onUpdate,
  onDelete,
  allTags,
}: {
  item: WatchItemRow;
  tab: TabKey;
  onTabChange: (t: TabKey) => void;
  onUpdate: (code: string, patch: Parameters<typeof api.watchlistItemUpdate>[1]) => Promise<void>;
  onDelete: (code: string) => Promise<void>;
  allTags: WatchTagNode[];
}) {
  /** 标签 id → 名称（一律显示名称，不显示 id 编码） */
  const nameById = useMemo(() => tagNameMap(allTags), [allTags]);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState(item.reason ?? "");
  const [expectation, setExpectation] = useState(item.expectation ?? "");
  const [targetPrice, setTargetPrice] = useState(typeof item.targetPrice === "number" ? String(item.targetPrice) : "");
  const [saving, setSaving] = useState(false);

  // 切标的时同步表单（受控输入需跟随 props）
  useEffect(() => {
    setEditing(false);
    setReason(item.reason ?? "");
    setExpectation(item.expectation ?? "");
    setTargetPrice(typeof item.targetPrice === "number" ? String(item.targetPrice) : "");
  }, [item.code, item.reason, item.expectation, item.targetPrice]);

  const save = async () => {
    setSaving(true);
    const tp = targetPrice.trim() === "" ? null : Number(targetPrice);
    await onUpdate(item.code, {
      reason,
      expectation,
      targetPrice: tp === null || !Number.isFinite(tp) ? null : tp,
    });
    setSaving(false);
    setEditing(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      {/* 标的头部：核心信息 + 编辑（强调标的的核心位置） */}
      <div style={{ padding: "0.5rem 0.9rem 0.45rem", borderBottom: `1px solid ${C.border}`, background: "#fff", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
          <a
            href={stockDetailUrl(item.code, item.kind)}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: "1.15rem", fontWeight: 800, color: C.text, textDecoration: "none" }}
            title="在雪球查看该标的"
          >
            {item.name || item.code}
          </a>
          <span style={{ fontSize: "0.78rem", color: C.faintest, fontFamily: "ui-monospace, monospace" }}>{item.code}</span>
          {item.kind === "fund" ? (
            <span style={{ fontSize: "0.7rem", background: C.accentBg, color: C.accent, borderRadius: 4, padding: "0 0.35rem" }}>场外基金</span>
          ) : null}
          <span style={{ fontSize: "1.05rem", fontWeight: 700, color: pctColor(item.pct) }}>{fmtPrice(item.price)}</span>
          <span style={{ fontSize: "0.85rem", fontWeight: 600, color: pctColor(item.pct) }}>{fmtPct(item.pct)}</span>
          <span style={{ flex: 1 }} />
          {editing ? (
            <>
              <button type="button" style={btnSmall} disabled={saving} onClick={() => void save()}>
                {saving ? "保存中…" : "💾 保存"}
              </button>
              <button type="button" style={{ ...btnSmall, background: "#f1f5f9", color: C.text }} onClick={() => setEditing(false)}>
                取消
              </button>
            </>
          ) : (
            <button type="button" style={{ ...btnSmall, background: "#f1f5f9", color: C.text }} onClick={() => setEditing(true)}>
              ✏️ 编辑理由/预期
            </button>
          )}
          <ConfirmButton
            variant="outline"
            title={`删除标的「${item.name || item.code}」`}
            confirmText="删除标的"
            description={
              <>
                将删除标的 <b>{item.name || item.code}</b>（{item.code}）及其<b>全部相关数据</b>：
                提醒规则、提醒命中记录、逻辑复核历史都会一并清除，且<b>不可恢复</b>。
                <br />
                如果只是不想在当前标签看到它，请用标签行上的「✕ 移出标签」。
              </>
            }
            onConfirm={() => onDelete(item.code)}
          >
            🗑 删除标的
          </ConfirmButton>
        </div>

        {/* 所属 tag 标签（可增删 → 直接改标的归属） */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem", marginTop: "0.3rem", alignItems: "center" }}>
          <span style={{ fontSize: "0.72rem", color: C.faintest }}>标签：</span>
          {item.tags.length === 0 ? (
            <span style={{ fontSize: "0.72rem", color: C.faintest }}>（无，仅在「全部」可见）</span>
          ) : (
            item.tags.map((t) => (
              <span
                key={t}
                style={{
                  fontSize: "0.72rem",
                  background: C.accentBg,
                  color: C.accent,
                  border: `1px solid ${C.accentBorder}`,
                  borderRadius: 999,
                  padding: "0.02rem 0.45rem",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.2rem",
                }}
              >
                {nameById.get(t) ?? t}
                <button
                  type="button"
                  title={`从标签「${nameById.get(t) ?? t}」移除`}
                  onClick={() => void onUpdate(item.code, { tags: item.tags.filter((x) => x !== t) })}
                  style={{ border: "none", background: "transparent", color: C.accent, cursor: "pointer", padding: 0, fontSize: "0.8rem", lineHeight: 1 }}
                >
                  ✕
                </button>
              </span>
            ))
          )}
          <TagAdder allTags={allTags} owned={item.tags} onAdd={(t) => void onUpdate(item.code, { tags: [...item.tags, t] })} />
        </div>

        {/* 编辑区：入选理由 / 预期 / 目标价 */}
        {editing ? (
          <div style={{ display: "grid", gridTemplateColumns: "2fr 2fr 1fr", gap: "0.5rem", marginTop: "0.6rem" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={{ fontSize: "0.75rem", color: C.faint, fontWeight: 600 }}>入选理由</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="为什么选它（逻辑确认的「前提」）"
                style={{ ...input, minHeight: 56, lineHeight: 1.6, resize: "vertical" }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={{ fontSize: "0.75rem", color: C.faint, fontWeight: 600 }}>预期</span>
              <textarea
                value={expectation}
                onChange={(e) => setExpectation(e.target.value)}
                placeholder="可验证的目标（如 Q3 业绩兑现 / 半年内估值修复到 25x）"
                style={{ ...input, minHeight: 56, lineHeight: 1.6, resize: "vertical" }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={{ fontSize: "0.75rem", color: C.faint, fontWeight: 600 }}>目标价（可选）</span>
              <input
                value={targetPrice}
                onChange={(e) => setTargetPrice(e.target.value)}
                inputMode="decimal"
                step="0.01"
                placeholder="如 1800"
                style={input}
              />
            </label>
          </div>
        ) : (
          <div
            style={{
              marginTop: "0.25rem",
              fontSize: "0.75rem",
              color: C.faint,
              display: "flex",
              gap: "0.75rem",
              flexWrap: "wrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <span title={`入选理由：${item.reason || "未填写"}`}>📝 {item.reason || "（未填写）"}</span>
            {item.expectation ? <span title={`预期：${item.expectation}`}>🎯 {item.expectation}</span> : null}
            {typeof item.targetPrice === "number" ? <span title="目标价">🏷 {item.targetPrice}</span> : null}
            <span title="入选时间">🕒 {String(item.addedAt).slice(0, 10)}</span>
          </div>
        )}
      </div>

      {/* 四个功能面 Tab */}
      <div style={{ padding: "0.25rem 0.9rem 0", borderBottom: `1px solid ${C.border}`, flexShrink: 0, background: "#fff" }}>
        <SegTabs value={tab} options={TABS} onChange={onTabChange} />
      </div>

      {/* 面板内容（独立滚动） */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0.55rem 0.9rem 1.2rem" }}>
        {tab === "track" ? <TrackPanel code={item.code} name={item.name} kind={item.kind} /> : null}
        {tab === "deepdive" ? (
          <DeepDivePanel code={item.code} name={item.name} kind={item.kind} onReason={(r) => onUpdate(item.code, { reason: r })} />
        ) : null}
        {tab === "alerts" ? <AlertsPanel code={item.code} name={item.name} /> : null}
        {tab === "logic" ? <LogicPanel code={item.code} name={item.name} /> : null}
      </div>
    </div>
  );
}



/** 给标的追加 tag 的小下拉 */
function TagAdder({
  allTags,
  owned,
  onAdd,
}: {
  allTags: WatchTagNode[];
  owned: string[];
  onAdd: (tagId: string) => void;
}) {
  const flat = useMemo(() => {
    const out: { id: string; name: string; depth: number }[] = [];
    const walk = (nodes: WatchTagNode[], depth: number) => {
      for (const n of nodes) {
        if (n.id !== WATCH_ROOT_TAG) out.push({ id: n.id, name: n.name, depth });
        walk(n.children, depth + 1);
      }
    };
    walk(allTags, 0);
    return out;
  }, [allTags]);

  const candidates = flat.filter((t) => !owned.includes(t.id));
  if (candidates.length === 0) return null;

  return (
    <select
      value=""
      onChange={(e) => {
        if (e.target.value) onAdd(e.target.value);
        e.currentTarget.value = "";
      }}
      title="添加到标签"
      style={{ ...input, padding: "0.1rem 0.3rem", fontSize: "0.75rem", borderRadius: 999, width: "auto", maxWidth: 120 }}
    >
      <option value="">＋ 标签</option>
      {candidates.map((t) => (
        <option key={t.id} value={t.id}>
          {"　".repeat(t.depth)}
          {t.name}
        </option>
      ))}
    </select>
  );
}

export type { WatchPeriod };

/** 默认导出（App.tsx 路由表以 default 方式引入） */
export default WatchlistTool;
