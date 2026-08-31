# 调研：Toolbox 专属 Chrome 扩展（2026-08-31 完成）

> 状态：**调研完成，结论＝值得做，但定位为「手动一键采集」补充通道**，不替代现有 CDP/Playwright 自动化
> 来源：memo `mtakhsbu-5ki7in` · 对话 `https://chat.deepseek.com/share/gck1xzvmz8pxuxlwe1`

## 原始诉求

浏览网页（知乎文章、抖音视频等）时，需要浏览器侧组件与本地 Toolbox 协作，把内容一键收入知识库/文档中心。选型：Chrome 扩展 vs 油猴脚本 vs 其他。

## 方案对比（对话结论）

| 方案 | 安全性 | 开发复杂度 | 调试难度 | 与本地服务交互 | 结论 |
|---|---|---|---|---|---|
| **Chrome 扩展（MV3）** | 高（官方安全模型） | 中 | 中 | **强**（Native Messaging / WS / fetch） | **推荐** |
| 油猴脚本 | 中 | 低 | 低 | 弱（仅 `GM_xmlhttpRequest` 单向为主） | 仅适合原型 |
| 本地服务自开 HTTP/WS 端口 | 低（需自行防护） | 中 | 低 | 强 | 扩展的通信底座，非替代方案 |
| Native Messaging（扩展专属） | **最高**（不经端口，白名单扩展可连） | **高**（系统注册 + 平台差异） | 高 | 强 | 高安全场景备选 |
| Shared Workers / Broadcast Channel | — | 低 | 低 | 仅页面间 | 实验储备 |

**关键判断**：油猴脚本在"配置界面、多数据源管理、双向通信"上会迅速腐化（单文件、DOM 手搓 UI）；扩展的多文件结构（background/content/popup）天然关注点分离。

## 对照 Toolbox 现状

| 能力 | 现状 | 扩展的增量价值 |
|---|---|---|
| 浏览器自动化 | `core/browser.ts`：CDP 连接（`tryConnectCdp`）+ Playwright 持久化 profile，已服务知乎爬虫 / DeepSeek 自动填入 / 书籍下载 | 自动化已强，**但不覆盖"用户正在浏览的页面随手采集"**——CDP 需开调试端口、且是"驱动浏览器"而非"用户主动触发" |
| 内容入库 | `features/zhihuCrawler`（抓取结果 → 文档中心/知识库导入）、`features/docs`、`core/knowledge` | 扩展只需产出结构化 payload，复用现有导入 API |
| 服务端 | Hono + `/api` 前缀，vite dev 代理 | 扩展直连 `http://127.0.0.1:<port>/api/...` 即可 |

**定位**：扩展 = **人在环路的一键采集器**（选中内容/整页 → 一键入库），CDP 自动化 = 批量/无人值守抓取。二者互补，不重复建设。

## 推荐架构（若实施）

```
content script（提取 DOM/选中文本）
      │ chrome.runtime.sendMessage
      ▼
background service worker（组装 payload、打标、错误重试）
      │ fetch / WebSocket → http://127.0.0.1:PORT/api/...
      ▼
Toolbox server（复用 features/docs、core/knowledge 现有导入接口）
```

- **通信优先选 HTTP/WebSocket 直连本地 server**（开发/调试成本最低，server 已有 `/api` 与 CORS 处理）。
- **Native Messaging 仅作备选**：需写 Native Host + Windows 注册表 `HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>`，消息格式为 `[4字节长度(小端)][UTF-8 JSON]`；优点是不暴露端口，代价是安装与调试成本高——个人本机场景不划算。

## 落地清单（实施时按序）

1. `manifest.json`（MV3）：`manifest_version: 3`、`permissions` 最小化（`activeTab`、`storage`、`scripting`）、`host_permissions: ["http://127.0.0.1:<port>/*"]`、`action.popup`、`background.service_worker`
2. `content.js`：站点适配器（知乎文章/回答、抖音视频页等），产出统一 payload `{ url, title, content(md/html), platform, capturedAt }`
3. `background.js`：Service Worker 会被休眠 → 重要状态放 `chrome.storage`；用 `chrome.runtime.onMessage` 收 content 消息，`fetch` 提交到 server
4. `popup.html/js`：目标库选择（知识库实例 / 文档中心文件夹）、标签、提交反馈
5. server 侧：新增一个"扩展采集"入口（复用 `docs`/`knowledge` 的导入契约，**先进 `packages/shared`**）
6. 固定扩展 ID（加载已解压扩展后从 `chrome://extensions` 取 ID），server 侧可校验 origin

## 注意事项（踩坑点）

- **Content Script 运行在隔离世界**：拿不到页面 JS 变量，需 `window.postMessage` 或注入 `<script>` 与页面脚本通信。
- **MV3 Service Worker 无长驻内存**：不要用全局变量存状态；定时任务用 `chrome.alarms`。
- **权限最小化**：能 `activeTab` 就不要 `tabs`（`tabs` 会触发更重的安装警告）。
- **CORS/端口**：本地 server 需允许扩展 origin；端口以配置形式存于扩展 options（server 端口可能变动）。

## 触发实施的信号

- 频繁出现"看到好内容想手动一键入库"的场景（当前只能复制粘贴或走爬虫）
- 需要绕过 CDP 无法处理的前端加密内容（页面内 DOM 直取更简单）

## 教训沉淀

- **先核对已有自动化能力再选型**：Toolbox 已有 CDP 通道，扩展的价值不在"能不能抓"，而在"用户主动触发的便捷性"——定位错会导致重复建设。
- **个人本机场景安全第一性原则不适用**：Native Messaging 虽然最安全，但系统注册 + 跨平台的成本远超本机 127.0.0.1 的 HTTP 直连。
