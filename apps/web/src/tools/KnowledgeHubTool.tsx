// ============================================================
// 知识库中心（工具分组）
// 列表视图：领域库与虚拟库混合展示；「详情」进入知识库详情页
// 详情页四区（Tab）：配置区 / 导入区 / 问答区 / 数据区
// - 领域知识库：导入直接进本库，问答只查本库，可配置特化模板
// - 虚拟知识库：导入自动分发到最匹配子领域，问答先领域路由（综合匹配）
// ============================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../api";
import Modal from "../Modal";
import type { KnowledgeDomainMeta, KnowledgeEntry, KnowledgeInstanceInfo, VirtualKb } from "@toolbox/shared";

const card: CSSProperties = {
  background: "#fff",
  borderRadius: 12,
  padding: "1.25rem 1.5rem",
  marginBottom: "1rem",
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
};
const input: CSSProperties = {
  padding: "0.55rem 0.8rem",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  fontSize: "0.85rem",
  outline: "none",
  flex: 1,
  minWidth: 0,
};
const btn: CSSProperties = {
  padding: "0.55rem 1.1rem",
  borderRadius: 8,
  border: "none",
  background: "#3b82f6",
  color: "#fff",
  fontSize: "0.85rem",
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
const chip: CSSProperties = {
  padding: "0.28rem 0.8rem",
  borderRadius: 999,
  fontSize: "0.82rem",
  cursor: "pointer",
  border: "1px solid #cbd5e1",
  background: "#f1f5f9",
};

interface Overview {
  instances: (KnowledgeInstanceInfo & { meta?: KnowledgeDomainMeta | null })[];
  domains: KnowledgeDomainMeta[];
  virst: VirtualKb[];
}

/** 统一知识库条目（领域库 / 虚拟库混合） */
type KbEntry =
  | { type: "domain"; name: string; count: number; meta: KnowledgeDomainMeta | null }
  | { type: "virt"; name: string; count: number; virt: VirtualKb };

export default function KnowledgeHubTool() {
  const [ov, setOv] = useState<Overview>({ instances: [], domains: [], virst: [] });
  const [err, setErr] = useState("");
  // 视图：null=列表，KbEntry=详情
  const [detail, setDetail] = useState<KbEntry | null>(null);
  const [tab, setTab] = useState<"config" | "import" | "ask" | "data">("ask");
  // 使用区状态
  const [askQ, setAskQ] = useState("");
  const [askA, setAskA] = useState("");
  const [askRouted, setAskRouted] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [importMsg, setImportMsg] = useState("");
  const [importResults, setImportResults] = useState<import("@toolbox/shared").KnowledgeImportRecordItem[]>([]);
  const [importDistribution, setImportDistribution] = useState<Record<string, number> | null>(null);
  const [importHistory, setImportHistory] = useState<import("@toolbox/shared").KnowledgeImportRecord[]>([]);
  const [busy, setBusy] = useState(false);
  // 领域配置状态
  const [tplAsk, setTplAsk] = useState("");
  const [tplExtract, setTplExtract] = useState("");
  const [metaDesc, setMetaDesc] = useState("");
  const [metaKeywords, setMetaKeywords] = useState("");
  const [cfgMsg, setCfgMsg] = useState("");
  // 数据区
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [entryTotal, setEntryTotal] = useState(0);
  const [entryOffset, setEntryOffset] = useState(0);
  const [entryMsg, setEntryMsg] = useState("");
  // 新建
  const [showNew, setShowNew] = useState<"domain" | "virt" | "">("");
  const [ndName, setNdName] = useState("");
  const [ndDesc, setNdDesc] = useState("");
  const [ndKeywords, setNdKeywords] = useState("");
  const [ndGenTpl, setNdGenTpl] = useState(false);
  const [nvName, setNvName] = useState("");
  const [nvDesc, setNvDesc] = useState("");
  const [nvSelDomains, setNvSelDomains] = useState<string[]>([]);
  // 虚拟库编辑（详情页配置区）
  const [virtEditDomains, setVirtEditDomains] = useState<string[]>([]);
  const [virtEditDesc, setVirtEditDesc] = useState("");
  // 删除确认 Modal
  const [delTarget, setDelTarget] = useState<KbEntry | null>(null);
  const [delTyped, setDelTyped] = useState("");
  // 医学模板重置确认 Modal
  const [seedAsk, setSeedAsk] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.knowledgeHubOverview();
      setOv({ instances: r.instances, domains: r.domains, virst: r.virst });
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 统一条目列表：领域元数据 + 隐式实例领域 + 虚拟库
  const entriesList = useMemo<KbEntry[]>(() => {
    const list: KbEntry[] = [];
    const domainNames = new Set<string>();
    for (const d of ov.domains) {
      domainNames.add(d.name);
      const count = ov.instances.find((i) => i.instance === d.name)?.count ?? 0;
      list.push({ type: "domain", name: d.name, count, meta: d });
    }
    for (const it of ov.instances) {
      if (!domainNames.has(it.instance)) {
        domainNames.add(it.instance);
        list.push({ type: "domain", name: it.instance, count: it.count, meta: it.meta ?? null });
      }
    }
    for (const v of ov.virst) {
      const count = v.domains.reduce((s, d) => s + (ov.instances.find((i) => i.instance === d)?.count ?? 0), 0);
      list.push({ type: "virt", name: v.name, count, virt: v });
    }
    // 虚拟库在前，领域库在后（各按条数降序）
    return list.sort((a, b) => (a.type === b.type ? b.count - a.count : a.type === "virt" ? -1 : 1));
  }, [ov]);

  // 虚拟库可选的领域 = 全部领域（有数据实例 ∪ 已建元数据，含空库）
  const allDomains = useMemo(() => {
    const s = new Set<string>();
    for (const it of ov.instances) s.add(it.instance);
    for (const d of ov.domains) s.add(d.name);
    return [...s];
  }, [ov]);
  const domainCount = (name: string) => ov.instances.find((i) => i.instance === name)?.count ?? 0;

  // ---------- 详情页：进入/返回时重置状态 ----------
  const openDetail = (e: KbEntry) => {
    setDetail(e);
    setTab("ask");
    setAskA("");
    setAskRouted("");
    setImportMsg("");
    setCfgMsg("");
    setEntryOffset(0);
    if (e.type === "domain") {
      setTplAsk(e.meta?.askTemplate ?? "");
      setTplExtract(e.meta?.extractTemplate ?? "");
      setMetaDesc(e.meta?.desc ?? "");
      setMetaKeywords(e.meta?.keywords?.join("，") ?? "");
    } else {
      setVirtEditDomains([...e.virt.domains]);
      setVirtEditDesc(e.virt.desc ?? "");
    }
  };

  // 数据区加载
  const loadEntries = useCallback(async () => {
    if (!detail) return;
    try {
      const r = detail.type === "virt"
        ? await api.knowledgeHubVirtEntries(detail.name, 50, entryOffset)
        : await api.knowledgeHubDomainEntries(detail.name, 50, entryOffset);
      setEntries(r.entries);
      setEntryTotal(r.total);
      setEntryMsg("");
    } catch (e) {
      setEntryMsg(`❌ ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [detail, entryOffset]);

  useEffect(() => {
    if (detail && tab === "data") void loadEntries();
    if (detail && tab === "import") void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, tab, entryOffset]);

  // ---------- 问答 ----------
  const ask = async () => {
    if (!detail || !askQ.trim()) return;
    setBusy(true);
    setAskA("");
    setAskRouted("");
    try {
      if (detail.type === "virt") {
        const r = await api.knowledgeHubAskVirt(detail.name, askQ);
        if (r.ok && r.answer) {
          setAskA(r.answer);
          setAskRouted((r as { routed?: string }).routed ?? "");
        } else setAskA(`❌ ${(r as { message?: string }).message ?? "无回答"}`);
      } else {
        const r = await api.knowledgeHubAskDomain(detail.name, askQ);
        if (r.ok && r.answer) setAskA(r.answer);
        else setAskA(`❌ ${(r as { message?: string }).message ?? "无回答"}`);
      }
    } catch (e) {
      setAskA(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // ---------- 导入（批量：每行一条链接） ----------
  const doImport = async () => {
    if (!detail) return;
    const urls = importUrl.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 20);
    if (urls.length === 0) return setImportMsg("❌ 请至少输入一条 Chat 分享链接");
    setBusy(true);
    setImportMsg("");
    setImportResults([]);
    setImportDistribution(null);
    try {
      const r = detail.type === "virt"
        ? await api.knowledgeHubImportBatchVirt(detail.name, urls)
        : await api.knowledgeHubImportBatchDomain(detail.name, urls);
      if (r.ok) {
        setImportResults(r.items);
        setImportDistribution((r as { distribution?: Record<string, number> }).distribution ?? null);
        const fail = r.items.filter((i) => !i.ok).length;
        setImportMsg(`✅ 批量导入完成：共导入 ${r.totalImported} 条（${r.items.length} 链接，${fail ? `${fail} 失败` : "全部成功"}）`);
        await loadHistory();
        if (tab === "data") void loadEntries();
      } else setImportMsg(`❌ ${(r as { message?: string }).message ?? "导入失败"}`);
    } catch (e) {
      setImportMsg(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const loadHistory = useCallback(async () => {
    try {
      const r = await api.knowledgeHubImportHistory();
      setImportHistory(r.items);
    } catch {
      /* ignore */
    }
  }, []);

  const clearHistory = async () => {
    if (!confirm("清空全部导入历史记录？")) return;
    try {
      await api.knowledgeHubClearImportHistory();
      setImportHistory([]);
    } catch (e) {
      setImportMsg(`❌ ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ---------- 领域配置保存 ----------
  const saveCfg = async () => {
    if (detail?.type !== "domain") return;
    try {
      await api.knowledgeHubSetDomain(detail.name, {
        desc: metaDesc,
        keywords: metaKeywords.split(/[,，、]/).map((k) => k.trim()).filter(Boolean),
        askTemplate: tplAsk,
        extractTemplate: tplExtract,
      });
      setCfgMsg("✅ 已保存");
      setTimeout(() => setCfgMsg(""), 2500);
      await load();
    } catch (e) {
      setErr(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const seedMedical = async () => {
    if ((!!tplAsk || !!tplExtract) && !seedAsk) {
      setSeedAsk(true);
      return;
    }
    setSeedAsk(false);
    try {
      await api.knowledgeHubSeedMedical(!!tplAsk || !!tplExtract);
      setCfgMsg("✅ 已初始化内置医学模板");
      setTimeout(() => setCfgMsg(""), 3000);
      await load();
    } catch (e) {
      setErr(`初始化失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ---------- 新建 ----------
  const createNewDomain = async () => {
    if (!ndName.trim()) return setErr("请填写领域名称");
    setBusy(true);
    try {
      const r = await api.knowledgeHubCreateDomain(ndName.trim(), ndDesc || undefined, ndKeywords.split(/[,，、]/).map((k) => k.trim()).filter(Boolean), ndGenTpl);
      if (!r.ok) setErr(r.message ?? "创建失败");
      else {
        setErr((r as { warning?: string }).warning ? `⚠️ ${(r as { warning?: string }).warning}` : "");
        setShowNew("");
        setNdName("");
        setNdDesc("");
        setNdKeywords("");
        setNdGenTpl(false);
        await load();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const createNewVirt = async () => {
    if (!nvName.trim() || nvSelDomains.length === 0) return setErr("请填写虚拟库名称并至少勾选一个领域");
    try {
      const r = await api.knowledgeHubCreateVirt(nvName.trim(), nvSelDomains, nvDesc || undefined);
      if (!r.ok) setErr(r.message ?? "创建失败");
      else {
        setErr("");
        setShowNew("");
        setNvName("");
        setNvDesc("");
        setNvSelDomains([]);
        await load();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleVirtDomain = (d: string) => {
    setNvSelDomains((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  };

  // 虚拟库配置保存（动态调整引用领域）
  const saveVirtCfg = async () => {
    if (detail?.type !== "virt") return;
    if (virtEditDomains.length === 0) return setCfgMsg("❌ 至少保留一个领域");
    try {
      const r = await api.knowledgeHubUpdateVirt(detail.name, { domains: virtEditDomains, desc: virtEditDesc });
      if (!r.ok) setCfgMsg(`❌ ${r.message ?? "保存失败"}`);
      else {
        setCfgMsg("✅ 已保存");
        setTimeout(() => setCfgMsg(""), 2500);
        await load();
      }
    } catch (e) {
      setCfgMsg(`❌ ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ---------- 删除（Modal 输入名称精准确认） ----------
  const confirmDelete = async () => {
    if (!delTarget) return;
    if (delTyped.trim() !== delTarget.name) {
      setErr("名称不匹配，已取消删除");
      setDelTarget(null);
      setDelTyped("");
      return;
    }
    const e = delTarget;
    setDelTarget(null);
    setDelTyped("");
    try {
      if (e.type === "domain") {
        const r = await api.knowledgeHubDeleteDomain(e.name);
        if (r.ok) setErr(`🗑️ 领域「${e.name}」已删除（清空 ${(r as { removedEntries?: number }).removedEntries ?? 0} 条）`);
        else setErr(`删除失败：${r.message}`);
      } else {
        await api.knowledgeHubDeleteVirt(e.name);
        setErr(`🗑️ 虚拟库「${e.name}」已删除`);
      }
      setDetail(null);
      await load();
    } catch (ex) {
      setErr(`删除失败：${ex instanceof Error ? ex.message : String(ex)}`);
    }
  };

  // ---------- 数据区：单条删除 ----------
  const deleteEntry = async (key: string) => {
    if (detail?.type !== "domain" || !confirm(`删除知识条目「${key}」？`)) return;
    try {
      const r = await api.knowledgeHubDeleteEntry(detail.name, key);
      setEntryMsg(r.ok ? "✅ 已删除" : `❌ ${r.message ?? ""}`);
      await loadEntries();
    } catch (e) {
      setEntryMsg(`❌ ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ================= 详情视图 =================
  if (detail) {
    return (
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "1.5rem 1rem", color: "#1e293b", fontSize: "0.9rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", marginBottom: "0.8rem", flexWrap: "wrap" }}>
          <button style={{ ...btn, background: "#64748b", padding: "0.4rem 0.9rem", fontSize: "0.82rem" }} onClick={() => setDetail(null)}>← 返回列表</button>
          <h2 style={{ margin: 0, fontSize: "1.15rem" }}>
            {detail.type === "virt" ? "🧩" : "🏷️"} {detail.name}
          </h2>
          <span style={{ fontSize: "0.78rem", padding: "0.1rem 0.5rem", borderRadius: 999, background: detail.type === "virt" ? "#ede9fe" : "#dbeafe", color: detail.type === "virt" ? "#6d28d9" : "#1d4ed8" }}>
            {detail.type === "virt" ? "虚拟库" : "领域库"}
          </span>
          <span style={{ fontSize: "0.82rem", color: "#64748b" }}>{detail.count} 条</span>
          {detail.type === "virt" && (
            <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
              组成：{detail.virt.domains.map((d) => `${d}(${domainCount(d)})`).join("、")}
            </span>
          )}
          {detail.type === "domain" && detail.meta?.desc && <span style={{ fontSize: "0.8rem", color: "#64748b" }}>{detail.meta.desc}</span>}
          <button style={{ ...btn, background: "#ef4444", fontSize: "0.76rem", padding: "0.35rem 0.7rem", marginLeft: "auto" }} onClick={() => { setDelTarget(detail); setDelTyped(""); }}>🗑️ 删除</button>
        </div>
        {err && <div style={{ ...card, color: "#b91c1c", background: "#fef2f2" }}>⚠️ {err}</div>}

        {/* Tab 切换 */}
        <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1rem", flexWrap: "wrap" }}>
          {([["ask", "🔍 问答区"], ["import", "📥 导入区"], ["config", "⚙️ 配置区"], ["data", "🗃️ 数据区"]] as [typeof tab, string][]).map(([k, label]) => (
            <button key={k} style={{ ...btn, background: tab === k ? "#3b82f6" : "#cbd5e1", fontSize: "0.82rem", padding: "0.4rem 1rem" }} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>

        {/* 问答区 */}
        {tab === "ask" && (
          <div style={card}>
            <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.6rem" }}>
              <input style={input} placeholder={`向「${detail.name}」提问…`} value={askQ} onChange={(e) => setAskQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void ask(); }} autoFocus />
              <button style={btn} onClick={() => void ask()} disabled={busy}>🔍 问答</button>
            </div>
            {askRouted && (
              <div style={{ fontSize: "0.8rem", color: "#6d28d9", marginBottom: "0.4rem" }}>
                ⚡ 自动路由：该问题已匹配到「{askRouted}」领域，仅在该领域检索（更聚焦、更省）
              </div>
            )}
            {askA && <div style={{ whiteSpace: "pre-wrap", background: "#f8fafc", borderRadius: 8, padding: "0.8rem 1rem", lineHeight: 1.7 }}>{askA}</div>}
          </div>
        )}

        {/* 导入区 */}
        {tab === "import" && (
          <div style={card}>
            <div style={{ fontSize: "0.85rem", color: "#64748b", marginBottom: "0.6rem" }}>
              {detail.type === "virt" ? "批量粘贴 Chat 分享链接（每行一条），导入内容将自动分发到最匹配的子领域（按领域关键词匹配，无匹配归 other）。" : "批量粘贴 Chat 分享链接（每行一条），导入内容直接写入本领域库。"}
            </div>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
              <textarea
                style={{ ...input, minHeight: 72, resize: "vertical", fontFamily: "inherit", lineHeight: 1.6 }}
                placeholder={"https://chat.deepseek.com/share/xxxx\nhttps://chat.deepseek.com/share/yyyy\n（每行一条，最多 20 条）"}
                value={importUrl}
                onChange={(e) => setImportUrl(e.target.value)}
              />
              <button style={btn} onClick={() => void doImport()} disabled={busy}>
                {busy ? "⏳ 导入中…" : `📥 批量导入（${importUrl.split("\n").map((s) => s.trim()).filter(Boolean).length} 条）`}
              </button>
            </div>
            {importMsg && <div style={{ color: "#0e7490", marginTop: "0.5rem", fontSize: "0.85rem" }}>{importMsg}</div>}
            {/* 逐条结果 */}
            {importResults.length > 0 && (
              <div style={{ marginTop: "0.8rem", borderTop: "1px dashed #e2e8f0", paddingTop: "0.7rem" }}>
                <div style={{ fontWeight: 600, fontSize: "0.88rem", marginBottom: "0.5rem" }}>
                  导入结果（{importResults.filter((r) => r.ok).length} 成功 / {importResults.filter((r) => !r.ok).length} 失败，共 {importResults.reduce((s, r) => s + r.imported, 0)} 条）
                  {importDistribution && Object.keys(importDistribution).length > 0 && (
                    <span style={{ marginLeft: "0.6rem", fontWeight: 400 }}>
                      分发：
                      {Object.entries(importDistribution).map(([k, v]) => (
                        <span key={k} style={{ ...chip, marginLeft: "0.3rem", background: "#ecfdf5", borderColor: "#a7f3d0", fontSize: "0.76rem", padding: "0.1rem 0.55rem" }}>{k} → {v}</span>
                      ))}
                    </span>
                  )}
                </div>
                <div style={{ display: "grid", gap: "0.4rem" }}>
                  {importResults.map((r, idx) => (
                    <div key={idx} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", border: `1px solid ${r.ok ? "#bbf7d0" : "#fecaca"}`, borderRadius: 8, padding: "0.45rem 0.7rem", background: r.ok ? "#f0fdf4" : "#fef2f2" }}>
                      <span style={{ fontSize: "0.85rem" }}>{r.ok ? "✅" : "❌"}</span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: "0.75rem", color: "#64748b", wordBreak: "break-all" }}>{r.url}</div>
                        {r.title && <div style={{ fontSize: "0.8rem", color: "#334155" }}>「{r.title.slice(0, 50)}」</div>}
                        {r.ok ? (
                          <div style={{ fontSize: "0.78rem", color: "#15803d" }}>导入 {r.imported} 条{r.skipped ? ` · 跳过 ${r.skipped}` : ""}{r.conflicts ? ` · 冲突 ${r.conflicts}` : ""}</div>
                        ) : (
                          <div style={{ fontSize: "0.78rem", color: "#b91c1c" }}>{r.message}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* 历史导入记录 */}
            <details style={{ marginTop: "0.9rem", borderTop: "1px dashed #e2e8f0", paddingTop: "0.7rem" }}>
              <summary style={{ cursor: "pointer", fontSize: "0.83rem", color: "#475569", fontWeight: 600 }}>
                🕘 历史导入记录（{importHistory.length} 条）
              </summary>
              <div style={{ marginTop: "0.6rem" }}>
                {importHistory.length > 0 && (
                  <button style={{ ...btn, background: "#ef4444", fontSize: "0.75rem", padding: "0.3rem 0.7rem", marginBottom: "0.5rem" }} onClick={() => void clearHistory()}>🗑️ 清空历史</button>
                )}
                {importHistory.length === 0 && <div style={{ color: "#94a3b8", fontSize: "0.82rem" }}>（暂无导入记录）</div>}
                <div style={{ display: "grid", gap: "0.4rem" }}>
                  {importHistory.map((h, idx) => (
                    <div key={idx} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.5rem 0.7rem" }}>
                      <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap", fontSize: "0.8rem" }}>
                        <span style={{ fontWeight: 600 }}>{h.targetType === "virt" ? "🧩" : "🏷️"} {h.target}</span>
                        <span style={{ color: "#64748b" }}>{new Date(h.time).toLocaleString()}</span>
                        <span style={{ color: "#15803d" }}>导入 {h.totalImported} 条（{h.items.length} 链接：{h.items.filter((i) => i.ok).length} 成功 / {h.items.filter((i) => !i.ok).length} 失败）</span>
                        {h.distribution && Object.keys(h.distribution).length > 0 && (
                          <span style={{ color: "#64748b" }}>分发：{Object.entries(h.distribution).map(([k, v]) => `${k}→${v}`).join("、")}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          </div>
        )}

        {/* 配置区 */}
        {tab === "config" && (
          <div style={card}>
            {detail.type === "virt" ? (
              <div>
                <div style={{ fontSize: "0.85rem", color: "#64748b", marginBottom: "0.6rem" }}>勾选下方领域可动态调整虚拟库的引用范围（导入自动分发、问答自动路由）：</div>
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.8rem" }}>
                  {allDomains.map((d) => {
                    const on = virtEditDomains.includes(d);
                    return (
                      <span
                        key={d}
                        style={{ ...chip, background: on ? "#dbeafe" : "#f1f5f9", borderColor: on ? "#3b82f6" : "#cbd5e1", userSelect: "none" }}
                        onClick={() => setVirtEditDomains((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]))}
                      >
                        {on ? "☑" : "☐"} {d}（{domainCount(d)}）
                      </span>
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.8rem" }}>
                  <input style={{ ...input }} placeholder="虚拟库描述（可选）" value={virtEditDesc} onChange={(e) => setVirtEditDesc(e.target.value)} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.8rem" }}>
                  <button style={btn} onClick={() => void saveVirtCfg()}>💾 保存引用</button>
                  {cfgMsg && <span style={{ color: "#0e7490", fontSize: "0.85rem" }}>{cfgMsg}</span>}
                </div>
              </div>
            ) : (
              <div>
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.8rem" }}>
                  <input style={{ ...input, maxWidth: 340 }} placeholder="领域描述（自动匹配导入用）" value={metaDesc} onChange={(e) => setMetaDesc(e.target.value)} />
                  <input style={{ ...input }} placeholder="匹配关键词（逗号分隔，问答路由/导入分发用）" value={metaKeywords} onChange={(e) => setMetaKeywords(e.target.value)} />
                </div>
                {detail.name === "medical" && (
                  <button style={{ ...btn, background: "#10b981", fontSize: "0.78rem", padding: "0.35rem 0.8rem", marginBottom: "0.6rem" }} onClick={() => void seedMedical()}>
                    🔄 重置为内置医学模板
                  </button>
                )}
                <div style={{ display: "grid", gap: "0.6rem" }}>
                  <div>
                    <div style={{ fontSize: "0.82rem", fontWeight: 600, marginBottom: "0.25rem", color: "#475569" }}>问答模板（system；留空用通用{detail.name === "medical" ? "，可点上方重置为内置医学模板" : ""}）</div>
                    <textarea style={{ width: "100%", minHeight: 80, resize: "vertical", padding: "0.5rem 0.7rem", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: "0.8rem", fontFamily: "inherit", lineHeight: 1.5, boxSizing: "border-box" }} value={tplAsk} onChange={(e) => setTplAsk(e.target.value)} />
                  </div>
                  <div>
                    <div style={{ fontSize: "0.82rem", fontWeight: 600, marginBottom: "0.25rem", color: "#475569" }}>导入提取模板（system；留空用通用）</div>
                    <textarea style={{ width: "100%", minHeight: 80, resize: "vertical", padding: "0.5rem 0.7rem", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: "0.8rem", fontFamily: "inherit", lineHeight: 1.5, boxSizing: "border-box" }} value={tplExtract} onChange={(e) => setTplExtract(e.target.value)} />
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", marginTop: "0.6rem" }}>
                  <button style={btn} onClick={() => void saveCfg()}>💾 保存配置</button>
                  {cfgMsg && <span style={{ color: "#0e7490", fontSize: "0.85rem" }}>{cfgMsg}</span>}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 数据区 */}
        {tab === "data" && (
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.6rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>🗃️ 知识条目（共 {entryTotal} 条）</div>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <button style={{ ...btn, background: "#64748b", fontSize: "0.78rem", padding: "0.3rem 0.7rem" }} disabled={entryOffset === 0} onClick={() => setEntryOffset((o) => Math.max(0, o - 50))}>上一页</button>
                <span style={{ fontSize: "0.82rem", color: "#64748b" }}>第 {Math.floor(entryOffset / 50) + 1} / {Math.max(1, Math.ceil(entryTotal / 50))} 页</span>
                <button style={{ ...btn, background: "#64748b", fontSize: "0.78rem", padding: "0.3rem 0.7rem" }} disabled={entryOffset + 50 >= entryTotal} onClick={() => setEntryOffset((o) => o + 50)}>下一页</button>
              </div>
            </div>
            {entryMsg && <div style={{ color: "#0e7490", fontSize: "0.85rem", marginBottom: "0.5rem" }}>{entryMsg}</div>}
            {entries.length === 0 && <div style={{ color: "#94a3b8", fontSize: "0.85rem" }}>（暂无条目，可在「导入区」导入知识）</div>}
            <div style={{ display: "grid", gap: "0.4rem" }}>
              {entries.map((en) => (
                <div key={en.key} style={{ display: "flex", gap: "0.6rem", alignItems: "flex-start", border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.5rem 0.7rem", background: "#fff" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: "0.78rem", color: "#1d4ed8", fontFamily: "monospace", wordBreak: "break-all" }}>{en.key}</div>
                    <div style={{ fontSize: "0.82rem", color: "#334155", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{en.value}</div>
                    {en.source && <div style={{ fontSize: "0.72rem", color: "#94a3b8", marginTop: "0.2rem" }}>来源：{en.source}</div>}
                  </div>
                  <button style={{ fontSize: "0.7rem", padding: "0.15rem 0.5rem", borderRadius: 5, border: "1px solid #fecaca", background: "#fef2f2", color: "#dc2626", cursor: "pointer", whiteSpace: "nowrap" }} onClick={() => void deleteEntry(en.key)}>删除</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ================= 列表视图 =================
  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "1.5rem 1rem", color: "#1e293b", fontSize: "0.9rem" }}>
      <h2 style={{ margin: "0 0 0.25rem" }}>📚 知识库中心</h2>
      <p style={{ color: "#64748b", margin: "0 0 1rem", fontSize: "0.85rem" }}>
        领域知识库与虚拟知识库使用方式一致：导入自动入库、问答自动匹配。虚拟库会进一步把内容分发到最匹配的领域库。
      </p>
      {err && <div style={{ ...card, color: "#b91c1c", background: "#fef2f2" }}>⚠️ {err}</div>}

      {/* 列表 */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.7rem" }}>
          <h4 style={{ margin: 0 }}>🗂️ 知识库列表</h4>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button style={{ ...btn, background: "#10b981", fontSize: "0.8rem", padding: "0.4rem 0.9rem" }} onClick={() => setShowNew(showNew === "domain" ? "" : "domain")}>
              ＋ 新建领域库
            </button>
            <button style={{ ...btn, background: "#8b5cf6", fontSize: "0.8rem", padding: "0.4rem 0.9rem" }} onClick={() => setShowNew(showNew === "virt" ? "" : "virt")}>
              ＋ 新建虚拟库
            </button>
          </div>
        </div>

        {showNew === "domain" && (
          <div style={{ background: "#f8fafc", borderRadius: 10, padding: "0.9rem 1rem", marginBottom: "0.8rem" }}>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
              <input style={{ ...input, maxWidth: 180 }} placeholder="领域名称（如 trading）" value={ndName} onChange={(e) => setNdName(e.target.value)} />
              <input style={{ ...input, maxWidth: 300 }} placeholder="描述（可选）" value={ndDesc} onChange={(e) => setNdDesc(e.target.value)} />
              <input style={{ ...input }} placeholder="匹配关键词（逗号分隔，问答路由/导入分发用）" value={ndKeywords} onChange={(e) => setNdKeywords(e.target.value)} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem", cursor: "pointer", color: "#475569" }}>
                <input type="checkbox" checked={ndGenTpl} onChange={(e) => setNdGenTpl(e.target.checked)} />
                ✨ 自动生成提示词模板（LLM 按领域信息生成 问答/导入 模板）
              </label>
              <button style={btn} onClick={() => void createNewDomain()} disabled={busy}>{ndGenTpl && busy ? "⏳ 生成模板中…" : "创建领域库"}</button>
            </div>
          </div>
        )}
        {showNew === "virt" && (
          <div style={{ background: "#f8fafc", borderRadius: 10, padding: "0.9rem 1rem", marginBottom: "0.8rem" }}>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
              <input style={{ ...input, maxWidth: 180 }} placeholder="虚拟库名称（如 综合）" value={nvName} onChange={(e) => setNvName(e.target.value)} />
              <input style={{ ...input }} placeholder="描述（可选）" value={nvDesc} onChange={(e) => setNvDesc(e.target.value)} />
            </div>
            <div style={{ fontSize: "0.82rem", fontWeight: 600, marginBottom: "0.4rem", color: "#475569" }}>包含的领域库（导入自动分发、问答自动路由；空库也可加入）：</div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
              {allDomains.length === 0 && <span style={{ color: "#94a3b8" }}>（暂无领域库，可先「新建领域库」或直接导入创建）</span>}
              {allDomains.map((name) => {
                const on = nvSelDomains.includes(name);
                const count = domainCount(name);
                return (
                  <span
                    key={name}
                    style={{ ...chip, background: on ? "#dbeafe" : "#f1f5f9", borderColor: on ? "#3b82f6" : "#cbd5e1", userSelect: "none" }}
                    onClick={() => toggleVirtDomain(name)}
                    title={count === 0 ? "空领域库（尚无数据，可先加入再导入）" : undefined}
                  >
                    {on ? "☑" : "☐"} {name}（{count}）
                  </span>
                );
              })}
            </div>
            <button style={btn} onClick={() => void createNewVirt()}>创建虚拟库</button>
          </div>
        )}

        {entriesList.length === 0 && <div style={{ color: "#94a3b8", fontSize: "0.85rem" }}>（暂无知识库，点击上方「新建」创建，或直接粘贴 Chat 链接导入会自动建库）</div>}
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {entriesList.map((e) => (
            <div key={`${e.type}-${e.name}`} style={{ display: "flex", alignItems: "center", gap: "0.8rem", border: "1px solid #e2e8f0", borderRadius: 10, padding: "0.65rem 1rem", background: "#fff" }}>
              <span style={{ fontSize: "1rem" }}>{e.type === "virt" ? "🧩" : "🏷️"}</span>
              <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>{e.name}</span>
              <span style={{ fontSize: "0.78rem", padding: "0.1rem 0.5rem", borderRadius: 999, background: e.type === "virt" ? "#ede9fe" : "#dbeafe", color: e.type === "virt" ? "#6d28d9" : "#1d4ed8" }}>
                {e.type === "virt" ? "虚拟库" : "领域库"}
              </span>
              <span style={{ fontSize: "0.8rem", color: "#64748b" }}>{e.count} 条</span>
              <span style={{ marginLeft: "auto", display: "flex", gap: "0.4rem" }}>
                <button style={{ ...btn, fontSize: "0.78rem", padding: "0.35rem 0.9rem" }} onClick={() => openDetail(e)}>📄 详情</button>
                <button
                  style={{ fontSize: "0.75rem", padding: "0.35rem 0.6rem", borderRadius: 6, border: "1px solid #fecaca", background: "#fef2f2", color: "#dc2626", cursor: "pointer" }}
                  onClick={() => { setDelTarget(e); setDelTyped(""); }}
                  title="删除（需输入名称确认）"
                >
                  🗑️
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ color: "#94a3b8", fontSize: "0.8rem", marginTop: "0.4rem" }}>
        💡 点击「详情」进入知识库详情页（问答区 / 导入区 / 配置区 / 数据区）；删除需输入名称确认。
      </div>

      {/* 删除确认 Modal */}
      <Modal
        open={!!delTarget}
        title={delTarget ? `🗑️ 删除${delTarget.type === "virt" ? "虚拟" : "领域"}知识库「${delTarget.name}」` : ""}
        onClose={() => { setDelTarget(null); setDelTyped(""); }}
        footer={
          <>
            <button style={{ ...btn, background: "#64748b" }} onClick={() => { setDelTarget(null); setDelTyped(""); }}>取消</button>
            <button style={{ ...btn, background: "#ef4444" }} onClick={() => void confirmDelete()}>确认删除</button>
          </>
        }
      >
        {delTarget && (
          <div>
            {delTarget.type === "domain" ? (
              <p style={{ margin: "0 0 0.8rem", color: "#b91c1c" }}>
                将清空该领域全部 <b>{delTarget.count}</b> 条知识，且<b>不可恢复</b>；引用该领域的虚拟库将同步移除对其的引用。
              </p>
            ) : (
              <p style={{ margin: "0 0 0.8rem", color: "#64748b" }}>仅移除虚拟库组合配置，不影响领域库数据。</p>
            )}
            <p style={{ margin: "0 0 0.5rem" }}>请输入名称「<b>{delTarget.name}</b>」确认删除：</p>
            <input style={{ ...input, width: "100%" }} placeholder={delTarget.name} value={delTyped} onChange={(e) => setDelTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void confirmDelete(); }} autoFocus />
            {delTyped && delTyped.trim() !== delTarget.name && <div style={{ color: "#dc2626", fontSize: "0.8rem", marginTop: "0.4rem" }}>名称不匹配，无法删除</div>}
          </div>
        )}
      </Modal>

      {/* 医学模板重置确认 Modal */}
      <Modal open={seedAsk} title="🔄 重置为内置医学模板" onClose={() => setSeedAsk(false)}
        footer={<><button style={{ ...btn, background: "#64748b" }} onClick={() => setSeedAsk(false)}>取消</button><button style={btn} onClick={() => void seedMedical()}>确认重置</button></>}
      >
        <p style={{ margin: 0 }}>当前领域已有自定义模板，重置将<b>覆盖</b>为内置医学模板，确定继续？</p>
      </Modal>
    </div>
  );
}
