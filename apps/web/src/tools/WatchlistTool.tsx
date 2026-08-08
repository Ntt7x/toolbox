// ============================================================
// 专题自选股：新建专题 + 专题内收录（入选个股 + 入选理由）
// - 专题列表（左） + 专题详情（右）：增删个股、改名、删除专题
// - 每只股票支持「财报分析」（LLM 联网搜索，后台任务 + 缓存）
// ============================================================

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { api, errMsg } from "../api";
import { useAsyncTask } from "../hooks/useAsyncTask";
import { ErrorCard, PageHeader } from "../ui";
import type {
  AsyncTaskResult,
  FundSnapshot,
  QuoteSnapshot,
  WatchlistFundamentalResult,
  WatchlistStock,
  WatchlistSummary,
  WatchlistTopic,
  WatchlistUpdateRequest,
} from "@toolbox/shared";

/** 个股/基金详情页跳转：股票/ETF → 雪球；场外基金 → 天天基金；无法识别 → 雪球搜索 */
function stockDetailUrl(code: string, kind?: string): string {
  if (kind === "fund") return `https://fund.eastmoney.com/${code}.html`;
  const c = code.trim().toUpperCase();
  if (/^HK\d{5}$/.test(c)) return `https://xueqiu.com/S/${c}`;
  if (/^(SH|SZ)\d{6}$/.test(c)) return `https://xueqiu.com/S/${c}`;
  if (/^\d{6}$/.test(c)) {
    // 裸 6 位：6xx→沪，0/3xx→深；北交所(4/8/92x) 雪球无个股页 → 搜索
    if (/^[0-3]/.test(c) || /^6/.test(c)) return `https://xueqiu.com/S/${c.startsWith("6") ? "SH" : "SZ"}${c}`;
    return `https://xueqiu.com/k?q=${c}`;
  }
  return `https://xueqiu.com/k?q=${encodeURIComponent(code)}`;
}

const card: CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: "1.25rem 1.5rem",
  marginBottom: "1rem",
};

const btn: CSSProperties = {
  padding: "0.5rem 1.1rem",
  borderRadius: 8,
  border: "none",
  background: "#3b82f6",
  color: "#fff",
  fontSize: "0.9rem",
  fontWeight: 600,
  cursor: "pointer",
};

const btnGhost: CSSProperties = { ...btn, background: "transparent", color: "#dc2626", border: "1px solid #fca5a5", padding: "0.3rem 0.8rem", fontSize: "0.8rem" };
const btnSmall: CSSProperties = { ...btn, padding: "0.3rem 0.8rem", fontSize: "0.8rem" };

const input: CSSProperties = {
  padding: "0.5rem 0.7rem",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  fontSize: "0.9rem",
  outline: "none",
  minWidth: 0,
};

const table: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" };
const thTd: CSSProperties = { border: "1px solid #e2e8f0", padding: "0.45rem 0.5rem", textAlign: "center", verticalAlign: "top" };
const th: CSSProperties = { ...thTd, background: "#f1f5f9", fontWeight: 600 };

/** 财报分析结果卡片（LLM 输出，含 dataMode 标注） */
function FundamentalCard({ r, onClose, onOptimize }: { r: WatchlistFundamentalResult; onClose: () => void; onOptimize?: () => void }) {
  const kv = (label: string, v?: string) =>
    v ? (
      <div style={{ marginBottom: "0.45rem" }}>
        <span style={{ fontWeight: 600, color: "#334155" }}>{label}：</span>
        <span style={{ whiteSpace: "pre-wrap" }}>{v}</span>
      </div>
    ) : null;
  return (
    <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "0.9rem 1rem", marginTop: "0.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
        <span style={{ fontWeight: 700 }}>
          🔍 {r.name ?? r.code} 财报分析
          {r.dataMode === "search" ? "（联网实时）" : "（知识）"}
          {r.fromCache ? " · 缓存" : ""}
        </span>
        <button style={btnGhost} onClick={onClose} type="button">关闭</button>
        {onOptimize && (
          <button
            style={{ ...btnGhost, background: "#16a34a", color: "#fff", borderColor: "#16a34a" }}
            onClick={onOptimize}
            type="button"
          >
            ✨ 优化入选理由
          </button>
        )}
      </div>
      {kv("概览", r.summary)}
      {kv("财务数据", r.financials)}
      {kv("核心看点", r.strengths)}
      {kv("主要风险", r.risks)}
      {kv("结论", r.conclusion)}
      {r.model ? <div style={{ color: "#94a3b8", fontSize: "0.75rem" }}>模型：{r.model}</div> : null}
    </div>
  );
}

export default function WatchlistTool() {
  const [topics, setTopics] = useState<WatchlistSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [topic, setTopic] = useState<WatchlistTopic | null>(null);
  // 首次加载后自动选中第一个专题（仅一次；用户手动清空后不再自动）
  const autoSelectedRef = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 新建专题
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newGroup, setNewGroup] = useState("");
  // 新建面板折叠 + 内部 tab（manual / chat）
  const [showCreate, setShowCreate] = useState(false);
  const [createTab, setCreateTab] = useState<"manual" | "chat">("manual");
  // 拖拽排序
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  // 个股列表排序视图（仅展示用，不影响 topic.stocks 存储顺序）
  const [sortMode, setSortMode] = useState<"none" | "desc" | "asc">("none");
  /** 个股行情快照（code → QuoteSnapshot / FundSnapshot 混合） */
  const [quotes, setQuotes] = useState<Record<string, QuoteSnapshot & Partial<FundSnapshot>>>({});
  // Chat 补充（追加到当前专题）
  const [appendUrl, setAppendUrl] = useState("");
  const [appending, setAppending] = useState(false);
  const [showAppend, setShowAppend] = useState(false);
  // 列表项描述悬浮卡片
  const [hoverInfo, setHoverInfo] = useState<string | null>(null);
  // 详情页描述：展开 / 编辑
  const [descExpanded, setDescExpanded] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descEditText, setDescEditText] = useState("");
  // Chat 导入
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importClipHint, setImportClipHint] = useState(false);
  // 添加股票
  const [addCode, setAddCode] = useState("");
  const [addName, setAddName] = useState("");
  const [addReason, setAddReason] = useState("");
  // 名称补全：候选下拉（代码输入框支持名称搜索）
  const [stockCands, setStockCands] = useState<{ code: string; name: string; market: string; type: string }[]>([]);
  const [candsOpen, setCandsOpen] = useState(false);
  const [candsLoading, setCandsLoading] = useState(false);
  /** 添加类型：stock=股票/场内ETF，fund=场外基金 */
  const [addKind, setAddKind] = useState<"stock" | "fund">("stock");
  // 财报分析：code → 结果
  const [fundamentals, setFundamentals] = useState<Record<string, WatchlistFundamentalResult>>({});
  const [analyzing, setAnalyzing] = useState<Record<string, boolean>>({});

  const refreshList = useCallback(async () => {
    try {
      const r = await api.watchlistList();
      if (r.ok) setTopics(r.topics);
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await api.watchlistDetail(id);
      if (r.ok) setTopic(r.topic);
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);

;

  /** 根据财报分析优化入选理由（LLM；成功后更新专题内该股理由） */
  const [optimizingCode, setOptimizingCode] = useState<string | null>(null);
  const [optNotice, setOptNotice] = useState<{ code: string; text: string; ok: boolean | null } | null>(null); // 非侵入提示
  const optimizeReasonForStock = async (stock: WatchlistStock | undefined) => {
    if (!topic || !stock) return;
    if (optimizingCode) return; // 串行保护：一次只跑一个优化
    setOptimizingCode(stock.code);
    setErr(null);
    setOptNotice({ code: stock.code, text: "正在根据财报分析优化理由…", ok: null });
    try {
      const r = await api.watchlistOptimizeReason(topic.id, stock.code, stock.reason);
      if (r.ok && r.topic) {
        setTopic(r.topic);
        await refreshList();
        setOptNotice({ code: stock.code, text: "✅ 理由已优化", ok: true });
      } else {
        setOptNotice({ code: stock.code, text: "❌ " + (r.message ?? "优化失败"), ok: false });
      }
    } catch (e) {
      setOptNotice({ code: stock.code, text: "❌ " + errMsg(e), ok: false });
    } finally {
      setOptimizingCode(null);
      // 3s 后自动消失（非侵入）
      setTimeout(() => setOptNotice((n) => (n?.code === stock.code ? null : n)), 3000);
    }
  };

  /** 生成延续思路/扩展思考提示词（专题信息 → LLM → 可粘贴 DeepSeek Chat） */
  const [extending, setExtending] = useState(false);
  const [extendResult, setExtendResult] = useState<string | null>(null);
  const [extendCopied, setExtendCopied] = useState(false);
  const extendTopic = async () => {
    if (!topic || extending) return;
    setExtending(true);
    setErr(null);
    try {
      const r = await api.watchlistExtendPrompt(topic.id);
      if (r.ok && r.prompt) setExtendResult(r.prompt);
      else setErr(r.message ?? "生成失败");
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setExtending(false);
    }
  };
  const copyExtendPrompt = async () => {
    if (!extendResult) return;
    try {
      await navigator.clipboard.writeText(extendResult);
      setExtendCopied(true);
      setTimeout(() => setExtendCopied(false), 2000);
    } catch { /* 忽略 */ }
  };
  const refreshExtend = async () => {
    if (!topic || extending) return;
    setExtending(true);
    setErr(null);
    try {
      const r = await api.watchlistExtendPrompt(topic.id, true);
      if (r.ok && r.prompt) setExtendResult(r.prompt);
      else setErr(r.message ?? "刷新失败");
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setExtending(false);
    }
  };

  const goChat = async () => {
    if (!extendResult) return;
    setErr(null);
    setInfo(null);
    try {
      // 自动打开 + 填入 + 开启深度思考/智能搜索 + 自动发送
      const r = await api.chatBrowserOpen(extendResult, { send: true, deepThink: true, search: true });
      if (r.ok) setInfo(r.message ?? "已打开浏览器");
      else setErr(r.message ?? "打开失败");
    } catch (e) {
      setErr(errMsg(e));
    }
  };

    /** 加载近期热点新闻（已迁移到「新闻中心」页面，移除） */

  /** 名称补全：输入（非纯代码）→ 防抖搜索候选 */
  const searchCandsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchStockCands = (v: string) => {
    if (searchCandsTimer.current) clearTimeout(searchCandsTimer.current);
    const t = v.trim();
    if (!t || /^[\dhk/]+$/i.test(t) || addKind === "fund") {
      setCandsOpen(false);
      return;
    }
    setCandsLoading(true);
    searchCandsTimer.current = setTimeout(async () => {
      try {
        const r = await api.watchlistSearchStock(t, 8);
        if (r.ok) {
          setStockCands(r.items ?? []);
          setCandsOpen((r.items?.length ?? 0) > 0);
        }
      } catch {
        setCandsOpen(false);
      } finally {
        setCandsLoading(false);
      }
    }, 320);
  };

  // 挂载：加载专题列表 + 自动捕获剪贴板（Chat 导入 / Chat 补充链接）
  useEffect(() => {
    void refreshList();
    void readImportClipboard();
    void readAppendClipboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 首次加载到专题后自动选中第一个（右侧功能区默认展示；仅一次）
  useEffect(() => {
    if (!autoSelectedRef.current && topics.length > 0) {
      autoSelectedRef.current = true;
      setSelectedId(topics[0].id);
      void loadDetail(topics[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topics]);

  /** 加载个股行情快照（批量，复用公共行情模块缓存；基金走 fund: 前缀） */
  const loadQuotes = useCallback(async (codes: string[]) => {
    if (codes.length === 0) return;
    try {
      const r = await api.watchlistQuotes(codes);
      if (r.ok) {
        setQuotes((prev) => {
          const next = { ...prev };
          for (const q of r.quotes) {
            if (!q.ok || !q.code) continue;
            next[q.code] = q; // normCode：sh688102 / 基金 161725
            const bare = q.code.replace(/^(sh|sz|hk|bj)/, "");
            if (bare !== q.code) next[bare] = q; // 纯数字：688102（表格行 code 兼容）
          }
          return next;
        });
      }
    } catch {
      // 行情失败静默（表格显示 —）
    }
  }, []);

  // 选中专题 → 加载详情 + 批量行情
  useEffect(() => {
    if (!selectedId) return;
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  // 专题详情变化 → 刷新行情（基金代码带 fund: 前缀）
  useEffect(() => {
    if (topic) void loadQuotes(topic.stocks.map((s) => (s.kind === "fund" ? `fund:${s.code}` : s.code)));
  }, [topic, loadQuotes]);

  const createTopic = async () => {
    const name = newName.trim();
    if (!name) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await api.watchlistCreate(name, newDesc.trim() || undefined, newGroup.trim() || undefined);
      if (r.ok) {
        setNewName("");
        setNewDesc("");
        setNewGroup("");
        setShowCreate(false);
        setSelectedId(r.topic.id);
        await refreshList();
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  const renameTopic = async () => {
    if (!topic) return;
    const patch: { name?: string; description?: string } = {};
    const name = (topic.name || "").trim();
    if (name) patch.name = name;
    // 介绍：与 name 一起提交（输入框 blur 触发）
    if (topic.description !== undefined) patch.description = topic.description;
    setErr(null);
    try {
      const r = await api.watchlistUpdate(topic.id, patch as WatchlistUpdateRequest);
      if (r.ok) {
        setTopic(r.topic);
        await refreshList();
      }
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  /** 保存描述编辑（进入编辑模式 → 输入 → 保存；直接提交，避免 setTopic 异步未生效导致保存旧值） */
  const saveDescEdit = async () => {
    if (!topic) return;
    setErr(null);
    try {
      const r = await api.watchlistUpdate(topic.id, { description: descEditText.trim() || undefined });
      if (r.ok) {
        setTopic(r.topic);
        await refreshList();
        setEditingDesc(false);
        setDescExpanded(true);
      }
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  const deleteTopic = async () => {
    if (!topic) return;
    if (!window.confirm(`确定删除专题「${topic.name}」？其下 ${topic.stocks.length} 只自选股将一并删除。`)) return;
    setErr(null);
    try {
      const r = await api.watchlistDelete(topic.id);
      if (r.ok) {
        setSelectedId(null);
        setTopic(null);
        await refreshList();
      }
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  /** 添加/更新股票（自动解析名称） */
  const addStock = async () => {
    if (!topic) return;
    let code = addCode.trim();
    // 统一输入框：非代码格式（如输入名称）→ 按名称搜索第一个结果自动填（股票）
    if (!/^(sh|sz|hk|bj)?\d{5,6}$/i.test(code) && addKind === "stock" && code) {
      try {
        const r = await api.watchlistSearchStock(code);
        if (r.ok && r.items.length > 0) {
          code = r.items[0].code;
          setAddCode(code);
          if (!addName) setAddName(r.items[0].name);
        } else {
          setErr(`未找到「${code}」对应的股票，请直接输入代码`);
          return;
        }
      } catch (e) {
        setErr(errMsg(e));
        return;
      }
    }
    if (!code) {
      setErr(addKind === "fund" ? "请输入基金代码（6 位数字，如 161725）" : "请输入股票代码（如 600519 / sh600519 / hk00700）");
      return;
    }
    if (!addReason.trim()) {
      setErr("请输入入选理由");
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      // 未填名称时自动解析
      let name = addName.trim();
      if (!name) {
        try {
          const r = await api.watchlistResolve(code, addKind);
          if (r.ok && r.name) name = r.name;
        } catch {
          // 解析失败静默
        }
      }
      const stock: WatchlistStock = { code, ...(name ? { name } : {}), reason: addReason.trim(), ...(addKind === "fund" ? { kind: "fund" as const } : {}) };
      const r = await api.watchlistUpdate(topic.id, { addStocks: [stock] });
      if (r.ok) {
        setTopic(r.topic);
        setAddCode("");
        setAddName("");
        setAddReason("");
        await refreshList();
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  const removeStock = async (code: string) => {
    if (!topic) return;
    setErr(null);
    try {
      const r = await api.watchlistUpdate(topic.id, { removeCodes: [code] });
      if (r.ok) {
        setTopic(r.topic);
        setFundamentals((f) => {
          const n = { ...f };
          delete n[code];
          return n;
        });
        await refreshList();
      }
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  /** 拖拽重排：stocks 顺序 = 优先级（乐观更新 + 失败回滚） */
  const reorderStock = async (from: number, to: number) => {
    if (!topic || from === to) return;
    const stocks = topic.stocks.slice();
    const [moved] = stocks.splice(from, 1);
    stocks.splice(to, 0, moved);
    const prev = topic;
    setTopic({ ...topic, stocks });
    try {
      const r = await api.watchlistUpdate(topic.id, { reorderCodes: stocks.map((s) => s.code) });
      if (r.ok) {
        setTopic(r.topic);
        await refreshList();
      }
    } catch (e) {
      setTopic(prev);
      setErr(errMsg(e));
    }
  };

  /** Chat 补充：分享链接 → LLM 整理 → 追加个股到当前专题（后台任务轮询） */
  /** 从剪贴板读取 DeepSeek 分享链接并自动填入（仅当符合格式且输入框为空） */
  const readAppendClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const url = text.trim();
      if (/^https:\/\/chat\.deepseek\.com\/share\/[A-Za-z0-9_-]+$/.test(url) && !appendUrl.trim()) {
        setAppendUrl(url);
      }
    } catch {
      // 剪贴板无权限/不可用：静默，可手动粘贴或点按钮
    }
  };

  const appendChat = async () => {
    if (!topic) return;
    const url = appendUrl.trim();
    if (!url) return;
    setAppending(true);
    setErr(null);
    try {
      const t = await api.watchlistAppend(topic.id, url);
      if (!t.ok) {
        setErr(t.message || "补充失败");
        return;
      }
      if (t.taskId) {
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const st = await api.watchlistImportTaskStatus(t.taskId).catch(() => null);
          if (st?.ok && st.status === "done" && st.result) {
            setAppendUrl("");
            setShowAppend(false);
            setTopic(st.result);
            setSelectedId(st.result.id);
            await refreshList();
            return;
          }
          if (st?.ok && (st.status === "error" || st.status === "cancelled")) {
            setErr(st.message || "补充失败");
            return;
          }
        }
        setErr("补充超时，请稍后重试");
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setAppending(false);
    }
  };

  /** Chat 导入：分享链接 → 自动创建专题（后台 LLM 整理，轮询进度） */
  /** 从剪贴板读取 DeepSeek 分享链接并自动填入（仅当符合格式且输入框为空） */
  const readImportClipboard = async () => {    try {
      const text = await navigator.clipboard.readText();
      const url = text.trim();
      if (/^https:\/\/chat\.deepseek\.com\/share\/[A-Za-z0-9_-]+$/.test(url) && !importUrl.trim()) {
        setImportUrl(url);
        setImportClipHint(true);
        setTimeout(() => setImportClipHint(false), 6000);
      }
    } catch {
      // 剪贴板无权限/不可用：静默，可手动粘贴
    }
  };

  const importChat = async () => {
    const url = importUrl.trim();
    if (!url) return;
    setImporting(true);
    setErr(null);
    try {
      const t = await api.watchlistImport(url);
      if (!t.ok) {
        setErr(t.message || "导入失败");
        return;
      }
      if (t.taskId) {
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const st = await api.watchlistImportTaskStatus(t.taskId).catch(() => null);
          if (st?.ok && st.status === "done" && st.result) {
            setImportUrl("");
            setShowCreate(false);
            setSelectedId(st.result.id);
            await refreshList();
            return;
          }
          if (st?.ok && (st.status === "error" || st.status === "cancelled")) {
            setErr(st.message || "导入失败");
            return;
          }
        }
        setErr("导入超时，请稍后重试");
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setImporting(false);
    }
  };

  /** 财报分析（后台任务；命中缓存秒回） */
  const analyze = async (stock: WatchlistStock, force = false) => {
    if (!topic) return;
    setAnalyzing((a) => ({ ...a, [stock.code]: true }));
    setErr(null);
    try {
      const t = await api.watchlistFundamental(topic.id, stock.code, force);
      if (t.ok && t.status === "done" && t.result) {
        setFundamentals((f) => ({ ...f, [stock.code]: t.result as WatchlistFundamentalResult }));
      } else if (t.ok && t.taskId) {
        const r = await pollFundamental(t.taskId);
        if (r.ok && r.result) setFundamentals((f) => ({ ...f, [stock.code]: r.result as WatchlistFundamentalResult }));
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setAnalyzing((a) => ({ ...a, [stock.code]: false }));
    }
  };

  const pollFundamental = async (taskId: string, tries = 60): Promise<AsyncTaskResult<WatchlistFundamentalResult>> => {
    if (!topic) return { ok: false, message: "专题不存在" };
    for (let i = 0; i < tries; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      const r = await api.watchlistFundamentalTaskStatus(topic.id, taskId).catch(() => null);
      if (r && r.ok && (r.status === "done" || r.status === "error" || r.status === "cancelled")) return r;
    }
    return { ok: false, message: "分析超时" };
  };

  return (
    <div>
      <PageHeader
        title="📌 专题自选股"
        desc="自建投资专题，收录（入选个股 + 入选理由）；每只股票可用 LLM 财报分析（联网搜索，缓存 2 年）。示例专题：AI 硬件 / 通胀消费 / 水利开支 / 商业航天…"
      />
      {err && <ErrorCard>{err}</ErrorCard>}
      {info && (
        <div style={{ padding: "0.6rem 0.9rem", borderRadius: 8, background: "#ecfdf5", border: "1px solid #6ee7b7", color: "#047857", fontSize: "0.85rem", marginBottom: "0.6rem", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
          <span>ℹ️ {info}</span>
          <button type="button" onClick={() => setInfo(null)} style={{ border: "none", background: "none", color: "#047857", cursor: "pointer", fontSize: "0.8rem" }}>✕</button>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: "1rem", alignItems: "start" }}>
        {/* 左：专题列表 */}
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: "0.7rem" }}>🗂️ 我的专题</div>
          <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.6rem" }}>
            <button
              style={{ ...btn, flex: 1, background: showCreate ? "#1d4ed8" : "#3b82f6" }}
              onClick={() => setShowCreate((v) => !v)}
              type="button"
            >
              {showCreate ? "▾ 收起新建面板" : "➕ 新建专题"}
            </button>
          </div>

          {/* 新建专题聚合面板（手动创建 / Chat 导入 同属"新建专题"，tab 切换） */}
          {showCreate && (
            <div style={{ marginBottom: "0.7rem", padding: "0.6rem", background: "#eff6ff", borderRadius: 8, border: "1px solid #bfdbfe" }}>
              <div style={{ fontWeight: 600, fontSize: "0.82rem", marginBottom: "0.4rem", color: "#1d4ed8" }}>🆕 新建专题</div>
              {/* tab：手动 / Chat */}
              <div style={{ display: "flex", gap: "0.3rem", marginBottom: "0.45rem" }}>
                <button
                  style={{ ...btn, flex: 1, padding: "0.32rem", fontSize: "0.8rem", background: createTab === "manual" ? "#2563eb" : "#93c5fd" }}
                  onClick={() => setCreateTab("manual")}
                  type="button"
                >
                  ✍️ 手动创建
                </button>
                <button
                  style={{ ...btn, flex: 1, padding: "0.32rem", fontSize: "0.8rem", background: createTab === "chat" ? "#7c3aed" : "#c4b5fd" }}
                  onClick={() => setCreateTab("chat")}
                  type="button"
                >
                  🤖 Chat 导入
                </button>
              </div>
              {createTab === "manual" ? (
                <>
                  <input
                    style={{ ...input, width: "100%", boxSizing: "border-box", marginBottom: "0.35rem", fontSize: "0.82rem" }}
                    placeholder="专题名称（如 商业航天）"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void createTopic(); }}
                  />
                  <textarea
                    style={{ ...input, width: "100%", resize: "vertical", minHeight: 44, fontSize: "0.8rem", boxSizing: "border-box", marginBottom: "0.35rem" }}
                    placeholder="专题介绍（可选，鼠标悬浮专题名可见）"
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                  />
                  <input
                    style={{ ...input, width: "100%", boxSizing: "border-box", marginBottom: "0.35rem", fontSize: "0.8rem" }}
                    placeholder="分组（可选，如：消费 / 科技；留空=未分组）"
                    value={newGroup}
                    onChange={(e) => setNewGroup(e.target.value)}
                  />
                  <button style={{ ...btn, width: "100%", padding: "0.4rem", fontSize: "0.82rem" }} onClick={() => void createTopic()} disabled={loading} type="button">
                    ✓ 创建专题
                  </button>
                </>
              ) : (
                <>
                  <input
                    style={{ ...input, width: "100%", fontSize: "0.8rem", boxSizing: "border-box", marginBottom: "0.35rem" }}
                    placeholder="https://chat.deepseek.com/share/<id>"
                    value={importUrl}
                    onChange={(e) => setImportUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void importChat(); }}
                  />
                  <div style={{ display: "flex", gap: "0.3rem" }}>
                    <button
                      style={{ ...btn, flex: 1, padding: "0.4rem", fontSize: "0.8rem", background: "#0891b2" }}
                      onClick={() => void readImportClipboard()}
                      type="button"
                    >
                      📋 从剪贴板读取
                    </button>
                    <button
                      style={{ ...btn, flex: 1, padding: "0.4rem", fontSize: "0.8rem", background: "#7c3aed" }}
                      onClick={() => void importChat()}
                      disabled={importing}
                      type="button"
                    >
                      {importing ? "🔄 提取整理中…" : "📥 从 Chat 导入"}
                    </button>
                  </div>
                  {importClipHint && (
                    <div style={{ color: "#0891b2", fontSize: "0.75rem", marginTop: "0.3rem" }}>
                      📋 已捕获剪贴板中的分享链接，点击「从 Chat 导入」即可创建专题。
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {topics.length === 0 && <div style={{ color: "#94a3b8", fontSize: "0.85rem" }}>还没有专题，先新建或导入一个。</div>}
          {/* 按分组渲染（组内保持原顺序；未分组最后） */}
          {(() => {
            const groups = new Map<string, { label: string; items: typeof topics }>();
            for (const t of topics) {
              const g = (t.group || "").trim() || "未分组";
              if (!groups.has(g)) groups.set(g, { label: g, items: [] });
              groups.get(g)!.items.push(t);
            }
            const entries = [...groups.entries()].sort((a, b) => (a[0] === "未分组" ? 1 : b[0] === "未分组" ? -1 : a[0].localeCompare(b[0], "zh")));
            return entries.map(([g, v]) => (
              <div key={g} style={{ marginBottom: "0.35rem" }}>
                <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "#64748b", padding: "0.3rem 0.5rem 0.15rem", letterSpacing: 0.3 }}>
                  📁 {g} <span style={{ color: "#94a3b8", fontWeight: 400 }}>{v.items.length}</span>
                </div>
                {v.items.map((t) => (
            <div
              key={t.id}
              onClick={() => setSelectedId(t.id)}
              onMouseEnter={() => setHoverInfo(t.id)}
              onMouseLeave={() => setHoverInfo(null)}
              style={{
                position: "relative",
                padding: "0.42rem 0.6rem",
                borderRadius: 8,
                cursor: "pointer",
                marginBottom: "0.25rem",
                background: t.id === selectedId ? "#eff6ff" : "transparent",
                border: t.id === selectedId ? "1px solid #bfdbfe" : "1px solid transparent",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "0.3rem",
              }}
            >
              <span
                style={{ fontWeight: 600, fontSize: "0.9rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {t.name}
                {t.description ? <span style={{ color: "#94a3b8", marginLeft: "0.25rem", fontSize: "0.8rem" }}>ℹ️</span> : null}
              </span>
              <span style={{ color: "#94a3b8", fontSize: "0.78rem", whiteSpace: "nowrap" }}>{t.stockCount} 只</span>

              {/* 描述悬浮卡片（自定义，可读全文） */}
              {hoverInfo === t.id && t.description ? (
                <div
                  style={{
                    position: "absolute",
                    left: "calc(100% + 8px)",
                    top: -4,
                    width: 320,
                    maxHeight: 220,
                    overflow: "auto",
                    background: "#fff",
                    border: "1px solid #cbd5e1",
                    borderRadius: 10,
                    boxShadow: "0 8px 24px rgba(15,23,42,0.15)",
                    padding: "0.7rem 0.85rem",
                    zIndex: 50,
                    fontSize: "0.8rem",
                    lineHeight: 1.5,
                    color: "#334155",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: "0.3rem", color: "#1d4ed8" }}>
                    📖 {t.name} · 专题介绍
                  </div>
                  {t.description}
                </div>
              ) : null}
            </div>
              ))}
              </div>
            ));
          })()}
        </div>

        {/* 右：专题详情 */}
        <div style={card}>
          {!topic ? (
            <div style={{ color: "#94a3b8", padding: "1.5rem 0", textAlign: "center" }}>← 从左侧选择一个专题，或新建专题</div>
          ) : (
            <div>
              {/* 标题 + 操作 */}
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.3rem" }}>
                {/* 分组选择（已有分组 + 未分组；改后即存） */}
                <select
                  style={{ ...input, width: 126, fontSize: "0.8rem", padding: "0.38rem 0.5rem" }}
                  value={topic.group || "未分组"}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTopic({ ...topic, group: v === "未分组" ? undefined : v });
                    void api.watchlistUpdate(topic.id, { group: v === "未分组" ? "" : v }).then((r) => { if (r.ok) { setTopic(r.topic); void refreshList(); } }).catch(() => {});
                  }}
                  title="专题分组（列表按此分组展示）"
                >
                  {(() => {
                    const seen = new Set<string>();
                    const groups: string[] = [];
                    for (const t of topics) { const g = (t.group || "").trim(); if (g && !seen.has(g)) { seen.add(g); groups.push(g); } }
                    return (
                      <>
                        {groups.map((g) => <option key={g} value={g}>{g}</option>)}
                        <option value="未分组">未分组</option>
                      </>
                    );
                  })()}
                </select>
                <input
                  style={{ ...input, fontWeight: 700, fontSize: "1.05rem", flex: 1 }}
                  value={topic.name}
                  onChange={(e) => setTopic({ ...topic, name: e.target.value })}
                  onBlur={() => void renameTopic()}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                />
                <span style={{ color: "#94a3b8", fontSize: "0.8rem" }}>更新于 {topic.updatedAt.slice(0, 10)} · {topic.stocks.length} 只</span>
                <button style={{ ...btnSmall, background: "#7c3aed" }} onClick={() => setShowAppend((v) => !v)} type="button">
                  🤖 Chat 补充
                </button>
                <button style={btnGhost} onClick={() => void deleteTopic()} type="button">删除专题</button>
              </div>

              {/* Chat 补充输入（阅读 Chat 对话 → 追加个股到本专题） */}
              {showAppend && (
                <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.8rem", padding: "0.5rem 0.6rem", background: "#f5f3ff", borderRadius: 8, border: "1px solid #ddd6fe" }}>
                  <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "#6d28d9", whiteSpace: "nowrap" }}>📥 阅读 Chat 对话追加个股：</span>
                  <input
                    style={{ ...input, flex: 1, minWidth: 200, fontSize: "0.82rem" }}
                    placeholder="https://chat.deepseek.com/share/<id>"
                    value={appendUrl}
                    onChange={(e) => setAppendUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void appendChat(); }}
                  />
                  <button
                    style={{ ...btn, background: "#64748b", padding: "0.4rem 0.8rem", fontSize: "0.82rem" }}
                    onClick={() => void readAppendClipboard()}
                    title="读取剪贴板中的分享链接并自动填入"
                    type="button"
                  >
                    📋
                  </button>
                  <button style={{ ...btn, background: "#7c3aed", padding: "0.4rem 0.9rem", fontSize: "0.82rem" }} onClick={() => void appendChat()} disabled={appending} type="button">
                    {appending ? "🔄 补充中…" : "补充"}
                  </button>
                </div>
              )}

              {/* 专题介绍（摘要折叠 + 编辑；不占版面） */}
              {editingDesc ? (
                <div style={{ marginBottom: "0.8rem" }}>
                  <textarea
                    style={{ ...input, width: "100%", resize: "vertical", minHeight: 80, fontSize: "0.85rem", boxSizing: "border-box" }}
                    placeholder="📖 专题介绍：主题逻辑 / 选股思路 / 风险提示…"
                    value={descEditText}
                    onChange={(e) => setDescEditText(e.target.value)}
                    autoFocus
                  />
                  <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.35rem" }}>
                    <button style={{ ...btn, padding: "0.35rem 0.9rem", fontSize: "0.82rem" }} onClick={() => void saveDescEdit()} type="button">✓ 保存</button>
                    <button style={{ ...btn, background: "#64748b", padding: "0.35rem 0.9rem", fontSize: "0.82rem" }} onClick={() => setEditingDesc(false)} type="button">取消</button>
                  </div>
                </div>
              ) : topic.description ? (
                <div style={{ marginBottom: "0.8rem", padding: "0.5rem 0.7rem", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: "0.82rem", color: "#334155" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <span style={{ fontWeight: 600, color: "#1d4ed8" }}>📖 专题介绍</span>
                    <span style={{ flex: 1 }} />
                    <button style={{ ...btnSmall, background: "#e2e8f0", color: "#334155" }} onClick={() => setDescExpanded((v) => !v)} type="button">
                      {descExpanded ? "收起 ▴" : "展开 ▾"}
                    </button>
                    <button
                      style={{ ...btnSmall, background: "#e2e8f0", color: "#334155" }}
                      onClick={() => { setDescEditText(topic.description ?? ""); setEditingDesc(true); }}
                      type="button"
                    >
                      ✏️ 编辑
                    </button>
                  </div>
                  <div
                    style={{
                      marginTop: "0.35rem",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      ...(descExpanded ? {} : { maxHeight: "2.6em", overflow: "hidden" }),
                    }}
                  >
                    {topic.description}
                  </div>
                </div>
              ) : (
                <button
                  style={{ ...btnSmall, background: "#e2e8f0", color: "#334155", marginBottom: "0.8rem" }}
                  onClick={() => { setDescEditText(""); setEditingDesc(true); }}
                  type="button"
                >
                  ＋ 添加专题介绍
                </button>
              )}

              {/* 今日行情速览（对专题内股票/ETF 结构化统计；基金净值不计入） */}
              {(() => {
                const stockQs = topic.stocks
                  .filter((s) => s.kind !== "fund")
                  .map((s) => quotes[s.code])
                  .filter((q): q is QuoteSnapshot => !!q && q.ok === true && typeof q.pct === "number");
                if (stockQs.length === 0) return null;
                const up = stockQs.filter((q) => q.pct! > 0).length;
                const down = stockQs.filter((q) => q.pct! < 0).length;
                const flat = stockQs.length - up - down;
                const avg = stockQs.reduce((a, q) => a + (q.pct ?? 0), 0) / stockQs.length;
                // 顺序加权平均（列表顺序=用户排序优先级）：
                // Zipf 幂律权重 w_i = 1/(i+1)^s（s=1，齐夫定律）——排序数据"位置即重要度"的实证统计模型
                // （自然语言词频/城市人口/网页访问量等均服从该分布；兼具 80/20 帕累托特性：
                // 前 20% 位置的合计权重随列表增长趋近 80%），比线性权重更符合位置优先级衰减规律
                const zs = 1;
                const wSum = stockQs.reduce((a, _q, i) => a + 1 / Math.pow(i + 1, zs), 0);
                const wAvg = stockQs.reduce((a, q, i) => a + (q.pct ?? 0) * (1 / Math.pow(i + 1, zs)), 0) / wSum;
                const latest = stockQs.reduce((a, q) => (q.ts && q.ts > a ? q.ts : a), "");
                return (
                  <div style={{ display: "flex", gap: "1.2rem", flexWrap: "wrap", alignItems: "center", marginBottom: "0.8rem", padding: "0.45rem 0.7rem", background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 8, fontSize: "0.82rem", color: "#0c4a6e" }}>
                    <span style={{ fontWeight: 600 }}>📊 今日行情速览</span>
                    <span>🟢 上涨 <b>{up}</b></span>
                    <span>⚪ 平盘 <b>{flat}</b></span>
                    <span>🔴 下跌 <b>{down}</b></span>
                    <span>
                      平均 <b style={{ color: avg > 0 ? "#dc2626" : avg < 0 ? "#16a34a" : "#334155" }}>{avg > 0 ? "+" : ""}{avg.toFixed(2)}%</b>
                    </span>
                    <span title="按列表顺序 Zipf 幂律加权（w_i = 1/(i+1)，齐夫定律——排序位置重要度的实证统计模型，兼具 80/20 帕累托特性），越靠前的个股贡献越大；体现用户排序优先级">
                      顺序加权 <b style={{ color: wAvg > 0 ? "#dc2626" : wAvg < 0 ? "#16a34a" : "#334155" }}>{wAvg > 0 ? "+" : ""}{wAvg.toFixed(2)}%</b>
                    </span>
                    {latest && <span style={{ color: "#94a3b8", fontSize: "0.72rem" }}>更新 {new Date(latest).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>}
                    <button
                      style={{ marginLeft: "auto", padding: "0.3rem 0.9rem", borderRadius: 8, border: "none", background: "#7c3aed", color: "#fff", fontSize: "0.78rem", fontWeight: 600, cursor: "pointer" }}
                      onClick={() => void extendTopic()}
                      disabled={extending}
                      type="button"
                      title="根据专题与已有个股，生成延续思路/扩展思考的 DeepSeek Chat 提示词"
                    >
                      {extending ? "生成中…" : "🧠 延续思考"}
                    </button>
                  </div>
                );
              })()}

              {/* 延续思考提示词结果（生成后可复制 / 跳转 DeepSeek Chat；可收起） */}
              {extendResult && (
                <div style={{ marginBottom: "0.8rem", padding: "0.8rem 1rem", background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
                    <span style={{ fontWeight: 700, fontSize: "0.88rem" }}>🧠 延续思考提示词</span>
                    <span style={{ flex: 1 }} />
                    <button style={{ padding: "0.3rem 0.9rem", borderRadius: 8, border: "none", background: "#16a34a", color: "#fff", fontSize: "0.78rem", cursor: "pointer" }} onClick={copyExtendPrompt} type="button">
                      {extendCopied ? "✅ 已复制" : "📋 复制"}
                    </button>
                    <button style={{ padding: "0.3rem 0.9rem", borderRadius: 8, border: "none", background: "#0891b2", color: "#fff", fontSize: "0.78rem", cursor: "pointer" }} onClick={() => void goChat()} type="button" title="自动打开 DeepSeek Chat 并填入提示词、开启深度思考+智能搜索、自动发送">
                      💬 去 Chat
                    </button>
                    <button style={{ padding: "0.3rem 0.9rem", borderRadius: 8, border: "1px solid #cbd5e1", background: "#fff", color: "#2563eb", fontSize: "0.78rem", cursor: "pointer" }} onClick={() => void refreshExtend()} disabled={extending} type="button">🔄 刷新{extending ? "中…" : ""}</button><button style={{ padding: "0.3rem 0.9rem", borderRadius: 8, border: "1px solid #cbd5e1", background: "#fff", color: "#64748b", fontSize: "0.78rem", cursor: "pointer" }} onClick={() => setExtendResult(null)} type="button">
                      🙈 收起
                    </button>
                  </div>
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "0.82rem", lineHeight: 1.6, color: "#4c1d95", margin: 0, maxHeight: "40vh", overflowY: "auto" }}>
                    {extendResult}
                  </pre>
                </div>
              )}

              {/* 添加个股 */}
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "center", marginBottom: "0.8rem" }}>
                <select
                  style={{ ...input, width: 104 }}
                  value={addKind}
                  onChange={(e) => setAddKind(e.target.value as "stock" | "fund")}
                  title="股票/ETF 走腾讯实时行情；场外基金走天天基金净值"
                >
                  <option value="stock">股票 / ETF</option>
                  <option value="fund">场外基金</option>
                </select>
                <div style={{ position: "relative", flex: 1, minWidth: 180 }}>
                  <input
                    style={{ ...input, width: "100%", boxSizing: "border-box" }}
                    placeholder={addKind === "fund" ? "代码 161725" : "代码或名称（如 600519 / 茅台，自动识别）"}
                    value={addCode}
                    onChange={(e) => {
                      setAddCode(e.target.value);
                      setAddName("");
                      setCandsOpen(false);
                      searchStockCands(e.target.value);
                    }}
                    onBlur={() => setTimeout(() => setCandsOpen(false), 200)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && candsOpen && stockCands.length > 0) {
                        const c = stockCands[0];
                        setAddCode(c.code);
                        setAddName(c.name);
                        setCandsOpen(false);
                        e.preventDefault();
                      }
                    }}
                  />
                  {/* 已识别名称反馈（统一输入框：代码/名称皆可，识别结果即时展示） */}
                  {addName && addKind === "stock" && (
                    <span
                      style={{
                        position: "absolute",
                        right: 8,
                        top: "50%",
                        transform: "translateY(-50%)",
                        background: "#dcfce7",
                        color: "#15803d",
                        fontSize: "0.72rem",
                        fontWeight: 600,
                        padding: "0.1rem 0.5rem",
                        borderRadius: 999,
                        pointerEvents: "none",
                        maxWidth: 120,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      🏷️ {addName}
                    </span>
                  )}
                  {candsOpen && stockCands.length > 0 && (
                    <div
                      style={{
                        position: "absolute",
                        top: "100%",
                        left: 0,
                        right: 0,
                        marginTop: 4,
                        background: "#fff",
                        border: "1px solid #e2e8f0",
                        borderRadius: 10,
                        boxShadow: "0 8px 24px rgba(15,23,42,.14)",
                        zIndex: 20,
                        maxHeight: 260,
                        overflowY: "auto",
                      }}
                    >
                      {stockCands.map((c, i) => (
                        <div
                          key={`${c.market}-${c.code}`}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setAddCode(c.code);
                            if (!addName.trim()) setAddName(c.name);
                            setCandsOpen(false);
                          }}
                          style={{
                            padding: "0.45rem 0.7rem",
                            cursor: "pointer",
                            display: "flex",
                            gap: "0.5rem",
                            alignItems: "baseline",
                            fontSize: "0.84rem",
                            borderBottom: i < stockCands.length - 1 ? "1px solid #f1f5f9" : "none",
                          }}
                        >
                          <span style={{ fontWeight: 600, color: "#334155" }}>{c.name}</span>
                          <span style={{ color: "#64748b", fontFamily: "monospace", fontSize: "0.78rem" }}>{c.market}{c.code}</span>
                          <span style={{ color: "#94a3b8", fontSize: "0.72rem" }}>{c.type}</span>
                        </div>
                      ))}
                      {candsLoading && <div style={{ padding: "0.45rem 0.7rem", color: "#94a3b8", fontSize: "0.78rem" }}>搜索中…</div>}
                    </div>
                  )}
                </div>
                <input
                  style={{ ...input, flex: 1, minWidth: 180 }}
                  placeholder="入选理由（必填）"
                  value={addReason}
                  onChange={(e) => setAddReason(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void addStock(); }}
                />
                <button style={btn} onClick={() => void addStock()} disabled={loading} type="button">加入专题</button>
              </div>

              {/* 个股表（拖动 ⠿ 行头调整优先级；顺序 = 优先级；行情 = 实时快照） */}
              <table style={table}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: 34 }}>⠿</th>
                    <th style={{ ...th, textAlign: "left" }}>名称 / 代码</th>
                    <th style={{ ...th, textAlign: "left" }}>入选理由</th>
                    <th style={{ ...th, width: 130 }}>
                      行情
                      {Object.keys(quotes).length > 0 && (
                        <button
                          type="button"
                          title="按今日涨跌幅排序（仅查看，不影响列表顺序）；排序视图下不可拖拽"
                          onClick={() => setSortMode((m) => (m === "none" ? "desc" : m === "desc" ? "asc" : "none"))}
                          style={{ marginLeft: "0.35rem", padding: "0.1rem 0.4rem", borderRadius: 6, border: "1px solid #cbd5e1", background: sortMode === "none" ? "#fff" : "#eff6ff", color: sortMode === "none" ? "#64748b" : "#2563eb", fontSize: "0.7rem", cursor: "pointer" }}
                        >
                          {sortMode === "none" ? "↕" : sortMode === "desc" ? "↓ 高→低" : "↑ 低→高"}
                        </button>
                      )}
                    </th>
                    <th style={{ ...th, width: 130 }}>财报分析</th>
                    <th style={{ ...th, width: 60 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {topic.stocks.length === 0 && (
                    <tr>
                      <td style={thTd} colSpan={6}>
                        <span style={{ color: "#94a3b8" }}>暂无自选股，请在上面添加。拖动 ⠿ 可调整优先级。</span>
                      </td>
                    </tr>
                  )}
                  {(() => {
                       if (sortMode === "none") return topic.stocks;
                       // 排序视图：按行情涨跌幅排序（无行情数据按 0 计，置底）
                       return [...topic.stocks].sort((a, b) => {
                         const qa = typeof quotes[a.code]?.pct === "number" ? (quotes[a.code]!.pct as number) : (sortMode === "desc" ? -Infinity : Infinity);
                         const qb = typeof quotes[b.code]?.pct === "number" ? (quotes[b.code]!.pct as number) : (sortMode === "desc" ? -Infinity : Infinity);
                         return sortMode === "desc" ? qb - qa : qa - qb;
                       });
                     })().map((s, i) => {
                    const q = quotes[s.code];
                    return (
                    <tr
                      key={s.code}
                      draggable={sortMode === "none"}
                      onDragStart={() => setDragIdx(i)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => { if (dragIdx !== null) void reorderStock(dragIdx, i); setDragIdx(null); }}
                      onDragEnd={() => setDragIdx(null)}
                      style={{
                        cursor: "grab",
                        ...(dragIdx === i ? { opacity: 0.35, background: "#f8fafc" } : {}),
                        ...(dragIdx !== null && dragIdx !== i ? { borderTop: "2px dashed #93c5fd" } : {}),
                      }}
                    >
                      <td style={{ ...thTd, color: "#94a3b8", fontSize: "1rem" }} title="拖动调整优先级">⠿</td>
                      <td style={{ ...thTd, textAlign: "left", whiteSpace: "nowrap" }}>
                        <a
                          href={stockDetailUrl(s.code, s.kind)}
                          target="_blank"
                          rel="noreferrer"
                          title={s.kind === "fund" ? "跳转天天基金" : "跳转雪球个股页"}
                          onClick={(e) => e.stopPropagation()}
                          style={{ color: "inherit", textDecoration: "none" }}
                        >
                          <div style={{ fontWeight: 700, fontSize: "0.95rem", lineHeight: 1.3 }}>{s.name ?? "—"}</div>
                          <div style={{ color: "#1d4ed8", fontSize: "0.72rem", lineHeight: 1.2, textDecoration: "underline" }}>{s.code} ↗</div>
                        </a>
                      </td>
                      <td style={{ ...thTd, textAlign: "left", fontSize: "0.8rem" }}>{s.reason}
                        {optNotice?.code === s.code && (
                          <div style={{ marginTop: "0.25rem", fontSize: "0.72rem", color: optNotice.ok === false ? "#b91c1c" : optNotice.ok ? "#15803d" : "#64748b" }}>
                            {optNotice.text}
                          </div>
                        )}
                      </td>
                      <td style={{ ...thTd, fontSize: "0.75rem", textAlign: "left", whiteSpace: "nowrap" }}>
                        {q?.ok ? (
                          s.kind === "fund" ? (
                            <>
                              <div style={{ fontWeight: 600 }}>
                                {q.nav !== undefined ? q.nav.toFixed(4) : "—"}
                                {q.pct !== undefined ? (
                                  <span style={{ color: (q.pct ?? 0) >= 0 ? "#dc2626" : "#16a34a", marginLeft: "0.25rem" }}>
                                    {(q.pct ?? 0) >= 0 ? "+" : ""}{q.pct}%
                                  </span>
                                ) : null}
                              </div>
                              <div
                                style={{ color: "#64748b" }}
                                title={
                                  [
                                    q.navDate ? `净值日期 ${q.navDate}` : "",
                                    q.totalNav !== undefined ? `累计净值 ${q.totalNav}` : "",
                                    q.m1 !== undefined ? `近1月 ${q.m1}%` : "",
                                    q.y1 !== undefined ? `近1年 ${q.y1}%` : "",
                                    q.manager ? `经理 ${q.manager}` : "",
                                    q.company ? `公司 ${q.company}` : "",
                                    q.riskLevel ? `风险等级 ${q.riskLevel}` : "",
                                    q.buyStatus ? `申购 ${q.buyStatus}` : "",
                                  ].filter(Boolean).join("\n") || "场外基金"
                                }
                              >
                                {q.navDate ? `净值 ${q.navDate}` : "场外基金"}
                              </div>
                            </>
                          ) : (
                            <>
                              <div style={{ fontWeight: 600 }}>
                                {q.price?.toLocaleString() ?? "—"}
                                {q.pct !== undefined ? (
                                  <span style={{ color: (q.pct ?? 0) >= 0 ? "#dc2626" : "#16a34a", marginLeft: "0.25rem" }}>
                                    {(q.pct ?? 0) >= 0 ? "+" : ""}{q.pct}%
                                  </span>
                                ) : null}
                              </div>
                              <div style={{ color: "#64748b" }}>
                                {q.marketCap !== undefined ? `市值 ${(q.marketCap / 10000).toFixed(2)}万亿` : ""}
                                {q.pe !== undefined ? ` PE ${q.pe}` : ""}
                              </div>
                            </>
                          )
                        ) : (
                          <span style={{ color: "#94a3b8" }}>—</span>
                        )}
                      </td>
                      <td style={thTd}>
                        {s.kind === "fund" ? (
                          <span style={{ fontSize: "0.7rem", color: "#94a3b8" }}>净值型</span>
                        ) : (
                          <>
                            <button
                              style={btnSmall}
                              onClick={() => void analyze(s)}
                              disabled={!!analyzing[s.code]}
                              type="button"
                            >
                              {analyzing[s.code] ? "分析中…" : fundamentals[s.code] ? "重新分析" : "📊 分析"}
                            </button>
                            {fundamentals[s.code]?.ok ? (
                              <div style={{ marginTop: "0.3rem", fontSize: "0.75rem", color: "#15803d" }}>
                                {fundamentals[s.code].conclusion ?? "已生成分析"}
                              </div>
                            ) : fundamentals[s.code] && !fundamentals[s.code].ok ? (
                              <div style={{ marginTop: "0.3rem", fontSize: "0.75rem", color: "#b91c1c" }}>{fundamentals[s.code].message}</div>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td style={thTd}>
                        <button style={btnGhost} onClick={() => void removeStock(s.code)} type="button">移除</button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* 财报分析详情 */}
              {Object.entries(fundamentals).map(([code, r]) =>
                r.ok ? (
                  <FundamentalCard
                    key={code}
                    r={r}
                    onClose={() => setFundamentals((f) => { const n = { ...f }; delete n[code]; return n; })}
                    onOptimize={() => void optimizeReasonForStock(topic?.stocks.find((s) => s.code === code))}
                  />
                ) : null,
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
