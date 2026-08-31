# 调研：Python 回测方案（2026-08-31 完成）

> 状态：**调研完成，结论＝暂不引入 Python 回测栈**；需要回测能力时优先在 TS 内实现（数据层已就位）
> 来源：memo `mtakims8-9r3beg` · 对话 `https://chat.deepseek.com/share/sg4ids27uqj3z1i91d`

## 原始诉求

调研适合**个人、低频、简单、成本低**的策略回测与低频量化方案（后延伸到债券数据工具与前端图表选型）。

## 方案全景（对话结论）

### 一、回测框架分层

| 层级 | 代表 | 定位 | 备注 |
|---|---|---|---|
| 入门友好 | `backtesting.py`、`Zipline`、`QF-Lib` | API 直观、10 行跑通 | Zipline 维护停滞、A 股支持弱 |
| 功能全面 | **Backtrader**（1.9w+ star）、Backtrader-Next（+4.5x） | 事件驱动、150+ 指标、多资产 | 中低频主力；纯 Python 性能一般 |
| 极致性能 | **VectorBT**（NumPy+Numba 向量化）、**AKQuant**（Rust 核心 + Python 接口，+20x，AKShare 团队） | 海量参数扫描 / 因子挖掘 | 与事件驱动引擎"快慢结合" |
| 专业领域 | `vn.py`（期货 CTP）、`T1.AI`（A 股多因子） | 垂直场景 | |
| 云端 | 聚宽 JoinQuant、掘金、QuantConnect(LEAN) | 零配置、社区策略多 | 数据与代码在他人平台 |
| 券商终端 | QMT / Ptrade | 实盘直通 | 有资金门槛 |

**社区主流实践**：**向量化快速扫描（VectorBT/Qlib）+ 事件驱动精准验证（Backtrader）** 双引擎交叉验证，两者年化差异 ≤ 3% 才放行。

### 二、数据（免费源）

`AkShare`（A 股覆盖广）· `yfinance`（美股）· `Tushare`（财务全，免费额度）· `MiniQMT`（券商免费行情）。
债券：`ak.bond_zh_us_rate` 一个接口拿到中美 2/5/10/30Y 收益率 + 利差 + GDP 增速，数据自 1990 年起；JP10Y 无直接接口，需走 `bond_investing_global`（Investing.com 源，需先确认指数名、控制频率）。

### 三、前端图表

TradingView Charting Library 需**商业授权**（个人项目门槛高）；官方开源替代 **Lightweight Charts**（~40KB）原生支持**收益率曲线图**（`createYieldCurveChart`），是债券/利差展示的首选。

## 对照 Toolbox 现状

| 回测要素 | 现状 | 缺口 |
|---|---|---|
| 行情/K 线 | `core/quote.ts`、`core/kline.ts`（含月线 BOLL）、`core/fund.ts` | 已有历史数据能力 |
| 数据工程 | `core/data-infra/`（调度-任务-消息-FaaS）+ `core/volatility` 用例 | 已能批量/增量落地历史数据 |
| 交易事实 | `features/tradeV2`（逐笔交易 → 仓位派生 + 收益三视图 + 归因 + 综合指标） | **已有"事后归因"，缺"事前回测"** |
| 数值计算 | TS 全栈 | 低频日线级回测的计算量 TS 足够 |

## 结论与实施建议

**暂不引入 Python 回测栈**（与 akshare 决策同因：跨语言进程成本 > 个人低频场景收益）。

若需要回测能力，按以下顺序推进（**TS 优先，Python 兜底**）：

1. **P0 · TS 事件驱动回测器（建议形态）**：新建 `core/backtest.ts`（纯函数：按日回放 K 线 + 撮合 + 手续费/滑点 + 输出收益/回撤/夏普/盈亏比），复用 `core/kline.ts` 数据；业务接入 `features/`（如"策略回测"工具页），契约先进 `packages/shared`。指标口径与 `tradeV2` 的 `TradeV2Metrics` 对齐（年化波动/夏普/最大回撤/盈亏比/期望），保证"回测 vs 实盘"可比。
2. **P1 · 参数扫描**：同一引擎批处理参数组合（低频策略参数维度小，TS 足够；若确需海量扫描再考虑 VectorBT 子进程）。
3. **P2 · Python 旁路（仅当确需）**：FastAPI + `backtesting.py`，作为**只读计算进程**，由 server 通过 HTTP 调用；不写主库。
4. **前端展示**：如需净值/利差曲线，用 **Lightweight Charts**（开源免费），不用 TradingView 商业库。

## 触发重新评估的信号

- 需要 pandas/numpy 级计算（多因子、滚动训练、大规模参数寻优）
- 需要 akshare 独有数据作为回测输入（见 `plans/akshare-python-backend.md`）
- 回测运行时间成为交互瓶颈（低频日线一般不会）

## 教训沉淀

- **数据已在手，引擎是唯一缺口**：Toolbox 缺的不是数据源（quote/kline/data-infra 已全），而是回测引擎——因此不必为回测引入一整套 Python 生态。
- **指标口径必须统一**：回测指标要与 `tradeV2` 实盘归因口径一致，否则"回测—实盘"无法互相校验（对话中双引擎交叉验证 ≤3% 的思路同样适用于自建引擎与实盘对账）。
