# scripts/ 开发辅助脚本指南（唯一入口）

> **设计思想：集中 · 整合 · 复用 · 进化**
> - **集中**：所有开发辅助脚本统一收在 `scripts/dev-utils/`，根目录不散放 `tmp_*.mjs`
> - **整合**：文档只留这一份（本 README 合并了工具表、规范、历史归档），避免多文档漂移
> - **复用**：重复第 2 次出现的脚本需求直接用现成工具 / 在 `dev-utils/` 内固化
> - **进化**：本文件随工具增删同步更新；新工具出现即在 §2 补一行、在 §4 归档旧脚本去向

---

## 1. 目录结构

```
scripts/
├── README.md        ← 本文件（唯一文档：思想 + 工具表 + 规范 + 归档）
└── dev-utils/       所有可复用脚本
    ├── dev.mjs               开发进程管理器（supervisor：start/stop/restart/status/kill-port；单实例防重）
    ├── proc.mjs              进程诊断/清理 CLI（status/list/kill/kill-port）
    ├── smoke-pages.mjs       页面冒烟（17 页；--page <路径> 定向单页）
    ├── test.mjs              模块单测快捷（自动定位测试文件 / 全量串行）
    ├── commit.mjs            git 提交包装（消息引号安全，自动 add+commit）
    ├── api-cli.mjs           API CLI（GET/POST/PUT/DELETE + JSON body）
    └── api.mjs / memo.mjs / kv.mjs / e2e.mjs / patch.mjs / browser-probe.mjs / self-test.mjs
```

## 2. 工具速查表

| 脚本 | 用途 | 典型用法 |
|---|---|---|
| `dev.mjs` | **开发进程管理器**：server(tsx watch)+web(vite) supervisor，健康检查自动拉起，**单实例防重**（start/restart 前杀旧 supervisor），端口清理 | `node scripts/dev-utils/dev.mjs start\|stop\|restart\|status\|kill-port <port>` |
| `proc.mjs` | **进程诊断/清理**：端口占用 + supervisor 状态 + 全部 node 进程命令行（查残留 supervisor/tsx/vite） | `node scripts/dev-utils/proc.mjs status\|list\|kill <pid>\|kill-port <port>` |

| `test.mjs` | **模块单测快捷**（自动定位测试文件/全量） | `node scripts/dev-utils/test.mjs tradePlan` |
| `commit.mjs` | **git 提交包装**（消息引号安全，自动 add+commit） | `node scripts/dev-utils/commit.mjs "feat(x): 说明"` |
| `api-cli.mjs` | **API CLI**（curl 替代，Windows 引号安全） | `node scripts/dev-utils/api-cli.mjs GET /health` |
| `smoke-pages.mjs` | 页面冒烟（18 页；**`--page <路径>` 定向单页**配合 L2） | `node scripts/dev-utils/smoke-pages.mjs [--page /tools/x]` |
| `api.mjs` | 通用 API 客户端：fetch+json 包装，非 2xx 抛带 message 的 Error（含 rejectReason） | `import { call, get, post, put, del } from "./api.mjs"` |
| `e2e.mjs` | API E2E 断言脚手架：用例列表 + 统计 + 失败 exit 1 | 脚本内 `import { e2e, assert } from "./e2e.mjs"` |
| `memo.mjs` | 改进备忘录 CLI：读 open / 批量 done / 新增 / 统计 / 最近 / 按页面过滤（**每轮「处理备忘录」必用**） | `node scripts/dev-utils/memo.mjs list\|done <id>...\|add <text>\|stats\|recent\|bypage <关键词>` |
> **cmd 分号防御**：`done` 自动剥离参数中的 `;` 粘连并跳过非 ID 参数（`done id1; node x` 不再误报 404） |
| `kv.mjs` | KV/DB 只读检查：前缀过滤/统计/取值（查测试数据残留） | `node scripts/dev-utils/kv.mjs list\|count\|get <key>` |
| `patch.mjs` | 文件文本替换执行器：patch.json 驱动，dry-run/原子写盘，CRLF 感知（**替代 node -e 长替换**） | `node scripts/dev-utils/patch.mjs <patch.json> [--apply]` |

| `self-test.mjs` | **工具自测**（patch.mjs 逻辑回归；工具改动后必跑） | `node scripts/dev-utils/self-test.mjs` |
| `check-change.mjs` | **改动健康检查**（文件数/行数/触及分层→建议验证级别；提交前跑，dev.md §6.8） | `node scripts/dev-utils/check-change.mjs [--base main]` |
| `browser-probe.mjs` | 浏览器探针：launch 系统 Chrome + 选择器存在/可见/文本/aria 属性 | `node scripts/dev-utils/browser-probe.mjs <url> --check "textarea:主输入框"` |

## 3. 使用规范

**强制规则以 dev.md §6.8 为准（唯一来源）**，这里只列 README 特有提醒：
- 工具表/归档表是"第 2 次需求先查表"的查表入口；新增工具记得同步 §1 目录树 + §2 工具表（§8.1 同步义务）

## 4. 历史临时脚本归档（出现过的需求 → 去向）

| 需求类型 | 历史脚本（已删） | 去向/固化 |
|---|---|---|
| HTTP API 调用/集成验证 | tmp_tp_e2e / tmp_srv_check / tmp_v*.mjs | → `api.mjs` + `e2e.mjs` |
| 文件文本替换/补丁（最多） | tmp_patch_*.mjs 系列 | → `patch.mjs` |
| 浏览器自动化调试 | tmp_diag_* / tmp_browser_* / probe_*.cjs | → `browser-probe.mjs` |
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

## 5. 复用/进化流程（新需求怎么走）

```
出现新脚本需求
  → 1. 查 §2 工具表 / §4 归档：有没有现成工具？有 → 直接用
  → 2. 没有 → 判断是一次性还是可复用：
       一次性 → dev-utils/_tmp_*.mjs 跑完即删
       可复用 → 在 dev-utils/ 固化 + 在 §2 补一行 + 提交
  → 3. 每次阶段性提交同步更新本文件与 dev.md（§6.8）
```

## 6. 关联

- dev.md §6.8 开发辅助脚本规范（强制）
- dev.md §6 验证清单（smoke/单测/typecheck 流程）
