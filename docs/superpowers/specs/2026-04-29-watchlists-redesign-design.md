# 自选列表页面重新设计 — 设计文档

**日期：** 2026-04-29  
**状态：** 已批准，待实现  
**涉及范围：** 前端 (`apps/web`) + 后端 (`apps/server`)

---

## 1. 背景与目标

当前自选列表页面 (`/watchlists`) 采用卡片网格布局，仅展示列表名称和标的标签，无法查看实时行情数据。本次重新设计的目标是：

- **行情盯盘**：在自选列表中直接查看每个标的的最新价格、指标等行情数据
- **列表管理**：左侧导航支持创建、重命名、删除、拖拽排序列表；右侧表格支持移除标的、拖拽排序标的
- **自定义列**：用户可自行选择表格显示的指标列，默认给出一套常用组合
- **交互一致**：复用现有 K 线图表抽屉，点击标的即可查看详细走势

---

## 2. 整体架构

### 2.1 页面布局

采用**左侧列表导航 + 右侧行情表格**的经典布局：

```
WatchlistsView.vue (页面容器)
├── WatchlistSidebar.vue (左侧，固定宽度 240px)
│   ├── 列表项（支持拖拽排序）
│   ├── 右键菜单（重命名 / 删除）
│   └── 新建列表按钮
└── WatchlistTable.vue (右侧，自适应宽度)
    ├── 工具栏（周期选择 + 列设置 + 刷新按钮）
    ├── n-data-table（remote 分页）
    └── K 线抽屉（点击 Symbol 打开）
```

### 2.2 技术栈

- **前端**：Vue 3 + Naive UI + Pinia（新增依赖）
- **后端**：NestJS + TypeORM + PostgreSQL
- **数据持久化**：自定义列配置存入 `localStorage`

---

## 3. 后端设计

### 3.1 数据库变更

#### `watchlists` 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `display_order` | `INT` | 列表排序权重，默认 `0` |

#### `watchlist_items` 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `display_order` | `INT` | 标的在列表内的排序权重，默认 `0` |

**迁移策略**：
- 新建迁移文件
- 现有数据的 `display_order` 按 `created_at ASC` 顺序初始化，保证现有顺序不变

### 3.2 新增接口

#### `GET /watchlists/:id/quotes`

获取指定自选列表的最新行情数据。

**Query 参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `interval` | string | 是 | 行情周期：`1h` / `4h` / `1d` |
| `page` | number | 否 | 页码，默认 `1` |
| `page_size` | number | 否 | 每页条数，默认 `20` |
| `sort` | object | 否 | 排序规则 `{ field, order }`，不传则按 `display_order` 排序 |

**实现逻辑：**
1. 校验 watchlist 归属当前用户（`userId` 匹配），否则返回 `403`
2. 取出该列表的全部 symbols（按 `display_order ASC` 排序）
3. 对 symbols 数组做分页（`LIMIT` / `OFFSET`）
4. 对分页后的 symbols 查询 `klines` 表中对应 `interval` 的最新一条记录
5. 返回和 `POST /symbols/query` 同结构的 `SymbolRow[]`

**响应：**
```json
{
  "items": [
    {
      "symbol": "BTCUSDT",
      "close": 65000.5,
      "ma5": 64500.0,
      "ma30": 64000.0,
      "kdjJ": 45.2,
      "riskRewardRatio": 2.5,
      "stopLossPct": 3.2,
      "openTime": "2026-04-29T06:00:00Z"
    }
  ],
  "total": 100,
  "page": 1,
  "page_size": 20
}
```

#### `PUT /watchlists/reorder`

更新列表的排序。

**Body：**
```json
{ "ids": ["uuid-3", "uuid-1", "uuid-2"] }
```

**逻辑：** 按 `ids` 顺序依次设置每个 watchlist 的 `display_order`（`0, 1, 2...`）。

#### `PUT /watchlists/:id/reorder`

更新某个列表内标的的排序。

**Body：**
```json
{ "symbols": ["ETHUSDT", "BTCUSDT", "SOLUSDT"] }
```

**逻辑：** 按 `symbols` 顺序依次设置每个 `watchlist_item` 的 `display_order`。

### 3.3 现有接口调整

- `GET /watchlists`：返回时按 `display_order ASC, created_at DESC` 排序
- `GET /watchlists/:id`：返回时 items 按 `display_order ASC` 排序

---

## 4. 前端设计

### 4.1 引入 Pinia

安装 `pinia`，在 `apps/web/src/main.ts` 中注册：

```ts
import { createPinia } from 'pinia'
app.use(createPinia())
```

### 4.2 Store 设计 (`useWatchlistStore`)

```ts
interface WatchlistState {
  watchlists: Watchlist[]        // 所有列表
  currentId: string | null      // 当前选中列表 ID
  quotes: SymbolRow[]           // 当前列表行情
  total: number                 // 当前列表标的总数
  loadingLists: boolean         // 列表加载中
  loadingQuotes: boolean        // 行情加载中
  interval: '1h' | '4h' | '1d'  // 行情周期
  page: number                  // 当前页码
  pageSize: number              // 每页条数
  sortKey: string | null        // 排序字段
  sortOrder: 'ascend' | 'descend' | null  // 排序方向
  columns: string[]             // 自定义显示列
}
```

**核心 Actions：**

| Action | 说明 |
|--------|------|
| `loadWatchlists()` | 获取全部列表，默认选中第一个（或上次选中的） |
| `setCurrentId(id)` | 切换列表，重置 `page=1`，自动触发 `loadQuotes()` |
| `loadQuotes()` | 根据 `currentId` + `interval` + `page` + `pageSize` + `sort` 拉取行情 |
| `reorderWatchlists(ids)` | 乐观更新 + 调用 `PUT /watchlists/reorder` |
| `reorderItems(symbols)` | 乐观更新 + 调用 `PUT /watchlists/:id/reorder` |
| `saveColumns(columns)` | 更新自定义列并存入 `localStorage` |

### 4.3 组件清单

| 组件 | 路径 | 职责 |
|------|------|------|
| `WatchlistsView.vue` | `views/WatchlistsView.vue` | 页面容器，左右布局编排 |
| `WatchlistSidebar.vue` | `components/watchlist/WatchlistSidebar.vue` | 左侧列表导航，支持拖拽排序、右键菜单、新建 |
| `WatchlistTable.vue` | `components/watchlist/WatchlistTable.vue` | 右侧行情表格，remote 分页、表头排序、行内操作 |
| `WatchlistTableSettings.vue` | `components/watchlist/WatchlistTableSettings.vue` | 列自定义设置抽屉 |
| `SymbolStarButton.vue` | `components/common/SymbolStarButton.vue` | **复用现有**，行内收藏/取消收藏 |
| `KlineChart` | `components/charts/KlineChart.vue` | **复用现有**，K 线抽屉内展示 |

### 4.4 自定义列配置

- **可选列来源**：`symbolApi.getKlineColumns()` 返回后端支持的所有指标列名
- **默认列**：`['symbol', 'close', 'ma5', 'ma30', 'kdjJ', 'riskRewardRatio']`
- **持久化**：用户选择后存入 `localStorage`，key 为 `watchlist-columns`
- **设置入口**：表格工具栏"列设置"按钮 → 打开抽屉勾选/取消

### 4.5 数据流

```
WatchlistsView mounted
  → store.loadWatchlists()          // GET /watchlists
  → 默认选中第一个 / 恢复上次选中
  → store.loadQuotes()              // GET /watchlists/:id/quotes

用户切换列表
  → store.setCurrentId(id)
  → store.loadQuotes()              // page 重置为 1

用户切换周期 / 分页 / 排序
  → store 更新对应状态
  → store.loadQuotes()              // 带新参数请求

用户拖拽排序列表
  → 前端 optimistic update（立即重排 sidebar）
  → PUT /watchlists/reorder
  → 失败则回滚 + message.error()

用户拖拽排序标的
  → 前端 optimistic update（立即重排表格）
  → PUT /watchlists/:id/reorder
  → 失败则回滚 + message.error()
```

---

## 5. 交互细节

### 5.1 左侧 Sidebar

- **列表项**：显示列表名称 + 标的数量徽章
- **选中态**：高亮当前选中列表
- **右键菜单**：重命名、删除（带确认）
- **拖拽排序**：使用 `vuedraggable` 或原生 HTML5 Drag & Drop，拖拽时显示占位线
- **新建按钮**：底部固定"+ 新建列表"按钮，点击弹出输入框

### 5.2 右侧表格

- **行内操作**：
  - Symbol 列左侧显示 `SymbolStarButton`（收藏状态）
  - 每行末尾有"移除"按钮（从当前列表移除该标的）
  - 点击 Symbol 文本打开 K 线抽屉
- **表头排序**：点击表头触发 remote sort，字段和 `CryptoSymbolsPanel` 一致
- **拖拽排序**：表格行支持拖拽调整顺序（需关闭 remote sort 时生效，或拖拽后忽略当前 sort）
- **分页器**：底部显示，支持页码切换和每页条数切换（10 / 20 / 50）

### 5.3 K 线抽屉

- **复用现有实现**：和 `CryptoSymbolsPanel` 完全一致
- 点击 Symbol → 右侧滑出抽屉 → 展示该标的 K 线图表
- 抽屉标题格式：`{symbol} · {interval.toUpperCase()}`

---

## 6. 错误处理

| 场景 | 处理方式 |
|------|---------|
| 加载列表失败 | 左侧显示错误提示 + 重试按钮，右侧保持可用 |
| 加载行情失败 | 表格区域显示错误提示，可切换其他列表 |
| 创建/重命名失败 | `message.error()` 提示具体错误（如名称重复） |
| 删除列表失败 | `message.error()`，列表保留 |
| 拖拽排序失败 | **乐观更新 + 失败回滚**，不阻塞用户操作 |
| 移除标的失败 | **乐观更新 + 失败回滚** |
| 当前列表被删除 | 自动切换到第一个可用列表；无列表则显示空状态 |

### Loading 策略

- 左侧列表加载：`loadingLists` → sidebar 内显示 `n-spin`
- 右侧表格加载：`loadingQuotes` → 表格内显示 `n-spin`，表头保留可见
- 两者独立，避免全局阻塞

### 空状态

- **无自选列表**：左侧显示"暂无自选列表" + 新建按钮；右侧显示占位引导
- **列表无标的**：表格内显示 `n-empty` "暂无标的，去行情页添加"
- **加载中**：骨架屏或 spin，不显示空状态

---

## 7. 测试计划

### 后端测试

| 测试项 | 类型 | 说明 |
|--------|------|------|
| `getWatchlistQuotes` | 单元测试 | 正确返回分页行情、空列表、越权访问 `403` |
| `reorderWatchlists` | 单元测试 | 正确更新 `display_order`、无效 ID 忽略 |
| `reorderItems` | 单元测试 | 正确更新 `display_order`、越权 `403` |
| `GET /watchlists/:id/quotes` | 集成测试 | 参数校验、认证、响应格式 |
| `PUT /watchlists/reorder` | 集成测试 | 认证、Body 校验 |
| DB 迁移 | 手动测试 | 现有数据的 `display_order` 初始化正确 |

### 前端测试

| 测试项 | 类型 | 说明 |
|--------|------|------|
| `useWatchlistStore` | 单元测试 | state 变更、action 调用、乐观更新回滚 |
| `WatchlistSidebar` | 组件测试 | 渲染列表、拖拽交互、右键菜单 |
| `WatchlistTable` | 组件测试 | 分页、排序、列自定义、行内操作 |
| 端到端 | 手动测试 | 完整流程：创建列表 → 添加标的 → 查看行情 → 排序 → 删除 |

---

## 8. 实现顺序建议

1. **后端**：DB 迁移 → `display_order` 字段 → `GET /watchlists/:id/quotes` → reorder 接口
2. **前端**：安装 Pinia → Store 实现 → `WatchlistSidebar` → `WatchlistTable` → `WatchlistTableSettings` → 页面整合
3. **联调**：端到端测试 → 性能检查（大数据量列表的加载速度）

---

## 9. 风险与注意事项

1. **大数据量列表**：如果单个自选列表有数百个标的，`GET /watchlists/:id/quotes` 的 SQL 性能需要关注。可考虑对 `klines` 表建立 `(symbol, interval, open_time DESC)` 复合索引。
2. **拖拽排序与表头排序冲突**：当用户通过表头对表格进行 remote sort 时，行内拖拽排序应禁用或给出提示（拖拽会覆盖当前排序）。
3. **Pinia 引入**：这是项目首次引入 Pinia，需要确认团队对状态管理的规范，避免后续滥用。
