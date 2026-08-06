# 知识库基础能力 · 目标梳理（feat/knowledge-base）

> 2026-08-06 · 依据用户需求整理：业务将多处引入知识库基础能力，服务端预先实现公共模块，知识管理外包给 Reasonix Agent，文件资源集中管理并 KV 化。

## 1. 目标（用户原话 → 落地）

| # | 目标 | 含义 | 状态 |
|---|---|---|---|
| G1 | 业务后续多处引入知识库基础能力 | 知识库是**服务端公共模块**（core 层），各业务（利率/国债/自选股/康复…）可基于它实现**特定业务知识库**（key 前缀隔离，如 `cbRate.*` / `watchlist.*`） | ✅ 已定位公共模块（features/knowledge 业务路由已删） |
| G2 | 服务端预先实现知识库基础功能模块 | `core/knowledge`：KV 精确存储 + CRUD/搜索 + LLM 导入（分享对话→事实）/问答（检索→注入→回答） | ✅ 已实现 |
| G3 | 知识管理功能外包给 Reasonix Agent | Agent 用标准 `read_file/write_file` 经 `/k/{key}` 读写知识（提取/整理/问答由 Agent 承担），服务端只做存储与同步 | ✅ 已实现（kbSyncToDir/FromDir + watcher） |
| G4 | 服务端给 Agent 所有权限的文件资源，资源集中管理 | `tool_approval=yolo` 全自动批准；Agent 工作区集中到 `.file`（数据目录，git 隔离） | ✅ 已实现（cwd=DATA_DIR） |
| G5 | 服务端把文件资源实现为 KV 存储 | **KV 为真源**（SQLite `knowledge:` 前缀），`.file/k/` 目录只是 Agent 的**物化视图**；双向同步由服务端控制 | ✅ 已实现（G5 的"文件=KV 视图"）；🔮 扩展：`.file` 下其他文件资源 KV 化（todo） |

## 2. 架构（单向依赖）

```
业务（cbRate / treasuryFx / watchlist / 康复 …）
   │  调用 core/knowledge（特定业务知识库：kbSet/kbGet/kbList/kbAsk…）
   ▼
core/knowledge（服务端公共知识库模块）
   │  KV 真源（knowledge: 前缀）  ⇄  .file/k/（Agent 物化视图）
   │  kbSyncToDir / kbSyncFromDir + fs.watch watcher（1s 防抖）
   ▼
core/reasonix（ACP Host）
   │  tool_approval=yolo（文件全权限）
   │  handleToolCall / request_permission 兜底（bash/网络拒绝）
   ▼
Reasonix Agent（知识管理执行者）
   │  read_file/write_file /k/{key}
```

- **KV 是唯一真源**：服务端重启/Agent 崩溃，知识不丢（SQLite 持久化）
- **目录是接口视图**：Agent 只见 `.file/k/` 文件，感知不到 KV——对 Agent 透明
- **服务端是控制面**：同步时机（会话前物化/会话后写回/watcher 防抖）、key 校验（防穿越）、权限兜底

## 3. 数据流

**读（Agent 取知识）**：kbAsk/KV → kbSyncToDir → `.file/k/{key}` 文件 → Agent read_file → 直接使用
**写（Agent 存知识）**：Agent write_file `.file/k/{key}` → watcher(1s 防抖)/kbSyncFromDir → KV（key 校验 + 内容比对幂等）→ source=agent-write
**外采（LLM 导入）**：DeepSeek 分享链接 → kbImportFromChat（extractShare → LLM 提取 {key,value} → kbSetMany）

## 4. 已实现清单

- `core/knowledge.ts`：kbSet/kbGet/kbDelete/kbList(搜索)/kbSetMany/kbCount、kbSyncToDir/kbSyncFromDir（KB_ROOT_DIR=`.file/k`）、kbImportFromChat、kbAsk、数据源注册
- `core/reasonix.ts`：Agent cwd=DATA_DIR、会话前后同步 + watcher、tool_approval=yolo、handleToolCall（文件放行/非文件拒绝）、request_permission 兜底
- `core/prompts.ts`：knowledge.extract / knowledge.ask 提示词（本地设置数据链路）
- 测试：knowledge.test.ts 7 个单测（key 校验/CRUD/目录往返/删除同步/防穿越/.file 位置）；集成验证 Agent 读/写知识 + KV 同步
- 数据源 `knowledge:` 已注册（本地数据管理可见）

## 5. 待办 / 方向

- 🔮 **G5 扩展**：`.file` 下其他文件资源（非 /k/）是否 KV 化——设计取舍：目录保持真实文件（工具链兼容）vs 全 KV（统一管理）——待用户拍板
- 🔮 业务知识库接入示例：cbRate 利率专题（key 前缀 `cbRate.rate.*`）、watchlist 财报笔记等
- 🔮 kbAsk 接入页面（知识问答 UI）——当前为 core 能力，页面另议
- 🧩 需求型（feature）待用户确认后实施

## 6. 分支

feat/knowledge-base（efd880f + c01232d，待验收）
