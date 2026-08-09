# 领域经验：Reasonix ACP（按需加载）

> 由 dev.md §4「模式 3」拆出。仅当涉足 Reasonix 会话/MCP/知识库会话复用时阅读。
> dev.md 只保留一句话指针。

### 模式 3：Reasonix ACP `createReasonixSession / reasonixAsk / closeReasonixSession`（core/reasonix.ts）
- 启动官方 reasonix 二进制（v1.20.0+）ACP 服务（stdio NDJSON JSON-RPC），享受其会话持久化/压缩/前缀稳定
- 二进制：`llm.reasonixBin` 配置或 npm 包 `@reasonix/cli-<platform>-<arch>`（node_modules 内）
- **协议要点（实测）**：`session/prompt` 参数 = `{ sessionId, prompt: [{type:"text",text}] }`（非标准 message）；
  回答文本必须从 **`session/update` 通知的 `agent_message_chunk`** 收集（transcript .jsonl 不实时更新，勿读）
- 同会话多轮实测会话保持正常（第 2 轮引用第 1 轮上下文）；reasonix 自带 system 开销大（~20k tokens）
- 会话生命周期：创建→多轮 ask→close（释放资源）；进程惰性单例，shutdownReasonix() 回收
- **显式进程管理（2026-08-06）**：`getAcpStatus`（PID/启动时间/未决请求）、`ensureAcpRunning`、`stopAcp`
  （taskkill /T /F 进程树，连带 MCP 子进程；注册表保留，续问自动重启+resume）；shutdownReasonix = stopAcp
- **MCP 配置（2026-08-06）**：`core/mcpConfig` 存 `settings:mcp.servers`（本地设置数据）；
  默认 seed 内置知识库 kb（node+tsx+knowledgeMcp.ts，正斜杠路径——Windows 反斜杠会被 ESM loader
  误判为 d: 协议、file:// URL 被 tsx 拼接错乱）；`enabledMcpServers` 供会话挂载；
  **空数组=用户清空**（getMcpServers 只在从未配置/损坏时回退 seed）
- **对话数据服务端托管（2026-08-06）**：reasonixAsk 成功即写 `reasonixHistory:<regId>`（user/assistant 成对，上限 300 条）；
  `getReasonixHistory` / `deleteReasonixHistory`（随 closeReasonixSession 清理）；
  `backfillReasonixHistory` 从 `%APPDATA%/reasonix/sessions/<sid>.jsonl` 回填存量会话历史
  （幂等：已有托管数据跳过；user 消息剥离注入引导词提取真实问题）；详情路由惰性触发
- **引导词去重（2026-08-07）**：knowledgeSession 的 Agent 引导词（knowledge.agent.guide / medical-kb.agent.guide）
  **只在新会话首轮发送**——注册表记录渲染后引导词指纹 `guideFp`，后续轮次指纹相同则只发任务指令
  （历史已含引导，省每轮 ~200-400 token 且前缀更干净）；模板升级 → 指纹变 → 自动重发；
  会话重建（recreateSession）后新会话无历史，自动带引导词。
- **知识库会话复用（2026-08-07）**：reasonix 进程重启后旧会话 `unknown session` 时**重建而非 drop**——
  `recreateSession` 关闭旧会话并更新注册表（关闭失败也兜底删 `reasonixSession:` 注册表），
  同一实例注册表始终指向唯一活跃会话，不产生孤儿堆积。
