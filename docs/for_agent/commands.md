# 命令速查（Agent 侧）

> 所有开发命令统一走 `toolbox` 入口（`node scripts/dev-utils/toolbox.mjs`）；底层脚本可直调。
> 环境注意：node 在 `D:\Softwares\nodejs`（不在 PATH），命令前设 `set "PATH=D:\Softwares\nodejs;%PATH%"`（dev.md §3）。

## 开发进程

| 命令 | 用途 |
|---|---|
| `toolbox dev start` | 启动开发环境（server 8787 + web 5173，supervisor 自动拉起；先清端口残留） |
| `toolbox dev stop` / `restart` / `status` | 停止 / 重启 / 查看状态 |
| `toolbox dev kill-port 8787` | 按端口强杀（仅 node 进程） |
| `toolbox proc status` / `list` / `kill <pid>` | 进程诊断：端口占用、残留 supervisor/tsx/vite |

## 验证（改动后按 dev.md §5.1 分级执行）

| 命令 | 级别 | 用途 |
|---|---|---|
| `toolbox typecheck` | L0 | 全仓 TS 类型检查（server + web + shared）；`--app server|web` 定向提速 |
| `toolbox test` | L1 | 全量单测；`toolbox test <模块>` 定向；`--no-spawn` 受限环境免 tsx（resolve hook） |
| `toolbox api GET /health` | L2 | API 断言（自动加 /api 前缀；POST/PUT/DELETE 带 JSON body） |
| `toolbox smoke --page /tools/x` | L2 | 目标页定向冒烟（页面加载逻辑改动必跑） |
| `toolbox smoke` | L3 | 全量 18 页冒烟（页面级/全局改动、收尾自检） |
| `toolbox check` | — | 改动健康检查（文件数/行数/触及分层 → 建议验证级别；提交前跑） |
| `toolbox probe <url> --check "选择器"` | — | 浏览器探针（元素状态诊断） |
| `toolbox browser <script.mjs> [url]` | — | 浏览器冒烟运行器（playwright 模板固化：TMP/日志/Chrome 自动；脚本内用 page/log） |

## 数据与备忘录

| 命令 | 用途 |
|---|---|
| `toolbox memo stats` / `list` | 改进备忘录统计 / 明细（每轮处理 memo 必用） |
| `toolbox memo bypage <关键词>` | 按页面过滤未完成 memo |
| `toolbox memo done <id>...` | 处理完当场标记 done（硬性，dev.md §8.0） |
| `toolbox memo recent [N]` | 最近已处理 N 条（默认 5） |
| `toolbox kv count <前缀>` / `list` / `get <key>` | KV/DB 只读检查（查测试数据残留） |

## 提交与文本操作

| 命令 | 用途 |
|---|---|
| `toolbox commit "feat(x): 说明"` | git 提交包装（自动 add+commit+push；--no-add / --no-push） |
| `toolbox patch <patch.json> [--apply]` | 文件文本替换（dry-run 检查 → --apply 原子写盘；替代 node -e 长替换） |
| `toolbox self-test` | dev-utils 工具自测（工具改动后必跑） |

## 常用杂项

- 提交前清理测试数据：`toolbox kv count` 查 `it_*` / `test*` / `zh_*` 残留，dev.md §8.1
- 服务端校验改完必须重启 server 再断言（tsx watch 偶发不热更新，dev.md §6.7）：`toolbox dev restart`
- 新增工具/页面后核对菜单三件套 + 数据源注册（dev.md §5.2）

## 参考

- 脚本全表与规范：`scripts/README.md`（toolbox 入口说明 + 归档表）
- 验证分级与触发时机：`dev.md §5.1`
