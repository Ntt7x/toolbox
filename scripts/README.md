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
    ├── dev.mjs               开发进程管理器（supervisor：start/stop/restart/status/kill-port；单实例防重）
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
    ├── patch.mjs             文件文本替换执行器（patch.json 驱动）
    ├── check-change.mjs      改动健康检查
    ├── browser-probe.mjs     浏览器探针
    ├── browser-run.mjs       浏览器冒烟运行器（playwright 模板固化）
    ├── ts-resolve-hook.mjs   TS resolve hook（免 spawn 跑 TS 单测）
    ├── _lib.mjs              共享库（ROOT/tsxCli/viteCli 动态路径）
    ├── self-test.mjs         工具自测
    └── browser-run.mjs 占位
```

## 2. 命令速查表（toolbox 入口）

| 命令 | 用途 | 典型用法 |
|---|---|---|
| `dev` | **开发进程管理器**：server(tsx watch)+web(vite) supervisor，健康检查自动拉起，单实例防重 | `toolbox dev start|stop|restart|status|kill-port <port>` |
| `proc` | **进程诊断/清理**：端口占用 + supervisor 状态 + node 进程命令行（查残留） | `toolbox proc status|list|kill <pid>|kill-port <port>` |
| `typecheck` | **TypeScript 类型检查（L0 必跑）**：全仓或单 app | `toolbox typecheck [--app server|web]` |
| `test` | **模块单测快捷**（自动定位测试文件/全量；`--no-spawn` 受限环境用 resolve hook 免 tsx） | `toolbox test tradePlan` / `toolbox test tradeV2 --no-spawn` |
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

## 3. 库模块（仅脚本内 import，不提供 CLI）

| 模块 | 用途 |
|---|---|
| `api.mjs` | 通用 API 客户端：`import { call, get, post, put, del } from "./api.mjs"`；非 2xx 抛带 message 的 Error（含 rejectReason）；BASE 可用环境变量 `TOOLBOX_API` 覆盖 |
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
    ├── browser-run.mjs       浏览器冒烟运行器（playwright 模板固化）
    ├── ts-resolve-hook.mjs   TS resolve hook（免 spawn 跑 TS 单测）
    ├── _lib.mjs              共享库（ROOT/tsxCli/viteCli 动态路径）
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
