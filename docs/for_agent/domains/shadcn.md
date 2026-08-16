# shadcn/ui 领域文档（Base UI 版）

> 本文件记录本仓库 shadcn/ui 的使用、底层选型与踩坑经验。涉足前端组件/页面 UI 时**按需加载**。
> 主文档：`docs/for_agent/dev.md` §5.4。

## 1. 底层选型：Base UI（2026-08-10 切换）

- **当前底层：Base UI**（`@base-ui/react`，MUI 团队维护的无头组件库，Radix 的精神续作）。
  shadcn 官网声明：**2026 年 7 月起新项目默认 Base UI**（`init -b base`），Radix 依然支持且不弃用。
- **切换方式**（本项目实操）：底层选择在 `components.json` 的 **`style` 字段**（不是 `base` 字段）：
  `"style": "new-york"`（Radix）→ `"style": "base-nova"`（Base UI）。
  切换后 `npx shadcn@latest add <组件> --overwrite --yes` 重新生成组件（覆盖 `src/components/ui/`）。
- **依赖**：`@base-ui/react`（按需安装 `pnpm add @base-ui/react --filter @toolbox/web`）；
  `radix-ui` 已移除（-71 包）。`components.json` 的 `base` 字段是**无效**的（schema 无此字段）。
- **回退**：改回 `"style": "new-york"` + 重新 add 即可（官方支持双库共存，但本项目已全量切 Base UI，不要混用）。

## 2. Base UI 与 Radix 的 API 差异（踩坑记录）

| 差异点 | Radix（旧） | Base UI（新） | 本项目适配 |
|---|---|---|---|
| 受控 value | Select/Slider value 数组 | **Slider 支持单值 `value={number}`** | `value={[x]}` → `value={x}`；`onValueChange` 的 v 可能是 `number \| readonly number[]`，用 helper：`sliderNum(v) = typeof v==="number" ? v : v[0]` |
| 可选值空 | Select value 禁空串 | **Select value 可为 `null`** | `onValueChange={(v) => ...}` 的 v 类型 `string \| null` → `v ?? ""` |
| placeholder | 接受 null | **不接受 null**（TS 报 `string\|null`→`string\|undefined`） | 传 `placeholder ?? undefined` 或 `placeholder \|\| undefined` |
| data 属性 | `data-[state=...]`（冒号） | `data-horizontal` / `data-disabled`（连字符） | 自定义 CSS 选择器注意；Tailwind 类 `data-*:` 前缀不同 |
| **Select.Value 显示**（全局隐患 2026-08-16） | 渲染选项文本 | **渲染 value 本身（id），不自动找选项文本** | 显式映射：`<SelectValue>{opts.find(o=>o.value===v)?.label}</SelectValue>`（受控时）或包装层映射；trade-v2 已修 6 处，**其他页面（todo-v3/docs/知识库等）待全局排查** |
| asChild | Radix 的 `asChild` | **Base UI 用 `render` prop** | shadcn 模板已封装，业务代码无感（不要直接改模板） |

- **主题映射**（index.css `@theme inline`）对 Base UI 同样生效（`bg-primary` 等类正常解析，已采样确认）。
- **自定义易被覆盖**：`shadcn add --overwrite` 会重置组件模板——`slider` 轨道 `bg-muted`（太浅）、
  `button` outline `border-border`（对比度低）等自定义需在 add 后重做（本项目已恢复 `bg-slate-200/90` / `border-slate-300`）。

## 3. 使用规则（本项目）

1. **新组件优先 Base UI 版**：`npx shadcn@latest add <组件>`（components.json 已配 base-nova）自动拉 Base UI 版；
   不要手动改 `components.json` 的 `base` 字段（无效）。
2. **Slider 一律单值**：`value={number}` + `sliderNum(v)` 取数（不要用 `v[0]` 直接下标）。
3. **Select 处理 null**：`onValueChange={(v) => ... v ?? ""}`。
4. **模板自定义集中**：对 `ui/*.tsx` 的覆盖式自定义（轨道色/边框对比度/阴影）写注释标记「自定义，add 后需重做」，
   避免下次 `--overwrite` 后丢失。
5. **UI 验收**：页面改动过 `smoke-pages.mjs --page <目标页>`；组件库/主题层改动必须全量冒烟（L3）。
6. **主题对齐**（index.css）：变量用完整色值（hex）+ `@theme inline` 全量映射（tailwind v4 的 `bg-primary` 依赖它，
   缺映射会按钮全透明——详见 dev.md §5.4）。
