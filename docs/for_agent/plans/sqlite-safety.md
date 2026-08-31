# SQLite 数据安全规范 + WAL 恢复排查法

> 来源：2026-08-31 事故复盘（低级 agent 直连 DB 误删 137 条仓位交易）。本文件是操作红线，与 `dev.md §6.5 数据管理` 配套。

## 一、红线：生产 DB 只有 server 进程能写

项目 DB 在 `.file/toolbox.db`（SQLite，`db.ts` 默认模式**无 WAL、无 busy_timeout**）。

| 场景 | 正确做法 | 错误做法 |
|---|---|---|
| 排查数据 | `toolbox api` 走 HTTP，或只读打开（`new DatabaseSync(path, {readOnly:true})`） | `node -e "new DatabaseSync('.file/toolbox.db')"` 直连（⚠️ 第二进程并发写会与 server 事务交错覆盖） |
| 数据修复 | 先停服务 → 备份 → 脚本修复 → 校验 → 重启 | 服务运行时直连写库 |
| 备份 | `kv.mjs backup <key>`（单键）或停服后 copy 整库 | 运行中 copy 主文件（WAL 未 checkpoint 会缺数据） |
| 恢复 | 停服 → `kv.mjs restore` 或脚本恢复 → 校验条数/分布 | 直接覆盖 DB 不校验 |

## 二、WAL 恢复排查法（数据丢失黄金窗口）

**发现数据丢失后第一步：停服务冻结现场**，否则 checkpoint 会覆盖 WAL 中未合并的已删数据帧。

```powershell
# 1. 冻结现场（立即执行，先于任何分析）
node scripts/dev-utils/toolbox.mjs dev stop
copy .file\toolbox.db  .file\forensic\db
copy .file\toolbox.db-wal  .file\forensic\db-wal
copy .file\toolbox.db-shm  .file\forensic\db-shm

# 2. 扫描 WAL 找已删交易帧（可提取被 DELETE 的数据）
node scripts/dev-utils/toolbox.mjs walscan .file\forensic\db-wal

# 3. 诊断当前库 vs 备份差异
node scripts/dev-utils/toolbox.mjs dbdiag --compare .file\toolbox.db.bak-xxx
```

**WAL 帧特征**：
- 帧 = 24B 头 + 4096B 页数据；`kv_store` 行内 `key|value|updated_at` 三段紧邻
- 已删行的旧帧在 checkpoint 前仍物理存在于 WAL；checkpoint 后不可恢复
- `updated_at` 列的时间戳能定位「谁在何时重写过该行」（事故中 121 条 trade 的 kv updated_at = 8/31 23:34，锁定低级 agent 操作窗口）

## 三、数据完整性校验清单（任何恢复/修复后必做）

1. **条数**：恢复后 `kv count tradeV2:trade:` 与备份基准一致
2. **分布**：按 groupId / date 分组统计，与备份对比（`dbdiag --compare`）
3. **索引**：列表键（`tradeV2:trades:list`）与实体键（`tradeV2:trade:*`）数量一致
4. **API 视角**：`toolbox api GET /tools/trade-v2` 分组 entryCount 汇总 = 期望值

## 四、第三方 agent 沙盒约束（本次事故核心教训）

让外部 agent 操作本仓库前，必须注入以下约束：
- 禁止 `git reset --hard` / `git rebase` / `git push --force`（如需回退先问用户）
- 禁止直连 `.file/toolbox.db`（只允许 `toolbox api` / 只读打开）
- 禁止删除/覆盖 `.file/` 下任何文件（含备份）
- 数据修复必须：先备份 → 修复 → 与基准对比条数分布 → 报告差异
