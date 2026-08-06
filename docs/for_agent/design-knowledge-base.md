# 知识库基础能力 · 目标梳理（feat/knowledge-base）

> 2026-08-06 · 依据用户需求整理：业务将多处引入知识库基础能力，服务端预先实现公共模块，知识管理外包给 Reasonix Agent，文件资源集中管理并 KV 化。

## 1. 目标（用户原话 → 落地）

| # | 目标 | 含义 | 状态 |
|---|---|---|---|
| G1 | 业务后续多处引入知识库基础能力 | 知识库是**服务端公共模块**（core 层），各业务（医学/利率/自选股…）基于它实现**特定业务知识库**（key 前缀隔离，如 `medical.*`） | ✅ 医学知识库已落地 |
| G2 | 服务端预先实现知识库基础功能模块 | `core/knowledge`：**纯 SQLite KV** 精确存储 + CRUD/搜索 + LLM 导入/问答 + 实例隔离 | ✅ |
| G3 | 知识管理由 Reasonix Agent 承担（成本低） | Agent 经 **MCP 工具**（`core/knowledgeMcp` stdio server：kb_list/kb_get/kb_search/kb_set/kb_delete/kb_count）直接读写 SQLite KV——**无文件视图**；实例级会话持久（`knowledgeSession:<instance>`），多次问答/导入共享上下文 + 前缀缓存（实测 ~90% 命中） | ✅（用户明确要求 Reasonix 承接降本；文件视图方案已废弃） |
| G4 | 服务端给 Agent 所有权限的文件资源，资源集中管理 | `tool_approval=yolo` 全自动批准；Agent cwd 集中到 `.file`（数据目录，git 隔离） | ✅（与知识库解耦，仅资源管理） |
| G5 | 服务端把文件资源实现为 KV 存储 | **SQLite KV 是唯一真源**（`knowledge:` 前缀）；无物理文件层 | ✅ |

## 2. 架构（单向依赖）

```
业务（医学知识库 / 未来其他业务知识库）
   │  features/rehab → core/knowledgeSession（Reasonix 优先，失败降级 core/knowledge 直调）
   ▼
core/knowledgeSession（实例级 Reasonix 会话封装）
   │  会话注册表 KV（knowledgeSession:<instance>）+ MCP 挂载（stdio）
   ▼
core/reasonix（ACP Host）◄── mcpServers ──► core/knowledgeMcp（stdio MCP server）
   │                                                    │ kb_list/kb_get/kb_search/kb_set/kb_delete/kb_count
   ▼                                                    ▼
Reasonix Agent（知识管理执行者）                  core/knowledge（SQLite KV 唯一真源）
```

- **KV 是唯一真源**：服务端重启/崩溃知识不丢；无物理文件层
- **Agent 是执行者**：导入（对话整理为条目 kb_set 写入）与问答（kb_search 检索 + 引用回答）由 Reasonix 会话承担；会话持久 + 前缀缓存 → 成本低
- **降级链**：Reasonix 不可用（二进制/API key 缺失）→ 服务端直调 kbImportFromChat/kbAsk
- **MCP 子进程**：node + tsx CLI + 正斜杠路径（Windows 反斜杠会被 ESM loader 误判为 d: 协议）

## 3. 数据流

**导入（内化）**：DeepSeek 分享链接 → extractShare（对话原文）→ Reasonix 会话整理 → kb_set 写入（实例前缀 + 配额校验）
**问答（读取）**：问题 → Reasonix 会话 kb_search/kb_get 检索（限定实例前缀）→ 基于条目回答（引用 key）
**管理**：kbList（prefix/q 过滤）/ kbGet / kbDelete / listInstances / clearInstance / 配额（每实例 500 条）

## 4. 已实现清单

- `core/knowledge.ts`：kbSet/kbGet/kbDelete/kbList(搜索)/kbSetMany/kbCount、kbSyncToDir/kbSyncFromDir（KB_ROOT_DIR=`.file/k`）、kbImportFromChat、kbAsk、数据源注册
- `core/reasonix.ts`：Agent cwd=DATA_DIR、会话前后同步 + watcher、tool_approval=yolo、handleToolCall（文件放行/非文件拒绝）、request_permission 兜底
- `core/prompts.ts`：knowledge.extract / knowledge.ask 提示词（本地设置数据链路）
- 测试：knowledge.test.ts 7 个单测（key 校验/CRUD/目录往返/删除同步/防穿越/.file 位置）；集成验证 Agent 读/写知识 + KV 同步
- 数据源 `knowledge:` 已注册（本地数据管理可见）

## 5. 待办 / 方向

- ✅ **G5 已落地**：文件资源即 SQLite KV（无物理文件层）；`.file/k` 视图已删除
- 🔮 业务知识库接入示例：cbRate 利率专题（key 前缀 `cbRate.rate.*`）、watchlist 财报笔记等
- 🔮 kbAsk 接入页面（知识问答 UI）——当前为 core 能力，页面另议
- 🧩 需求型（feature）待用户确认后实施

## 6. 分支

feat/knowledge-base（最新待提交：文件视图层移除，知识库纯 KV）
