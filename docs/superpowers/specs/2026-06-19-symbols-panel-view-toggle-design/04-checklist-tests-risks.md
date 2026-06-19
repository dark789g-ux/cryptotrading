# 改造清单、测试策略与风险

## 9. 改造清单

### 9.1 新增文件

| 文件 | 说明 |
|------|------|
| `components/symbols/SymbolsPanelLayout.vue` | 通用面板外壳 |
| `components/symbols/ResizableSplitPane.vue` | 可拖拽分栏 |
| `components/symbols/a-shares/AShareDetailPanel.vue` | A 股详情内容面板 |
| `components/symbols/us-stocks/UsStockDetailPanel.vue` | 美股详情内容面板 |
| `components/symbols/crypto/CryptoSymbolsFilters.vue` | Crypto 过滤器 |
| `components/symbols/crypto/CryptoSymbolDetailDrawer.vue` | Crypto 详情抽屉外壳 |
| `components/symbols/crypto/CryptoSymbolDetailPanel.vue` | Crypto 详情内容面板 |
| `components/symbols/crypto/useCryptoSymbolsQuery.ts` | Crypto query composable |

### 9.2 修改文件

| 文件 | 修改内容 |
|------|----------|
| `components/symbols/ASharesPanel.vue` | 接入 SymbolsPanelLayout；删除 title；按钮居左；提供精简列定义与详情面板 slot |
| `components/symbols/UsStocksPanel.vue` | 同上；header 保留同步/标的管理按钮 |
| `components/symbols/CryptoSymbolsPanel.vue` | 同上；抽出 filters 与 detail drawer；接入 useCryptoSymbolsQuery |
| `components/symbols/a-shares/AShareDetailDrawer.vue` | 内部复用 AShareDetailPanel |
| `components/symbols/us-stocks/UsStockDetailDrawer.vue` | 内部复用 UsStockDetailPanel |
| `components/symbols/CryptoSymbolsPanel.spec.ts` | 更新对 `CryptoSymbolsFilters`、`CryptoSymbolDetailDrawer`、`useCryptoSymbolsQuery` 的引用与 mock |

### 9.3 分阶段实施（可选）

为降低单次 PR 体量，可按以下顺序分阶段合并：

| 阶段 | 内容 | 验收标准 |
|------|------|----------|
| Phase 1 | 新增通用组件（`SymbolsPanelLayout`、`ResizableSplitPane`）+ A 股面板改造 + A 股详情面板抽出 | A 股面板两种形态可切换、拖拽分栏、详情展示正常，单测通过 |
| Phase 2 | 美股面板接入通用布局 + 美股详情面板抽出 | 美股面板两种形态可切换、同步/标的管理按钮位置正确，单测通过 |
| Phase 3 | Crypto 过滤器/详情抽屉/query 抽出 + Crypto 面板接入通用布局 | Crypto 面板两种形态可切换、interval 选择器工作正常，单测通过 |

## 10. 测试策略

| 目标 | 测试内容 |
|------|----------|
| `ResizableSplitPane.vue` | 新增单测：拖拽时宽度变化、min/max 约束、pointer 事件绑定、窄屏堆叠退化 |
| `SymbolsPanelLayout.vue` | 新增单测：viewMode 切换、localStorage 读写、slot 渲染、按钮 emit |
| `AShareDetailPanel.vue` | 新增/更新单测：row 变化触发重拉、priceMode 变化触发重拉、AMV 标注渲染 |
| `UsStockDetailPanel.vue` | 新增单测：row 变化触发重拉、priceMode 变化触发重拉 |
| `CryptoSymbolDetailPanel.vue` | 新增单测：row/interval 变化触发重拉 |
| `CryptoSymbolsFilters.vue` | 新增单测：props/emits 与 A 股/美股 filters 组件风格对齐（searchQuery、selectedWatchlistIds、selectedStrategyIds、conditions 等字段的 v-model 与 apply/reset 事件） |
| `ASharesPanel.vue` / `UsStocksPanel.vue` / `CryptoSymbolsPanel.vue` | 更新单测：验证 split 模式下精简表格只渲染 3 列、行点击更新 selectedDetailRow、不再打开 drawer |
| 真机 / E2E | 验证拖拽流畅、ECharts resize 正确、localStorage 持久化生效 |

## 11. 风险与回滚

| 风险 | 缓解措施 |
|------|----------|
| ECharts 在拖拽时未正确 resize | `ResizableSplitPane` 在 divider 拖拽期间通过 ResizeObserver 或容器尺寸变化通知子组件；`KlineChart` 只负责监听自身容器 resize 并调用 `chart.resize()` |
| NDataTable 在 flex 子项中撑破布局 | 左侧容器设置 `min-width: 0` 与 `overflow: hidden`；右侧容器同样设置 `min-width: 0` |
| Crypto 抽出组件引入回归 | 保持现有 `CryptoSymbolsPanel.spec.ts` 中 `recalcKdjIndicators` 等核心逻辑不变，仅调整组件引用；新增独立单测覆盖抽出组件 |
| localStorage 非法值 | 读取后校验 `viewMode` 必须为 `table`/`split`，`leftWidth` 必须在 [0.2, 0.6] 之间，否则回默认值 |
| 三个面板同时改造增加单次 PR 体量 | 可分阶段提交：第一阶段 A 股 + 通用组件，第二阶段美股，第三阶段 Crypto |
