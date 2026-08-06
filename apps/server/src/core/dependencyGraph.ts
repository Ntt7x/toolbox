// ============================================================
// 公共模块：项目依赖图（自动生成）
// 扫描 server 源码（features/*/index.ts + core/*.ts）的相对 import，
// 生成 {nodes, edges} 供前端架构图页（ECharts graph）展示。
// - 自动跟进：新增 feature/core 模块或依赖变化，扫描即更新（无需手工维护）
// - 外部节点（DeepSeek/Reasonix/SQLite/MCP kb）与 LLM 三模式边由映射表补充
// ============================================================
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DepNode {
  id: string;
  name: string;
  type: "feature" | "core" | "external" | "data";
  desc?: string;
}

export interface DepEdge {
  from: string;
  to: string;
  /** import / llm-mode / acp / data / frontend */
  kind: string;
  label?: string;
}

export interface DependencyGraph {
  ok: boolean;
  generatedAt: string;
  nodes: DepNode[];
  edges: DepEdge[];
}

const SERVER_SRC = fileURLToPath(new URL("..", import.meta.url));
const FEATURES_DIR = join(SERVER_SRC, "features");
const CORE_DIR = join(SERVER_SRC, "core");

/** 模块中文名（feature/core 展示用；缺省用 id） */
const NODE_NAMES: Record<string, string> = {
  gridPlan: "交易网格计划",
  kelly: "凯利仓位助手",
  cbRate: "央行利率分析",
  treasuryFx: "国债汇率分析",
  reverseRepo: "买断式逆回购",
  watchlist: "专题自选股",
  rehab: "医学知识库",
  memo: "改进备忘录",
  books: "书籍下载",
  deepseekShareTool: "DeepSeek 分析提取",
  agentSessions: "LLM 会话管理",
  localData: "本地数据",
  llm: "LLM（三模式）",
  chatSession: "Cache 会话（模式2）",
  reasonix: "Reasonix ACP（模式3）",
  knowledge: "知识库 KV",
  knowledgeSession: "知识库 Agent 会话",
  knowledgeMcp: "知识库 MCP",
  mcpConfig: "MCP 配置",
  prompts: "提示词注册表",
  quote: "行情工具",
  fund: "场外基金",
  deepseekShare: "分享对话提取",
  tasks: "异步任务",
  sse: "SSE 推流",
  db: "SQLite",
  tableStore: "表模型存储",
  kvStore: "KV 存储",
  settingsStore: "本地设置数据",
  dataRegistry: "数据源注册表",
  routes: "公共路由",
  jsonParse: "JSON 容错解析",
  httpProxy: "HTTP 代理",
  "DeepSeek API": "DeepSeek API",
  "Reasonix Agent": "Reasonix Agent",
  "SQLite .file": "SQLite 数据库",
  "MCP kb": "知识库 MCP 工具",
};

/** 描述（节点详情展示） */
const NODE_DESC: Record<string, string> = {
  llm: "LLM 三种调用模式：direct 直调 / chatSession 自研缓存会话 / reasonix ACP 长会话；用量三层标注（业务 module·服务端 mode·场景 scene）",
  reasonix: "Go 二进制 Agent（ACP 协议），挂载 MCP 工具、显式进程管理、对话数据服务端托管",
  knowledge: "SQLite KV（knowledge: 前缀）+ 实例隔离（medical 等）+ LLM 导入/问答",
  db: "node:sqlite DatabaseSync，WAL，数据文件 .file/toolbox.db（git 隔离）",
};

/** 外部系统连接（人工补充：技术栈边界） */
const EXTERNAL_EDGES: DepEdge[] = [
  { from: "llm", to: "DeepSeek API", kind: "api", label: "Chat/Responses" },
  { from: "reasonix", to: "Reasonix Agent", kind: "acp", label: "ACP stdio" },
  { from: "reasonix", to: "MCP kb", kind: "acp", label: "MCP tools" },
  { from: "db", to: "SQLite .file", kind: "data", label: "读写" },
  { from: "knowledgeMcp", to: "knowledge", kind: "data", label: "KV" },
  { from: "knowledgeSession", to: "reasonix", kind: "acp", label: "会话" },
];

/** LLM 三模式边（业务 → 调用模式） */
const LLM_MODE_EDGES: DepEdge[] = [
  { from: "agentSessions", to: "chatSession", kind: "llm-mode", label: "模式2" },
  { from: "agentSessions", to: "reasonix", kind: "llm-mode", label: "模式3" },
  { from: "knowledgeSession", to: "reasonix", kind: "llm-mode", label: "模式3" },
  { from: "knowledge", to: "llm", kind: "llm-mode", label: "模式1" },
];

/** 解析相对 import 的 core 依赖 */
function scanCoreDeps(filePath: string, from: string, into: string[]): void {
  if (!existsSync(filePath)) return;
  const src = readFileSync(filePath, "utf8");
  const re = /from\s+"\.\.?\/[^"]*\/?(core|shared)\/([a-zA-Z0-9_]+)\.js"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const target = m[2];
    if (!into.includes(target)) into.push(target);
  }
}

/** 扫描 features 与 core，生成依赖图 */
export function generateDependencyGraph(): DependencyGraph {
  const nodes: DepNode[] = [];
  const edges: DepEdge[] = [];
  const nodeSet = new Set<string>();

  const addNode = (id: string, type: DepNode["type"], desc?: string) => {
    if (nodeSet.has(id)) return;
    nodeSet.add(id);
    nodes.push({ id, name: NODE_NAMES[id] ?? id, type, desc: desc ?? NODE_DESC[id] });
  };

  // features（业务层）
  const featureDeps = new Map<string, string[]>();
  let featureDir: string[] = [];
  try {
    featureDir = readdirSync(FEATURES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    featureDir = [];
  }
  for (const f of featureDir) {
    addNode(f, "feature");
    const deps: string[] = [];
    // index.ts + 同目录 service/store/history/compute
    for (const file of readdirSync(join(FEATURES_DIR, f))) {
      if (!/\.ts$/.test(file) || /\.test\.ts$/.test(file)) continue;
      scanCoreDeps(join(FEATURES_DIR, f, file), f, deps);
    }
    featureDeps.set(f, deps);
    for (const d of deps) {
      addNode(d, "core");
      edges.push({ from: f, to: d, kind: "import" });
    }
  }

  // core（公共层）内部依赖
  let coreFiles: string[] = [];
  try {
    coreFiles = readdirSync(CORE_DIR).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
  } catch {
    coreFiles = [];
  }
  for (const cf of coreFiles) {
    const id = cf.replace(/\.ts$/, "");
    addNode(id, "core");
    const deps: string[] = [];
    scanCoreDeps(join(CORE_DIR, cf), id, deps);
    for (const d of deps) {
      if (d === id) continue; // 自引用
      addNode(d, "core");
      if (!edges.some((e) => e.from === id && e.to === d && e.kind === "import")) {
        edges.push({ from: id, to: d, kind: "import" });
      }
    }
  }

  // 外部节点 + 手工补充边
  for (const e of EXTERNAL_EDGES) {
    addNode(e.to, e.to === "SQLite .file" ? "data" : "external");
    if (nodeSet.has(e.from)) edges.push(e);
  }
  for (const e of LLM_MODE_EDGES) {
    if (nodeSet.has(e.from) && nodeSet.has(e.to)) edges.push(e);
  }

  return { ok: true, generatedAt: new Date().toISOString(), nodes, edges };
}
