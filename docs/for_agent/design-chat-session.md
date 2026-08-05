# 设计：轻量对话会话层（Append-Only Context for Cache）

> 状态：设计 + 原型已验证（2026-08-06）｜实施范围：按用户决策「仅设计 + 原型」，暂不动生产页面
> 背景：DeepSeek 前缀缓存自动生效（相同前缀完整匹配即命中，命中价 ≈ 未命中价 1/50）。
> 借鉴：esengine/DeepSeek-Reasonix 的 Context Engine v2（stable prefix + append-only + 压缩），
> 以及其 ACP 会话化集成验证。

## 1. 目标

同一「任务/页面」内的多次 LLM 查询共享同一个对话上下文（append-only），使：
- 第 1 次调用：system + user1（前缀 miss，全价）
- 第 N 次调用：system + 全部历史 + userN（前缀 = system+历史，除尾部外全部命中缓存）

预期：第 2 次起每轮命中率 ~95%+，输入成本降至约 1/50（对照实验已验证 98.8%，成本降 13.2x）。

## 2. 现状与差距

- 现状：每次页面请求构造独立 messages（system + 1 条 user），跨请求无状态。
- 已落地：前缀稳定化（动态内容从 system 移 user，system 逐字稳定）——单次请求的 system 前缀可命中。
- 差距：多个请求之间不共享上下文 → 每轮只有 system 命中，新增 user 全 miss；批量场景（多标的）无法复用彼此上下文。

## 3. 方案 A：自研 core/chatSession（轻量会话层）

### 3.1 数据结构

```ts
interface ChatSession {
  id: string;                    // 会话 id（模块前缀 + 时间戳）
  module: string;                // 归属模块（用量/缓存统计维度）
  system: string;                // 稳定 system prompt（前缀锚点，会话内不变）
  model?: string;                // 固定模型（切换模型会破坏前缀，禁止中途换）
  history: LlmChatMessage[];     // 已交换的 user/assistant 消息（append-only）
  createdAt: number;
  lastAt: number;
  ttlMs: number;                 // 默认 30 分钟（缓存 TTL 数小时，会话不宜跨天）
  maxHistoryTokens: number;      // 压缩阈值（默认 ~4000 tokens）
}
```

存储：KV（`chatSession:<id>`），惰性加载；TTL 过期自动清理。

### 3.2 API

```ts
createSession(opts: { module; system; model?; search?; json?; ttlMs? }) → ChatSession
sessionAsk(sessionId, userMessage, opts?) → LlmChatResult
  // messages = [system, ...history, {role:"user", content:userMessage}]
  // 成功：history.push(user, assistant)；超阈值触发压缩
  // 失败：不 append（避免脏历史破坏前缀）
sessionList() → ChatSession[]
sessionDelete(id)
sessionCompact(id)   // 压缩策略（见 3.3）
```

### 3.3 压缩策略（借鉴 Reasonix：snip + 折叠）

历史超阈值时：
1. **snip**：裁剪最早几轮 assistant（工具/搜索结果类长文本，保留最近 N 轮）
2. **折叠**：将更早的轮次用 LLM 生成一句话摘要，替换为 `[摘要] ...`（作为前缀的一部分）
3. **绝不重写 system 与最近一轮**（verbatim，保持缓存前缀）

### 3.4 页面适配计划（后续实施）

| 场景 | 做法 | 预期 |
|---|---|---|
| 专题自选股·批量财报分析 | 同 session 逐只 append（system 固定 + 每只 user/assistant 轮） | 第 2 只起历史命中 |
| 央行利率分析 | 步骤化：逐央行 → 汇总（同 session） | 多轮共享 |
| 国债汇率/逆回购 | 同任务多轮探查共用 session | 同上 |

### 3.5 命中率度量

复用现有用量模型：session 调用以 `chat()` 同通道记录（module 前缀如 `watchlist.fundamental.session`），
前端命中率面板自动覆盖。会话轮次 id 可入 usage 备注（可选）。

## 3.6 原型实测（本会话，真实 key + 短 system）

模拟「批量财报分析」：同一会话逐只分析 3 只 vs 每次独立调用。

| 轮次 | A（append-only 会话） | B（独立调用） |
|---|---|---|
| 第 1 轮 | prompt=61 hit=0（0%） | prompt=61 hit=0（0%） |
| 第 2 轮 | prompt=167 hit=128（76.6%） | prompt=62 hit=0（0%） |
| 第 3 轮 | prompt=274 hit=128（46.7%） | prompt=63 hit=0（0%） |

3 轮输入成本：A $0.000035 / B $0.000026（B 反而略便宜）。

**关键发现（诚实记录）：**
1. append-only 会话命中率显著高于独立调用（第 3 轮 46.7% vs 0%），命中部分按 1/50 价；
2. **DeepSeek 缓存按固定 token 间隔切单元（约 128 tokens），跨单元边界无法部分命中**——
   第 3 轮只命中第一个完整单元（128），userB 之后因 assistant 插入与单元边界错位未命中；
3. **短历史场景收益有限**：3 轮历史仅 ~200 tokens，prompt 因累积变长（274 vs 63），
   即使命中（1/50 价）总成本也未低于独立调用；
4. **收益随轮次/历史增长**：system 大（Reasonix 20k tokens → 98.8% 命中）或轮次多、assistant 长时
   （历史 >> 新增 query），会话方式才显著省钱。我们的页面单次分析（system 数百 tokens）主收益
   已由「前缀稳定化」获得；批量多轮场景（watchlist 一次分析 >5 只）可考虑会话化。

**结论**：会话层是"批量/长任务"专用优化，非默认路径；短期维持前缀稳定化即可。

## 4. 方案 B：集成 Reasonix ACP（已验证可行，用户已选方向）

### 4.1 调研结论（本会话实测）

- 二进制：`npm i reasonix @reasonix/cli-win32-x64`（52MB，Windows amd64），`reasonix acp` 提供 ACP（NDJSON JSON-RPC 2.0 over stdio）
- 会话：`session/new`（cwd）→ `session/prompt`（流式）→ `session/close`；会话**独立 + persisted transcript**；`--continue`/`--resume` 续接
- 前缀稳定：官方文档明确 steer/追加不改 system/tool schema 等稳定前缀字节
- **实测（--metrics）**：首次 prompt=20159 cache_hit=0 cost=$0.00285；续接第 2 轮 **cache_hit=20096（98.8%）** cost=$0.000216（**降 13.2x**）
- 配置：`reasonix setup` 或 `DEEPSEEK_API_KEY` 环境变量（与我们同机制）；`--metrics` 输出 token/cache/cost JSON

### 4.2 集成设计（ACP 网关，后续实施）

```
core/reasonix.ts
  spawn reasonix acp（stdio 三流分离，DEEPSEEK_API_KEY 注入）
  initialize → 能力协商
  session/new(module 任务) → session/prompt(userMessage) → 解析最终回答
  session/close（任务结束回收）；session/list/delete 管理
```

- 收益：零自研会话管理（Reasonix 已实现持久化 + 压缩 + 前缀稳定 + 缓存统计）
- 成本：Go 子进程常驻（~50MB）、ACP 客户端适配、Reasonix 注入的 system（~20k tokens）比自研大、
  Reasonix 是通用 coding agent（工具/计划开销），对我们"页面直调"场景偏重
- 结论：**适合做"会话化批量分析"专用通道**（如 watchlist 多标的），与自研 chat() 并存；
  是否生产化需按页面收益评估（单场景成本对比后再定）

## 5. 建议路径（分两步）

1. **短期**（已选）：保留本设计文档 + 原型结论；页面暂不动（维持前缀稳定化收益）
2. **中期**（用户拍板后）：选一个高频批量场景（watchlist 财报分析）分别用 方案 A（chatSession）
   与 方案 B（ACP）做 A/B 成本对比（--metrics / 用量模型），按数据决定生产化

## 6. 已知风险

- 会话跨天：缓存 TTL 数小时 → 会话 TTL 设 ≤30 分钟，过期即弃
- 长历史：prompt 随轮次增长（miss 尾部恒定，但 hit 部分按 1/50 价仍计费）→ 压缩阈值必须
- 模型切换破坏前缀：会话内禁止换模型
- Reasonix 集成：二进制随平台分发、进程生命周期管理、Reasonix 自身 system 开销大
