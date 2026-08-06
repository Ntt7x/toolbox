# 知识库基础能力 · 目标梳理（feat/knowledge-base）

> 2026-08-06 · 依据用户需求整理：业务将多处引入知识库基础能力，服务端预先实现公共模块，知识管理外包给 Reasonix Agent，文件资源集中管理并 KV 化。

## 1. 目标（用户原话 → 落地）

| # | 目标 | 含义 | 状态 |
|---|---|---|---|
| G1 | 业务后续多处引入知识库基础能力 | 知识库是**服务端公共模块**（core 层），各业务（医学/利率/自选股…）基于它实现**特定业务知识库**（key 前缀隔离，如 `medical.*`） | ✅ 医学知识库已落地 |
| G2 | 服务端预先实现知识库基础功能模块 | `core/knowledge`：**纯 SQLite KV** 精确存储 + CRUD/搜索 + LLM 导入（分享对话→事实）/问答（检索→注入→回答）+ 实例隔离 | ✅ |
| G3 | 知识管理外包给 Reasonix Agent | ❌ **已废弃**：原经 `/k/` 文件视图（.file/k 目录 + watcher）给 Agent 读写知识——用户判定冗余，**已删除文件视图层**；知识导入/问答由服务端 LLM 能力（kbImportFromChat/kbAsk）承接 | ❌ 移除 |
| G4 | 服务端给 Agent 所有权限的文件资源，资源集中管理 | `tool_approval=yolo` 全自动批准；Agent cwd 集中到 `.file`（数据目录，git 隔离） | ✅（与知识库解耦，仅资源管理） |
| G5 | 服务端把文件资源实现为 KV 存储 | **SQLite KV 是唯一真源**（`knowledge:` 前缀）；无物理文件层（.file/k 已删除） | ✅ |

## 2. 架构（单向依赖）

```
业务（医学知识库 / 未来其他业务知识库）
   │  调用 core/knowledge（kbImportFromChat / kbAsk / kbSet / kbGet / kbList…）
   ▼
core/knowledge（服务端公共知识库模块）
   │  SQLite KV（.file/toolbox.db，knowledge: 前缀）—— 唯一真源
   │  实例隔离（key 首段 = 实例名 + 配额）
   ▼
core/llm（模式 1 直调：提取/问答）  core/deepseekShare（对话原文）
```

- **KV 是唯一真源**：服务端重启/崩溃知识不丢；无物理文件层
- **LLM 能力内聚**：导入（分享对话 → LLM 提取事实 → 入库）与问答（拆词检索 → 知识注入 → LLM 回答）都在服务端
- **Agent 解耦**：Reasonix 不再直接访问知识库（文件视图已删）；如需 Agent 参与，后续走 ACP 自定义工具（另议）

## 3. 数据流

**导入（内化）**：DeepSeek 分享链接 → extractShare（对话原文）→ LLM 提取 {key,value} 事实 → kbSetMany（实例前缀 + 配额校验）
**问答（读取）**：问题 → 拆词/2-gram 检索（限定实例前缀）→ 命中条目注入提示词 → LLM 回答（含来源）
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
