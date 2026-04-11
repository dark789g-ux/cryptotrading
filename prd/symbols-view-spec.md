# 标的展示（Vue）需求定稿

> 状态：已封版，与实现一致时以此文为验收依据。

## 1. 范围

- **标的页**：仅 Vue（`SymbolsView` 及子组件）。
- **删除**：`report.html`、`symbols.html`、仅被 `report.html` 引用的 `frontend/js/*.js` 整组。
- **回测查看**：仅通过 Vue（`BacktestView` / `ResultDrawer`）。

## 2. 布局

- 左侧：筛选 + 表格；右侧：K 线图；**左右可拖拽调整侧栏宽度**。
- 宽度：**最小 240px**，**最大 `min(640px, 75vw)`**。
- **localStorage**：`symbolsSidebarWidthPx`。

## 3. 筛选与搜索

- 修改周期、关键字、高级条件后 **不自动请求**；仅点击 **「搜索」** 提交。**Enter 不触发搜索**。
- **重置**：清空关键字与高级条件，恢复未过滤列表；与周期默认策略由产品保持与实现一致。
- 每次执行新检索（含重置后的重新加载）：**回到第 1 页**。
- **关键字 `q`**：交易对 **contains**，不区分大小写；空表示不按代码过滤。

## 4. 高级检索（技术指标）

-多条条件 **仅 AND**，**最多 10 条**。
- `field` 来自 **`kline-columns`**，**仅数值比较**（MVP）；缺行/非数/NaN ⇒不满足。
- `op`：`lt` | `lte` | `gt` | `gte` | `eq` | `neq`。
- `value`：JSON **number**。
- `conditions: []`：不做指标过滤。

## 5. 表格列与排序

- **`symbol`**：固定第一列，**不参与**「可勾选列」列表（不在 CSV 表头中）。
- 可勾选列：`kline-columns` 返回的**全部列**；**默认勾选**：`stop_loss_pct`、`risk_reward_ratio`。
- **localStorage 全局**：`symbolsTableVisibleFields`（JSON 数组）。
- **排序**：仅服务端；`sort.field` 只能是 **`symbol`** 或当前 **已勾选显示**的 CSV 列之一。

## 6. 分页

- 服务端分页；默认 **`page_size=20`**；**localStorage**：`symbolsPageSize`。
- 换页：**保留选中标的**，右侧 K 线不变。
- 新检索：**第 1 页**。

## 7. API

### `GET /api/symbols/kline-columns?interval=`

- 该周期目录下所有 CSV **表头并集**，返回列名数组（稳定排序）。

### `GET /api/symbols/names?interval=`

- 仅扫描文件名，**不读 CSV**；返回全部交易对字符串（同步页等使用）。

### `POST /api/symbols/query`

**Body：**

```json
{
  "interval": "1d",
  "page": 1,
  "page_size": 20,
  "sort": { "field": "symbol", "asc": true },
  "q": "",
  "conditions": [{ "field": "KDJ.J", "op": "lt", "value": 10 }],
  "fields": ["stop_loss_pct", "risk_reward_ratio"]
}
```

- `fields`：返回的 CSV 列（不含 `symbol`）；响应每条 **始终含 `symbol`**。
- `conditions` 长度 ≤ 10；`page_size` 后端上限 **100**。

**Response：**

```json
{
  "items": [{ "symbol": "BTCUSDT", "stop_loss_pct": null }],
  "total": 1234,
  "page": 1,
  "page_size": 20
}
```

### 移除

- `GET /api/symbols`
- `GET /api/filter-strategies`

## 8. 性能（MVP）

- 接受先全量过滤再分页；后续可优化。

## 9. 验收清单

- [x] 侧栏拖拽 + 宽度记忆
- [x] 仅按钮搜索；Enter 不搜
- [x] 高级检索 AND、≤10、数值 MVP
- [x] `kline-columns` 并集；`names` 轻量；同步页改用 `names`
- [x] 表格列勾选、全局记忆；排序仅 symbol + 已勾选列
- [x] POST 仅返回 `fields` + `symbol`
- [x] 静态 `report.html` / `symbols.html` / `frontend/js` 报告脚本已删除
