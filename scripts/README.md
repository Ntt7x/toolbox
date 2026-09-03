# scripts/ 开发辅助脚本指南

> **统一入口：`node scripts/dev-utils/toolbox.mjs <cmd> [args...]`**
> Agent / Vibe Coding 只需记住这一个命令：`toolbox list` 枚举全部工具、`toolbox help <cmd>` 看用法、
> `toolbox <cmd> ...` 转发到底层脚本。底层脚本保留原路径可直接调用（本入口只做分发，不改变实现）。

---

## 1. 目录结构

```
scripts/
├── README.md        ← 本文件（入口说明 + 工具表 + 规范 + 归档）
└── dev-utils/       所有可复用脚本
    ├── toolbox.mjs            ★ 统一入口（list/help/子命令转发）—— 优先用这个
    ├── config-cli.mjs        ★ 配置 CLI（show/paths/check/init：生效来源、库文件绝对路径、端口、环境变量覆盖）
    ├── config.mjs             配置库（转发 packages/shared/config.mjs，与服务端共用同一配置内核）
    ├── env.mjs               ★ 环境管理（prod=main / dev=分支；端口槽位 + 数据目录隔离；也被其它脚本 import 为库）
    ├── dev.mjs               开发进程管理器（supervisor：start/stop/restart/status/kill-port；单实例防重；环境感知）
    ├── proc.mjs              进程诊断/清理 CLI（status/list/kill/kill-port）
    ├── typecheck.mjs         TypeScript 类型检查（全仓 / --app server|web）
    ├── smoke-pages.mjs       页面冒烟（18 页；--page <路径> 定向单页）
    ├── test.mjs              模块单测快捷（自动定位测试文件 / 全量串行）
    ├── commit.mjs            git 提交包装（消息引号安全，自动 add+commit+push）
    ├── api-cli.mjs           API CLI（GET/POST/PUT/DELETE + JSON body）
    ├── api.mjs               通用 API 客户端（库，被其他脚本 import）
    ├── e2e.mjs               API E2E 断言脚手架（库）
    ├── memo.mjs              改进备忘录 CLI
    ├── kv.mjs                KV/DB 检查与备份（list/count/get/backup/restore）
    ├── dbdiag.mjs            SQLite 诊断与 WAL 恢复排查（health/compare/prefix/wal/ids）
    ├── patch.mjs             文件文本替换执行器（patch.json 驱动）
    ├── check-change.mjs      改动健康检查
    ├── browser-probe.mjs     浏览器探针
    ├── browser-run.mjs       浏览器冒烟运行器（playwright 模板固化）
    ├── ts-resolve-hook.mjs   TS resolve hook（免 spawn 跑 TS 单测）
    ├── _lib.mjs              共享库（ROOT/tsxCli/viteCli 动态路径）
    └── self-test.mjs         工具自测
```

## 2. 命令速查表（toolbox 入口）

| 命令 | 用途 | 典型用法 |
|---|---|---|
| `config` | **★ 配置查看/校验**：生效来源、库文件绝对路径、端口、环境变量覆盖（部署排障第一命令） | `toolbox config show\|paths\|check\|init [--json]` |
| `env` | **★ 环境管理**：prod(main)/dev(分支) 双环境，端口槽位 + 数据目录隔离，可并存 | `toolbox env status\|list\|start\|stop\|restart\|sync-data\|url\|release [branch]` |
| `dev` | **开发进程管理器**：server(tsx watch)+web(vite) supervisor，健康检查自动拉起，单实例防重（等价于 `env start/stop/...`） | `toolbox dev start\|stop\|restart\|status\|kill-port <port>` |
| `proc` | **进程诊断/清理**：端口占用 + supervisor 状态 + node 进程命令行（查残留） | `toolbox proc status|list|kill <pid>|kill-port <port>` |
| `typecheck` | **TypeScript 类型检查（L0 必跑）**：全仓或单 app | `toolbox typecheck [--app server|web]` |
| `test` | **模块单测快捷**（自动定位测试文件/全量；自动探测：能 spawn 走 tsx，受限自动回退 resolve hook） | `toolbox test tradePlan` |
| `smoke` | 页面冒烟（18 页；`--page` 定向单页配合 L2） | `toolbox smoke [--page /tools/x]` |
| `api` | **API CLI**（curl 替代，Windows 引号安全，自动加 /api 前缀） | `toolbox api GET /health` |
| `check` | 改动健康检查（文件数/行数/触及分层 → 建议验证级别） | `toolbox check [--base main]` |
| `probe` | 浏览器探针：launch 系统 Chrome + 选择器状态 | `toolbox probe <url> --check "textarea:主输入框"` |
| `browser` | **浏览器冒烟运行器**：playwright 模板固化（TMP/日志/Chrome 自动；裸表达式脚本直接跑） | `toolbox browser <script.mjs> [url]` |
| `memo` | **改进备忘录 CLI**（每轮「处理备忘录」必用；cmd 分号防御内置） | `toolbox memo list|stats|bypage <关键词>|done <id>...|add <text>` |
| `kv` | KV/DB 只读检查（前缀过滤/统计/取值；查测试数据残留） | `toolbox kv list|count|get <key>` |
| `commit` | **git 提交包装**（消息引号安全，自动 add+commit+push） | `toolbox commit "feat(x): 说明"` |
| `patch` | 文件文本替换执行器（patch.json 驱动，dry-run/原子写盘，CRLF 感知） | `toolbox patch <patch.json> [--apply]` |
| `self-test` | **工具自测**（patch.mjs 逻辑回归；工具改动后必跑） | `toolbox self-test` |

> 所有命令也可直接调用底层脚本：`node scripts/dev-utils/<脚本>.mjs ...`（参数一致）。

---

## 2.5 环境模型（prod / dev）—— 2026-09-02 引入

> 目标：日常使用的稳定实例与开发分支的验证实例**彻底分离**，可同时运行互不干扰。

| 维度 | **prod**（`main` 分支） | **dev**（其它分支） |
|---|---|---|
| 定位 | 日常使用的稳定实例，真实数据 | 分支验证实例，随便折腾 |
| server 端口 | `server.port`（默认 `8787`） | `env.devServerPortBase + slot`（默认 `8800 + slot`） |
| web 端口 | `web.port`（默认 `5173`） | `env.devWebPortBase + slot`（默认 `5180 + slot`） |
| 数据目录 | `server.dataDir`（默认 `.file/`） | `<env.envsDir>/<branch-id>/data/` |
| 日志 / 状态 | `server.dataDir` | `<env.envsDir>/<branch-id>/{logs,dev.pids.json}` |

> 上表括号里的默认值全部可在 **仓库根 `toolbox.config.json`** 改（配置化，2026-09-04）——见 §2.6。

- **槽位分配**：首次在某分支跑脚本时自动取最小空闲槽位，写入注册表 `<envsDir>/registry.json`，
  **分支 ↔ 槽位稳定映射**（重启不变）。并发上限 `env.maxSlots`（默认 50）。
- **切换分支即切换环境**：所有脚本（`dev` / `proc` / `api` / `smoke` / `browser`）都按**当前 git 分支**
  自动解析环境，无需手工改端口。
- **数据隔离是硬保证**：dev 分支写库写到自己的目录，**绝不污染 prod 真实数据**
  （服务端 `core/db.ts` 的 `DATA_DIR` 由 `TOOLBOX_DATA_DIR` 覆盖，`docs` 二进制目录随 `DATA_DIR` 走）。

### 常用操作

```bash
toolbox env status              # 当前分支环境：端口 / 存活 / 数据目录
toolbox env list                # 全部环境总览（跨分支，看谁占着谁）
toolbox env start|stop|restart  # 管理当前分支环境（转发 dev.mjs）
toolbox env sync-data           # prod → dev 数据快照（须先 stop；SQLite 三件套 db+(-wal)(-shm)）
toolbox env url                 # 打印当前环境 URL
toolbox env release [branch]    # 释放分支槽位（须先 stop；不影响数据目录）
toolbox proc envs               # 等价 env list（进程视角）
```

---

## 2.6 配置化（toolbox.config.json）—— 2026-09-04 引入

> 目标：**部署与服务管理**相关的一切（监听端口、SQLite 库文件、数据目录、多环境端口段、
> 进程管理参数）集中在一个配置文件里，代码里不留硬编码。

### 配置文件与优先级

| 层 | 文件 | 是否提交 | 用途 |
|---|---|---|---|
| 1 | 内置默认值（`packages/shared/config.mjs`） | 代码内 | 无任何配置文件时的行为（等同历史约定） |
| 2 | `toolbox.config.json` | **提交** | 部署基线，所有人共享 |
| 3 | `toolbox.config.local.json` | 不提交（已 gitignore） | 本机私有覆盖 |
| 4 | `TOOLBOX_CONFIG_FILE` 指向的文件 | 视部署而定 | 部署时指向 `/etc/toolbox.json` 之类 |
| 5 | 环境变量（`PORT` / `TOOLBOX_SERVER_PORT` / `TOOLBOX_DATA_DIR` / `TOOLBOX_DB_FILE` …） | — | CI/临时覆盖，优先级最高 |

- 文件支持 **注释与尾逗号**（非标准 JSON，由配置内核预处理剥离；字符串内的 `//` 不受影响）。
- 路径语义：相对路径一律相对**仓库根**；**绝对路径直接胜出**（dev 环境注入绝对路径靠这条）。
  `server.dbFile` 相对 `server.dataDir`；写绝对路径则整体指向别处的库。
- 配置写错（字段拼错 / 类型错 / 端口越界）→ **启动即失败并指出来源文件**，绝不静默降级。

### 可配置字段

| 字段 | 默认 | 消费方 |
|---|---|---|
| `server.host` / `server.port` | `null` / `8787` | 服务端监听（`null` = Node 默认双栈） |
| `server.dataDir` | `.file` | 数据目录（SQLite / docs / 浏览器 profile） |
| `server.dbFile` | `toolbox.db` | SQLite 库文件名 |
| `server.cors` | `true` | CORS（`true` / origin 字符串 / 数组） |
| `web.host` / `web.port` | `localhost` / `5173` | vite dev server |
| `env.prodBranch` | `main` | 命中即 prod 环境 |
| `env.devServerPortBase` / `env.devWebPortBase` | `8800` / `5180` | dev 端口段 |
| `env.maxSlots` | `50` | 可并存 dev 环境上限 |
| `env.envsDir` | `.file/envs` | dev 环境与注册表根目录 |
| `supervisor.*` | 见文件 | 健康检查间隔 / 空闲阈值 / 重启上限 / 宽限期 / 就绪超时 |

### 唯一实现，两端共用

配置内核是 `packages/shared/config.mjs`（**纯 ESM、零依赖**）——
服务端（TS）与 `scripts/dev-utils/*.mjs`（纯 node）都引它，避免「两份默认值各改一半」的漂移。
脚本侧经 `scripts/dev-utils/config.mjs` 转发（仓库根 `node_modules` 里没有 `@toolbox/shared`，
用相对路径引内核）。

### 常用操作

```bash
toolbox config show            # 生效配置全貌（来源 / 库文件绝对路径 / 端口 / 环境变量覆盖）
toolbox config paths           # 关键绝对路径
toolbox config check           # 校验配置（拼错字段会报错，退出码 1）
toolbox config init            # 生成本地覆盖模板
```

⚠️ 改配置后需**重启服务**生效（开发时 tsx watch 自动重启）；
启动日志会打印 `[config] … db=…` 自报实际使用的配置文件与库文件。

### 自报家门

`GET /api/health` 返回 `env` / `branch` / `dataDir`——多环境并存、端口容易混淆时，
先打健康接口确认「你正在跟哪个实例说话」：

```bash
toolbox api GET /health
# {"ok":true,...,"env":"dev","branch":"refactor/watchlist-to-watchgroups","dataDir":"...\\.file\\envs\\...\\data"}
```

### 数据同步

`env sync-data` 只做 **prod → dev 单向**快照（dev → prod 一律拒绝，防实验数据污染真实库）；
要求先 `stop`（运行中复制 SQLite 会拿到不一致快照）。

### 注意事项

- `env.mjs` 顶层 CLI **有 `isMain` 闸门**：被 import 时不执行 CLI（否则 import 方的 `--page` 等参数会
  掉进 else 分支打印用法——冒烟输出混进「用法: …」即此原因）。
- 端口用 `strictPort`：**不自动顺延**。顺延会让「env status 显示的端口」与实际不符，排查成本高。

---

## 3. 库模块（仅脚本内 import，不提供 CLI）

| 模块 | 用途 |
|---|---|
| `env.mjs` | 环境解析库：`import { resolveEnv, listEnvs, pidOnPort, isNodePid, branchToId, gitBranch, syncData } from "./env.mjs"`；同时是 `toolbox env` 的 CLI（有 `isMain` 闸门，import 不触发 CLI） |
| `api.mjs` | 通用 API 客户端：`import { call, get, post, put, del } from "./api.mjs"`；非 2xx 抛带 message 的 Error（含 rejectReason）；BASE 默认按**当前分支环境**解析，可用 `TOOLBOX_API` 覆盖；连接失败给出「先 `toolbox env start`」的可执行提示 |
| `e2e.mjs` | API E2E 断言脚手架：`import { e2e, assert } from "./e2e.mjs"`；用例列表 + 统计 + 失败 exit 1 |

## 4. 使用规范

**强制规则以 dev.md §6.8 为准（唯一来源）**，这里只列 README 特有提醒：
- **新增工具必须三同步**：`toolbox.mjs` 的 TOOLS 表补一行（含 desc/example）→ 本文件 §2 补一行 → self-test 跑通
- 工具表是「第 2 次需求先查表」的查表入口；出现第 2 次相似脚本需求 → 先查表再固化（§6.8）
- 一次性调试脚本 → `dev-utils/_tmp_*.mjs` 跑完即删，严禁提交

## 5. 历史临时脚本归档（出现过的需求 → 去向）

| 需求类型 | 历史脚本（已删） | 去向/固化 |
|---|---|---|
| HTTP API 调用/集成验证 | tmp_tp_e2e / tmp_srv_check / tmp_v*.mjs | → `api.mjs` + `e2e.mjs` |
| 文件文本替换/补丁（最多） | tmp_patch_*.mjs 系列 | → `patch.mjs` |
| 浏览器自动化调试 | tmp_diag_* / tmp_browser_* / probe_*.cjs | → `browser-probe.mjs` |
| 浏览器冒烟脚本（手写 playwright 模板） | tmp_bcheck / tmp_ledger 等 | → `browser-run.mjs` |
| TS 单测免 spawn（resolve hook） | tmp_rh*.mjs 系列 | → `ts-resolve-hook.mjs` + `test.mjs --no-spawn` |
| 备忘录批量操作 | 手写 node -e fetch | → `memo.mjs` |
| KV/DB 残留排查 | 手写 node:sqlite | → `kv.mjs` |
| 进程管理/诊断 | 手写 netstat+taskkill+wmic | → `dev.mjs`（管理）+ `proc.mjs`（诊断） |
| LLM 输出/JSON 容错验证 | verify_json.cjs / probe_verify.cjs | → core/jsonParse 单测覆盖 |
| 临时单测 | test_stores.ts / test_cancel.ts / test_zh_*.ts | → 正式 node:test |
| 网页分享/解析抓包 | parse_share.cjs / share.html | → `/tools/deepseek-share` API |
| main bundle 抓取 | main_bundle.js | 一次性（不再需要） |

**踩坑记忆**（防重犯）：
- `node -e` 长替换 → cmd 截断/引号剥落/CRLF 不匹配/反引号冲突（全踩过）→ 用 patch.mjs / write_file 脚本
- 多 dev.mjs supervisor 并存互相打架（曾 2 supervisor + 6 tsx watch 同跑）→ dev.mjs 已单实例防重；怀疑时 `proc.mjs list`
- Chrome profile 锁 → 失败重试前清锁；勿 rmSync profile（丢登录 cookie，见 dev.md §7.2）
- 服务端校验假 200（tsx watch 偶发不热更新）→ 重启 server 再断言（dev.md §6.7）
- toolbox.mjs 修改后先 `toolbox list` 冒烟再提交（防 TOOLS 表语法错误）

## 6. 复用/进化流程（新需求怎么走）

```
出现新脚本需求
  → 1. toolbox list / 查 §2 工具表 / §5 归档：有没有现成工具？有 → 直接用
  → 2. 没有 → 判断是一次性还是可复用：
        一次性 → dev-utils/_tmp_*.mjs 跑完即删
        可复用 → 在 dev-utils/ 固化 + toolbox.mjs TOOLS 表补行 + 本文件 §2 补行 + 提交
  → 3. 每次阶段性提交同步更新本文件与 dev.md（§6.8）
```

## 7. 关联

- dev.md §6.8 开发辅助脚本规范（强制）
- dev.md §5 验证清单（smoke/单测/typecheck 流程）
- docs/for_agent/commands.md 命令速查（与 toolbox list 同源，Agent 侧速查）
