# K 线图规范

> 适用页面：@apps/web/src/views/SymbolsView.vue、@apps/web/src/components/backtest/KlineChartModal.vue  
> 共用实现入口：@apps/web/src/composables/klineChartOptions.ts  
> 数据来源：
> - 行情页：`GET /api/klines/:symbol/:interval`
> - 回测弹窗：`GET /api/backtest/runs/:runId/kline-chart`

## 布局

**硬约束：新增或修改 K 线图/副图时，每个 pane 左上角必须显示指标数值面板，右侧必须显示图例。** 不满足此约束的副图不得合并。

图表分为 4 个 pane：

- 主图：K 线 + MA，约占高度 `36%`
- KDJ 副图：约占高度 `12%`
- MACD 副图：约占高度 `12%`
- Brick 副图：约占高度 `12%`
- 底部保留 `dataZoom`，联动全部 pane

当前实现中的 overlay 位置：

- 主图 overlay：`top: 10%`
- KDJ overlay：`top: 52%`
- MACD overlay：`top: 68%`
- Brick overlay：`top: 84%`

十字光标时间标签规则：

- 仅最下方 pane 显示 x 轴时间标签
- 主图与中间 pane 的 `axisPointer.label.show = false`
- 最下方 pane 的 `axisPointer.label.show = true`

## 数据模型

前端统一使用 `KlineChartBar`，其中砖型图数据挂在 `brickChart` 字段：

```ts
interface BrickChartPoint {
  brick: number
  delta: number
  xg: boolean
}

interface KlineChartBar {
  open_time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  MA5: number | null
  MA30: number | null
  MA60: number | null
  MA120: number | null
  MA240: number | null
  'KDJ.K': number | null
  'KDJ.D': number | null
  'KDJ.J': number | null
  DIF: number | null
  DEA: number | null
  MACD: number | null
  BBI: number | null
  brickChart?: BrickChartPoint
}
```

`brickChart` 字段含义：

- `brick`：砖型值，复用后端砖型值计算
- `delta`：DELTA，复用后端 DELTA 计算
- `xg`：当前根从"非上涨"切到"上涨"，并通过 `deltaMin` 过滤后为 `true`

`deltaMin` 来源：

- 行情页接口：默认按 `0` 处理
- 回测弹窗接口：使用 run 的 `configSnapshot.brickDeltaMin`

当前实现与副图展示都不输出 `AA1 / BB1 / CC1`。

## 各图实现

- [主图](main-chart.md)（K 线 + MA）
- [KDJ 副图](kdj-chart.md)
- [MACD 副图](macd-chart.md)
- [Brick 副图](brick-chart.md)

## Tooltip

Tooltip 由主图触发，显示当前 bar 的：

- `Open`
- `High`
- `Low`
- `Close`
- `Change`

若当前 bar 存在 `brickChart`，追加显示：

- `BRICK`
- `DELTA`
- `XG`

若当前 bar 存在成交点信息，回测弹窗还会追加显示：

- `entry`
- `exit`
- 对应价格、数量、盈亏与原因

## 联动规则

- 所有 pane 通过 `axisPointer.link: [{ xAxisIndex: 'all' }]` 联动
- 十字光标移动时，主图、KDJ、MACD、Brick 的左上角 overlay 同步刷新
- `dataZoom` 同时作用于 4 个 pane
- 回测弹窗和行情页共用同一套图表构建逻辑

## 实现要点

- 共用 option builder：@apps/web/src/composables/klineChartOptions.ts
- 主图与副图均由该 builder 输出统一的 `grid / xAxis / yAxis / legend / series / graphic`
- 后端砖型图统一计算入口：@apps/server/src/indicators/brick-chart.ts
- 回测接口与行情接口都返回 `brickChart`

## 验收基线

文档内容需要和以下实现保持一致：

1. 布局描述与 @apps/web/src/composables/klineChartOptions.ts 的 `grid / xAxis / yAxis` 配置一致
2. 接口字段与 @apps/web/src/composables/useApi.ts、@apps/server/src/backtest/kline-chart.controller.ts 一致
3. 文档明确区分行情页与回测弹窗两条接口，并说明 `deltaMin` 来源差异
4. Brick 副图只出现 `BRICK / DELTA` 两个绘图系列；`XG` 仅在左上角面板以文本数值显示，不在图中绘制散点；不出现阈值线、`AA1 / BB1 / CC1`
5. MACD 副图包含 `DIF / DEA / MACD` 三个系列，MACD 正柱实心、负柱空心，零轴虚线
6. 适用路径与当前仓库真实路径一致
