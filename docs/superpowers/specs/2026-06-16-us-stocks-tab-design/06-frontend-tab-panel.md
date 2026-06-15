# 06 · 前端美股 Tab 与面板

## 第 4 个 Tab

`SymbolsView.vue`（`:1-59`）：
- `activeTab` 类型并入 `'usStocks'`。
- 第 4 个 tab `<button>`「美股」+ 第 4 个 `v-else-if` 分支，keep-alive 包裹 `<UsStocksPanel>`。

## 组件树（apps/web/src/components/symbols/）

```text
UsStocksPanel.vue              照搬 ASharesPanel 骨架, 砍 scoresMap/hitLookup(无评分/信号)
  header: Refresh | Columns | 同步 | 标的管理
us-stocks/
  useUsStocksQuery.ts          取数+筛选+分页+排序 (镜像 useASharesQuery, 去掉 scores/strategy)
  UsStocksFilters.vue          搜索 / 主题(theme) / 类型 / 涨跌幅 / 前复权·不复权口径切换 / 高级筛选
  usStocksColumns.ts           createUsStocksColumnDefs(): 基础列 + buildIndicatorColumns(US子集,默认隐藏)
  UsStockDetailDrawer.vue      K线弹窗 (镜像 AShareDetailDrawer)
api/modules/market/usStocks.ts usStocksApi: query/summary/filterOptions/dateRange/klines/symbols/toggleTracked/sync
```

## 列系统复用（共享件，零重复）

- 复用 `SymbolColumnDef`（`columnTypes.ts`）、`buildIndicatorColumns`（`indicatorColumnDefs.ts`）、`ColumnSettingsDrawer`、`useSymbolColumnPreferences`。
- 基础列：`ticker`(fixed-left) / `name`(fixed-left) / `theme` / `stock_type` / `close` / `pctChg` / `volume` / `tradeDate`。
- 指标列：`buildIndicatorColumns` 传**美股适用子集**（MA/KDJ/MACD/BBI/ATR/low-high9/stop/rr；**排除** brick*/amv_* 这些 A 股专属 descriptor），`defaultVisible:false`。
- **无评分列、无买入信号列**（YAGNI / 不适用）。

## 必须同步扩展的去重点（探查已定位，漏则出 bug）

| 改动点 | 文件:位置 | 不改的后果 |
|--------|-----------|-----------|
| `SymbolsViewColumnPreferences` 加 `usStocks` | `api/modules/user-config/preferences.ts:1-17` | 保存丢字段 |
| `SymbolPreferenceScope` 联合加 `'usStocks'` | `useSymbolColumnPreferences.ts` | 类型不过 |
| preferences ref 初始化 + `cloneSymbolsViewPreferences` 加 usStocks | `useSymbolColumnPreferences.ts:14-18,112-114` | save 时 usStocks 被丢 |
| 后端 preferences DTO/控制器接受 `usStocks` | `/api/preferences/symbols-view` | 后端可能拒未知字段 |
| `COLUMN_KEY_GROUP` 补 `ticker/name/theme/stock_type` 分组 | `columnGroupMeta.ts` | 落 meta 兜底组 |

## 筛选（UsStocksFilters）

- **主题筛选**：`theme`（来自 CSV「行业」），比交易所更有用（AI芯片与算力/网络安全/医疗-GLP-1…）。
- **价格口径切换**：前复权(qfq)/不复权(raw) radio → `priceMode` query 参数（后端选列，见 [05](./05-nestjs-module.md#查询要点)）。
- 涨跌幅/搜索 + 高级数值筛选（复用 `NumericConditionFilter`）。
- v1 **不做** filter presets（A 股的筛选方案，YAGNI）。

## 同步 / 标的管理 UX

- **同步**按钮：`POST /api/us-stocks/sync` → 拿 jobId → 复用量化 jobs SSE 跟进度（见 [05](./05-nestjs-module.md#sync-派-job-桥)）。
- **标的管理**弹窗：列 `us_symbol`（ticker/name/theme/tracked 勾选 + 搜索），勾选 → `PUT /symbols/tracked`。扩到全美股=全标 tracked（P2 配合全名单同步）。
- 真机验证若写了用户列偏好，验完恢复默认（项目规范）。
