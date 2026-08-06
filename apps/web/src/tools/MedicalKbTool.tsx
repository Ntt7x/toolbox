// ============================================================
// 康复 / 医学知识库（medical 实例，基于 core/knowledge 公共模块）
// - 导入：DeepSeek Chat 分享链接 → LLM 提取事实 → 入库（medical.* 实例）
// - 列表/删除：medical 实例内知识条目
// - 问答：限定 medical 实例检索 → LLM 回答 + 展示命中条目
// ============================================================
import { useCallback, useEffect, useState } from "react";
import { api, errMsg } from "../api";
import { useAsyncTask } from "../hooks/useAsyncTask";
import { ErrorCard, PageHeader } from "../ui";
import type { KnowledgeAskResult, KnowledgeEntry, KnowledgeImportResult } from "@toolbox/shared";

const card: React.CSSProperties = { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "1rem", marginBottom: "1rem" };
const btn: React.CSSProperties = { padding: "0.45rem 1rem", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: "0.85rem" };
const input: React.CSSProperties = { flex: 1, padding: "0.45rem 0.7rem", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: "0.85rem", background: "#fff" };

/** 判断剪贴板文本是否符合 DeepSeek 分享链接 / share id 格式 */
function isShareInput(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^https?:\/\/chat\.deepseek\.com\/share\/[A-Za-z0-9_-]{8,64}$/.test(t)) return true;
  return /^[A-Za-z0-9_-]{8,64}$/.test(t);
}

export default function MedicalKbTool() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [url, setUrl] = useState(""); // 多行：每行一个分享链接
  const [question, setQuestion] = useState("");
  const [listErr, setListErr] = useState<string | null>(null);
  const [clipHint, setClipHint] = useState(false);

  const importTask = useAsyncTask<KnowledgeImportResult>("medicalKbImportTaskId", (tid) => api.taskStatus<KnowledgeImportResult>(tid), api.cancelTask);
  const askTask = useAsyncTask<KnowledgeAskResult>("medicalKbAskTaskId", (tid) => api.taskStatus<KnowledgeAskResult>(tid), api.cancelTask);

  const refresh = useCallback(async () => {
    try {
      const r = await api.medicalKbList();
      if (r.ok) setEntries(r.entries);
      setListErr(null);
    } catch (e) {
      setListErr(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, importTask.taskId]);

  // 挂载时自动读取剪贴板（符合链接格式则填入）
  useEffect(() => {
    void readClipboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doImport = async () => {
    // 从多行文本提取全部分享链接（兼容每行一个/夹杂说明文字）
    const links = (url.match(/https?:\/\/chat\.deepseek\.com\/share\/[A-Za-z0-9_-]{8,64}/g) ?? []).map((u) => u.trim()).filter(Boolean);
    if (links.length === 0) return;
    setUrl("");
    try {
      const t = await api.medicalKbImport(links);
      if (t.ok) importTask.watch(t.taskId, t);
      else setListErr(t.message);
    } catch (e) {
      setListErr(errMsg(e));
    }
  };

  /** 从剪贴板读取分享链接并自动填入（支持多个链接；仅当输入框为空） */
  const readClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const links = (text.match(/https?:\/\/chat\.deepseek\.com\/share\/[A-Za-z0-9_-]{8,64}/g) ?? []).map((u) => u.trim());
      if (links.length > 0 && !url.trim()) {
        setUrl(links.join("\n"));
        setClipHint(true);
        setTimeout(() => setClipHint(false), 6000);
      }
    } catch {
      // 剪贴板无权限/不可用（非 https 或未授权）：静默，可手动粘贴
    }
  };

  const doAsk = async () => {
    const q = question.trim();
    if (!q) return;
    try {
      const t = await api.medicalKbAsk(q);
      if (t.ok) askTask.watch(t.taskId, t);
      else setListErr(t.message);
    } catch (e) {
      setListErr(errMsg(e));
    }
  };

  const doDelete = async (key: string) => {
    try {
      const r = await api.medicalKbDelete(key);
      if (r.ok) void refresh();
      else setListErr(r.message);
    } catch (e) {
      setListErr(errMsg(e));
    }
  };

  const answer = askTask.result;

  return (
    <div>
      <PageHeader title="🩺 康复 / 医学知识库" desc="通过 DeepSeek Chat 分享链接导入医学知识，并基于知识库问答。数据存本地（medical 实例）。" />

      {listErr && <ErrorCard>❌ {listErr}</ErrorCard>}

      {/* 知识导入 */}
      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: "0.5rem" }}>📥 导入知识（Chat 分享链接，支持批量）</div>
        <textarea
          style={{ ...input, height: 64, resize: "vertical", fontFamily: "inherit", lineHeight: 1.7 }}
          placeholder={"粘贴 DeepSeek 分享链接，每行一个（支持多条批量导入）：\nhttps://chat.deepseek.com/share/xxx\nhttps://chat.deepseek.com/share/yyy"}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void doImport(); }}
        />
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", alignItems: "center" }}>
          <button style={{ ...btn, background: "#0ea5e9" }} onClick={() => void readClipboard()} title="读取剪贴板中的分享链接" type="button">
            📋 从剪贴板读取
          </button>
          <button style={btn} onClick={() => void doImport()} disabled={importTask.running || !url.trim()} type="button">
            {importTask.running ? "⏳ 提取中…" : "🚀 批量导入"}
          </button>
          <span style={{ color: "#94a3b8", fontSize: "0.75rem" }}>{url.trim() ? (url.match(/share\//g) ?? []).length + " 条链接" : "支持粘贴多条链接"}</span>
        </div>
        {clipHint && <div style={{ color: "#0284c7", fontSize: "0.8rem", marginTop: "0.4rem" }}>📋 已从剪贴板自动填入分享链接</div>}
        {importTask.running && <div style={{ color: "#b45309", fontSize: "0.8rem", marginTop: "0.4rem" }}>后台逐条提取事实中（LLM 解析对话 → 入库 medical 实例）…</div>}
        {importTask.result?.ok && (
          <div style={{ marginTop: "0.5rem" }}>
            {"items" in importTask.result && Array.isArray(importTask.result.items) ? (
              <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "0.7rem 0.9rem" }}>
                <div style={{ fontSize: "0.82rem", fontWeight: 600, marginBottom: "0.4rem" }}>
                  ✅ 批量导入完成：{importTask.result.summary ?? `成功 ${importTask.result.items.filter((x: { ok: boolean }) => x.ok).length}/${importTask.result.items.length}`} · 共 {importTask.result.imported} 条知识
                </div>
                {importTask.result.items.map((it: { url: string; ok: boolean; imported: number; message?: string }, i: number) => (
                  <div key={i} style={{ fontSize: "0.78rem", padding: "0.2rem 0", borderBottom: "1px solid #eef2f7", color: it.ok ? "#15803d" : "#b91c1c" }}>
                    {it.ok ? `✅ ${it.url.slice(0, 60)}… → +${it.imported} 条` : `❌ ${it.url.slice(0, 60)}… → ${it.message ?? "失败"}`}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: "#15803d", fontSize: "0.82rem" }}>
                ✅ 已导入 {importTask.result.imported} 条知识（来源：{importTask.result.title ?? ""}）
              </div>
            )}
          </div>
        )}
      </div>

      {/* 知识问答 */}
      <div style={card}>
        <div style={{ fontWeight: 700, marginBottom: "0.5rem" }}>💬 知识问答（仅检索 medical 实例）</div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input style={input} placeholder="如：感冒初发期应该用什么方子？" value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void doAsk(); }} />
          <button style={btn} onClick={() => void doAsk()} disabled={askTask.running} type="button">
            {askTask.running ? "⏳ 分析中…" : "提问"}
          </button>
        </div>
        {askTask.running && <div style={{ color: "#b45309", fontSize: "0.8rem", marginTop: "0.4rem" }}>检索知识 + LLM 回答中…</div>}
        {answer?.ok && (
          <div style={{ marginTop: "0.6rem", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.8rem" }}>
            <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.7, fontSize: "0.88rem" }}>{answer.answer}</div>
            {answer.used && answer.used.length > 0 && (
              <div style={{ marginTop: "0.6rem", borderTop: "1px dashed #e2e8f0", paddingTop: "0.5rem" }}>
                <div style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.3rem" }}>📎 命中的知识条目：</div>
                {answer.used.map((u) => (
                  <div key={u.key} style={{ fontSize: "0.78rem", color: "#475569" }}>
                    • <b>{u.key}</b>：{u.value.slice(0, 80)}{u.value.length > 80 ? "…" : ""}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 知识列表 */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
          <b>📚 知识条目（{entries.length}）</b>
          <span style={{ flex: 1 }} />
          <button style={{ ...btn, background: "#64748b", padding: "0.3rem 0.8rem" }} onClick={() => void refresh()} type="button">
            ⟳ 刷新
          </button>
        </div>
        {entries.length === 0 ? (
          <div style={{ color: "#94a3b8", fontSize: "0.82rem" }}>暂无知识，先用上方链接导入（提取事实自动生成 key/value）。</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            {entries.map((e) => (
              <div key={e.key} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.5rem 0.7rem", background: "#fff" }}>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <b style={{ fontSize: "0.8rem", color: "#1d4ed8" }}>{e.key.replace(/^medical\./, "")}</b>
                  <span style={{ flex: 1 }} />
                  {e.source && <span style={{ fontSize: "0.68rem", color: "#94a3b8" }}>📎 {e.source.slice(0, 24)}</span>}
                  <span style={{ fontSize: "0.68rem", color: "#94a3b8" }}>{new Date(e.updatedAt).toLocaleString("zh-CN")}</span>
                  <button style={{ fontSize: "0.7rem", padding: "0.15rem 0.5rem", background: "#fee2e2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 6, cursor: "pointer" }} onClick={() => void doDelete(e.key)} type="button">
                    删除
                  </button>
                </div>
                <div style={{ fontSize: "0.8rem", color: "#475569", marginTop: "0.3rem", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{e.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
