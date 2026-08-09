# 开发辅助脚本归档（history）

本文件归档开发过程中出现过的**临时性脚本**，按需求类型归类并记录去向——用于：
1. 认识哪些需求**反复出现**（→ 已固化到 `scripts/dev-utils/`）
2. 避免未来重新发明（搜索本表先看有没有现成工具）
3. 历史脚本一律删除（不留在仓库根目录），去向见下表

## 分类与去向总览

| 需求类型 | 历史脚本（已删） | 去向/固化 |
|---|---|---|
| **HTTP API 调用/集成验证** | tmp_tp_e2e.mjs、tmp_tp_v2_e2e.mjs、tmp_tp_v3_e2e.mjs、tmp_srv_check.mjs、tmp_check_tp.mjs、tmp_v3/v4/v5/v6.mjs | ✅ **api.mjs**（call/get/post/put/del）+ **e2e.mjs**（断言脚手架） |
| **文件文本替换/补丁**（最多） | tmp_patch_tp_ui3/ui4.mjs、tmp_patch_tp_v2.mjs、tmp_patch_tp_memo4.mjs、tmp_patch_tp6.mjs、tmp_patch_zh4.mjs、tmp_patch_dev4/dev5/dev8.mjs、tmp_tp2/tp_ui2.mjs | ✅ **patch.mjs**（patch.json 驱动、dry-run/原子写盘、CRLF 感知） |
| **浏览器自动化调试**（browserChat/知乎） | tmp_diag_toggle.mjs、tmp_diag_sw.mjs、tmp_browser_test.mjs、probe_*.cjs | ✅ **browser-probe.mjs**（launch Chrome + 选择器状态探针） |
| **备忘录批量操作** | 每轮手写 node -e fetch | ✅ **memo.mjs**（list/done/add） |
| **KV/DB 残留排查** | 手写 node:sqlite | ✅ **kv.mjs**（list/count/get） |
| **LLM 输出/JSON 容错验证** | verify_json.cjs、probe_verify.cjs | 一次性；如再出现 → 在 core/jsonParse 单测里覆盖（而非临时脚本） |
| **单测临时脚本** | test_stores.ts、test_cancel.ts、test_zh_*.ts、test_reuse*.ts | 已并入正式单测（node:test），不再用临时脚本 |
| **网页分享/解析抓包** | parse_share.cjs、share.html、share_conversation.txt | 一次性；如再出现 → 用 api.mjs 调 /tools/deepseek-share |
| **main bundle 抓取** | main_bundle.js | 一次性 |

## 经验总结（避免重复踩坑）

1. **补丁类**：`node -e` 里写长文本替换 → cmd 截断/引号/CRLF/反引号全踩过。**正解 = patch.mjs（或 write_file 脚本）**
2. **E2E 类**：每次重写 `call()` 包装 → **api.mjs** 已固化，import 即用
3. **浏览器类**：launch + goto + 打印选择器 → **browser-probe.mjs**；注意 Chrome profile 锁（失败重试前清锁，**勿 rmSync profile**——会丢登录 cookie，见 dev.md §4.5）
4. **验证类**：改服务端校验 → 重启 server + 用 api.mjs/e2e.mjs 打 400/200 断言（dev.md §4.7）

## 维护约定

- 新需求出现第 2 次 → 在 `scripts/dev-utils/` 固化（不要新建根目录 tmp）
- 一次性脚本 → `scripts/dev-utils/_tmp_*.mjs` 跑完即删
- 本表在新增/删除工具时同步更新
