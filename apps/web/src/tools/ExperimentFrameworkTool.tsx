// 实验·页面1：通用投资框架（e-梯队衰减仓位模型）
// 统一模式：useDataInfraTask（data-infra 一次性任务——状态/进度/结果统一链路）
import { useEffect, useState } from "react";
import type { ExperimentFrameworkResponse } from "@toolbox/shared";
import { useDataInfraTask } from "../hooks/useDataInfraTask";
import { api, errMsg } from "../api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { MarkdownView } from "../MarkdownView";

const C = { accent: "#2563eb", muted: "#94a3b8", text: "#1e293b", sub: "#64748b", border: "#e2e8f0" };

export default function ExperimentFrameworkTool() {
  const [topic, setTopic] = useState("");
  const [localErr, setLocalErr] = useState<string | null>(null);
  const task = useDataInfraTask<ExperimentFrameworkResponse>({
    storageKey: "expFrameworkTaskId",
    create: () => api.experimentFramework(topic.trim()).then((t) => {
      if (!t.ok) throw new Error(t.message);
      return { taskId: t.taskId };
    }),
    fetchResult: (taskId) => api.dataInfraResult<ExperimentFrameworkResponse>(taskId),
  });

  // 挂载恢复：跨页/刷新后继续等待
  useEffect(() => { task.resumeIfPending(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const run = async () => {
    if (!topic.trim()) { setLocalErr("请输入投资主题（如：光通信产业链）"); return; }
    setLocalErr(null);
    await task.run();
  };

  const running = task.state.status === "running";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card><CardContent>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <span style={{ width: 4, height: 14, borderRadius: 999, background: C.accent }} />
          <span style={{ fontSize: "0.9rem", fontWeight: 700, color: C.text }}>🧭 通用投资框架</span>
          <span style={{ fontSize: "0.72rem", color: C.muted, marginLeft: "auto" }}>主题 → 哲学/战略/战术/批判 4 层分析 + e-梯队仓位（联网搜索）</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
            placeholder="输入投资主题，如：光通信产业链 / 低空经济 / 创新药"
            className="h-9"
          />
          <Button onClick={() => void run()} disabled={running || !topic.trim()} className="h-9">
            {running ? "分析中…" : "🚀 开始分析"}
          </Button>
        </div>
        {localErr && <div style={{ color: "#dc2626", fontSize: "0.82rem", marginTop: 6 }}>{localErr}</div>}
        {running && (
          <div style={{ color: C.sub, fontSize: "0.8rem", marginTop: 6 }}>
            ⏳ {task.state.progress || "正在联网搜索并执行 4 层框架分析（约 1-3 分钟，可离开页面）…"}
          </div>
        )}
        {task.state.status === "failed" && task.state.error && (
          <div style={{ color: "#dc2626", fontSize: "0.82rem", marginTop: 6 }}>❌ {task.state.error}</div>
        )}
        {task.state.status === "cancelled" && (
          <div style={{ color: C.sub, fontSize: "0.82rem", marginTop: 6 }}>已取消</div>
        )}
      </CardContent></Card>

      {task.state.result && (
        <Card><CardContent>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: "0.78rem", color: C.muted }}>
            <span>📅 分析日期：{task.state.result.asOf}</span>
            {task.state.result.model && <span>· 模型：{task.state.result.model}</span>}
          </div>
          <MarkdownView>{task.state.result.report}</MarkdownView>
        </CardContent></Card>
      )}
    </div>
  );
}
