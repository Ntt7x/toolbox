// ============================================================
// 自选股·左栏：tag 树管理
// ------------------------------------------------------------
// 手写树（vscode 资源管理器范式；shadcn 生态无文件树组件，见 frontend-experience §9）：
//   默认展开一级 · 折叠箭头与点击选择分离 · 内联重命名 · hover 操作按钮 · 拖拽移动改层级
// 每行：缩进 · 折叠箭头 · 标签名 · 标的数 · 平均涨跌幅 · 新建/重命名/删除
// 删除走 ConfirmButton（确认模态），避免误删。紧凑布局（左栏较窄）。
//
// 顶级 tag「全部」**不渲染为树节点**，其功能合并进本区头部：
//   · 点头部「全部」= 不筛选（等价选中根 tag）
//   · 拖拽 tag 到头部 = 移到顶层（挂到根下）
//   理由：「全部」是筛选的缺省态而非一个分类，占一行会挤占真实分类的空间。
// ============================================================

import { useEffect, useMemo, useState } from "react";
import { WATCH_ROOT_TAG, type WatchTagNode } from "@toolbox/shared";
import { C, fmtPct, input, pctColor } from "./shared";
import { ConfirmButton } from "./ui";

export function TagTree({
  tags,
  selected,
  onCollapse,
  onSelect,
  onCreate,
  onRename,
  onMove,
  onDelete,
}: {
  tags: WatchTagNode[];
  selected: string;
  /** 折叠整个左栏（由外层 WatchlistTool 管理收起态） */
  onCollapse?: () => void;
  onSelect: (id: string) => void;
  onCreate: (name: string, parentId: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onMove: (id: string, parentId: string) => Promise<void>;
  onDelete: (id: string, mode: "promote" | "cascade") => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  // 默认展开一级（更深的收起）——避免首屏刷屏
  useEffect(() => {
    if (tags.length === 0) return;
    setCollapsed((prev) => {
      if (prev.size > 0) return prev; // 只初始化一次，保留用户折叠状态
      const next = new Set<string>();
      const walk = (nodes: WatchTagNode[], depth: number) => {
        for (const n of nodes) {
          if (depth >= 1) next.add(n.id);
          walk(n.children, depth + 1);
        }
      };
      walk(tags, 0);
      return next;
    });
  }, [tags]);

  /** 当前选中的标签名（折叠时在头部回显，避免「筛选生效但看不见」） */
  const activeName = useMemo(() => {
    const find = (nodes: WatchTagNode[]): WatchTagNode | null => {
      for (const n of nodes) {
        if (n.id === selected) return n;
        const hit = find(n.children);
        if (hit) return hit;
      }
      return null;
    };
    return find(tags)?.name ?? "";
  }, [tags, selected]);

  // 「全部」= 根 tag（不渲染为节点，只取它的统计给头部用）
  const root = tags[0] ?? null;
  const rootStats = root
    ? { totalCount: root.totalCount, avgPct: root.avgPct, avgCount: root.avgCount }
    : null;
  const allActive = selected === WATCH_ROOT_TAG;

  /** 渲染用节点：**跳过根**，直接呈现真实分类（「全部」的功能在头部） */
  const visibleNodes = useMemo(() => (root ? root.children : tags), [root, tags]);

  /** 拖到头部 = 移到顶层（挂到根 tag 下）——根被隐藏后唯一的「升到顶层」入口 */
  const handleRootDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const from = dragId;
    setDropId(null);
    setDragId(null);
    if (from) void onMove(from, WATCH_ROOT_TAG);
  };

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startRename = (n: WatchTagNode) => {
    setEditingId(n.id);
    setDraftName(n.name);
  };

  const commitRename = async (id: string) => {
    const name = draftName.trim();
    setEditingId(null);
    if (name) await onRename(id, name);
  };

  const commitCreate = async (parentId: string) => {
    const name = newName.trim();
    setAddingTo(null);
    setNewName("");
    if (name) await onCreate(name, parentId);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      {/* 行内管理按钮（✚子标签/重命名/删除）平时隐藏，悬停整行才出现，避免窄栏拥挤 */}
      <style>{`.wl-tagrow .wl-rowacts{opacity:0;transition:opacity .12s} .wl-tagrow:hover .wl-rowacts{opacity:1}`}</style>
      <div
        onDragOver={(e) => {
          if (!dragId || dragId === WATCH_ROOT_TAG) return;
          e.preventDefault();
          setDropId(WATCH_ROOT_TAG);
        }}
        onDragLeave={() => setDropId((cur) => (cur === WATCH_ROOT_TAG ? null : cur))}
        onDrop={handleRootDrop}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.3rem",
          padding: "0.3rem 0.45rem",
          borderBottom: `1px solid ${C.border}`,
          flexShrink: 0,
          userSelect: "none",
          background: dropId === WATCH_ROOT_TAG ? "#f1f5f9" : undefined,
        }}
      >
        <span style={{ width: 3, height: 12, borderRadius: 999, background: C.accent, flexShrink: 0 }} />
        <span style={{ fontWeight: 700, fontSize: "0.82rem", color: C.text, whiteSpace: "nowrap" }}>🏷 标签</span>

        {/* 「全部」入口：替代被隐藏的顶级 tag 节点，点击即取消筛选 */}
        <button
          type="button"
          title="显示全部标的（不按标签筛选）"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(WATCH_ROOT_TAG);
          }}
          style={{
            border: "none",
            background: allActive ? C.accent : "transparent",
            color: allActive ? "#fff" : C.faintest,
            fontWeight: allActive ? 700 : 500,
            fontSize: "0.72rem",
            padding: "0.03rem 0.35rem",
            borderRadius: 999,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          全部
          {rootStats ? ` ${rootStats.totalCount}` : ""}
        </button>
        {/* 「全部」的平均涨跌幅（与树内每行口径一致） */}
        {rootStats && typeof rootStats.avgPct === "number" ? (
          <span style={{ fontSize: "0.72rem", fontWeight: 700, color: pctColor(rootStats.avgPct), flexShrink: 0 }} title={`全部 ${rootStats.avgCount ?? 0} 只有行情标的的等权平均涨跌幅`}>
            {fmtPct(rootStats.avgPct)}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          title="新建顶层标签"
          onClick={(e) => {
            e.stopPropagation();
            setAddingTo(WATCH_ROOT_TAG);
          }}
          style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: "0.85rem", color: C.accent, padding: "0 0.15rem", lineHeight: 1, flexShrink: 0 }}
        >
          ✚
        </button>
        <button
          type="button"
          title="收起标签树"
          onClick={(e) => {
            e.stopPropagation();
            onCollapse?.();
          }}
          style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: "0.8rem", color: C.faintest, padding: "0 0.1rem", lineHeight: 1, flexShrink: 0 }}
        >
          ◀
        </button>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "0.2rem 0.3rem",
        }}
      >
        {visibleNodes.length === 0 ? (
          <div style={{ color: C.faintest, fontSize: "0.75rem", padding: "0.5rem", textAlign: "center", lineHeight: 1.6 }}>
            暂无标签
            <br />
            点上方 ✚ 新建（如「通胀」）
          </div>
        ) : (
          visibleNodes.map((n) => (
            <TagRow
              key={n.id}
              node={n}
              depth={0}
              selected={selected}
              collapsed={collapsed}
              editingId={editingId}
              draftName={draftName}
              dragId={dragId}
              dropId={dropId}
              onToggle={toggle}
              onSelect={onSelect}
              onStartRename={startRename}
              setDraftName={setDraftName}
              onCommitRename={commitRename}
              onCancelRename={() => setEditingId(null)}
              onDelete={onDelete}
              onSetDrag={setDragId}
              onSetDrop={setDropId}
              onMove={onMove}
              onAddChild={(id) => setAddingTo(id)}
            />
          ))
        )}

        {addingTo ? (
          <div style={{ padding: "0.3rem 0.45rem" }}>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => void commitCreate(addingTo)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitCreate(addingTo);
                if (e.key === "Escape") {
                  setAddingTo(null);
                  setNewName("");
                }
              }}
              placeholder="新标签名称，回车确认"
              style={{ ...input, width: "100%", fontSize: "0.82rem", padding: "0.25rem 0.45rem" }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TagRow({
  node,
  depth,
  selected,
  collapsed,
  editingId,
  draftName,
  dragId,
  dropId,
  onToggle,
  onSelect,
  onStartRename,
  setDraftName,
  onCommitRename,
  onCancelRename,
  onDelete,
  onSetDrag,
  onSetDrop,
  onMove,
  onAddChild,
}: {
  node: WatchTagNode;
  depth: number;
  selected: string;
  collapsed: Set<string>;
  editingId: string | null;
  draftName: string;
  dragId: string | null;
  dropId: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onStartRename: (n: WatchTagNode) => void;
  setDraftName: (v: string) => void;
  onCommitRename: (id: string) => Promise<void>;
  onCancelRename: () => void;
  onDelete: (id: string, mode: "promote" | "cascade") => Promise<void>;
  onSetDrag: (id: string | null) => void;
  onSetDrop: (id: string | null) => void;
  onMove: (id: string, parentId: string) => Promise<void>;
  onAddChild: (id: string) => void;
}) {
  const isCollapsed = collapsed.has(node.id);
  const hasChildren = node.children.length > 0;
  const active = node.id === selected;
  const isEditing = editingId === node.id;
  const isDropTarget = dropId === node.id && dragId !== node.id;

  return (
    <div>
      <div
        draggable={!node.preset && !isEditing}
        onDragStart={(e) => {
          e.stopPropagation();
          onSetDrag(node.id);
        }}
        onDragEnd={() => {
          onSetDrag(null);
          onSetDrop(null);
        }}
        onDragOver={(e) => {
          if (!dragId || dragId === node.id) return;
          e.preventDefault();
          onSetDrop(node.id);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const from = dragId;
          onSetDrop(null);
          onSetDrag(null);
          if (from && from !== node.id) void onMove(from, node.id);
        }}
        onClick={() => onSelect(node.id)}
        className="wl-tagrow"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.25rem",
          padding: "0.2rem 0.35rem",
          paddingLeft: 4 + depth * 13,
          borderRadius: 5,
          cursor: "pointer",
          background: active ? C.accentBg : isDropTarget ? "#f1f5f9" : "transparent",
          color: active ? C.accent : C.text,
          fontWeight: active ? 700 : 500,
          fontSize: "0.82rem",
          userSelect: "none",
        }}
      >
        {/* 折叠箭头（与点击选择分离） */}
        {hasChildren ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
            }}
            style={{ width: 12, fontSize: "0.62rem", color: C.faintest, flexShrink: 0 }}
            title={isCollapsed ? "展开" : "收起"}
          >
            {isCollapsed ? "▶" : "▼"}
          </span>
        ) : (
          <span style={{ width: 12, flexShrink: 0 }} />
        )}

        {isEditing ? (
          <input
            autoFocus
            value={draftName}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={() => void onCommitRename(node.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onCommitRename(node.id);
              if (e.key === "Escape") onCancelRename();
            }}
            style={{ ...input, flex: 1, minWidth: 0, fontSize: "0.88rem", padding: "0.15rem 0.35rem" }}
          />
        ) : (
          <>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={node.name}>
              {node.preset ? "🗂 " : ""}
              {node.name}
            </span>

            {/* 平均涨跌幅（该标签含子标签下标的的等权平均） */}
            <span style={{ fontSize: "0.74rem", fontWeight: 700, color: pctColor(node.avgPct), flexShrink: 0 }} title={`${node.avgCount ?? 0} 只有行情标的的等权平均涨跌幅`}>
              {fmtPct(node.avgPct)}
            </span>
            <span style={{ fontSize: "0.72rem", color: active ? C.accent : C.faintest, flexShrink: 0, minWidth: 16, textAlign: "right" }} title="含子标签的标的总数">
              {node.totalCount}
            </span>

            <span className="wl-rowacts" style={{ display: "flex", gap: "0.02rem", flexShrink: 0 }}>
              <IconBtn title="新建子标签" onClick={() => onAddChild(node.id)}>✚</IconBtn>
              <IconBtn
                title={node.preset ? "预置标签不可重命名" : "重命名"}
                dim={node.preset}
                onClick={() => {
                  if (node.preset) return;
                  onStartRename(node);
                }}
              >
                ✏️
              </IconBtn>
              {node.preset ? (
                <span style={{ width: 18 }} />
              ) : (
                <ConfirmButton
                  title={`删除标签「${node.name}」`}
                  confirmText="删除标签"
                  description={
                    <>
                      将删除标签 <b>{node.name}</b>（含 {node.totalCount} 个标的）。
                      <br />
                      默认处理方式：<b>子标签与标的提升到上一级</b>，<b>不会删除任何标的</b>。
                      {hasChildren ? (
                        <>
                          <br />
                          其下 {node.children.length} 个子标签会挂到 {node.name} 的父级下。
                        </>
                      ) : null}
                    </>
                  }
                  onConfirm={() => onDelete(node.id, "promote")}
                >
                  ✕
                </ConfirmButton>
              )}
            </span>
          </>
        )}
      </div>

      {!isCollapsed && hasChildren ? (
        <div>
          {node.children.map((c) => (
            <TagRow
              key={c.id}
              node={c}
              depth={depth + 1}
              selected={selected}
              collapsed={collapsed}
              editingId={editingId}
              draftName={draftName}
              dragId={dragId}
              dropId={dropId}
              onToggle={onToggle}
              onSelect={onSelect}
              onStartRename={onStartRename}
              setDraftName={setDraftName}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              onDelete={onDelete}
              onSetDrag={onSetDrag}
              onSetDrop={onSetDrop}
              onMove={onMove}
              onAddChild={onAddChild}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function IconBtn({
  children,
  title,
  onClick,
  dim,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  dim?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        border: "none",
        background: "transparent",
        cursor: dim ? "not-allowed" : "pointer",
        opacity: dim ? 0.3 : 0.55,
        fontSize: "0.7rem",
        padding: "0 0.1rem",
        lineHeight: 1,
        color: C.faint,
      }}
      onMouseEnter={(e) => {
        if (!dim) e.currentTarget.style.opacity = "1";
      }}
      onMouseLeave={(e) => {
        if (!dim) e.currentTarget.style.opacity = "0.55";
      }}
    >
      {children}
    </button>
  );
}
