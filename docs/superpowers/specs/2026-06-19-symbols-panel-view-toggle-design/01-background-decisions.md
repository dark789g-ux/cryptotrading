# 背景、范围与关键决策

## 1. 背景与目标

`ASharesPanel.vue` 当前采用「标题 + Refresh/Columns 按钮 + 过滤器 + 数据表格 + 右侧抽屉详情」的交互。用户希望在 A 股面板中：

1. 删除 "A 股数据" 标题。
2. Refresh、Columns 按钮居左排布。
3. 在 Columns 右侧新增视图切换按钮，支持两种内容形态：
   - 形态一（table）：保持现有的 `a-shares-filters + n-card` 表格视图。
   - 形态二（split）：上方保留筛选栏，下方左右分栏；左侧显示股票名称/代码/现价的精简列表，右侧显示对应股票详情（参考 `a-share-detail-drawer`），中间可通过鼠标拖拽调整分栏宽度。

经讨论，本设计将同一套交互模式推广到 **A 股、Crypto、美股** 三个 Symbols Panel，以保持一致的用户体验。

## 2. 范围

### 2.1 纳入范围

- `ASharesPanel.vue`、`UsStocksPanel.vue`、`CryptoSymbolsPanel.vue` 的 header 改造（删除 title、按钮居左、新增视图切换）。
- 三种面板均支持 `table` / `split` 两种视图形态。
- 新增通用 `SymbolsPanelLayout.vue` 与 `ResizableSplitPane.vue`。
- 抽出/新增各市场的详情 `***DetailPanel.vue`，使抽屉组件复用详情面板内容。
- Crypto 面板：将内联过滤器与内联详情 drawer 抽出为独立组件，补齐与 A 股/美股的结构同构。
- 视图模式与分栏宽度的 localStorage 持久化。
- 响应式适配与单测更新。

### 2.2 不纳入范围

- 列设置抽屉 `ColumnSettingsDrawer.vue` 的交互与 UI 不变，仅继续被三个面板共用。
- 不改动后端接口与数据库 schema。
- 不新增第三方拖拽库，分栏拖拽自行实现。

## 3. 关键决策（已确认）

| 问题 | 决策 |
|------|------|
| 视图模式持久化 | 是，按 scope（`crypto` / `aShares` / `usStocks`）存 localStorage，默认 `table` |
| 形态一下行点击 | 不再打开详情 drawer，详情只在形态二右侧面板查看 |
| 形态二左侧列表 | 复用 `NDataTable`，只渲染名称/代码/现价 3 列，保留远程分页与排序 |
| 分栏宽度持久化 | 是，默认 40%，最小 240px，最大 60% |
| 右侧空态 | 显示占位提示「点击左侧股票查看详情」 |
| 三个面板 title | 全部删除，保持一致 |
| 响应式窄屏 | split 模式退化为上下堆叠，隐藏拖拽分隔线 |
