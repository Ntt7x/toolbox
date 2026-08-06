// ============================================================
// 知识库中心（工具分组）
// - 领域知识库：多个独立领域库（医学/交易/…），每个可导入/问答，
//   领域可配置特化模板（ask/extract，医学库可一键从内置模板初始化）
// - 虚拟知识库：多个领域库的集合（如「综合」= 医学+交易+杂项），
//   聚合问答 + 导入自动匹配到对应领域库（静态关键词匹配，低成本）
// ============================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../api";
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

export default function KnowledgeHubTool() {
  const [ov, setOv] = useState<Overview>({ instances: [], domains: [], virst: [] });
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<"domain" | "virt">("domain");
  // 领域
  const [selDomain, setSelDomain] = useState<string>("");
  const [askQ, setAskQ] = useState("");
  const [askA, setAskA] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [importMsg, setImportMsg] = useState("");
  // 领域模板
  const [tplAsk, setTplAsk] = useState("");
  const [tplExtract, setTplExtract] = useState("");
  const [tplSaved, setTplSaved] = useState("");
  // 领域元数据（关键词/描述）
  const [metaDesc, setMetaDesc] = useState("");
  const [metaKeywords, setMetaKeywords] = useState("");
  const [metaSaved, setMetaSaved] = useState("");
  // 虚拟库
  const [selVirt, setSelVirt] = useState<string>("");
  const [virtName, setVirtName] = useState("");
  const [virtSelDomains, setVirtSelDomains] = useState<string[]>([]);
  const [virtDesc, setVirtDesc] = useState("");
  const [virtAsk, setVirtAsk] = useState("");
  const [virtAnswer, setVirtAnswer] = useState("");
  const [virtImport, setVirtImport] = useState("");
  const [virtImportMsg, setVirtImportMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const domainMeta = useMemo(() => ov.domains.find((d) => d.name === selDomain) ?? null, [ov.domains, selDomain]);

  const load = useCallback(async () => {
    try {
      const r = await api.knowledgeHubOverview();
      setOv({ instances: r.instances, domains: r.domains, virst: r.virst });
      setErr("");
      if (!selDomain && r.instances.length > 0) setSelDomain(r.instances[0].instance);
      if (!selVirt && r.virst.length > 0) setSelVirt(r.virst[0].name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 领域切换 → 载入元数据与模板
  useEffect(() => {
    if (!selDomain) return;
    const m = ov.domains.find((d) => d.name === selDomain) ?? null;
    setMetaDesc(m?.desc ?? "");
    setMetaKeywords(m?.keywords?.join("，") ?? "");
    setTplAsk(m?.askTemplate ?? "");
    setTplExtract(m?.extractTemplate ?? "");
  }, [selDomain, ov.domains]);

  // ---------- 领域问答/导入 ----------
  const askDomain = async () => {
    if (!selDomain || !askQ.trim()) return;
    setBusy(true);
    setAskA("");
    try {
      const r = await api.knowledgeHubAskDomain(selDomain, askQ);
      if (r.ok && r.answer) setAskA(r.answer);
      else setAskA(`❌ ${r.message ?? "无回答"}`);
    } catch (e) {
      setAskA(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const importDomain = async () => {
    if (!selDomain || !importUrl.trim()) return;
    setBusy(true);
    setImportMsg("");
    try {
      const r = await api.knowledgeHubImportDomain(selDomain, importUrl.trim());
      if (r.ok) setImportMsg(`✅ 导入 ${r.imported} 条${r.skipped ? `（重复跳过 ${r.skipped}）` : ""}${r.conflicts ? `（冲突 ${r.conflicts}）` : ""}`);
      else setImportMsg(`❌ ${(r as { message?: string }).message ?? "导入失败"}`);
    } catch (e) {
      setImportMsg(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // ---------- 领域元数据/模板保存 ----------
  const saveDomainMeta = async () => {
    if (!selDomain) return;
    try {
      await api.knowledgeHubSetDomain(selDomain, {
        desc: metaDesc,
        keywords: metaKeywords.split(/[,，、]/).map((k) => k.trim()).filter(Boolean),
      });
      setMetaSaved("✅ 元数据已保存");
      setTimeout(() => setMetaSaved(""), 2500);
      await load();
    } catch (e) {
      setErr(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const saveDomainTemplates = async () => {
    if (!selDomain) return;
    try {
      await api.knowledgeHubSetDomain(selDomain, { askTemplate: tplAsk, extractTemplate: tplExtract });
      setTplSaved("✅ 模板已保存（将作用于该领域的问答/导入）");
      setTimeout(() => setTplSaved(""), 3000);
      await load();
    } catch (e) {
      setErr(`模板保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const seedMedicalTemplates = async () => {
    const hasCustom = !!tplAsk || !!tplExtract;
    if (hasCustom && !confirm("当前领域已有自定义模板，重置将覆盖为内置医学模板，确定继续？")) return;
    try {
      await api.knowledgeHubSeedMedical(hasCustom);
      setTplSaved("✅ 已初始化内置医学模板");
      setTimeout(() => setTplSaved(""), 3000);
      await load();
    } catch (e) {
      setErr(`初始化失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ---------- 虚拟库 ----------
  const toggleVirtDomain = (d: string) => {
    setVirtSelDomains((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  };

  const createVirt = async () => {
    if (!virtName.trim() || virtSelDomains.length === 0) {
      setErr("请填写虚拟库名称并至少勾选一个领域");
      return;
    }
    try {
      const r = await api.knowledgeHubCreateVirt(virtName.trim(), virtSelDomains, virtDesc || undefined);
      if (!r.ok) setErr(r.message ?? "创建失败");
      else {
        setErr("");
        setVirtName("");
        setVirtSelDomains([]);
        setVirtDesc("");
        await load();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const virtTotal = (v: VirtualKb) =>
    v.domains.reduce((sum, d) => sum + (ov.instances.find((i) => i.instance === d)?.count ?? 0), 0);

  const askVirt = async () => {
    if (!selVirt || !virtAsk.trim()) return;
    setBusy(true);
    setVirtAnswer("");
    try {
      const r = await api.knowledgeHubAskVirt(selVirt, virtAsk);
      setVirtAnswer(r.ok && r.answer ? r.answer : `❌ ${r.message ?? "无回答"}`);
    } catch (e) {
      setVirtAnswer(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const importVirt = async () => {
    if (!selVirt || !virtImport.trim()) return;
    setBusy(true);
    setVirtImportMsg("");
    try {
      const r = await api.knowledgeHubImportVirt(selVirt, virtImport.trim());
      if (r.ok) setVirtImportMsg(`✅ 导入 ${r.imported} 条（自动匹配领域库）${r.skipped ? `（跳过 ${r.skipped}）` : ""}`);
      else setVirtImportMsg(`❌ ${(r as { message?: string }).message ?? "导入失败"}`);
    } catch (e) {
      setVirtImportMsg(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const selectedVirt = ov.virst.find((v) => v.name === selVirt) ?? null;

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "1.5rem 1rem", color: "#1e293b", fontSize: "0.9rem" }}>
      <h2 style={{ margin: "0 0 0.25rem" }}>📚 知识库中心</h2>
      <p style={{ color: "#64748b", margin: "0 0 1rem", fontSize: "0.85rem" }}>
        领域知识库各自独立（医学/交易/杂项…），可配置领域模板；虚拟知识库是多个领域库的集合，导入时自动匹配到对应领域。
      </p>
      {err && <div style={{ ...card, color: "#b91c1c", background: "#fef2f2" }}>⚠️ {err}</div>}

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button style={{ ...btn, background: tab === "domain" ? "#3b82f6" : "#cbd5e1" }} onClick={() => setTab("domain")}>🏷️ 领域知识库</button>
        <button style={{ ...btn, background: tab === "virt" ? "#3b82f6" : "#cbd5e1" }} onClick={() => setTab("virt")}>🧩 虚拟知识库</button>
      </div>

      {tab === "domain" && (
        <>
          {/* 领域选择 + 问答 + 导入 */}
          <div style={card}>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.8rem" }}>
              <span style={{ fontWeight: 600 }}>领域库：</span>
              {ov.instances.length === 0 && <span style={{ color: "#94a3b8" }}>（暂无领域库，先通过「导入」创建）</span>}
              {ov.instances.map((it) => (
                <span
                  key={it.instance}
                  style={{ ...chip, background: selDomain === it.instance ? "#dbeafe" : "#f1f5f9", borderColor: selDomain === it.instance ? "#3b82f6" : "#cbd5e1" }}
                  onClick={() => setSelDomain(it.instance)}
                  title={ov.domains.find((d) => d.name === it.instance)?.desc || ""}
                >
                  {it.instance}（{it.count}）
                </span>
              ))}
            </div>
            {selDomain && (
              <div>
                <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.6rem" }}>
                  <input style={input} placeholder={`向「${selDomain}」提问…`} value={askQ} onChange={(e) => setAskQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void askDomain(); }} />
                  <button style={btn} onClick={() => void askDomain()} disabled={busy}>🔍 问答</button>
                </div>
                {askA && <div style={{ whiteSpace: "pre-wrap", background: "#f8fafc", borderRadius: 8, padding: "0.8rem 1rem", marginBottom: "0.8rem", lineHeight: 1.7 }}>{askA}</div>}
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <input style={input} placeholder="Chat 分享链接（导入该领域库）…" value={importUrl} onChange={(e) => setImportUrl(e.target.value)} />
                  <button style={btn} onClick={() => void importDomain()} disabled={busy}>📥 导入</button>
                </div>
                {importMsg && <div style={{ color: "#0e7490", marginTop: "0.5rem", fontSize: "0.85rem" }}>{importMsg}</div>}
              </div>
            )}
          </div>

          {/* 领域元数据 + 模板（医学模板已迁入，可编辑/初始化） */}
          {selDomain && (
            <div style={card}>
              <h4 style={{ margin: "0 0 0.6rem" }}>
                ⚙️ 领域配置：{selDomain}
                {selDomain === "medical" && (
                  <button
                    style={{ ...btn, background: "#10b981", fontSize: "0.75rem", padding: "0.3rem 0.7rem", marginLeft: "0.8rem" }}
                    onClick={() => void seedMedicalTemplates()}
                  >
                    🔄 从内置医学模板初始化
                  </button>
                )}
              </h4>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.8rem" }}>
                <input style={{ ...input, maxWidth: 340 }} placeholder="领域描述（自动匹配导入用）" value={metaDesc} onChange={(e) => setMetaDesc(e.target.value)} />
                <input style={{ ...input }} placeholder="匹配关键词（逗号分隔，如 血压,手术,康复）" value={metaKeywords} onChange={(e) => setMetaKeywords(e.target.value)} />
                <button style={{ ...btn, background: "#475569" }} onClick={() => void saveDomainMeta()}>保存元数据</button>
              </div>
              {metaSaved && <div style={{ color: "#0e7490", margin: "0 0 0.6rem", fontSize: "0.85rem" }}>{metaSaved}</div>}
              <div style={{ display: "grid", gap: "0.6rem" }}>
                <div>
                  <div style={{ fontSize: "0.82rem", fontWeight: 600, marginBottom: "0.3rem", color: "#475569" }}>
                    问答模板（system；留空用通用模板{selDomain === "medical" ? "，或点上方按钮初始化医学模板" : ""}）
                  </div>
                  <textarea style={{ width: "100%", minHeight: 90, resize: "vertical", padding: "0.5rem 0.7rem", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: "0.8rem", fontFamily: "inherit", lineHeight: 1.5, boxSizing: "border-box" }} value={tplAsk} onChange={(e) => setTplAsk(e.target.value)} />
                </div>
                <div>
                  <div style={{ fontSize: "0.82rem", fontWeight: 600, marginBottom: "0.3rem", color: "#475569" }}>
                    导入提取模板（system；留空用通用模板{selDomain === "medical" ? "，或点上方按钮初始化医学模板" : ""}）
                  </div>
                  <textarea style={{ width: "100%", minHeight: 90, resize: "vertical", padding: "0.5rem 0.7rem", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: "0.8rem", fontFamily: "inherit", lineHeight: 1.5, boxSizing: "border-box" }} value={tplExtract} onChange={(e) => setTplExtract(e.target.value)} />
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", marginTop: "0.6rem" }}>
                <button style={btn} onClick={() => void saveDomainTemplates()}>💾 保存模板</button>
                {tplSaved && <span style={{ color: "#0e7490", fontSize: "0.85rem" }}>{tplSaved}</span>}
              </div>
            </div>
          )}
        </>
      )}

      {tab === "virt" && (
        <>
          {/* 新建虚拟库：领域多选 */}
          <div style={card}>
            <h4 style={{ margin: "0 0 0.6rem" }}>➕ 新建虚拟知识库（多个领域库的集合）</h4>
            <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.8rem", flexWrap: "wrap" }}>
              <input style={{ ...input, maxWidth: 200 }} placeholder="名称（如 综合）" value={virtName} onChange={(e) => setVirtName(e.target.value)} />
              <input style={{ ...input }} placeholder="描述（可选）" value={virtDesc} onChange={(e) => setVirtDesc(e.target.value)} />
            </div>
            <div style={{ fontSize: "0.82rem", fontWeight: 600, marginBottom: "0.4rem", color: "#475569" }}>选择包含的领域库：</div>
            {ov.instances.length === 0 && <div style={{ color: "#94a3b8", fontSize: "0.85rem" }}>（暂无领域库，请先在「领域知识库」页导入创建）</div>}
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.8rem" }}>
              {ov.instances.map((it) => {
                const on = virtSelDomains.includes(it.instance);
                return (
                  <span
                    key={it.instance}
                    style={{ ...chip, background: on ? "#dbeafe" : "#f1f5f9", borderColor: on ? "#3b82f6" : "#cbd5e1", cursor: "pointer", userSelect: "none" }}
                    onClick={() => toggleVirtDomain(it.instance)}
                  >
                    {on ? "☑" : "☐"} {it.instance}（{it.count}）
                  </span>
                );
              })}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.8rem" }}>
              <button style={btn} onClick={() => void createVirt()} disabled={busy}>创建虚拟库</button>
              {virtSelDomains.length > 0 && <span style={{ color: "#64748b", fontSize: "0.82rem" }}>已选 {virtSelDomains.length} 个领域</span>}
            </div>
          </div>

          {/* 虚拟库列表（卡片式） */}
          <div style={card}>
            <h4 style={{ margin: "0 0 0.6rem" }}>🗂️ 虚拟知识库列表</h4>
            {ov.virst.length === 0 && <div style={{ color: "#94a3b8", fontSize: "0.85rem" }}>（暂无虚拟库）</div>}
            <div style={{ display: "grid", gap: "0.6rem" }}>
              {ov.virst.map((v) => {
                const on = selVirt === v.name;
                return (
                  <div
                    key={v.name}
                    style={{
                      border: `1px solid ${on ? "#3b82f6" : "#e2e8f0"}`,
                      borderRadius: 10,
                      padding: "0.8rem 1rem",
                      cursor: "pointer",
                      background: on ? "#f0f7ff" : "#fff",
                    }}
                    onClick={() => setSelVirt(v.name)}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.6rem" }}>
                      <div style={{ fontWeight: 700, fontSize: "0.95rem" }}>
                        {v.name}
                        {v.desc && <span style={{ fontWeight: 400, color: "#64748b", fontSize: "0.82rem", marginLeft: "0.6rem" }}>{v.desc}</span>}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                        <span style={{ fontSize: "0.82rem", color: "#475569" }}>共 {virtTotal(v)} 条</span>
                        {on && (
                          <button
                            style={{ ...btn, background: "#ef4444", fontSize: "0.72rem", padding: "0.25rem 0.6rem" }}
                            onClick={(e) => { e.stopPropagation(); if (confirm(`删除虚拟库「${v.name}」？不影响领域库数据`)) { void (async () => { await api.knowledgeHubDeleteVirt(v.name); setSelVirt(""); await load(); })(); } }}
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
                      {v.domains.map((d) => (
                        <span key={d} style={{ ...chip, cursor: "default", background: "#ecfdf5", borderColor: "#a7f3d0", fontSize: "0.78rem", padding: "0.15rem 0.6rem" }}>
                          {d}（{ov.instances.find((i) => i.instance === d)?.count ?? 0}）
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 选中虚拟库：聚合问答 + 导入 */}
          {selectedVirt && (
            <div style={card}>
              <h4 style={{ margin: "0 0 0.6rem" }}>🔍 「{selectedVirt.name}」聚合问答（跨 {selectedVirt.domains.length} 个领域库检索）</h4>
              <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.6rem" }}>
                <input style={input} placeholder={`向「${selectedVirt.name}」提问…`} value={virtAsk} onChange={(e) => setVirtAsk(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void askVirt(); }} />
                <button style={btn} onClick={() => void askVirt()} disabled={busy}>🔍 问答</button>
              </div>
              {virtAnswer && <div style={{ whiteSpace: "pre-wrap", background: "#f8fafc", borderRadius: 8, padding: "0.8rem 1rem", marginBottom: "0.8rem", lineHeight: 1.7 }}>{virtAnswer}</div>}
              <h4 style={{ margin: "0.8rem 0 0.6rem" }}>📥 导入（自动匹配写入对应领域库）</h4>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <input style={input} placeholder="Chat 分享链接：每条内容按领域关键词自动匹配入库（无匹配归 other）…" value={virtImport} onChange={(e) => setVirtImport(e.target.value)} />
                <button style={btn} onClick={() => void importVirt()} disabled={busy}>📥 导入</button>
              </div>
              {virtImportMsg && <div style={{ color: "#0e7490", marginTop: "0.5rem", fontSize: "0.85rem" }}>{virtImportMsg}</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
