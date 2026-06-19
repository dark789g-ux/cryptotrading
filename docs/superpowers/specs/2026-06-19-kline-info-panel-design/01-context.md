# 01 · 背景与现状

## 1.1 背景与目标

在标的详情面板（K 线图视图）中，目前只有 K 线图本身。用户在查看某只标的 K 线时，无法在同一屏看到该标的的基本面 / 分类 / 行情类属性信息，需要切到列表列或 Drawer 头部才能看到。

**目标**：在 K 线图右侧增加一个可折叠 / 展开的竖向信息侧栏，展示与当前选中标的相关的属性信息。折叠后侧栏完全隐藏，仅在 K 线工具栏留一个触发按钮，使 K 线获得最大可视化空间。

**覆盖范围**：A 股、美股、加密三种标的的详情面板均增加信息侧栏。字段按标的类型差异化（A 股含估值/市值基本面；美股/加密退化为行情字段）。

## 1.2 详情面板组件结构

三种标的各有独立的详情面板组件，结构同构但略有差异：

- A 股：`apps/web/src/components/symbols/a-shares/AShareDetailPanel.vue`
  - 嵌套：`.a-share-detail-panel > .detail-content > .chart-panel > .chart-with-caption > <kline-chart>`
  - 唯一非图元素：底部 AMV 合规文案（`.amv-caption`，`AShareDetailPanel.vue:23-25`）
- 美股：`apps/web/src/components/symbols/us-stocks/UsStockDetailPanel.vue`（无 caption 层，直接 `.chart-panel`）
- 加密：`apps/web/src/components/symbols/crypto/CryptoSymbolDetailPanel.vue`（无 caption、无 `.chart-panel`，根元素直接包 `<kline-chart>`）

三个详情面板均接收 `row` prop（列表行快照），由 `ASharesPanel` / `UsStocksPanel` / `CryptoSymbolsPanel` 在列表行点击时设置。

## 1.3 K 线图组件

`apps/web/src/components/kline/KlineChart.vue`：

- 根元素 class `kline-chart-wrapper`（`KlineChart.vue:2`），内部为 toolbar + `.kline-chart` 纵向 flex
- toolbar 由子组件 `KlineChartToolbar.vue` 渲染（`KlineChart.vue:3-14` 引用）；toolbar 右侧动作区 `.kline-toolbar__actions`（`KlineChartToolbar.vue:37`，现承载"副图设置"齿轮按钮 `:40`）
- **触发按钮注入需改两个文件**：`KlineChartToolbar.vue`（新增 `actions` 具名插槽、在 `.kline-toolbar__actions` 渲染该插槽）+ `KlineChart.vue`（透传 `actions` 插槽给 `KlineChartToolbar`）
- `wrapperStyle`（`KlineChart.vue:89-90`）`width:'100%'`，水平占满父级

## 1.4 数据来源

**面板字段主要来自列表行 `row` 快照**：

| 标的 | row 类型 | 来源接口 | 类型定义 | 字段就绪度 |
|---|---|---|---|---|
| A 股 | `AShareRow` | `/a-shares/query` | `apps/web/src/api/modules/market/aShares.ts:18-49` | ✅ 现成 |
| 美股 | `UsStockRow` | `/us-stocks/query` | `apps/web/src/api/modules/market/usStocks.ts:17-37` | ✅ 现成 |
| 加密 | `SymbolRow` | `/symbols/query` | `apps/web/src/api/modules/market/symbols.ts:94-98` | ⚠️ **需后端补 SELECT** |

后端 daily_basic 实体（`apps/server/src/entities/raw/daily-basic.entity.ts:5-40`）已有：`turnover_rate`（%）、`volume_ratio`、`pe`、`pe_ttm`、`pb`（倍）、`total_mv`、`circ_mv`（万元）。已透出在 `/a-shares/query` 行（`a-shares-query.sql.ts:150-156`）。

**加密字段缺口（重要）**：后端 `symbols.service.ts` 的 `querySymbols` SQL（`:105-125`）当前只 `SELECT symbol, close, ma5, ma30, ma60, kdjJ, riskRewardRatio, stopLossPct, openTime, tags`，**未 SELECT `pct_chg`、`volume`、`amount`**。`SymbolRow` 类型也仅有 `symbol`/`name?`/`tags?` + 索引签名。因此加密面板的 pctChg/volume/amount **需后端补 SELECT 三列 + 前端 `SymbolRow` 类型补字段**（见 `./05-implementation.md` §5.2）。

## 1.5 现有格式化函数（主力，可直接复用）

`apps/web/src/components/symbols/a-shares/aSharesFormatters.ts`：

| 函数 | 行号 | 用途 |
|---|---|---|
| `formatNumber(value, digits)` | :1 | 定小数位，null → `'-'`。PE/PB 用 |
| `formatPercent(value)` | :7 | `${toFixed(2)}%`，null → `'-'`。换手率/涨跌幅用 |
| `formatAmount(value)` | :13 | 成交额（千元入）→ 亿/万缩写 |
| `formatMarketCap(value)` | :26 | 市值（**万元入**）→ 亿/万亿缩写 |
| `trendClass(value)` | :40 | 返回 `trend-up`/`trend-down`/`''`，驱动 CSS 涨跌着色 |

K 线 tooltip 通用大数缩写：`fmtCompact(value, digits=2)`（`apps/web/src/composables/kline/klineChartUtils.ts:12`），≥1e8 显示"亿"、≥1e4 显示"万"，不预设量纲。

**空值约定**：数值类字段 null 统一返回 `'-'`（半角连字符），与项目现有 formatter 一致。软字段（标签/评分）才用 `'—'`（em dash），本设计不涉及。

**涨跌着色**：`.trend-up` 绿涨 `#0ECB81` / `.trend-down` 红跌 `#F6465D`（`apps/web/src/styles/design-system.css:387-393`，CSS 变量 `--binance-green`/`--binance-red`）。

## 1.6 已用 UI 模式

- `n-collapse`：`ActiveMarketValuePanel.vue`、`ColumnSettingsDrawer.vue`
- `n-drawer`：三个详情面板的 Drawer 变体
- localStorage 持久化分栏比例：`ResizableSplitPane`（key 形如 `symbols_panel_split_width_{scope}`）

## 1.7 缺口

- K 线右侧**无任何侧栏位置**：`.chart-panel`（`AShareDetailPanel.vue:193-200`）`flex:1; height:100%`，水平占满 split-right
- `volume_ratio`（量比）**无现成 formatter**，也未在任何列展示（但类型有此字段，筛选器有此选项）
- 成交量 `volume` 的 A 股展示也缺 formatter（美股有局部 `formatVolume` `usStocksColumns.ts:40`，加密有局部 `formatFixed` `apps/web/src/components/symbols/cryptoColumns.ts:12`）
- 加密 `symbols/query` SQL 缺 `pct_chg`/`volume`/`amount` 三列（见 §1.4）

## 1.8 方案选择

提出过三个方案：

- **A. 抽取共享 `KlineWithInfoPanel` 包装组件（采用）**：把"K 线 + 右侧可折叠侧栏 + 触发按钮 + 持久化 + 响应式守卫"封装为共享布局组件，三种详情面板用它包裹各自的 `<kline-chart>`；字段内容由插槽按类型注入。侧栏交互逻辑只写一次，字段渲染按类型独立，符合现有"三套详情面板各自独立"结构。
- B. 三详情面板各自内联实现侧栏 —— 三份重复代码，违反 DRY。
- C. 改造 `ResizableSplitPane` 支持第三栏 —— 现有两栏硬编码（`ResizableSplitPane.vue:7-17`），改三栏影响所有使用者，杀鸡用牛刀。

**决策：方案 A。** 侧栏交互逻辑三种标的完全相同，抽象成共享组件最省事；字段按类型差异化适合插槽注入，不强行统一三种标的的数据结构。
