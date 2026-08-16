# 前端开发经验（设计 · 组件 · UI · 工程化）

> 本文件整合多次前端开发会话的全部成熟经验（设计理念 / 组件选型 / UI 细节 / 交互模式 /
> 布局工程化 / React 陷阱 / 性能 / 测试 / 踩坑集锦）。
> **原则在 dev.md §5（验证清单）与 §5.4（UI 细节）；本文件是前端专项的完整展开**。
> shadcn 组件 API 细节见 `domains/shadcn.md`；本文档引用它，不重复。

---

## 一、设计理念（新页面 / 大改造写代码前必做）

### 1.1 设计前置五问（dev.md §5.0 扩展）

写代码前先产出《设计说明》并自答五问（答不了说明没想清楚，不许动手）：

1. **定位**：页面在用户工作流里是什么？在生态里是**采集/沉淀/应用**哪一层？与相邻模块的关系与数据流转？
2. **范式**：成熟工具领域有没有已验证的交互范式可复用（vscode 目录+编辑器、资源管理器、聊天界面）？
   **禁止自创更差的范式**——成熟范式是用户已经会用、不用学的。
3. **规模**：数据量增长到 100/1000 时还成立吗？**搜索/缓存/层级这些"规模性能力"是否一开始就有**，而不是等崩了再补？
4. **消费 vs 管理**：内容型页面以**消费**（读/搜/改/用内容）为核心，管理功能（组织/回收站/标签）是手段不是目的——别本末倒置。
5. **验收 = 用户旅程**：从进页面到完成核心任务（找到→打开→读完→改完）每一步是否顺手？用**用户旅程走查**代替"功能存在性"验收。

### 1.2 反面案例（文档中心初版——血的教训）

初版是"上传+浏览工具"不是"文档工作台"：**弹窗预览、树无叶子、无编辑、无全文搜索、无缓存**——
全是被用户 memo 一条条点破后才补（数学公式→tab→树叶子→编辑器布局）。
**根因**："先实现后设计、被动修补"。教训：
- 工具类页面先确立**信息架构**（区域划分、主次、用户旅程），再填功能
- 复用成熟范式（vscode）而非自创
- 交付前做**使用场景走查**（多开、编辑、对比），不只是"功能存在性"冒烟

### 1.3 内容型页面 = 消费优先

- 以**阅读/搜索/使用**为核心，管理功能（组织/回收站/标签）不喧宾夺主
- 默认态应该让用户**直接看到内容**（如树默认打开一级、不刷屏）

---

## 二、组件选型与成熟库使用

### 2.1 手写 vs 成熟库（核心铁律，用户批"一堆 bug"后确立）

**凡是滚动容器、弹层/菜单、折叠、气泡、对话框、表格、标签页这类有成熟语义的交互组件，
一律优先用 shadcn/ui 成熟组件**（ScrollArea / DropdownMenu / Collapsible / Tabs / Dialog / Tooltip / Table），**不要手写轮子**。

手写反复踩坑的记录：
- 滚动容器 flex 子项压缩 → **文本重叠**（→ ScrollArea 解决）
- `position: fixed` 受容器干扰 → **定位漂移**（→ portal 到 body）
- Escape 关闭缺失 → **遮罩残留挡交互**
- 滚动/高亮联动错位 → 相对坐标 + 跳转保护期

**例外**（shadcn 生态没有的）：文件树/资源管理器（见 §9）、拖拽排序、内联编辑——这些保留手写（业务逻辑），但骨架组件（滚动/按钮/输入）仍用成熟件。

### 2.2 组件库安装（workspace）

```bash
cd apps/web; npx shadcn@latest add <组件> -y -c apps/web   # -c 指定 workspace，否则报 monorepo 根错误
```
- 底层是 **Base UI**（`@base-ui/react`），shadcn 官网 2026-07 起新项目默认
- **安装组件前先查官方 registry**（`npx shadcn add tree` 404 = 官方没有）；社区 registry 用 `npx shadcn add @<registry>/<component>`
- 完整社区注册表索引：`https://ui.shadcn.com/r/registries.json`（277 个）；CLI 内置无需配置
- **API/踩坑全部见 `domains/shadcn.md`**（Select 空串 / Slider 数组 / Input 半受控 / @theme inline 映射 / 染色按逻辑）

### 2.3 弹层/右键菜单规范（portal + 翻转 + Escape）

1. **一律 `createPortal` 渲染到 `document.body`**——fixed 视口定位不受容器干扰（flex 链/overflow/transform 祖先）
2. **定位 = 鼠标视口坐标 + 4px**，从鼠标点右下方展开；**空间不足翻转到另一侧**（菜单边缘贴鼠标点）
   ❌ 禁止 `Math.min(鼠标, 窗口边缘)` "压边"——会把菜单推到窗口边缘离鼠标几百 px（"菜单太远"根因）
3. **必须支持 Escape 关闭**（打开时挂 window keydown、关闭时卸载）
4. 验证陷阱：菜单本体是遮罩（z90）的子级（z95）——`body > div` 只匹配遮罩会误报"菜单未出现"

### 2.4 TOC / 大纲联动高亮（MarkdownView 实践）

- **高亮判定用内容区相对坐标**（`标题.top - 内容区.top <= 80`）——**不要用视口绝对坐标**
  （内容区在页面中部时标题永远到不了视口顶部 → 高亮错位/消失）
- **点击跳转用瞬间 scrollIntoView（block: start）** + `jumpAt` 时间戳——跳转后 600ms 内 onScroll 不覆盖高亮
  （否则 smooth 途中 onScroll 把点击项覆盖成中间标题）
- 标题锚点 id 在重渲染后可能丢失 → **scrollTo 直接 `querySelectorAll("h1,h2,h3,h4")[i]` 定位**，不依赖 id

---

## 三、UI 细节规范（所有页面交互控件）

1. **输入框/文本域**：`padding ≥ 0.6rem 0.85rem`、`min-height ≥ 40px`、`font-size ≥ 0.9rem`、
   `border-radius 10px`、边框 `#cbd5e1` + focus ring（`0 0 0 3px rgba(37,99,235,0.12)`）。
   多行文本域高度 ≥ 96px（约 4 行），`line-height 1.7`。
2. **按钮**：`padding ≥ 0.5rem 1rem`、`font-size ≥ 0.86rem`、圆角 ≥ 10px；主按钮品牌蓝 + 阴影 + hover 反馈；禁用态 opacity 0.55。
3. **表单结构**：字段用 `.field-label`（0.8rem/600/深灰）标注，输入框与标签间距 ≥ 0.3rem；**不要只靠 placeholder**（会消失）。
4. **通用原则**：可读性优先——正文 ≥ 0.8rem、表格 ≥ 0.8rem；可点击元素有 hover 反馈；卡片间距 ≥ 1rem；避免过小点击区（≥ 28px 高度）。
5. **组件染色按逻辑**：危险操作（删除 ✕）`hover:bg-red-50 hover:text-red-600`；Slider 轨道 `bg-slate-200/90`（默认 bg-muted 太浅）+ 填充 primary；outline 按钮边框加深 `border-slate-300`；提示条用色底+文字色双通道。
6. **空状态**：列表/搜索结果/回收站空时给明确提示（"无匹配文档"、"回收站是空的"），不要白屏。
7. 优先复用 `styles.css` 工具类（`.input`/`.btn`/`.field-label`/`.card`）；内联样式不得低于上述最小尺寸。

---

## 四、交互模式（vscode 风格最佳实践）

- **多 tab 浏览**：内容型页面（文档中心）用 tab 栏 + 内容区（vscode），tab 名截断（maxWidth 220 + ellipsis）
- **中键关闭 tab**：`onMouseDown` 判断 `e.button === 1` + `e.preventDefault()`（否则触发辅助滚动）
- **右键菜单**：见 §2.3
- **拖拽**：HTML5 DnD（`dataTransfer.setData` 传 id，`onDrop` 处理）；draggable 元素要 `e.stopPropagation` 防冒泡
- **内联编辑**：点条目 → 就地 input（autoFocus）→ Enter 保存 / Escape 取消 / 失焦保存；与右键"重命名"联动
- **折叠**：树/大纲用折叠箭头（▼/▶），**默认收起子级**（默认打开一级，不刷屏）；点击箭头 toggle 与点击项跳转分离（`e.stopPropagation`）
- **侧边栏拉伸**：拖拽 handle 调宽（min/max clamp），**宽度 localStorage 记忆**（刷新保持）
- **文件上传**：右键菜单 + 隐藏 input（`ref` + `.click()`），文件夹上传用 `webkitdirectory`

---

## 五、布局工程化

### 5.1 视口级布局（页面不整体滚动）

```tsx
// 根容器：高度 = 100dvh − 页面容器垂直 padding（如 main 的 1.75rem×2=56px）
<div style={{ height: "calc(100dvh - 56px)", overflow: "hidden", display: "flex", flexDirection: "column", boxSizing: "border-box" }}>
  <Header />                                    {/* flexShrink: 0 */}
  <Toolbar />                                   {/* flexShrink: 0 */}
  <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "stretch" }}>  {/* 主区 */}
    <aside style={{ overflow: "auto" }} />      {/* 左栏独立滚动 */}
    <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }} />
  </div>
</div>
```
- **`100dvh` 替代 `100vh`**（处理浏览器地址栏/工具栏动态伸缩）
- **height 要精确减去容器 padding**（估算会溢出产生页面滚动条 + 底部截断——"高度不够"根因）
- 每个区域**独立滚动**（overflow auto + minHeight 0），页面自身 overflow hidden

### 5.2 滚动容器

- 长列表（TOC/日志/结果）用 **shadcn ScrollArea**——内部 viewport 自动滚动，天然防 flex 压缩重叠
- **手写 `overflowY: auto` 在 flex column 父容器里会被子项压缩**（flex-shrink:1）→ 文本溢出重叠
  （TOC 文本重叠根因；修复：ScrollArea 或子项 flexShrink: 0 + 非 flex 容器）

---

## 六、React 状态与陷阱

1. **闭包陷阱**：`setTimeout`/异步回调里引用 state 会拿到旧值——**回调显式传参**（`void runCheck(false, list)` 传触发时的 list），不要依赖闭包捕获
2. **受控输入吞中间态**：数字输入 `onChange` 立即回写会吞"1."（小数点）——**半受控**：输入中只更新本地 `text` 原始字符串，blur/步进才 `commit(clamp(parse))`；`inputMode="decimal"`；step 0.01（成本价等小数）
3. **useEffect 时序**：依赖 state 的初始化（如"首次加载后默认收起子文件夹"）用 `useRef` 标记 initialized，只在数据就绪后跑一次
4. **JSX 注释必须 `{/* */}`**——`//` 在 JSX 属性前会语法错
5. **重渲染后 DOM 属性丢失**（标题锚点 id）——运行时直接查询 DOM，不依赖渲染期赋的 id
6. **`createPortal` 渲染到 body** 的弹层：Escape 监听在打开时挂载/关闭时卸载（useEffect 依赖弹层 state）

---

## 七、性能

- **内容缓存**：tab 打开过的文档内容存 `Map<id, content>`，切回不重新请求（useRef 缓存）
- **tab 名截断 + 树叶子数量徽章**避免长内容撑爆布局
- 长文档（数千行）渲染：react-markdown 默认可接受；minimap 类逐行 canvas 需合并相邻同色行（见 plans/reading-minimap.md）
- 搜索即时过滤用 `useMemo`（依赖 items+关键词），不每次重算

---

## 八、前端测试（dev.md §5.1 配套）

- **L2 定向验证**：目标页 `smoke-pages.mjs --page /tools/x`（内容断言）+ playwright 交互实测（点击/滚动/折叠/右键）
- **playwright 交互实测要点**：
  - 用系统 Chrome（`executablePath`，playwright-core 无自带浏览器）
  - `evaluate` 里不能直接传 DOM 节点跨调用（序列化丢失）——**同一 evaluate 内完成"点击+读结果"**
  - 滚动后元素 `scrollIntoViewIfNeeded` 再操作；boundingBox 是实时坐标
  - 右键菜单位置断言：菜单是遮罩子级，`body > div` 只匹配遮罩——用 `querySelectorAll("div")` 找 z95
- **用户反馈≠实测时先自查**：① 验证脚本选择器/等待/状态 ② 用户浏览器 HMR 未生效（硬刷新 Ctrl+F5）③ 窗口尺寸/DPI/缩放差异——不要急着否定用户
- **数据安全**：交互实测的测试数据（建文件夹/传文档）用完必须清理（回收站彻底删除），零残留

---

## 九、文件树 / 资源管理器专项

### 9.1 组件化评估结论（2026-08-16，memo msvp4nao）

- **shadcn 官方 + 277 个社区注册表：无文件树组件**（只有 sidebar 导航/file-input 上传；`@toc-cn` 是 TOC 组件但网络超时）
- Base UI 有 Tree 但是**选择树**（nested checkbox），不支持右键/拖拽/内联重命名/多级图标
- **结论**：文件树保留手写（vscode 资源管理器范式），骨架组件（ScrollArea/按钮/输入）用成熟件

### 9.2 文件树手写最佳实践（文档中心沉淀）

- **默认收起子级**（默认打开一级），根级展开——不刷屏
- **缩进占位对齐**：叶子行要留箭头占位（14px）与文件夹行文本基线对齐
- 每行结构：`[折叠箭头|图标|名称|计数/徽章]`，名称 ellipsis
- 右键菜单（portal）+ 拖拽（DnD）+ 内联重命名（autoFocus input）是文件树标配
- 搜索时树切"搜索结果视图"（覆盖树，vscode 风格）
- 回收站作为树底部特殊条目（软删可恢复）

---

## 十、踩坑集锦（边角经验速查）

| 现象 | 根因 | 解法 |
|---|---|---|
| 按钮/滑块白色透明"看不见" | tailwind `@theme inline` 未映射 CSS 变量 | 补映射（见 shadcn.md）；自检 `getComputedStyle(button).backgroundColor` 应为 `rgb(37,99,235)` |
| 菜单"太远"/贴屏幕边缘 | `Math.min(鼠标, 窗口边缘)` 压边 | 翻转贴近（§2.3） |
| TOC 文本重叠 | flex column 子项 flex-shrink:1 压缩 | ScrollArea 或非 flex 容器 |
| TOC 高亮错位/消失 | 视口绝对坐标（内容区在页面中部） | 内容区相对坐标（§2.4） |
| 内容底部截断/页面滚动 | 根高度估算（`calc(100vh - 20px)` 与容器 padding 不符） | `calc(100dvh - 实际padding)` + overflow hidden |
| 数字输入打不出小数点 | 受控 onChange 吞中间态 | 半受控（§6.2） |
| HMR 改了但页面没变 | vite HMR 偶发未生效 | 硬刷新 Ctrl+F5；服务端改动重启 dev |
| `body > div` 查不到菜单 | 菜单是遮罩子级 | `querySelectorAll("div")` 找 z95 |
| evaluate 传 DOM 节点失效 | playwright 序列化 | 同一 evaluate 内完成操作 |
| 单测清空生产数据 | 测试 finally 写 KV | 备份/恢复模式（dev.md §6.5 数据安全铁律） |
