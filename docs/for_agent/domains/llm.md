# LLM 领域文档（core/llm.ts + chatSession + reasonix）

> dev.md §6 的细节展开（用量切面 / 三种模式 / 决策清单）。**原则在 dev.md §6.1（成本原则）**，
> 本文件是「怎么实现 + 踩过的坑」。改动 LLM 调用前按需加载。

## 一、LLM 用量切面（三层标注，2026-08-06 重构后规范）

每次 LLM 调用被切面记录到 `llmUsage:log`，**三层标注**各自职责：

| 维度 | 值 | 职责 | 由谁决定 |
|---|---|---|---|
| `module` | 业务场景，如 `medical-kb.ask`、`cb-rate`、`watchlist.fundamental` | **面向业务**：统计"哪个业务花了多少钱" | **调用方透传**（业务入口） |
| `mode` | `direct` / `chat-session` / `reasonix` | **面向服务端逻辑**：统计"哪种调用方式" | 底层实现固定（chat/chatSessionAsk/reasonixAsk） |
| `scene` | `business` / `system` / `test` | 归属分类 | 从 module 推断（`it.`/`test.`→test；`llm.*`→system；其余 business） |

**核心规则（教训：曾混乱——medical-kb 问答用量记成会话 module `knowledge.medical`，与业务对不上）**：
1. **业务 module 由调用方透传，会话 module 只是兜底**：`chatSessionAsk(sid, msg, { module })`、
   `reasonixAsk(regId, text, { module })`、`kbAsk/kbImportFromChat(..., { module })` 均支持
   `module` 覆盖（缺省回落会话/默认 module）。
2. **module 命名规范**：`<页面/业务>.<动作>` 点分（`medical-kb.ask`、`medical-kb.import`、
   `agent-session.chat`）；**禁止**把底层会话标识（`knowledge.medical`、`watchlist.fundamental.session`）当用量 module。
3. **链路**：业务 feature（如 rehab 的 medical-kb 路由）→ 调 knowledgeSession/kbAsk 时**显式传业务 module**；
   会话类封装（knowledgeSession）再透传给 reasonixAsk/chat；**未传时归 `knowledge.unknown` 并 console.warn**
   （不回落成 `knowledge.<instance>` 技术 module，让漏传问题在用量上暴露）。
4. **前端展示**：按场景（业务/系统/测试）→ 按模式 → 按模块 三栏；旧数据无 mode/scene 兼容按 direct/module 推断。

## 二、三种调用模式（direct / 自研会话 / Reasonix）

### 模式 1：直接调用 `chat(messages, { search?, json?, module? })`（core/llm.ts）
- search=联网搜索（Responses API + web_search，服务端执行，仅 deepseek-v4-flash）；json=response_format json_object
- **前缀稳定化约定**：system 保持逐字稳定（动态日期/标的/月份移到 user 消息），以命中 DeepSeek 前缀缓存（价 ~1/50）

### 模式 2：自研 Cache 会话 `createChatSession / chatSessionAsk`（core/chatSession.ts）
- 借鉴 Reasonix "append-only context"：system 固定 + 每轮 append user/assistant；同会话连续调用前缀命中缓存
- KV 持久化（chatSession:<id>），TTL 30 分钟；历史超长自动压缩（保留 system + 最近 6 轮）
- 注意：`createChatSession` 返回对象，传给 `chatSessionAsk` 须用 `.id`
- 实测：3 轮命中率 0% → 51% → 88.7%；适合批量/长任务（单次分析仍用模式 1）

### 模式 3：Reasonix ACP

- **专业领域文档**：Reasonix ACP 全部细节（协议要点 / 会话生命周期 / 进程管理 / MCP 配置 / 对话托管 / 引导词去重 / 会话复用）**见 `docs/for_agent/domains/reasonix.md`**——涉足 Reasonix 时按需加载。

### 通用细节（三种模式共用）

- 搜索模式**必须在提示词注入当前日期**（否则模型按训练知识理解"本月"）
- **LLM JSON 容错解析在 core/jsonParse.ts**（robustJsonParse/fixJsonQuotes/extractOuterJson），
  所有 LLM 结构化输出业务（cbRate / treasuryFx）共用——新业务直接 import，不要复制
- **DeepSeek 联网搜索（Responses API + web_search）耗时 8~10 分钟是常态**（多步搜索），
- **搜索任务超时对齐（2026-08-14 教训）**：联网搜索类后台任务超时须 ≥10 分钟（cbRate/treasuryFx/reverseRepo 已统一）；core/llm 内部硬超时（chatSearch 600s）不得短于任务超时，否则任务被 llm 层提前 abort
  后台任务超时需留足（≥10 分钟）；前端「停止分析」可随时中断；长超时在此环境
  （Node 24 + tsx watch）偶发不触发（任务最终 done/TTL 清理兜底），属已知现象
- **提示词统一存储于「本地设置数据」**（`settings:prompt.*`，经 `core/prompts.ts` 注册表）：
  默认值在 `core/prompts.ts` 集中 seed，运行时存 SQLite 可编辑可重置；
  服务端实际使用（cb-rate 拼 LLM 请求）与 web 页面「查看/复制程序性提示词」展示
  走**同一条链路**（`GET /api/prompts/:id` 返回 template + rendered）——改提示词
  改数据库即生效（或 API/本地数据管理页编辑），页面与实发永不失步；占位符式模板
  （如 cb-rate.system 的 {banksText}/{calendarJson}/{searchNote}/{calendarRule}）
  支持 search/日历组合，grid-plan 为无占位符全文；
  **注记也可编辑**：cb-rate.note.search / cb-rate.note.knowledge 是独立设置项，
  service 与渲染预览均从库读取 {searchNote} 替换文本——服务端对 LLM 的使用 100% 走同一链路
- API key 存服务端本地设置库（`settings:llm.apiKey`，SQLite `.file/`，已 gitignore）；旧 `.env` 仅一次性迁移
- 结构化工具（如 cb-rate）用 search 默认开 + JSON 输出 + 提示词给出严格 JSON schema，
  解析容忍杂质包裹；失败时保留 raw 兜底展示
- **LLM JSON 输出必须多层容错解析**（`robustJsonParse`，cbRate/service.ts）：
  LLM 常在字符串值内插未转义半角引号（如 `"summary": "2026年7月呈现"xxx"yyy"`）导致
  JSON.parse 失败。解析链：直接 parse → 栈匹配提取最外层 JSON（跳过字符串内 { }）→
  修复值内裸引号 → parse。
  `fixJsonQuotes` 为两遍扫描：定位所有"内容引号/结束候选"，最后一个结束候选作字符串结束，
  其余全部转义（内容引号成对 + 与结束重叠的 LLM 畸形模式如 `"高"}` 也能恢复合法 JSON）。
  注意 extractOuterJson 遇裸引号会因栈不平衡返回 null，故 fix 后须对整体再试 parse。

## 三、LLM 调用开发经验总结（决策清单，2026-08-07 整合）

**选择调用模式（先决策再写码）**：
| 场景 | 模式 | 理由 |
|---|---|---|
| 单次分析、参数随请求变化 | 模式 1 `chat`（system 固定） | 无会话语义，一次即弃 |
| 多轮续问 / 批量同类任务 / 同 system 高频复用 | 模式 2 `createChatSession`+`chatSessionAsk` | append-only，前缀缓存命中（实测 3 轮 0%→51%→88.7%） |
| 长上下文 / Agent 任务 / 知识库问答 | 模式 3 Reasonix ACP | 自带压缩/持久化/工具（代价 ~20k token system 开销） |

**已踩过的坑（勿重犯）**：
- system 内联 `{conversation}`/日期 → 前缀缓存永远 miss（watchlist.import 前身）
- system 4 变体（cbRate 旧版：banks/日历/搜索注记全内联）→ 收敛为仅 searchNote 2 变体
- 会话 append 累积污染（固定 id 会话多轮后旧内容残留）→ 按内容哈希的 id（`wl-imp-{hash}`）天然隔离
- 搜索模式不注入日期 → 模型按训练知识理解「本月」；日期注入 user 且当天固定
- 模板改版后设置数据里旧模板残留（seed 幂等不覆盖）→ 改模板后必须 `POST /api/prompts/<id>/reset`
- Reasonix 引导词每轮重复 → 首轮发 + 指纹去重（省 ~200-400 token/轮）

**验证手段**：
- LLM 用量切面（三层标注）看 module 覆盖；会话列表（Agent 会话管理页）看会话是否按预期复用
- 缓存命中实验：同一会话连续 ask，对比 usage 中 prompt tokens（命中后大幅下降）
- 单测：`chatSession.test.ts` 会话语义/归档；`knowledgeSession.test.ts` 引导词指纹去重
