# 5. 前端集成、错误处理、测试与文件清单

## 5.1 KlineChart 透传回调

**文件**：`apps/web/src/components/kline/KlineChart.vue`

新增可选 prop：

```ts
recalcIndicators?: (params?: IndicatorSubplotParams) => Promise<void>
```

行为：
1. 监听 `localPrefs.params` 变化；
2. 变化前快照旧 `params`（可能为 `undefined`）；
3. 调用 `recalcIndicators(localPrefs.value.params)`；
4. 成功：父组件已在回调里更新 `data`，`KlineChart` 随 `props.data` 变化重绘；
5. 失败：用 `update({ params: oldParams })` 回滚本地偏好（`oldParams` 为 `undefined` 时即清除自定义参数），并继续向上抛错误，由父组件 toast。

这样父页面不需要反向控制 `KlineChart` 的 prefs，失败回滚由组件内部处理。

## 5.2 父页面接入

本期优先接入两个核心入口：

| 入口 | 回调逻辑 |
|---|---|
| `CryptoSymbolsPanel.vue` | 调用 `klinesApi.recalcKlines(selectedSymbol, store.interval, { kdjParams })` 替换 `klineData` |
| `AShareDetailDrawer.vue` | 调用 `aSharesApi.recalcKlines(tsCode, limit, priceMode, range, { kdjParams })`，重新 merge moneyFlow/AMV 后替换 K 线 |

其它入口（`UsStockDetailDrawer`、`UsIndexPanel`、`FlowTrendModal`、`SignalTradeKlineModal` 等）本期**不传入 `recalcIndicators`**：齿轮仍会显示、参数仍会持久化，但图表不会自动刷新，相当于“本页面暂不生效”。

## 5.3 错误处理

| 层级 | 处理 |
|---|---|
| Popover 输入 | `NInputNumber` 的 min/max/precision 做第一道限制；“确定”前再整体校验 |
| 后端 DTO | `class-validator` 校验 `n/m1/m2` 范围，非法返回 400 |
| `recalcIndicators` 回调 | 父页面 catch API 错误，toast 提示，不更新 `data` |
| `KlineChart` 内部 | 回调 reject 后，自动把 `params` 回滚到上一版成功值，保证 UI 与数据一致 |

## 5.4 文件清单

### 新增

- `apps/web/src/components/kline/KdjParamsEditor.vue`
- `apps/server/src/indicators/kdj.ts`
- `apps/server/src/market-data/klines/dto/kdj-params.dto.ts`

### 修改

- `apps/web/src/composables/kline/subplotConfig.ts`
- `apps/web/src/composables/kline/useKlineChartPrefs.ts`
- `apps/web/src/components/kline/KlineChartToolbar.vue`
- `apps/web/src/components/kline/KlineChart.vue`
- `apps/web/src/api/modules/market/symbols.ts`
- `apps/web/src/api/modules/market/aShares.ts`
- `apps/web/src/components/symbols/CryptoSymbolsPanel.vue`
- `apps/web/src/components/symbols/a-shares/AShareDetailDrawer.vue`
- `apps/server/src/market-data/klines/klines.controller.ts`
- `apps/server/src/market-data/klines/klines.service.ts`
- `apps/server/src/market-data/a-shares/a-shares.controller.ts`
- `apps/server/src/market-data/a-shares/a-shares.service.ts`
- `apps/server/src/backtest/engine/bt-indicators.ts`（可选：复用新 `kdj.ts`）

## 5.5 测试计划

- `subplotConfig.spec.ts`：`normalizePrefs` 对 `params` 的合并、默认值省略、越界清理；
- `useKlineChartPrefs`：参数更新后写入 localStorage；
- `KdjParamsEditor.vue` / `KlineChartToolbar.vue`：打开 → 改值 → 确定 emit；取消不 emit；
- 后端 `KlinesService.recalcKlines`：给定固定 OHLC，自定义参数能得到与默认 `9/3/3` 不同的 KDJ 序列；
- 后端 `ASharesService.recalcKlines`：同上，且其它列不变；
- 端到端：Crypto 或 A 股详情页改 KDJ 参数 → 发起 `recalc` 请求 → 图表重绘。

## 5.6 不在本期范围

- MACD / MA / BRICK / 0AMV 等其它指标参数化；
- 美股、美股指数、回测 K 线的后端 recalc；
- 跨设备同步参数到后端用户偏好表；
- KDJ 参数在前端的本地实时预览。
