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
