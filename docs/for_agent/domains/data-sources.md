# 领域经验：外部数据源（按需加载）

> 由 dev.md §5 拆出。仅当涉足外部数据源/行情/分享提取时阅读。

## 东财 7x24 快讯

- **东财 7x24 快讯（2026-08-07）**：`https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_1_.html`
  返回 JSONP（`var ajaxResult={...}`，须正则剥 `var ` 前缀与尾分号再 JSON.parse），字段 `LivesList[].title/digest/showtime/url_w`；
  缓存 10 分钟（`watchlist:hotnews`）；np-listapi 新版接口实测常返回空 list，勿用。

## 外部数据源清单

## 5. 外部数据源经验

- **知乎爬虫（多内容目标，2026-08 实测）**：
  - 不局限用户：`parseZhihuTarget` 识别 **用户/问题/回答/文章/想法** 链接，或从分享文本自动提取链接（answer 路径须在 question 之前匹配：`question/{qid}/answer/{aid}`）
  - **专栏文章（zhuanlan）**：`zhuanlan.zhihu.com/p/xxx` 与 `zhihu.com/p/xxx` 是**不同 id 体系**——专栏链接必须保留 zhuanlan 域名（规范化成 www.zhihu.com/p 会 404）；parseZhihuTarget 中专栏域须**最先匹配**；`ZH_LINK_RE` 用 `(?:[\w-]+\.)?zhihu\.com` 支持子域
  - 用户 → 浏览器拦截签名 API + 滚动（断点续爬）；问题 → 拦截 `/api/v4/questions/{qid}/answers` 抓回答流；回答/文章/想法 → 打开详情页 DOM 提取正文（选择器：`.RichContent-inner`/`.Post-RichTextContainer`/`.RichText.ztext`/`.Post-RichText`/`.ArticleContent`）
  - 断点续爬：进度存 `zhihuCrawl:progress:<id>`（seed/phaseIndex/commentsDone），数量上限 100/超时 20min 自动暂停、取消返回已抓结果、续爬 seed 去重
  - 知乎新版评论 API：`/api/v4/comment_v5/{type}/{id}/root_comment`；入口是「N 条评论」按钮
  - 风控 40362：临时限流，等待恢复；Chrome profile 锁残留 → launch 失败重试前 `rmSync(PROFILE_DIR)`
- **知识库中心（虚拟知识库，2026-08）**：
  - 领域知识库 = 实例前缀（`medical.`/`trading.`…）；虚拟知识库 = 多领域集合（KV `kbVirt:<name>`，名称支持中文）
  - 虚拟库导入自动匹配：`kbImportFromChat(..., matchDomains)` 逐条静态关键词匹配（领域元数据 `kbDomain:<name>.keywords`）→ 写入 `medical.`/`trading.` 等前缀，无匹配归 `other.`（低成本；LLM 匹配可后续做兜底）
  - 聚合问答：`kbAsk(question, { instances: [...] })` 多前缀检索 → 单次 LLM
  - **领域特化模板（医学模板已迁入）**：`kbDomain:<name>` 支持 `askTemplate/extractTemplate`（问答/导入 system 模板）；`kbAsk/kbImportFromChat` 按实例读取（`getInstanceTemplate` 内联在 knowledge.ts，避免与 knowledgeHub 循环依赖），无配置回退 medical/通用；`seedMedicalTemplates(force)` 幂等初始化（force 强制还原内置医学模板）；路由 `POST /domain/medical/seed`
  - **统一体验（2026-08）**：领域库与虚拟库「导入/问答」体感一致——前端合并列表（领域+虚拟混合，类型徽章/条数）、统一使用区；可显式新建领域库（`POST /domain`，重复拒绝；`generateTemplates: true` 可选 **LLM 自动生成 ask/extract 模板**，一次调用 json 输出，失败降级 warning）；**空领域库（无数据）也可加入虚拟库**（前端多选合并 instances∪domains）；虚拟库问答先**领域路由**（纯静态 `matchDomain` 问题关键词打分）→ 命中只检索最相关领域（省 token/聚焦），未命中降级全领域；导入自动分发到最匹配领域（**无匹配归虚拟库杂项领域**——名字含 other/杂项/misc 优先，其次第一个领域，勿硬编码 other）；ask 返回 `routed` 供前端展示自动路由提示
  - **知识条目 key 支持中文**：`KEY_RE` 用 Unicode（`\p{L}\p{N}`）——zhihu 导入中文标题等场景 key 含中文合法（2026-08 改，勿回退 ASCII-only）
  - **知乎爬虫导入虚拟库**：instances 接口返回虚拟库（type=virt，在前）+ 领域实例；import 到虚拟库按子领域关键词分发（无匹配归杂项），默认选中「我的」
  - 医学知识库页面已删除（RehabMedicalTool），功能迁入知识库中心（领域库 medical + 模板）
  - 数据源已注册：`kbVirt:`/`kbDomain:`（知识库中心）
  - 前端交互要点：新建虚拟库用**领域多选 checkbox**（勿让用户手输领域名）；虚拟库卡片式列表展示总条目数
- **A/H 股行情（多源，2026-08 实测选型）**：`core/quote.ts` 提供两个能力——
  - `getQuoteSnapshot(code)`：**实时快照**（现价/涨跌/换手/PE/PB/市值/52周区间/币种），
    腾讯 `qt.gtimg.cn` 主源（A/H 一体、字段最全、GBK 需 TextDecoder('gbk') 转码），
    东财 `push2.eastmoney.com`（JSON 干净，secid=1.600519/0.000858/116.00700）与新浪
    `hq.sinajs.cn`（需 Referer，字段贫乏）自动降级；KV 缓存 `quote:s:` 5 分钟（行情时效短）
  - `queryMonthlyBoll(code)`：月 K → 月线 BOLL（网格计划用，腾讯 `web.ifzq.gtimg.cn` qfqmonth，
    排除未完成当月）
  - **腾讯快照字段表**（~ 分隔，A/H 前段同构）：3=价 4=昨收 5=开 31=涨跌 32=涨跌幅 33=高
    34=低 36=量 37=额（A 股万元/港股元，均转亿）39=PE 45=总市值；**A 股** 38=换手 46=PB
    47/48=52周高低；**港股** 46=TENCENT 占位 → PB=47、52周=48/49
- **DeepSeek 分享提取**：`GET https://chat.deepseek.com/api/v0/share/content?share_id={id}`
  （UA + Accept: application/json），消息含 role/content/thinking/inserted_at/accumulated_token_usage
- 测试用真实分享 id：`u5myqtvktzo5gal4qi`；测试行情：`600519` / `hk00700`
- 测试命令：`node "node_modules\.pnpm\tsx@4.23.5\node_modules\tsx\dist\cli.mjs" --test
  apps/server/src/features/cbRate/cbRate.test.ts apps/server/src/core/tasks.test.ts`
  （cbRate 单测 14 项 + tasks 单测 6 项，共 20 项，均须全绿）
