# 规划：引入 Python akshare 数据源（暂缓，2026-08-26）

> 状态：**暂缓**（用户 2026-08-26 决策：记入规划文档，不引入）
> 来源：memo `mt4l6ddy-7d8jel`

## 原始需求
引入 python 的 akshare 库（https://github.com/akfamily/akshare），引入 typed python 后端，构建更好的交易数据源和数据工程实践。

## 评估结论（暂缓理由）
1. **能力重叠**：akshare 的核心价值（丰富免费数据源）与现有 TS 行情层（腾讯主源/东财/新浪 failover + data-infra 数据工程）大面积重叠——已覆盖 A/H 行情、K线、外汇、批量快照
2. **架构成本高**：引入 Python 后端 = 新进程/部署/依赖管理（akshare 依赖 pandas 等重依赖）/跨语言调用（HTTP 或消息）——个人低并发场景收益不抵成本
3. **现有数据工程已成熟**：调度器-任务-消息-FaaS 统一链路 + 波动率用例落地，TS 全栈一致

## 未来评估触发点（当以下任一出现再评估）
- 需要 akshare 独有字段：分红送转、财务指标、龙虎榜、资金流、ETF 申赎清单等
- 需要爬虫类数据源（同花顺/东财专有接口）且 TS 直连不稳定
- 需要 pandas/numpy 计算（量化回测/复杂指标）超出 TS 能力

## 若实施（参考方案）
- 独立 Python 服务（FastAPI + typed Python），仅作为**数据源适配器**（akshare 封装为 REST，返回标准化 JSON）
- TS 侧 core/quote.ts 加一个 failover 源（akshare 兜底），不改变现有链路
- Python 进程由 dev.mjs 管理（与 server/web 同生命周期）

## 决策记录
- 2026-08-26：用户选择"暂缓，记入规划文档"——不引入 Python 后端

---

## 复核（2026-08-31）：维持暂缓

memo `mt4l6ddy-7d8jel` 仍处于 doing，本轮重新评估后**维持暂缓**，补充新证据：

1. **能力重叠加剧**：TS 侧已覆盖 A/H 行情（`core/quote.ts`）、K 线（`core/kline.ts`）、场外基金（`core/fund.ts`）、历史波动率（`core/volatility`），且统一由 `core/data-infra/`（调度-任务-消息-FaaS）编排——akshare 的主价值（免费数据源）已被覆盖。
2. **akshare 的真实增量是"独有字段"，不是"行情"**：复核确认其亮点接口为 `bond_zh_us_rate`（中美 2/5/10/30Y 收益率 + 利差 + GDP，1990 年至今）、财务指标、分红送转、龙虎榜、资金流、ETF 申赎清单等。其中**国债收益率 Toolbox 已有 LLM 分析路径**（`features/treasuryFx`），若改为结构化数据接入，属于"精度升级"而非"能力从无到有"。
3. **跨语言成本未变**：新进程（FastAPI + pandas 重依赖）+ 生命周期管理 + 跨进程调用与排障，个人低并发场景仍不划算；且多进程写同一 SQLite（`node:sqlite` 单文件）有额外一致性风险。

### 复核后的触发点（任一出现即重新评估）

- 需要**结构化**国债/利差历史序列（现为 LLM 联网抓取，精度与时点不可控）→ 可先只做 akshare 债券接口
- 需要分红送转 / 龙虎榜 / 资金流 / 财务指标等 TS 侧拿不到的字段
- 需要 pandas/numpy 级计算（回测/多因子）→ 与 `plans/python-backtest.md` 联动评估
- TS 直连数据源出现稳定性问题，需要兜底源

### 若届时实施（最小改动路径）

1. Python 服务（FastAPI + typed Python）**只做数据源适配器**：akshare 封装为 REST，返回标准化 JSON；
2. **只读**：不写 `toolbox.db`，写入一律回传 TS 主服务（规避多进程写 SQLite）；
3. `core/quote.ts` 加 failover 源或新增独立数据源模块，进 `dataRegistry` 注册；
4. 进程纳入 `scripts/dev-utils/dev.mjs` 生命周期管理（与 server/web 同启停）。
