# 2026-08-07 批次：feat/memo-batch（处理 5 条备忘录）

分支：`feat/memo-batch`（自 main 分出；zhihu-crawler 分支另待验收）

## 完成项

1. **菜单改名**：`后台管理`→`后台`、`小工具`→`工具`（App.tsx MENU_GROUPS）
2. **备忘录输入框**：单行 input → textarea（需求型 110px / 修复型 46px，Enter 提交 / Shift+Enter 换行，placeholder 按类型提示）
3. **知乎爬虫多内容目标**（备忘录 mshwilcb）：
   - `parseZhihuTarget`：识别 用户/问题/回答/文章/想法 链接 + 分享文本自动提取（answer 匹配先于 question）
   - 问题链接 → 拦截 `/api/v4/questions/{qid}/answers` 抓回答流（滚动加载、日期过滤、limit）
   - 回答/文章/想法链接 → 打开详情页 DOM 提取正文（`.RichContent-inner` / `.Post-RichTextContainer`）
   - 前端：目标输入框支持链接/文本，「识别目标」对非用户链接显示类型；parseZhihuTarget 单测 3 个
4. **知识库重构**（备忘录 mshw5isb，最大项）：
   - 取消「知识库」分组 → 工具分组新增 `knowledge-hub`（知识库中心）
   - 领域知识库集合：overview 列出全部实例 + 领域元数据（`kbDomain:<name>` desc/keywords）
   - 虚拟知识库（`kbVirt:<name>` 多领域集合，名称支持中文）：创建/删除/聚合问答/导入自动匹配
   - `kbAsk` 支持 `instances[]` 多前缀检索（聚合问答单次 LLM）
   - `kbImportFromChat(..., matchDomains)` 逐条静态关键词匹配 → 写入 `medical.`/`trading.`，无匹配归 `other.`
   - 通用领域问答/导入路由（任意实例；医学库保留 rehab Agent 会话特化路径）
   - 新 feature：`features/knowledgeHub/index.ts`；核心：`core/knowledgeHub.ts`
   - 单测 4 个 + 集成冒烟：创建综合库/领域元数据/聚合问答 2s/导入医学内容自动进 medical

## 验证

- typecheck 全绿（server+web）
- 单测 95/95（`apps/server/src/**/*.test.ts`）
- 集成冒烟：overview（medical 141 / knowledge-base 12 / zhihu_test 1）、虚拟库 CRUD、聚合问答、自动匹配导入（imported 4/skipped 2/conflicts 4 因 key 已存在）

## 提交

- `70024fc` fix(memo-batch): 菜单改名 + 备忘录输入框
- `eb001a9` feat(zhihu-crawler): 支持标准链接/分享文本目标
- `eb93045` feat(knowledge-hub): 知识库重构（虚拟库+自动匹配导入）

## 备忘录状态

5 条全部标记 done（mshwilcb / mshwg4p6 / mshwflke / mshwe6gx / mshw5isb）。

## 遗留 / 后续

- `feat/zhihu-crawler` 分支仍待用户验收（含本分支部分重叠改动的冲突需在合并时处理——先合 zhihu-crawler 再合 memo-batch，或反向按时间顺序）
- 虚拟库导入自动匹配为静态关键词；LLM 匹配兜底可作后续增强（降低成本权衡）
- 知识库中心领域问答走 kbAsk 直调（非 Agent 会话）；医学库仍走 rehab Agent 会话特化路径
