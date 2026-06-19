# 数据流、视图模式与响应式

## 6. 数据流与状态持久化

```text
SymbolsPanelLayout
├─ viewMode: localStorage 读写
├─ leftWidth: localStorage 读写
├─ 渲染 header
│  ├─ Refresh 按钮 → emit refresh
│  ├─ Columns 按钮 → update:showColumnSettings(true)
│  └─ 视图切换按钮 → 切换 viewMode，持久化
├─ 渲染 filters slot
├─ viewMode === 'table'
│  └─ 渲染 table slot
└─ viewMode === 'split'
   └─ ResizableSplitPane
      ├─ left slot: split-left（精简表格）
      └─ right slot
         ├─ 有 selectedDetailRow → split-right（详情面板）
         └─ 无 selectedDetailRow → empty-detail slot

具体面板
├─ 管理 searchQuery、filters、pagination、sort、selectedDetailRow
├─ 提供完整表格列定义与精简表格列定义
└─ 提供详情面板组件实例
```

持久化规则：

- `viewMode` 写入 `symbols_panel_view_mode_<scope>`，读取失败默认 `table`。
- `leftWidth` 写入 `symbols_panel_split_width_<scope>`，读取失败默认 `0.4`。
- 数值写入前需校验范围，避免读取到非法值导致布局异常。

## 7. 视图模式与交互

### 7.1 形态一：table

```text
┌─────────────────────────────────────────────────────────┐
│ [Refresh] [Columns] [切换视图]  [面板特定操作]            │
├─────────────────────────────────────────────────────────┤
│ filters slot                                            │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────┐    │
│  │ n-data-table（完整列）                            │    │
│  │ remote 分页 / 排序 / loading                      │    │
│  │ 行点击不再打开详情 drawer                         │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### 7.2 形态二：split

```text
┌─────────────────────────────────────────────────────────┐
│ [Refresh] [Columns] [切换视图]  [面板特定操作]            │
├─────────────────────────────────────────────────────────┤
│ filters slot                                            │
├────────────────────┬────────────────────────────────────┤
│ n-data-table       │  detail-panel slot                 │
│ （名称/代码/现价） │  （KlineChart + 副图 + 标注）       │
│ 点击行 ▶ 设置选中  │  未选中时显示 empty-detail slot   │
│ remote 分页/排序   │                                    │
├────────────────────┼────────────────────────────────────┤
│ 分页               │                                    │
└────────────────────┴────────────────────────────────────┘
         ▲
         └── ResizableSplitPane 分隔线（min 240px / max 60%）
```

### 7.3 视图切换按钮

- 使用 `n-button` + `@vicons/ionicons5` 图标：
  - table 模式显示分栏图标（如 `GridOutline`），tooltip「切换为分栏视图」。
  - split 模式显示表格图标（如 `ListOutline`），tooltip「切换为表格视图」。

## 8. 响应式

- 宽屏（>960px）：split 模式正常左右分栏，可拖拽。
- 窄屏（≤960px）：split 模式退化为上下堆叠，divider 隐藏，左侧全宽在上，右侧全宽在下。
- table 模式在窄屏下保持现有行为（表格横向滚动）。
