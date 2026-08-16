# docs/for_agent · Agent 文档地图

> 本目录是 Agent 常驻知识库。**新会话先读本文件**（30 秒定位），再按任务类型按需加载对应文档。
> 原则：**规范层必读、参考层按需、记录层检索**——避免每次会话都通读全部文档。

## 文档分层

| 层 | 文件 | 内容 | 何时读 |
|---|---|---|---|
| **入口（必读）** | `AGENTS.md`（仓库根） | 启动仪表盘：开工清单 + 铁律速查 + 文档地图 | 每个新会话开头 |
| **规范层（必读）** | `dev.md` | 开发规范总纲：分层架构 / 契约驱动 / 验证分级 / git 分支 / 本地数据 / LLM 成本原则 | 每个新会话（§0-§5 必读；§6 仅 §6.1/6.5/6.7 必读，其余小节涉足 LLM/脚本时按需） |
| **速查层（高频）** | `commands.md` | 命令速查：toolbox 入口 + dev/test/api/kv/memo/commit/patch + typecheck | 需要执行命令时 |
| **架构层（理解）** | `dev.md §1` + 仓库源码树 | 目录结构、分层铁律、工具注册流程、RPC 形态 | 改架构 / 新增工具时 |
| **领域层（按需）** | `domains/` | 专业领域经验：frontend-experience / reasonix / shadcn / llm / features / data-sources | 涉足对应领域时（见下方索引） |
| **记录层（检索）** | `history/` | 历史会话归档（时间线，只增不改） | 了解已完成/遗留；开工前查最新 + INDEX |
| **规划层（存档）** | `plans/` | 阶段性规划/路线图（束之高阁待触发，如 `plans/modularization.md`） | 涉及规划/改造方向时参考 |
| **脚本层（执行）** | `scripts/README.md` | 开发辅助脚本指南（toolbox 统一入口） | 用脚本时先看入口说明 |

## 新会话启动清单（5 步，约 1 分钟）

1. **读地图**：本文件（当前页）——确定本次任务涉及哪几层文档
2. **查状态**：`git status` / `git branch -a` —— 当前分支 + 是否有待验收分支
3. **读历史**：`docs/for_agent/history/INDEX.md` 或最近一篇 `history/YYYY-MM-DD-NN.md`（NN 最大者）——了解已完成/遗留，避免重复开发
4. **读备忘录**：`node scripts/dev-utils/toolbox.mjs memo stats` + `list` —— 处理 open 改进项
5. **建分支**：需要改动一律 `git switch -c <type>/<简述>`（规范见 dev.md §4.1）

## 按任务类型 → 该读什么

| 任务类型 | 必读 | 按需 |
|---|---|---|
| 改后端业务（feature） | dev.md §0-§5、§6.7 | dev.md §7 对应领域 + domains/features.md |
| 改核心公共模块（core） | dev.md §1、§6 | domains/features.md（LLM 相关看 §6.3） |
| 改前端页面 | dev.md §5（验证分级）、§6.6 | **domains/frontend-experience.md（前端必读）**；domains/shadcn.md（组件）；smoke-pages 对应页 |
| 涉足 Reasonix / 知识库会话 | dev.md §6.3 | domains/reasonix.md |
| 涉足行情/外部数据源 | dev.md §7.5 | domains/data-sources.md |
| 新增工具/页面/菜单 | dev.md §5.2（三件套核对） | commands.md（验证命令） |
| 处理改进备忘录 | dev.md §8.0 | commands.md（memo 命令） |
| 修复 bug / 重构 | dev.md §6.7、§4 | 本次 bug 涉及的模块文档 |
| 提交/合并 | dev.md §4 | commands.md（commit/check 命令） |

## 新功能 / 新页面完整流程（按序执行，缺一步都别急）

1. **设计前置**（dev.md §5.0 + frontend-experience.md §一）：产出《设计说明》——定位/范式（复用成熟范式）/规模/消费vs管理/用户旅程走查
2. **组件选型**（frontend-experience.md §二）：交互组件先查 shadcn 成熟件（`npx shadcn add <组件> -y -c apps/web`）；shadcn 没有的（文件树/拖拽/内联编辑）才手写，骨架仍用成熟件
3. **实现**：遵循 dev.md §1 架构分层 + §2 契约驱动（先定 packages/shared 类型）→ 后端 feature → 前端页面
4. **验证**（§5.1 分级）：L0 typecheck 必跑 → L1 单测（服务端逻辑）→ L2 定向验证（`toolbox api` / `toolbox smoke --page` + playwright 交互实测）——**不无脑全量冒烟**
5. **提交/验收**（§4）：报告用户 → 确认后 `toolbox commit` → 用户验收 → 合并 main → 归档 history

## 领域文档索引（domains/）

| 文档 | 领域 | 加载时机 |
|---|---|---|
| `domains/reasonix.md` | Reasonix ACP（协议/会话/进程/MCP/托管/引导词去重） | 涉足 Reasonix 会话 / 知识库会话复用 |
| `domains/shadcn.md` | shadcn/ui 组件（Base UI 底层/API 差异/主题映射） | 涉足前端组件 / 页面 UI |
| `domains/frontend-experience.md` | 前端全量经验（设计五问/组件选型/UI 细节/布局工程化/React 陷阱/踩坑集锦） | 前端页面开发/改造前必读 |
| `domains/llm.md` | LLM 调用细节（用量切面三标注/三模式/决策清单/JSON 容错） | 改动 LLM 调用 / 新增 LLM 业务 |
| `domains/features.md` | 浏览器自动化 / 策略仓位管理（trade-plan / 仓位管理 v2）/ 数据可信度（cbRate） | 改 browserChat / trade-plan / trade-v2 / LLM 结构化输出 |
| `domains/data-sources.md` | 外部数据源（知乎/知识库中心/行情/分享/快讯） | 涉足外部数据源 |

## 维护规则

- **本目录全部文件是维护性文件**：每次阶段性提交/归档时整体同步（dev.md §8.1）。
- **省 Token（dev.md §0.5）**：文档按需加载——新会话只读必读层，领域层按任务加载；改代码同步落文档一次到位，不另起一轮；大段历史用 INDEX 摘要代替全文。
- **新增文档**：先在本文件「文档分层/领域索引」登记，再写内容；删除文档同样更新本文件。
- **新工具注册**：toolbox.mjs TOOLS 表 + scripts/README.md §2 + commands.md 三处同步（scripts/README.md §4）。
- 历史文件只增不改（除非事实错误），保持时间线完整（dev.md §8）。
