# 阅读器 Minimap 设计（暂缓规划，2026-08-16 束之高阁）

> 状态：**暂缓（束之高阁）**——用户 2026-08-16 要求移除 minimap，设计保留备查。
> 后续若重新启用，按本文档实现，并注意已踩过的坑。

## 背景

文档中心 vscode 风格阅读器曾实现右侧 minimap（v2，参考 vscode），用户反馈
"右侧的 minimap 不是目录，请参考 vscode minimap"，实现 v3（canvas 内容缩略图）后
用户仍决定**移除**（体验与收益不匹配，优先保证目录稳定性）。

## v3 实现方案（已实现过，代码可参考 git 历史 1111ee1 前的 MarkdownView.tsx）

- **canvas 内容缩略**：md 源码逐行映射色块（标题蓝 #3b82f6 / 代码深 #0f172a / 引用浅蓝
  #bfdbfe / 表格灰 #94a3b8 / 列表浅灰 #cbd5e1 / 正文 #e2e8f0），行 y = i/总行数 × 高度
- **视口指示块**：内容滚动比例 → 蓝色半透明块（top % + 高度 ~12%）
- **点击/拖动跳转**：mmJump 按 clientY 比例设置 scrollTop

## 踩坑记录（重新启用时必读）

1. **canvas 尺寸**：必须在布局完成后绘制（`scrollRef.current.clientHeight`），依赖
   `props.children` 变化触发；HMR 或字体加载后需重绘（KaTeX 延迟渲染会改变行高，但
   minimap 用源码行色条不受影响）
2. **视口指示块不能 pointer-events**（否则挡住 canvas 点击）
3. **minimap 不是目录**：用户明确区分"标题列表"（= TOC 的职责）与"内容缩略图"（= minimap），
   两者不要混用
4. **性能**：长文档（数千行）逐行 fillRect 可接受；更优做法是合并相邻同色行为一条

## 为什么暂缓

- 目录（TOC）本身曾出现严重高亮 bug（视口绝对坐标 vs 内容区相对坐标，见 dev.md §5.4），
  优先保证目录稳定
- minimap 对个人工具集的边际价值低于其实现/维护成本
- 如需"快速定位"，TOC 点击跳转已满足；minimap 属于锦上添花
