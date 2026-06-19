# 总体架构与组件设计

## 4. 总体架构

新增/改造文件清单：

```text
apps/web/src/components/symbols/
├── SymbolsPanelLayout.vue              # 新增：通用外壳
├── ResizableSplitPane.vue              # 新增：可拖拽左右分栏
├── ColumnSettingsDrawer.vue            # 已存在，继续共用
├── CryptoSymbolsPanel.vue              # 改造
├── UsStocksPanel.vue                   # 改造
├── ASharesPanel.vue                    # 改造
├── a-shares/
│   ├── ASharesFilters.vue              # 已存在，基本不变
│   ├── AShareDetailDrawer.vue          # 改造：复用 AShareDetailPanel
│   └── AShareDetailPanel.vue           # 新增
├── us-stocks/
│   ├── UsStocksFilters.vue             # 已存在，基本不变
│   ├── UsStockDetailDrawer.vue         # 改造：复用 UsStockDetailPanel
│   └── UsStockDetailPanel.vue          # 新增
└── crypto/
    ├── CryptoSymbolsFilters.vue        # 新增
    ├── CryptoSymbolDetailDrawer.vue    # 新增
    ├── CryptoSymbolDetailPanel.vue     # 新增
    └── useCryptoSymbolsQuery.ts        # 新增（推荐）
```

架构分层：

```text
┌─────────────────────────────────────────────┐
│  SymbolsPanelLayout.vue                     │
│  - header 布局 + 视图切换按钮               │
│  - viewMode / splitWidth 持久化             │
│  - 根据 viewMode 渲染 table 或 split        │
├─────────────────────────────────────────────┤
│  具体面板（ASharesPanel / UsStocksPanel /   │
│  CryptoSymbolsPanel）                       │
│  - 提供 filters slot                        │
│  - 提供 table slot（完整表格）              │
│  - 提供 split-left slot（精简表格）         │
│  - 提供 split-right slot（详情面板）        │
│  - 管理 query / pagination / selected row   │
├─────────────────────────────────────────────┤
│  ***DetailPanel.vue                         │
│  - 拉取详情数据 + 渲染 KlineChart           │
│  - A 股额外处理资金流 + AMV                 │
├─────────────────────────────────────────────┤
│  ResizableSplitPane.vue                     │
│  - 纯 UI：左右分栏 + 拖拽分隔线             │
└─────────────────────────────────────────────┘
```

## 5. 组件设计

### 5.1 `SymbolsPanelLayout.vue`

职责：仅负责外壳布局、视图切换、状态持久化、两种形态的容器渲染。不感知具体市场业务。

Props：

| Prop | 类型 | 必填 | 说明 |
|------|------|------|------|
| `scope` | `'crypto' \| 'aShares' \| 'usStocks'` | 是 | localStorage key 命名空间 |
| `loading` | `boolean` | 否 | 控制 Refresh 按钮 loading |
| `showColumnSettings` | `boolean` | 否 | 列设置弹窗显隐；支持 `v-model:showColumnSettings` |
| `viewMode` | `'table' \| 'split'` | 否 | 当前视图模式；支持 `v-model:viewMode`；默认从 localStorage 读取，失败回退 `table` |
| `leftWidth` | `number` | 否 | 分栏左侧宽度比例（0~1）；支持 `v-model:leftWidth`；默认从 localStorage 读取，失败回退 `0.4` |

Emits：

| Emit | 说明 |
|------|------|
| `update:showColumnSettings` | 列设置弹窗显隐变化 |
| `update:viewMode` | 视图模式变化 |
| `update:leftWidth` | 分栏宽度变化 |
| `refresh` | 点击 Refresh 按钮 |

Slots：

| Slot | 说明 |
|------|------|
| `header-actions` | header 最右侧的额外操作按钮（如美股的同步/标的管理、Crypto 的 interval 选择器） |
| `filters` | 筛选器区域 |
| `table` | 形态一下的完整表格 |
| `split-left` | 形态二左侧的精简表格 |
| `split-right` | 形态二右侧的详情面板 |
| `empty-detail` | 形态二右侧未选中股票时的占位 |

localStorage key：

- 视图模式：`symbols_panel_view_mode_<scope>`
- 分栏宽度：`symbols_panel_split_width_<scope>`

### 5.2 `ResizableSplitPane.vue`

职责：纯 UI 组件，负责左右分栏与拖拽调整宽度。

Props：

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `leftWidth` | `number` | `0.4` | 左侧面板宽度占容器比例（0~1） |
| `minWidthPx` | `number` | `240` | 左侧面板最小像素宽度 |
| `maxRatio` | `number` | `0.6` | 左侧面板最大宽度占容器比例（0~1） |

Emits：`update:leftWidth`

实现要点：

- 容器使用 flex 布局：
  - `.rsp-left`：`width: calc(var(--left-ratio) * 100%)`，`min-width: 0`
  - `.rsp-divider`：固定宽度 6px，cursor `col-resize`
  - `.rsp-right`：`flex: 1`，`min-width: 0`
- 使用 `pointerdown` / `pointermove` / `pointerup` 监听拖拽。
- 拖拽开始时给 `document.body` 添加 `user-select: none` 与 `cursor: col-resize`；结束时移除。
- 拖拽时根据容器当前像素宽度，将 `minWidthPx` 与 `maxRatio` 统一转换为像素限制，再约束新的左侧宽度。
- 响应式断点 ≤960px 时，退化为上下堆叠，隐藏 divider。

### 5.3 `***DetailPanel.vue`

为每个市场新增详情内容面板，从现有 drawer 中抽出核心逻辑。

| 面板 | 新增文件 | 来源 |
|------|----------|------|
| A 股 | `AShareDetailPanel.vue` | 从 `AShareDetailDrawer.vue` 抽出 |
| 美股 | `UsStockDetailPanel.vue` | 从 `UsStockDetailDrawer.vue` 抽出 |
| Crypto | `CryptoSymbolDetailPanel.vue` | 从 `CryptoSymbolsPanel.vue` 内联 drawer 抽出 |

Props：

| Prop | A 股 | 美股 | Crypto | 说明 |
|------|------|------|--------|------|
| `row` | `SymbolRow` | `SymbolRow` | `SymbolRow` | 当前选中行 |
| `priceMode` | `'qfq' \| 'raw'` | `'qfq' \| 'raw'` | - | 复权模式 |
| `interval` | - | - | `'1h' \| '4h' \| '1d'` | Crypto 时间周期；当前仅支持这三个值，新增周期需同步更新 `useCryptoSymbolsQuery` 与详情面板 |

内部职责：

- 监听 `row` 变化，拉取对应 K 线数据。
- A 股：并行拉取 K 线、资金流向、AMV，merge 后传给 `KlineChart`；保留 AMV 合规标注。
- 美股：拉取 K 线。
- Crypto：根据 `interval` 拉取 K 线。
- `priceMode` / `interval` 变化时重拉数据。

`***DetailDrawer.vue` 改造为仅保留 `n-drawer` 外壳，内部复用对应 `***DetailPanel.vue`。

### 5.4 `CryptoSymbolsFilters.vue`（新增）

把 `CryptoSymbolsPanel.vue` 中内联的筛选器抽出：

- search 输入框
- watchlist 多选
- strategy 多选
- numeric condition filter

Props/Emits 与 A 股/美股 filters 组件风格对齐。

### 5.5 `useCryptoSymbolsQuery.ts`（新增，推荐）

把 Crypto 面板中内联的数据获取逻辑抽出为 composable，返回：

```ts
{
  symbols: Ref<SymbolRow[]>,
  loading: Ref<boolean>,
  pagination: Ref<{ page: number; pageSize: number; itemCount: number }>,
  handlePageChange: (page: number) => void,
  handlePageSizeChange: (size: number) => void,
  handleSorterChange: (...) => void,
  reload: () => Promise<void>,
}
```
