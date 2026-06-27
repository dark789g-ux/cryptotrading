# KlineChart 工具栏标的代码/名称展示 — 设计 spec

> 日期：2026-06-27　分支：feat/table-column-prefs-generalization（实现时按规范另开分支）

## 一句话目标

在 `KlineChartToolbar.vue` 的 `.kline-toolbar__range` 区域（当前仅有日期范围选择器）的**左侧**新增一段文本，展示当前标的的**代码 + 名称**（如 `000001.SZ 平安银行`），代码用主色、名称用次色；name 缺失时只显示代码。能力做成 `KlineChart` 通用 prop，10 个调用方全部接线。

## 背景与现状摸底（file:line 为证）

`KlineChartToolbar` 被 `KlineChart` 包裹，`KlineChart` 被 10 个面板/弹窗复用。关键事实：

- **`KlineChart` 当前完全不接收标的标识信息**。其 props 仅 `data / currentTs / sliderStart / height / showToolbar / granularity / range / disabledRange / prefsKey / availableSubplots / recalcIndicators`，无任何 code/name 字段 —— `apps/web/src/components/kline/KlineChart.vue:44-69`。
- `KlineChart` 向 toolbar 传 props 的位置 —— `apps/web/src/components/kline/KlineChart.vue:3-16`。
- `KlineChartToolbar` 当前 props：`granularity / range / data / disabledRange / prefs / update / reset` —— `apps/web/src/components/kline/KlineChartToolbar.vue:182-195`。
- `.kline-toolbar__range` 容器（仅含 3 个分支的 `n-date-picker`）—— `apps/web/src/components/kline/KlineChartToolbar.vue:4-34`；其 flex 样式 —— 同文件 `:298-303`。
- 每根 K 线 `KlineChartBar` **不带** ts_code/name，只有 OHLCV + 指标 —— `apps/web/src/api/modules/market/symbols.ts:31-50`。
- 项目**无**统一的 `tsCode+name` 格式化函数，各调用方在 modal 标题各拼各的（grep `formatSymbolLabel` 等全项目无匹配）。
- `KlineChart.vue` 当前 317 行，单文件 ≤500 行约束内有空间。

结论：这是**全局缺失**，需在核心链路（KlineChart + KlineChartToolbar）一次性补 prop，再由各调用方按各自手头的标的信息接线。

## 设计决策

### D1. 双字段 prop：`symbolCode?: string` + `symbolName?: string`

**不**用单个拼好的 `symbolLabel` 字符串。理由：

1. 需求要"代码主色 / 名称次色"分别样式化 —— 只有分开传才能干净渲染两段不同样式。
2. name 缺失要降级（只显代码）—— 降级逻辑集中写在 toolbar 一处，10 个调用方无需各写各的。
3. 各调用方手头本来就是分开的（`row.tsCode` + `row.name`），分开传比拼字符串更直接。

两 prop 默认 `''`。`v-if="symbolCode"` 控制整块显隐：不传 / 传空 → 完全不渲染，旧调用方零影响（向后兼容）。

### D2. 展示位置与排版

文本放 `.kline-toolbar__range` 内、`n-date-picker` **之前**（最左），代码在前、名称在后。

```text
┌──────────────────────────────────────────────┐
│ 000001.SZ 平安银行 │ [2026-01-01 ~ 06-27]  ⚙ │
└──────────────────────────────────────────────┘
  ↑代码(主色)  ↑名称(次色)   日期范围选择器     副图齿轮

name 缺失时（自选股 / 回测弹窗）：
┌──────────────────────────────────────────────┐
│ BTCUSDT │ [2026-01-01 ~ 06-27]             ⚙ │
└──────────────────────────────────────────────┘
```

### D3. 配色复用 toolbar 现有色值（不引新色）

- 代码（主色）= `#d0d4dc`（colors.text.DEFAULT），可加 `font-weight: 500`。
- 名称（次色）= `#848e9c`（colors.text.secondary），`text-overflow: ellipsis` + `max-width` 防过长撑破工具栏。

### D4. 降级 / 边界口径

- **WatchlistTable / 回测弹窗**：手头只有 symbol 字符串、无 name，**不额外去查 name**，直接降级只显代码（YAGNI）。
- **OAMV `ActiveMarketValuePanel`**：基准标的硬编码于面板标题（`930903.CSI 中证A股指数`，`apps/web/src/components/symbols/ActiveMarketValuePanel.vue:6`），接成**两个常量 prop** 显示（与其它入口一致），**非**"无标的不渲染"。
- 选中标的切换（如 A 股详情切 `selectedDetailRow`、自选股切 symbol）由 prop 响应式自然驱动，无需额外逻辑。

## 核心链路改动（2 文件）

```text
调用方 ──:symbol-code / :symbol-name──► KlineChart.vue ──透传──► KlineChartToolbar.vue
                                                                        │
                                              .kline-toolbar__range 内 n-date-picker 之前
                                              <span class="kline-toolbar__symbol" v-if="symbolCode">
                                                <span class="...__code">{{ symbolCode }}</span>
                                                <span class="...__name" v-if="symbolName">{{ symbolName }}</span>
                                              </span>
```

### 文件 1：`apps/web/src/components/kline/KlineChartToolbar.vue`

- `defineProps` 新增 `symbolCode?: string`、`symbolName?: string`，`withDefaults` 各默认 `''`。
- `.kline-toolbar__range` 内、`n-date-picker` 之前插入 `<span class="kline-toolbar__symbol" v-if="symbolCode">`，内含 `__code`（必显）与 `__name`（`v-if="symbolName"`）。
- `<style scoped>` 加 `.kline-toolbar__symbol` / `__code` / `__name` 样式（见 D3）。

### 文件 2：`apps/web/src/components/kline/KlineChart.vue`

- `defineProps` 新增 `symbolCode?: string`、`symbolName?: string`，默认 `''`。
- `<kline-chart-toolbar>` 标签上加 `:symbol-code="props.symbolCode"` `:symbol-name="props.symbolName"` 透传。

## 调用方字段映射（10 个，按文件域分组）

> 字段名以各调用方实际 row 类型 / props 定义为准（实现时逐个 file 核对，禁止凭表推断）。

| 调用方文件 | symbolCode 来源 | symbolName 来源 | 备注 |
|---|---|---|---|
| `symbols/a-shares/AShareDetailPanel.vue` | `row?.tsCode` | `row?.name` | row 可空 |
| `symbols/a-shares-index/ASharesIndexKlineModal.vue` | `row?.tsCode` | `row?.name` | row 可空 |
| `symbols/us-stocks/UsStockDetailPanel.vue` | `row?.ticker` | `row?.name` | 代码字段是 `ticker` |
| `symbols/us-index/UsIndexPanel.vue` | `selectedIndex` | 从 `indexOptions` 反查 label | `.NDX`→`纳斯达克100` |
| `symbols/crypto/CryptoSymbolDetailPanel.vue` | `row.symbol` | `row.name ?? ''` | name 可选 |
| `money-flow/FlowTrendModal.vue` | `tsCode`(prop) | `entityName`(prop) | |
| `strategy/SignalTradeKlineModal.vue` | `trade?.tsCode` | `trade?.name ?? ''` | trade 可空 |
| `watchlist/WatchlistTable.vue` | `selectedSymbol` | —（不传） | 降级只显代码 |
| `backtest/KlineChartModal.vue` | `symbol ?? ''` | —（不传） | 降级只显代码 |
| `symbols/ActiveMarketValuePanel.vue` | `'930903.CSI'`(常量) | `'中证A股指数'`(常量) | 标的硬编码于标题(`:6`)，接成常量 prop |

## 测试

更新 `apps/web/src/components/kline/KlineChartToolbar.spec.ts`（已存在），补 3 个用例：

1. 传 `symbolCode` + `symbolName` → 渲染 `.kline-toolbar__symbol`，含 code 与 name 两段。
2. 只传 `symbolCode` → 渲染 code，**不**渲染 `__name`。
3. 两者都不传（或 `symbolCode=''`）→ `.kline-toolbar__symbol` 整块不渲染。

## 验证标准

- `pnpm --filter @cryptotrading/web type-check` 绿。
- `pnpm --filter @cryptotrading/web build`（vite，SFC 编译，type-check 查不出模板/宏编译错，必跑）绿。
- `pnpm --filter @cryptotrading/web test`（vitest）KlineChartToolbar 相关用例绿。
- 真机 / 浏览器 e2e 抽验：A 股个股详情、A 股指数 K 线弹窗、自选股（验证降级只显代码）至少 3 个入口，确认文本出现在日期选择器左侧、代码主色名称次色、切换标的文本随动。

## 任务拆分（subagent-driven-development 编排）

按"互不相交的文件域"切分，避免并行覆盖：

```text
T1 核心链路（串行前置，其余全依赖它）
   └─ KlineChartToolbar.vue + KlineChart.vue + KlineChartToolbar.spec.ts
        │
        ├─► T2 A 股域（并行）
        │     AShareDetailPanel / ASharesIndexKlineModal / WatchlistTable
        │     / FlowTrendModal / SignalTradeKlineModal / ActiveMarketValuePanel
        ├─► T3 美股·Crypto 域（并行）
        │     UsStockDetailPanel / UsIndexPanel / CryptoSymbolDetailPanel
        └─► T4 回测域（并行）
              backtest/KlineChartModal
                   │
                   ▼
              T5 集成验证（串行收尾）
              type-check + vite build + vitest + 浏览器 e2e 抽验
```

- **T1**：subagent_type=general-purpose。核心 2 文件 + 单测；产出可被 T2/T3/T4 依赖的 `symbol-code`/`symbol-name` prop 契约。
- **T2 / T3 / T4**：subagent_type=general-purpose，三组文件域互不相交，可并行。每组 subagent 先逐 file 核对各 row/props 真实字段名（见映射表「备注」），再接线。
- **T5**：subagent_type=general-purpose（或主线程亲自）。门禁命令 + 浏览器 e2e 派 browser-tester。

## 硬约束 / 项目规范对齐

- 单文件 ≤500 行：KlineChart 317 行、Toolbar 372 行，加 prop 后仍远低于上限。
- `.vue` 改动合并前必跑 `vite build`（type-check 不等于 SFC 编译）。
- 修改 import 块后立即回读文件头部验证顺序。
- prop 默认值用内联字面量（`''`），不引用 `<script setup>` 局部变量。
- 向后兼容：不传新 prop 的旧路径零行为变化（`v-if="symbolCode"` 兜底）。
