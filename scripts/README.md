# scripts/（开发辅助脚本）

所有开发辅助脚本统一集中在 **`dev-utils/`** 目录（`scripts/` 根目录不直接放脚本，只放本入口说明）。

## 快速入口

| 需要什么 | 用哪个 |
|---|---|
| 启动/停止/重启 dev 环境（server+web supervisor） | `node scripts/dev-utils/dev.mjs start\|stop\|restart\|status` |
| 进程诊断/清理（残留 supervisor/tsx/vite、端口占用） | `node scripts/dev-utils/proc.mjs status\|list\|kill\|kill-port` |
| 页面冒烟（17 页，页面大改后必跑） | `node scripts/dev-utils/smoke-pages.mjs` |
| 调用 API / 跑 E2E 断言 | `dev-utils/api.mjs` + `dev-utils/e2e.mjs` |
| 文件文本替换补丁 | `dev-utils/patch.mjs` |
| 浏览器探针 / 备忘录 CLI / KV 检查 | `dev-utils/browser-probe.mjs` / `memo.mjs` / `kv.mjs` |

## 规范（详见 dev.md §4.8）
1. 所有辅助脚本放 `dev-utils/`，禁止根目录散放 `tmp_*.mjs`
2. 历史临时脚本归类与去向：`dev-utils/ARCHIVE.md`
3. 详细工具表：`dev-utils/README.md`
