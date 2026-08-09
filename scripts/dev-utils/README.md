# 开发辅助脚本（scripts/dev-utils/）

集中管理开发过程中的**可复用辅助脚本**（把反复手写的临时脚本固化），由 dev.md §4.8 规范强制使用。

| 脚本 | 用途 | 典型用法 |
|---|---|---|
| `api.mjs` | 通用 API 客户端（fetch+json 包装、非 2xx 抛错） | `import { call, get, post, put, del } from "./api.mjs"` |
| `memo.mjs` | 改进备忘录 CLI（读 open / 批量 done / 新增） | `node scripts/dev-utils/memo.mjs list` / `done <id>...` / `add <text>` |
| `kv.mjs` | KV/DB 检查（只读 SQLite，前缀过滤/统计/取值） | `node scripts/dev-utils/kv.mjs list tradePlan:` / `count <前缀>` / `get <key>` |
| `e2e.mjs` | API E2E 断言脚手架（用例列表 + 统计/失败退出） | 脚本内 `import { e2e, assert } from "./e2e.mjs"` |

## 规则（dev.md §4.8）
1. **所有开发辅助脚本一律放 `scripts/dev-utils/`**，禁止在仓库根目录放 `tmp_*.mjs` 临时脚本（反复踩坑：残留混入 commit、cmd 引号截断）
2. **出现第二次相似需求就固化**：发现要手写「fetch+json 调用」「读 kv」「标记备忘录」时，直接用现成工具
3. 一次性调试脚本：写进 `scripts/dev-utils/` 下临时文件跑完即删（或直接写可复用版本）
4. 大段文件替换不要用 `node -e`（CRLF/中文/引号地狱）——写 `.mjs` 脚本文件执行（见 dev.md §4.6）

## 示例
```bash
# 看有没有 open 备忘录
node scripts/dev-utils/memo.mjs list
# 标记完成
node scripts/dev-utils/memo.mjs done msl9xlmb-x5xfuc
# 检查测试数据残留
node scripts/dev-utils/kv.mjs count tradePlan:
node scripts/dev-utils/kv.mjs list tradePlan:
```
