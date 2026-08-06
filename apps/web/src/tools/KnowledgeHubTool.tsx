// ============================================================
// 知识库中心（工具分组）
// - 领域知识库：多个独立领域库（医学/交易/…），每个可导入/问答
// - 虚拟知识库：多个领域库的集合（如「综合」= 医学+交易+杂项），
//   聚合问答 + 导入自动匹配到对应领域库（静态关键词匹配，低成本）
// ============================================================
import { useCallback, useEffect, useState } from "react";
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
  padding: "0.5rem 0.8rem",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  fontSize: "0.85rem",
  outline: "none",
  flex: 1,
  minWidth: 0,
};
const btn: CSSProperties = {
  padding: "0.5rem 1.1rem",
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
  padding: "0.25rem 0.7rem",
  borderRadius: 999,
  fontSize: "0.8rem",
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
  // 领域：选中实例
  const [selDomain, setSelDomain] = useState<string>("");
  // 领域问答/导入
  const [askQ, setAskQ] = useState("");
  const [askA, setAskA] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [importMsg, setImportMsg] = useState("");
  const [busy, setBusy] = useState(false);
  // 领域元数据
  const [metaName, setMetaName] = useState("");
  const [metaDesc, setMetaDesc] = useState("");
  const [metaKeywords, setMetaKeywords] = useState("");
  // 虚拟库
  const [selVirt, setSelVirt] = useState<string>("");
  const [virtName, setVirtName] = useState("");
  const [virtDomains, setVirtDomains] = useState("");
  const [virtDesc, setVirtDesc] = useState("");
  const [virtAsk, setVirtAsk] = useState("");
  const [virtAnswer, setVirtAnswer] = useState("");
  const [virtImport, setVirtImport] = useState("");
  const [virtImportMsg, setVirtImportMsg] = useState("");

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
  }, [selDomain, selVirt]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 领域问答/导入（医学知识库原能力通用化） ----------
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

  // ---------- 领域元数据 ----------
  const saveDomainMeta = async () => {
    if (!metaName.trim()) return;
    try {
      await api.knowledgeHubSetDomain(metaName.trim(), {
        desc: metaDesc,
        keywords: metaKeywords.split(/[,，、]/).map((k) => k.trim()).filter(Boolean),
      });
      setMetaName("");
      setMetaDesc("");
      setMetaKeywords("");
      await load();
    } catch (e) {
      setErr(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ---------- 虚拟库 ----------
  const createVirt = async () => {
    const domains = virtDomains.split(/[,，、]/).map((d) => d.trim()).filter(Boolean);
    if (!virtName.trim() || domains.length === 0) {
      setErr("虚拟库名称与领域列表必填（领域用逗号分隔）");
      return;
    }
    try {
      const r = await api.knowledgeHubCreateVirt(virtName.trim(), domains, virtDesc || undefined);
      if (!r.ok) setErr(r.message ?? "创建失败");
      else {
        setErr("");
        setVirtName("");
        setVirtDomains("");
        setVirtDesc("");
        await load();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

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

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "1.5rem 1rem", color: "#1e293b", fontSize: "0.9rem" }}>
      <h2 style={{ margin: "0 0 0.25rem" }}>📚 知识库中心</h2>
      <p style={{ color: "#64748b", margin: "0 0 1rem", fontSize: "0.85rem" }}>
        领域知识库各自独立（医学/交易/杂项…）；虚拟知识库是多个领域库的集合，导入时自动匹配到对应领域。
      </p>
      {err && <div style={{ ...card, color: "#b91c1c", background: "#fef2f2" }}>⚠️ {err}</div>}

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button style={{ ...btn, background: tab === "domain" ? "#3b82f6" : "#cbd5e1" }} onClick={() => setTab("domain")}>🏷️ 领域知识库</button>
        <button style={{ ...btn, background: tab === "virt" ? "#3b82f6" : "#cbd5e1" }} onClick={() => setTab("virt")}>🧩 虚拟知识库</button>
      </div>

      {tab === "domain" && (
        <>
          {/* 领域选择 + 问答 */}
          <div style={card}>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.8rem" }}>
              <span style={{ fontWeight: 600 }}>领域库：</span>
              {ov.instances.length === 0 && <span style={{ color: "#94a3b8" }}>（暂无领域库，先通过「导入」创建）</span>}
              {ov.instances.map((it) => (
                <span
                  key={it.instance}
                  style={{ ...chip, background: selDomain === it.instance ? "#dbeafe" : "#f1f5f9", borderColor: selDomain === it.instance ? "#3b82f6" : "#cbd5e1" }}
                  onClick={() => setSelDomain(it.instance)}
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

          {/* 领域元数据（用于虚拟库导入自动匹配） */}
          <div style={card}>
            <h4 style={{ margin: "0 0 0.6rem" }}>🗂️ 领域元数据（自动匹配导入用）</h4>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
              <input style={{ ...input, maxWidth: 160 }} placeholder="领域名（如 medical）" value={metaName} onChange={(e) => setMetaName(e.target.value)} />
              <input style={{ ...input, maxWidth: 320 }} placeholder="领域描述" value={metaDesc} onChange={(e) => setMetaDesc(e.target.value)} />
              <input style={{ ...input }} placeholder="匹配关键词（逗号分隔，如 血压,手术,康复）" value={metaKeywords} onChange={(e) => setMetaKeywords(e.target.value)} />
              <button style={btn} onClick={() => void saveDomainMeta()}>保存</button>
            </div>
            {ov.domains.length > 0 && (
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                {ov.domains.map((d) => (
                  <span
                    key={d.name}
                    title={`${d.desc}\n关键词：${d.keywords.join("、")}`}
                    style={{ ...chip, background: "#ecfdf5", borderColor: "#a7f3d0", cursor: "default" }}
                  >
                    {d.name}（{d.keywords.length} 词）
                  </span>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {tab === "virt" && (
        <>
          {/* 创建虚拟库 */}
          <div style={card}>
            <h4 style={{ margin: "0 0 0.6rem" }}>➕ 新建虚拟知识库（多个领域库的集合）</h4>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <input style={{ ...input, maxWidth: 160 }} placeholder="名称（如综合）" value={virtName} onChange={(e) => setVirtName(e.target.value)} />
              <input style={{ ...input, maxWidth: 300 }} placeholder="领域列表（逗号分隔，如 medical,trading,other）" value={virtDomains} onChange={(e) => setVirtDomains(e.target.value)} />
              <input style={{ ...input }} placeholder="描述（可选）" value={virtDesc} onChange={(e) => setVirtDesc(e.target.value)} />
              <button style={btn} onClick={() => void createVirt()}>创建</button>
            </div>
          </div>

          {/* 虚拟库列表 + 问答 + 导入 */}
          <div style={card}>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.8rem" }}>
              <span style={{ fontWeight: 600 }}>虚拟库：</span>
              {ov.virst.length === 0 && <span style={{ color: "#94a3b8" }}>（暂无虚拟库）</span>}
              {ov.virst.map((v) => (
                <span
                  key={v.name}
                  style={{ ...chip, background: selVirt === v.name ? "#dbeafe" : "#f1f5f9", borderColor: selVirt === v.name ? "#3b82f6" : "#cbd5e1" }}
                  onClick={() => setSelVirt(v.name)}
                  title={`领域：${v.domains.join("、")}${v.desc ? `\n${v.desc}` : ""}`}
                >
                  {v.name}（{v.domains.join("+")}）
                </span>
              ))}
              {selVirt && (
                <button
                  style={{ ...btn, background: "#ef4444", fontSize: "0.75rem", padding: "0.3rem 0.7rem" }}
                  onClick={async () => { if (confirm(`删除虚拟库「${selVirt}」？不影响领域库数据`)) { await api.knowledgeHubDeleteVirt(selVirt); setSelVirt(""); await load(); } }}
                >
                  删除
                </button>
              )}
            </div>
            {selVirt && (
              <div>
                <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.6rem" }}>
                  <input style={input} placeholder={`向「${selVirt}」提问（聚合 ${ov.virst.find((v) => v.name === selVirt)?.domains.length ?? 0} 个领域库）…`} value={virtAsk} onChange={(e) => setVirtAsk(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void askVirt(); }} />
                  <button style={btn} onClick={() => void askVirt()} disabled={busy}>🔍 聚合问答</button>
                </div>
                {virtAnswer && <div style={{ whiteSpace: "pre-wrap", background: "#f8fafc", borderRadius: 8, padding: "0.8rem 1rem", marginBottom: "0.8rem", lineHeight: 1.7 }}>{virtAnswer}</div>}
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <input style={input} placeholder="Chat 分享链接（导入 → 自动匹配写入对应领域库）…" value={virtImport} onChange={(e) => setVirtImport(e.target.value)} />
                  <button style={btn} onClick={() => void importVirt()} disabled={busy}>📥 导入（自动匹配）</button>
                </div>
                {virtImportMsg && <div style={{ color: "#0e7490", marginTop: "0.5rem", fontSize: "0.85rem" }}>{virtImportMsg}</div>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
