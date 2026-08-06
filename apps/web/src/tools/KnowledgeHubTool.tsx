// ============================================================
// 知识库中心（工具分组）
// 统一体验：领域知识库与虚拟知识库在「导入/问答」上体感一致——
// - 领域知识库：导入直接进本库，问答只查本库（可配置特化模板）
// - 虚拟知识库：导入自动分发到最匹配的子领域（无匹配归 other），
//   问答先做领域路由（综合匹配）→ 命中只查最相关领域，未命中降级全领域
// ============================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../api";
import Modal from "../Modal";
import type { KnowledgeDomainMeta, KnowledgeInstanceInfo, VirtualKb } from "@toolbox/shared";

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
  const [selName, setSelName] = useState("");
  // 使用区（统一：导入 + 问答）
  const [askQ, setAskQ] = useState("");
  const [askA, setAskA] = useState("");
  const [askRouted, setAskRouted] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [importMsg, setImportMsg] = useState("");
  const [busy, setBusy] = useState(false);
  // 领域配置（选中领域库时）
  const [tplAsk, setTplAsk] = useState("");
  const [tplExtract, setTplExtract] = useState("");
  const [metaDesc, setMetaDesc] = useState("");
  const [metaKeywords, setMetaKeywords] = useState("");
  const [cfgMsg, setCfgMsg] = useState("");
  // 新建
  const [showNew, setShowNew] = useState<"domain" | "virt" | "">("");
  const [ndName, setNdName] = useState("");
  const [ndDesc, setNdDesc] = useState("");
  const [ndKeywords, setNdKeywords] = useState("");
  const [ndGenTpl, setNdGenTpl] = useState(false);
  const [nvName, setNvName] = useState("");
  const [nvDesc, setNvDesc] = useState("");
  const [nvSelDomains, setNvSelDomains] = useState<string[]>([]);
  // 删除确认 Modal（输入名称精准确认）
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
  const entries = useMemo<KbEntry[]>(() => {
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
    return list;
  }, [ov]);

  const selected = useMemo(() => entries.find((e) => e.name === selName) ?? null, [entries, selName]);

  // 选中变化 → 载入配置（领域库）
  useEffect(() => {
    setAskA("");
    setAskRouted("");
    setImportMsg("");
    setCfgMsg("");
    if (selected?.type === "domain") {
      setTplAsk(selected.meta?.askTemplate ?? "");
      setTplExtract(selected.meta?.extractTemplate ?? "");
      setMetaDesc(selected.meta?.desc ?? "");
      setMetaKeywords(selected.meta?.keywords?.join("，") ?? "");
    }
  }, [selName, selected?.type]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 统一使用区：问答 ----------
  const ask = async () => {
    if (!selected || !askQ.trim()) return;
    setBusy(true);
    setAskA("");
    setAskRouted("");
    try {
      if (selected.type === "virt") {
        const r = await api.knowledgeHubAskVirt(selected.name, askQ);
        if (r.ok && r.answer) {
          setAskA(r.answer);
          setAskRouted((r as { routed?: string }).routed ?? "");
        } else setAskA(`❌ ${(r as { message?: string }).message ?? "无回答"}`);
      } else {
        const r = await api.knowledgeHubAskDomain(selected.name, askQ);
        if (r.ok && r.answer) setAskA(r.answer);
        else setAskA(`❌ ${(r as { message?: string }).message ?? "无回答"}`);
      }
    } catch (e) {
      setAskA(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // ---------- 统一使用区：导入 ----------
  const doImport = async () => {
    if (!selected || !importUrl.trim()) return;
    setBusy(true);
    setImportMsg("");
    try {
      const r = selected.type === "virt"
        ? await api.knowledgeHubImportVirt(selected.name, importUrl.trim())
        : await api.knowledgeHubImportDomain(selected.name, importUrl.trim());
      if (r.ok) {
        const extra = selected.type === "virt" ? "（已自动分发到最匹配领域）" : "";
        setImportMsg(`✅ 导入 ${r.imported} 条${extra}${r.skipped ? `（跳过 ${r.skipped}）` : ""}${r.conflicts ? `（冲突 ${r.conflicts}）` : ""}`);
      } else setImportMsg(`❌ ${(r as { message?: string }).message ?? "导入失败"}`);
    } catch (e) {
      setImportMsg(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // ---------- 领域配置保存 ----------
  const saveCfg = async () => {
    if (selected?.type !== "domain") return;
    try {
      await api.knowledgeHubSetDomain(selected.name, {
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

  // ---------- 新建领域库 ----------
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

  // ---------- 新建虚拟库 ----------
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

  // 虚拟库可选的领域 = 全部领域（有数据实例 ∪ 已建元数据，含空库）
  const allDomains = useMemo(() => {
    const s = new Set<string>();
    for (const it of ov.instances) s.add(it.instance);
    for (const d of ov.domains) s.add(d.name);
    return [...s];
  }, [ov]);
  const domainCount = (name: string) => ov.instances.find((i) => i.instance === name)?.count ?? 0;

  // ---------- 删除知识库（Modal 输入名称精准确认，防误删） ----------
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
      if (selName === e.name) setSelName("");
      await load();
    } catch (ex) {
      setErr(`删除失败：${ex instanceof Error ? ex.message : String(ex)}`);
    }
  };

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "1.5rem 1rem", color: "#1e293b", fontSize: "0.9rem" }}>
      <h2 style={{ margin: "0 0 0.25rem" }}>📚 知识库中心</h2>
      <p style={{ color: "#64748b", margin: "0 0 1rem", fontSize: "0.85rem" }}>
        领域知识库与虚拟知识库使用方式一致：导入自动入库、问答自动匹配。虚拟库会进一步把内容分发到最匹配的领域库。
      </p>
      {err && <div style={{ ...card, color: "#b91c1c", background: "#fef2f2" }}>⚠️ {err}</div>}

      {/* 统一知识库列表 */}
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

        {/* 新建表单 */}
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

        {/* 条目列表（混合） */}
        {entries.length === 0 && <div style={{ color: "#94a3b8", fontSize: "0.85rem" }}>（暂无知识库，点击上方「新建」创建，或直接粘贴 Chat 链接导入会自动建库）</div>}
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {entries.map((e) => {
            const on = selName === e.name;
            return (
              <div key={`${e.type}-${e.name}`}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.8rem",
                  border: `1px solid ${on ? "#3b82f6" : "#e2e8f0"}`,
                  borderRadius: on ? "10px 10px 0 0" : 10,
                  padding: "0.7rem 1rem",
                  cursor: "pointer",
                  background: on ? "#f0f7ff" : "#fff",
                }}
                onClick={() => setSelName(e.name)}
              >
                <span style={{ fontSize: "1rem" }}>{e.type === "virt" ? "🧩" : "🏷️"}</span>
                <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>{e.name}</span>
                <span style={{ fontSize: "0.78rem", padding: "0.1rem 0.5rem", borderRadius: 999, background: e.type === "virt" ? "#ede9fe" : "#dbeafe", color: e.type === "virt" ? "#6d28d9" : "#1d4ed8" }}>
                  {e.type === "virt" ? "虚拟库" : "领域库"}
                </span>
                <span style={{ fontSize: "0.8rem", color: "#64748b", marginLeft: "auto" }}>{e.count} 条</span>
                <button
                  style={{ fontSize: "0.75rem", padding: "0.2rem 0.6rem", borderRadius: 6, border: "1px solid #fecaca", background: "#fef2f2", color: "#dc2626", cursor: "pointer" }}
                  onClick={(ev) => { ev.stopPropagation(); setDelTarget(e); setDelTyped(""); }}
                  title="删除（需输入名称确认）"
                >
                  🗑️
                </button>
              </div>
              {/* 选中行下方原地展开详情功能区 */}
              {on && (
                <div style={{ marginTop: "0.5rem", paddingTop: "0.8rem", borderTop: "1px dashed #cbd5e1" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.8rem", flexWrap: "wrap" }}>
                    {e.type === "virt" ? (
                      <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                        组成：{e.virt.domains.map((d) => `${d}(${domainCount(d)})`).join("、")}
                      </span>
                    ) : (
                      e.meta?.desc && <span style={{ fontSize: "0.8rem", color: "#64748b" }}>{e.meta.desc}</span>
                    )}
                  </div>
                  {/* 问答 */}
                  <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.6rem" }}>
                    <input style={input} placeholder={`向「${e.name}」提问…`} value={askQ} onChange={(ev) => setAskQ(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Enter") void ask(); }} />
                    <button style={btn} onClick={() => void ask()} disabled={busy}>🔍 问答</button>
                  </div>
                  {askRouted && (
                    <div style={{ fontSize: "0.8rem", color: "#6d28d9", marginBottom: "0.4rem" }}>
                      ⚡ 自动路由：该问题已匹配到「{askRouted}」领域，仅在该领域检索（更聚焦、更省）
                    </div>
                  )}
                  {askA && <div style={{ whiteSpace: "pre-wrap", background: "#fff", borderRadius: 8, padding: "0.8rem 1rem", marginBottom: "0.8rem", lineHeight: 1.7, border: "1px solid #e2e8f0" }}>{askA}</div>}
                  {/* 导入 */}
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <input style={input} placeholder="Chat 分享链接（导入此知识库）…" value={importUrl} onChange={(ev) => setImportUrl(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Enter") void doImport(); }} />
                    <button style={btn} onClick={() => void doImport()} disabled={busy}>📥 导入</button>
                  </div>
                  {importMsg && <div style={{ color: "#0e7490", marginTop: "0.5rem", fontSize: "0.85rem" }}>{importMsg}</div>}
                  {/* 领域库配置（折叠） */}
                  {e.type === "domain" && (
                    <details style={{ marginTop: "0.9rem", borderTop: "1px dashed #e2e8f0", paddingTop: "0.7rem" }}>
                      <summary style={{ cursor: "pointer", fontSize: "0.83rem", color: "#475569", fontWeight: 600 }}>⚙️ 领域配置（描述 / 关键词 / 模板）</summary>
                      <div style={{ marginTop: "0.7rem" }}>
                        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.7rem" }}>
                          <input style={{ ...input, maxWidth: 320 }} placeholder="领域描述" value={metaDesc} onChange={(ev) => setMetaDesc(ev.target.value)} />
                          <input style={{ ...input }} placeholder="匹配关键词（逗号分隔）" value={metaKeywords} onChange={(ev) => setMetaKeywords(ev.target.value)} />
                        </div>
                        {e.name === "medical" && (
                          <button style={{ ...btn, background: "#10b981", fontSize: "0.76rem", padding: "0.3rem 0.7rem", marginBottom: "0.6rem" }} onClick={() => void seedMedical()}>
                            🔄 重置为内置医学模板
                          </button>
                        )}
                        <div style={{ display: "grid", gap: "0.6rem" }}>
                          <div>
                            <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.25rem", color: "#475569" }}>问答模板（system；留空用通用）</div>
                            <textarea style={{ width: "100%", minHeight: 70, resize: "vertical", padding: "0.5rem 0.7rem", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: "0.8rem", fontFamily: "inherit", lineHeight: 1.5, boxSizing: "border-box" }} value={tplAsk} onChange={(ev) => setTplAsk(ev.target.value)} />
                          </div>
                          <div>
                            <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.25rem", color: "#475569" }}>导入提取模板（system；留空用通用）</div>
                            <textarea style={{ width: "100%", minHeight: 70, resize: "vertical", padding: "0.5rem 0.7rem", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: "0.8rem", fontFamily: "inherit", lineHeight: 1.5, boxSizing: "border-box" }} value={tplExtract} onChange={(ev) => setTplExtract(ev.target.value)} />
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", marginTop: "0.6rem" }}>
                          <button style={btn} onClick={() => void saveCfg()}>💾 保存配置</button>
                          {cfgMsg && <span style={{ color: "#0e7490", fontSize: "0.83rem" }}>{cfgMsg}</span>}
                        </div>
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>
          );
          })}
        </div>
      </div>

      {/* 知识库列表底部帮助 */}
      <div style={{ color: "#94a3b8", fontSize: "0.8rem", marginTop: "0.4rem" }}>
        💡 点击知识库行可在下方展开 问答/导入/配置 功能区；点击另一行切换；删除需输入名称确认。
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
                将清空该领域全部 <b>{delTarget.count}</b> 条知识，且<b>不可恢复</b>。
              </p>
            ) : (
              <p style={{ margin: "0 0 0.8rem", color: "#64748b" }}>
                仅移除虚拟库组合配置，不影响领域库数据。
              </p>
            )}
            <p style={{ margin: "0 0 0.5rem" }}>请输入名称「<b>{delTarget.name}</b>」确认删除：</p>
            <input
              style={{ ...input, width: "100%" }}
              placeholder={delTarget.name}
              value={delTyped}
              onChange={(e) => setDelTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void confirmDelete(); }}
              autoFocus
            />
            {delTyped && delTyped.trim() !== delTarget.name && (
              <div style={{ color: "#dc2626", fontSize: "0.8rem", marginTop: "0.4rem" }}>名称不匹配，无法删除</div>
            )}
          </div>
        )}
      </Modal>

      {/* 医学模板重置确认 Modal */}
      <Modal
        open={seedAsk}
        title="🔄 重置为内置医学模板"
        onClose={() => setSeedAsk(false)}
        footer={
          <>
            <button style={{ ...btn, background: "#64748b" }} onClick={() => setSeedAsk(false)}>取消</button>
            <button style={btn} onClick={() => void seedMedical()}>确认重置</button>
          </>
        }
      >
        <p style={{ margin: 0 }}>当前领域已有自定义模板，重置将<b>覆盖</b>为内置医学模板，确定继续？</p>
      </Modal>
    </div>
  );
}
