---
name: frontend-dev-lessons
description: cryptotrading 项目专用前端开发技能。用户提及前端开发相关问题时使用。
---

# Frontend Dev Lessons

## 适用范围

在 `apps/web` 做任何前端修改时，先读取本技能。项目技术栈是 Vue 3 + TypeScript + Vite + Naive UI + Vue Router，样式体系以 `apps/web/src/styles/design-system.css` 和 `apps/web/src/styles/tokens` 为准。

修改前先看相邻实现，优先沿用既有 component、composable、API client、Naive UI 组件和设计系统。单文件接近 500 行时先拆分职责，避免继续堆逻辑。

## 工作流

1. 先定位既有实现和边界：
   - Page/panel components 负责 workflow state 和 API triggers。
   - Feature components 负责本地 UI composition。
   - Shared components 只抽象稳定交互模式，不抽象业务专属数据请求。
   - Remote tables 必须保持 filtering、sorting、pagination 与后端一致。
2. 设计 UI 时参考 `.prompts/misc/DESIGN-binance.md`；K 线相关参考 `apps/web/src/components/backtest/KlineChartModal.vue` 和 `apps/web/src/components/kline/KlineChart.vue`，不要从零重建。
3. 大改后运行前端类型自检：

```powershell
cd apps/web; pnpm exec vue-tsc --noEmit
```

项目已有 filter 命令时也可以运行：

```powershell
corepack pnpm --filter @cryptotrading/web type-check
```

PowerShell 中不要使用 `&&`。除非用户明确要求，不要启动 Vite preview。

## TypeScript 与数据安全

- 禁用 `any`，用 `unknown` 加类型收窄。
- 禁用 `arr[i] || {}` 后再读属性；这会让缺失数据变成空对象并掩盖类型/运行时问题。
- 对象键名使用英文，避免 Windows GBK 终端下中文裸键名解析错误。
- 涉及文件 I/O 时显式指定 `encoding='utf-8'`。
- HTML 模板必须包含 `<meta charset="UTF-8">`。

## UI 与样式

- 优先使用 Naive UI 组件，不要自建已有组件能力。
- `.vue`、`.ts`、`.css` 中不要手写 `#xxxxxx` 或 `rgba(...)` 颜色值；必须从 `apps/web/src/styles/tokens` 或设计系统中引用。
- tokens 中找不到需要的颜色或样式时，先向用户确认，不能擅自新增。
- 样式统一走 `apps/web/src/styles/design-system.css`。
- 不要设计导出 CSV 的功能。

## Naive UI Modal

`n-modal` 可能 teleport，scoped CSS 未必能约束真实 card。需要控制 card 尺寸时，优先在 `n-modal` 上直接绑定 `style`：

```vue
<n-modal
  v-model:show="showModal"
  preset="card"
  :style="{ width: 'min(480px, calc(100vw - 32px))' }"
/>
```

Condition/filter modals 的默认经验：

- 使用偏任务型宽度，约 `480px`。
- 移动端使用 `calc(100vw - 32px)`。
- field selection 独占一行。
- operator 和 value 放在下一行。
- add button 右对齐。
- condition lists 使用 `max-height` 和 `overflow-y: auto`。
- empty states 保持紧凑。

## Naive UI 类型

不要猜 Naive UI 是否导出某个类型。需要 `NSelect` option typing 时，检查 `apps/web/node_modules/naive-ui` 下的本地声明，或者使用本地联合类型。

Grouped options 形如：

```ts
{
  type: 'group',
  label: 'Group label',
  key: 'stable-key',
  children: [{ label: 'Field', value: 'field' }],
}
```

## Filter 抽象边界

多个 panels 都需要 numeric conditions 时，通常只抽取 condition editor：

```ts
interface NumericCondition {
  field: string
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
  value: number
}
```

Shared component 可以负责打开/关闭 Modal、编辑单个 condition、添加/删除/清空 conditions、展示 active count。

Parent feature component 仍负责 search text、market/industry selectors、interval selectors、field options、labels、API request timing、reset/apply semantics。除非两个页面拥有几乎相同的业务字段，否则不要抽取完整 business filter bar。

## Remote Table Filtering

表格的分页、表头排序、筛选都走后端；筛选与排序必须基于全量数据，不能只处理当前页。表头排序使用 `n-data-table` 内置能力，但请求和排序结果由后端负责。

添加 advanced filters 时：

- 添加 frontend condition state。
- 将条件包含在 API query body 中。
- 在现有 reset action 中重置它。
- 扩展 backend field whitelists 和 SQL mappings。
- SQL field mapping 必须显式，绝不要把任意 frontend field names 拼接进 SQL。

对于 A-share technical filters，latest-row list filtering 应 join 最新的 quote/metric/indicator rows，并通过 `CONDITION_COL_MAP` 这类 whitelist 映射每个允许字段。

## Data Table 规范

- 默认不要用行点击；交互放在 `操作` 列。
- 表格默认带分页器，选项为 `[10, 20, 50]`，默认 `10`。
- 表格单元格的条件样式应贴近列 `render` 实现：如果颜色、文本状态、徽标等由当前单元格值决定，优先在列定义里计算并绑定到 render 输出，避免依赖父组件 `scoped`/`:deep()` 样式去覆盖 `n-data-table` 内部 DOM。
- 条件颜色必须使用现有 TS token（如 `colors.success.DEFAULT` / `colors.error.DEFAULT`）或 CSS token，不要手写颜色值；保留语义 class 可以用于复用，但关键视觉结果不要只依赖跨组件 CSS 覆盖。
- 修改表格条件展示前先搜索相邻页面是否已有同类模式，例如收益率、涨跌幅、状态列等；优先复用已验证的 render + token 写法。
- 远程模式下，未点表头时列 `sortOrder` 恒为 `false`，避免默认排序假高亮；请求仍可带默认 `sortBy`/`sortOrder`。
- 使用 `explicitSort` 区分默认排序和用户点击。用户点击了与默认同列同向的排序，也应视为显式并高亮。
- 清除排序或重置筛选后回到默认排序，且 `explicitSort=false`；仅修改筛选不应改变 `explicitSort`。
- `runId` 缓存如果保存表格状态，必须包含 `explicitSort`。

## n-data-table remote 分页

`n-data-table remote` 不会接管数据或分页状态，调用方必须完整控制：

1. 同时绑定 `@update:page` 和 `@update:page-size`，在回调中更新 `page`、`pageSize` 并重新加载。
2. `pagination` computed 必须包含 `itemCount: total.value`。
3. `:data` 必须是后端分页后的当前页数据；remote 模式不会自动 slice。
4. 后端接口必须接收 `page`/`pageSize` 或 `skip`/`take`，并返回 `{ rows, total, page, pageSize }`。
5. 新增分页表格前，参考 `SymbolsView.vue`、`BacktestDetail.vue`、`candle-log.controller.ts`、`symbols.service.ts`。

## ECharts Custom Series

Custom series 的 `data` 不能包含 `null` 项。ECharts 仍会对 `null` 调用 `renderItem`，`api.value(n)` 可能返回 `0`，导致 y=0 幽灵柱并破坏 yAxis 自动量程。

正确做法：

- 使用 `flatMap()` 过滤无效项，只保留有效数据。
- 将原始数组索引 `idx` 存入 data 第 `0` 维。
- `renderItem` 中用 `api.value(0)` 取原始 x 坐标。
- 过滤后不要依赖 `params.dataIndex`，它是过滤后数组的局部索引。
- 值域差异明显的系列不要共享同一 yAxis；按值域绑定独立 yAxis，可在同一 grid 中用 `position: 'right'` 叠加。

## ECharts Kline 修改

新增或重排 Kline chart panes 时，必须同步更新所有耦合结构：

- `grid`
- `xAxis`
- `yAxis`
- 每个 series 的 `xAxisIndex` / `yAxisIndex`
- `dataZoom.xAxisIndex`
- `axisPointer.link`
- legend positions
- graphic overlay positions
- tooltip content

K 线图或副图修改优先参考现有实现，不要从零设计。

## Cleanup Rule

删除可见 UI modules 时，移除完整 usage chain：

- Template usage。
- Component imports。
- Composable destructuring。
- 不再使用的 computed values、refs、types 和 helper functions。

最后运行前端 type-check，捕获遗漏的 template/script references。
