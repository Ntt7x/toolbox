// ============================================================
// 自选股 · 提醒设置（券商式：标的 + 条件 + 阈值 + 方向）
// 规则全量覆盖保存（服务端权威校验：标的须在分组内、阈值须为正）
// 命中：按 ruleId + 交易日去重落库；once 规则命中后自动停用
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { api, errMsg } from "../../api";
import type { WatchAlertHit, WatchAlertKind, WatchAlertRule, WatchItem } from "@toolbox/shared";
import {
  C, Caveats, Empty, Loading, MetaBar, SectionTitle, SegTabs,
  btn, btnGhost, btnSmall, input, table, th, thTd,
} from "./shared";

const KIND_OPTS: { value: WatchAlertKind; label: string; unit: string; hint: string }[] = [
  { value: "price", label: "价格", unit: "元", hint: "价格上破/下破某价位（券商最常用）" },
  { value: "dayPct", label: "日涨跌", unit: "%", hint: "当日涨跌幅超过 ±阈值" },
  { value: "periodPct", label: "周/月涨跌", unit: "%", hint: "周度或月度涨跌幅超过 ±阈值" },
  { value: "amplitude", label: "振幅", unit: "%", hint: "当日振幅超过阈值" },
];

function newRule(code: string, name?: string): WatchAlertRule {
  return {
    id: `al-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    code,
    ...(name ? { name } : {}),
    kind: "price",
    threshold: 0,
    dir: "up",
    enabled: true,
    repeat: "once",
    createdAt: new Date().toISOString(),
  };
}

export default function AlertsPanel({ groupId, items }: { groupId: string; items: WatchItem[] }) {
  const [rules, setRules] = useState<WatchAlertRule[]>([]);
  const [hits, setHits] = useState<WatchAlertHit[]>([]);
  const [triggered, setTriggered] = useState<WatchAlertHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [meta, setMeta] = useState<import("@toolbox/shared").WatchDataMeta | undefined>();
  const [sub, setSub] = useState<"rules" | "hits">("rules");

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.watchlistAlerts(groupId);
      if (r.ok) {
        setRules(r.rules);
        setHits(r.hits);
        setTriggered(r.triggered);
        setMeta(r.meta);
        setDirty(false);
      } else setErr(r.message ?? "加载失败");
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    setRules([]);
    setHits([]);
    setTriggered([]);
    void load();
  }, [load]);

  useEffect(() => {
    setRules([]);
  }, [groupId]);

  const patch = (id: string, p: Partial<WatchAlertRule>) => {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...p } : r)));
    setDirty(true);
  };

  const addRule = () => {
    if (items.length === 0) return;
    setRules((prev) => [...prev, newRule(items[0].code, items[0].name)]);
    setDirty(true);
  };

  const removeRule = (id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    setInfo(null);
    try {
      const r = await api.watchlistSaveAlerts(groupId, rules);
      if (r.ok) {
        setRules(r.rules);
        setDirty(false);
        setInfo("✅ 提醒规则已保存");
        await load();
      } else setErr(r.message ?? "保存失败");
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const clearHits = async () => {
    setErr(null);
    try {
      const r = await api.watchlistClearAlertHits(groupId);
      if (r.ok) {
        setHits([]);
        setInfo("✅ 命中记录已清空");
      } else setErr(r.message ?? "清空失败");
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  if (loading && rules.length === 0 && hits.length === 0) return <Loading text="加载提醒设置…" />;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <SegTabs
          value={sub}
          size="sm"
          options={[
            { value: "rules", label: `规则（${rules.length}）` },
            { value: "hits", label: `命中（${hits.length}）`, badge: triggered.length },
          ]}
          onChange={(v) => setSub(v as "rules" | "hits")}
        />
        <span style={{ flex: 1 }} />
        {sub === "rules" ? (
          <>
            <button type="button" style={btnSmall} onClick={addRule} disabled={items.length === 0}>＋ 新增规则</button>
            <button type="button" style={btn} onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? "保存中…" : dirty ? "💾 保存" : "已保存"}
            </button>
          </>
        ) : (
          <button type="button" style={{ ...btnSmall, background: "#fff", color: C.faint, border: `1px solid ${C.border}` }} onClick={() => void clearHits()} disabled={hits.length === 0}>
            🧹 清空命中
          </button>
        )}
      </div>

      {err ? <div style={{ color: "#b91c1c", fontSize: "0.85rem", marginTop: "0.5rem" }}>{err}</div> : null}
      {info ? <div style={{ color: "#15803d", fontSize: "0.85rem", marginTop: "0.5rem" }}>{info}</div> : null}
      <Caveats meta={meta} />
      <MetaBar meta={meta} />

      {triggered.length > 0 && sub === "rules" && (
        <div style={{ background: C.gainBg, border: "1px solid #fecaca", borderRadius: 8, padding: "0.5rem 0.7rem", margin: "0.5rem 0", fontSize: "0.8rem", color: "#b91c1c" }}>
          🔔 当前有 {triggered.length} 条提醒命中
          {triggered.slice(0, 5).map((h, i) => (
            <div key={`${h.ruleId}-${i}`}>· {h.name ?? h.code} {h.text}</div>
          ))}
        </div>
      )}

      {sub === "rules" ? (
        items.length === 0 ? (
          <Empty>该分组暂无标的，请先添加标的再设置提醒</Empty>
        ) : rules.length === 0 ? (
          <Empty>暂无提醒规则，点击「新增规则」添加（如：茅台 上破 1800 元）</Empty>
        ) : (
          <table style={table}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: "left" }}>标的</th>
                <th style={th}>条件</th>
                <th style={th}>方向</th>
                <th style={th}>阈值</th>
                <th style={th}>周期</th>
                <th style={th}>重复</th>
                <th style={th}>启用</th>
                <th style={th}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => {
                const kindOpt = KIND_OPTS.find((k) => k.value === r.kind)!;
                return (
                  <tr key={r.id}>
                    <td style={{ ...thTd, textAlign: "left" }}>
                      <select
                        style={{ ...input, fontSize: "0.8rem", padding: "0.3rem 0.4rem", maxWidth: 140 }}
                        value={r.code}
                        onChange={(e) => {
                          const it = items.find((x) => x.code === e.target.value);
                          patch(r.id, { code: e.target.value, ...(it?.name ? { name: it.name } : {}) });
                        }}
                      >
                        {items.map((i) => (
                          <option key={i.code} value={i.code}>{i.name ?? i.code}</option>
                        ))}
                      </select>
                    </td>
                    <td style={thTd}>
                      <select
                        style={{ ...input, fontSize: "0.8rem", padding: "0.3rem 0.4rem" }}
                        value={r.kind}
                        title={kindOpt.hint}
                        onChange={(e) => patch(r.id, { kind: e.target.value as WatchAlertKind })}
                      >
                        {KIND_OPTS.map((k) => (
                          <option key={k.value} value={k.value}>{k.label}</option>
                        ))}
                      </select>
                    </td>
                    <td style={thTd}>
                      <select
                        style={{ ...input, fontSize: "0.8rem", padding: "0.3rem 0.4rem" }}
                        value={r.dir}
                        onChange={(e) => patch(r.id, { dir: e.target.value as "up" | "down" })}
                      >
                        <option value="up">{r.kind === "price" ? "上破 ≥" : "涨超 ≥"}</option>
                        <option value="down">{r.kind === "price" ? "下破 ≤" : "跌超 ≤"}</option>
                      </select>
                    </td>
                    <td style={thTd}>
                      <input
                        style={{ ...input, width: 88, fontSize: "0.8rem", padding: "0.3rem 0.4rem", textAlign: "right" }}
                        type="number"
                        min={0}
                        step={r.kind === "price" ? 0.01 : 0.1}
                        value={r.threshold || ""}
                        placeholder={kindOpt.unit}
                        onChange={(e) => patch(r.id, { threshold: Number(e.target.value) })}
                      />
                      <span style={{ color: C.faintest, fontSize: "0.75rem", marginLeft: "0.2rem" }}>{kindOpt.unit}</span>
                    </td>
                    <td style={thTd}>
                      {r.kind === "periodPct" ? (
                        <select
                          style={{ ...input, fontSize: "0.8rem", padding: "0.3rem 0.4rem" }}
                          value={r.period ?? "week"}
                          onChange={(e) => patch(r.id, { period: e.target.value as "week" | "month" | "day" })}
                        >
                          <option value="week">周</option>
                          <option value="month">月</option>
                          <option value="day">日</option>
                        </select>
                      ) : (
                        <span style={{ color: C.faintest, fontSize: "0.75rem" }}>—</span>
                      )}
                    </td>
                    <td style={thTd}>
                      <select
                        style={{ ...input, fontSize: "0.8rem", padding: "0.3rem 0.4rem" }}
                        value={r.repeat}
                        onChange={(e) => patch(r.id, { repeat: e.target.value as "once" | "always" })}
                        title="once：触发一次后自动停用；always：每次命中都记录"
                      >
                        <option value="once">一次</option>
                        <option value="always">每次</option>
                      </select>
                    </td>
                    <td style={thTd}>
                      <input type="checkbox" checked={r.enabled} onChange={(e) => patch(r.id, { enabled: e.target.checked })} />
                    </td>
                    <td style={thTd}>
                      <button type="button" style={btnGhost} onClick={() => removeRule(r.id)}>删除</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      ) : hits.length === 0 ? (
        <Empty>暂无命中记录（规则命中后按「规则 + 交易日」去重落库）</Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
          {hits.map((h, i) => (
            <div key={`${h.ruleId}-${h.date}-${i}`} style={{ display: "flex", gap: "0.5rem", alignItems: "baseline", border: `1px solid ${C.border}`, borderRadius: 8, padding: "0.4rem 0.7rem", background: "#fff", fontSize: "0.82rem", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, color: C.gain }}>🔔</span>
              <span style={{ fontWeight: 600 }}>{h.name ?? h.code}</span>
              <span style={{ color: C.text }}>{h.text}</span>
              <span style={{ flex: 1 }} />
              <span style={{ color: C.faintest, fontSize: "0.75rem" }}>{h.date} {new Date(h.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
          ))}
        </div>
      )}

      <SectionTitle>说明</SectionTitle>
      <div style={{ fontSize: "0.76rem", color: C.faint, lineHeight: 1.7 }}>
        · 判定在服务端完成（纯函数 + 单测覆盖），读取提醒设置时会用当前行情即时判定一次并落库。<br />
        · 阈值相等即命中（券商惯例：触及即提醒）。<br />
        · 「一次」规则命中后自动停用；「每次」规则同一交易日只记录一条。<br />
        · 场外基金为净值型、无日 K，仅支持价格与日涨跌类提醒。
      </div>
    </div>
  );
}
