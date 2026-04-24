# K 线图规范

> 适用页面：@apps/web/src/views/SymbolsView.vue、@apps/web/src/components/backtest/KlineChartModal.vue  
> 共用实现入口：@apps/web/src/composables/klineChartOptions.ts  
> 数据来源：
> - 行情页：`GET /api/klines/:symbol/:interval`
> - 回测弹窗：`GET /api/backtest/runs/:runId/kline-chart`

## 布局

**硬约束：新增或修改 K 线图/副图时，每个 pane 左上角必须显示指标数值面板，右侧必须显示图例。** 不满足此约束的副图不得合并。

图表分为 4 个 pane（另有底部 dataZoom 滑块）：

| pane | grid top | grid height | xAxisIndex | yAxisIndex |
|------|----------|-------------|------------|------------|
| 主图（K + MA） | `10%` | `36%` | 0 | 0 |
| KDJ 副图 | `52%` | `11%` | 1 | 1 |
| MACD 副图 | `68%` | `11%` | 2 | 2 |
| Brick 副图 | `84%` | `8%` | 3 | 3（BRICK）、4（DELTA） |

左右留白：所有 pane 均为 `left: '8%', right: '8%'`。

左上角 overlay（graphic text）对应位置：

- 主图：`left: '9%', top: '10%'`
- KDJ：`left: '9%', top: '52%'`
- MACD：`left: '9%', top: '68%'`
- Brick：`left: '9%', top: '84%'`

十字光标时间标签规则：

- 仅最下方 pane（xAxisIndex 3）的 `axisPointer.label.show = true`，其余全部 `false`

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

## 弹窗全屏

> 仅适用于 @apps/web/src/components/backtest/KlineChartModal.vue

- 在 `n-modal` 标题栏右侧（关闭按钮左边）放置一个全屏切换按钮，使用 `n-modal` 的 `header-extra` slot 实现
- 按钮图标：未全屏时显示「放大」图标，全屏时显示「缩小」图标（使用 `n-icon`）
- 切换逻辑：维护 `isFullscreen` 响应式变量，点击切换
- 全屏状态：`n-modal` 的 `style` 动态绑定，`isFullscreen` 为 true 时改为 `width: 100vw; height: 100vh; max-width: 100vw; border-radius: 0`
- 图表高度：`.kline-chart` 的 `height` 由固定 `600px` 改为响应式——普通态 `600px`，全屏态自动撑满（`calc(100vh - 60px)`，60px 为标题栏高度）
- 图表 resize：`isFullscreen` 变化后调用 `chartInstance.resize()`
- ESC 键不额外处理（n-modal 本身已处理关闭）

## 各图实现

- [主图](charts/main-chart.md)（K 线 + MA）
- [KDJ 副图](charts/kdj-chart.md)
- [MACD 副图](charts/macd-chart.md)
- [Brick 副图](charts/brick-chart.md)

## 左上角面板通用规则

所有 pane 的左上角面板（ECharts graphic text）遵循以下规则：

- 光标悬停于某根 K 线上时，显示该根的指标值
- 光标离开后，回到最后一根 bar 的值
- 每个数值后追加方向标记（与前一根同指标值比较）：
  - `↑`（上涨，涨色 `#0ECB81`）
  - `↓`（下跌，跌色 `#F6465D`）
  - `-`（持平，灰色 `#848E9C`）
- null 值显示为 `-`

## Tooltip

Tooltip 由 `trigger: 'axis'` 触发，优先取蜡烛图系列的 dataIndex 定位当前 bar，显示：

- 时间（`open_time`，灰色 `#848E9C`）
- `Open / High / Low / Close`（4 位小数）
- `Change`：与前一根 close 的差值与百分比，涨绿跌红

若当前 bar 存在交易记录（`bar.trades`），追加显示（仅回测弹窗）：

- `Entry`：价格、Shares、进场原因
- `Exit`：价格、PnL（盈亏颜色与涨跌色一致）、出场原因；半仓平仓额外标注 `Partial`

**brickChart 数据不在 tooltip 中显示**，仅在左上角面板展示。

## 联动规则

- 所有 pane 通过 `axisPointer.link: [{ xAxisIndex: 'all' }]` 联动
- 十字光标移动时，主图、KDJ、MACD、Brick 的左上角 overlay 同步刷新
- `dataZoom`（inside + slider）同时作用于 4 个 pane（`xAxisIndex: [0,1,2,3]`）
- 回测弹窗和行情页共用同一套图表构建逻辑（`buildKlineChartOption`）

## 实现要点

- 共用 option builder：@apps/web/src/composables/klineChartOptions.ts
- 配色常量：@apps/web/src/composables/chartColors.ts
- 主图与副图均由该 builder 输出统一的 `grid / xAxis / yAxis / legend / series / graphic`
- 后端砖型图统一计算入口：@apps/server/src/indicators/brick-chart.ts
- 回测接口与行情接口都返回 `brickChart`

## 验收基线

1. 布局描述与 @apps/web/src/composables/klineChartOptions.ts 的 `grid / xAxis / yAxis` 配置一致
2. 接口字段与 @apps/web/src/composables/useApi.ts、@apps/server/src/backtest/kline-chart.controller.ts 一致
3. 文档明确区分行情页与回测弹窗两条接口，并说明 `deltaMin` 来源差异
4. Brick 副图只出现 `BRICK` 一个绘图系列；`DELTA` 仅在左上角面板显示数值，不绘制折线；`XG` 仅在左上角面板以 `1`/`0` 文本显示，不在图中绘制散点；图例只显示 `BRICK`；不出现阈值线、`AA1 / BB1 / CC1`
5. MACD 副图包含 `DIF / DEA / MACD` 三个系列，上涨柱实心绿、下跌柱空心红（透明填充 + 红边框），零轴虚线
6. KDJ 副图显示 y=0、y=10、y=90 三条水平参考虚线；J < 10 区间背景 `rgba(14,203,129,0.08)`，J > 90 区间背景 `rgba(246,70,93,0.08)`，通过 markArea 实现
7. 所有 pane 关闭 yAxis 默认水平网格线（`splitLine: { show: false }`），仅通过 markLine 添加有意义的参考线
8. 适用路径与当前仓库真实路径一致
