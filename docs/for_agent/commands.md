# 命令速查（Agent 侧）

> 所有开发命令统一走 `toolbox` 入口（`node scripts/dev-utils/toolbox.mjs`）；底层脚本可直调。
> 环境注意：node 在 `D:\Softwares\nodejs`（不在 PATH），命令前设 `set "PATH=D:\Softwares\nodejs;%PATH%"`（dev.md §3）。

## ⚠️ 命令卫生（Windows/cmd，⛔ dev.md 第 1 条）

- **任何命令不带 `;`**（cmd 下 `;` 会被当参数：`git status;` → unknown switch、`toolbox test cache;` → 找不到模块）——**要串命令就拆成多次工具调用**
- **不写 `node -e` 长 JS**（引号/中文被 cmd 剥 → 语法错 + 生成畸形垃圾文件）——大段替换一律 `write_file` 写 `scripts/dev-utils/_tmp_*.mjs` 落盘执行
- **`toolbox` 入口已自动剥离参数尾部 `;`**（`toolbox test cache;` 等价 `test cache`）——但**裸 `git`/`curl`/`node` 无此兜底**，务必逐条写
- api 验证用 `toolbox api`（宽松 JSON body 如 `{force:true}` 自动补引号；大响应默认截断加 `--full`）

## 环境（prod / dev，2026-09-02 引入）

> **prod = `main` 分支**（日常稳定实例，端口 8787/5173，数据 `.file/`）；
> **dev = 其它分支**（验证实例，端口 8800+slot / 5180+slot，数据 `.file/envs/<id>/data/`）。
> **两者可同时运行**；所有脚本按**当前 git 分支**自动解析环境，无需手工改端口。

| 命令 | 用途 |
|---|---|
| `toolbox config show` | **生效配置全貌**：配置文件来源 / 库文件绝对路径 / 端口 / 环境变量覆盖（部署排障第一命令） |
| `toolbox config paths` | 只打印关键绝对路径（root / dataDir / dbPath / envsDir），供脚本取用 |
| `toolbox config check` | 校验配置文件（字段拼错、类型/范围错误 → 报错退出 1；配置写错**启动即失败**不静默） |
| `toolbox config init` | 生成 `toolbox.config.local.json` 本地覆盖模板（不提交，已在 .gitignore） |
| `toolbox env status` | 当前分支环境详情（端口 / 存活 / 数据目录） |
| `toolbox env list` | 全部环境总览（跨分支，看谁占着谁） |
| `toolbox env start` / `stop` / `restart` | 管理**当前分支**环境（转发 dev.mjs） |
| `toolbox env sync-data` | prod → dev 数据快照（须先 stop；**单向**，禁止回写 prod） |
| `toolbox env url` | 打印当前环境 URL |
| `toolbox env release [branch]` | 释放分支端口槽位（须先 stop） |
| `toolbox api GET /health` | 环境自报：`env` / `branch` / `dataDir`（端口混淆时先确认在跟谁说话） |

⚠️ 在 dev 分支跑 `toolbox api` / `smoke` 默认打到**该分支**的 8800；若没起服务会提示先 `toolbox env start`。

## 开发进程

| 命令 | 用途 |
|---|---|
| `toolbox dev start` | 启动**当前分支环境**（prod 8787+5173 / dev 8800+slot+5180+slot；supervisor 自动拉起；先清端口残留） |
| `toolbox dev stop` / `restart` / `status` | 停止 / 重启 / 查看状态（等价 `toolbox env stop|restart|status`） |
| `toolbox dev kill-port <port>` | 按端口强杀（仅 node 进程） |
| `toolbox proc status` / `list` / `kill <pid>` | 进程诊断：端口占用、残留 supervisor/tsx/vite |
| `toolbox proc envs` | 全环境端口总览（等价 `toolbox env list`） |

## 验证（改动后按 dev.md §5.1 分级执行）

| 命令 | 级别 | 用途 |
|---|---|---|
| `toolbox typecheck` | L0 | 全仓 TS 类型检查（server + web + shared）；`--app server|web` 定向提速 |
| `toolbox test` | L1 | 全量单测；`toolbox test <模块>` 定向；自动探测（能 spawn 走 tsx，受限自动回退 resolve hook） |
| `toolbox api GET /health` | L2 | API 断言（自动加 /api 前缀；POST/PUT/DELETE 带 JSON body） |
| `toolbox smoke --page /tools/x` | L2 | 目标页定向冒烟（页面加载逻辑改动必跑） |
| `toolbox smoke` | L3 | 全量 18 页冒烟（页面级/全局改动、收尾自检） |
| `toolbox check` | — | 改动健康检查（文件数/行数/触及分层 → 建议验证级别；提交前跑） |
| `toolbox probe <url> --check "选择器"` | — | 浏览器探针（元素状态诊断） |
| `toolbox browser <script.mjs> [url]` | — | 浏览器冒烟运行器（playwright 模板固化：TMP/日志/Chrome 自动；脚本内用 page/log） |

## 数据与备忘录

| 命令 | 用途 |
|---|---|
| `toolbox memo add <text>` | 新增 fix 型备忘录（Agent 用；格式建议 `[页面] 问题`，用户浮窗会自动加页面前缀） |
| `toolbox memo stats` / `list` | 改进备忘录统计 / 明细（每轮处理 memo 必用） |
| `toolbox memo bypage <关键词>` | 按页面过滤未完成 memo |
| `toolbox memo done <id>...` | 处理完当场标记 done（硬性，dev.md §8.0） |
| `toolbox memo recent [N]` | 最近已处理 N 条（默认 5） |
| `toolbox kv count <前缀>` / `list` / `get <key>` | KV/DB 只读检查（查测试数据残留） |

## 提交与文本操作

| 命令 | 用途 |
|---|---|
| `toolbox commit "feat(x): 说明"` | git 提交包装（自动 add+commit+push；--no-add / --no-push / --amend） |
| `toolbox commit --file <UTF-8消息文件>` | **中文提交消息必须用此形式**（cmd/PowerShell 以 GBK 传参给 node → 乱码写进历史且无法还原；脚本含 U+FFFD 哨兵拦截）；--amend 改写尖端并 `--force-with-lease` 推送 |
| `toolbox patch <patch.json> [--apply]` | 文件文本替换（dry-run 检查 → --apply 原子写盘；替代 node -e 长替换） |
| `toolbox self-test` | dev-utils 工具自测（工具改动后必跑） |

## 常用杂项

- 提交前清理测试数据：`toolbox kv count` 查 `it_*` / `test*` / `zh_*` 残留，dev.md §8.1
- 服务端校验改完必须重启 server 再断言（tsx watch 偶发不热更新，dev.md §6.7）：`toolbox dev restart`
- 新增工具/页面后核对菜单三件套 + 数据源注册（dev.md §5.2）

## 参考

- 脚本全表与规范：`scripts/README.md`（toolbox 入口说明 + 归档表）
- 验证分级与触发时机：`dev.md §5.1`
