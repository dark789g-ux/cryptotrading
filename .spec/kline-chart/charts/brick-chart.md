# Brick 副图

> 父文档：@.spec/kline-chart/kline-chart-spec.md

## 参数计算

> 实现入口：`@apps/server/src/backtest/engine/bt-indicators.ts` → `precomputeBrickChart`  
> 对外封装：`@apps/server/src/indicators/brick-chart.ts` → `calcBrickChartPoints`

### BRICK

通达信公式翻译，固定参数：HHV/LLV 窗口 `P=4`，VAR2A SMA `N=4`，VAR4A/VAR5A SMA `N=6`。

对每根 bar：

1. `HHV` = 近 4 根最高价的最高值，`LLV` = 近 4 根最低价的最低值
2. `range = HHV - LLV`
3. `VAR1A = range > 0 ? (HHV - close) / range × 100 - 90 : -90`
4. `VAR3A = range > 0 ? (close - LLV) / range × 100 : 50`
5. `VAR2A = SMA(VAR1A, N=4)` — 即 `(VAR1A + 3 × prev) / 4`，首值用 VAR1A 初始化
6. `VAR4A = SMA(VAR3A, N=6)` — 即 `(VAR3A + 5 × prev) / 6`，首值用 VAR3A 初始化
7. `VAR5A = SMA(VAR4A, N=6)` — 即 `(VAR4A + 5 × prev) / 6`，首值用 VAR3A 初始化
8. `VAR6A = (VAR5A + 100) - (VAR2A + 100) = VAR5A - VAR2A`
9. `BRICK = VAR6A > 4 ? VAR6A - 4 : 0`

### DELTA

基于 BRICK 的变化率指标：

```
diff1 = |BRICK[i] - BRICK[i-1]|
diff2 = |BRICK[i-1] - BRICK[i-2]|
DELTA = diff2 > 1e-10 ? diff1 / diff2 : 0
```

即当前 bar 的 BRICK 变化幅度 / 前一根 bar 的 BRICK 变化幅度，反映 brick 值加速或减速的程度。前 2 根 bar 无 DELTA 值（需要 i ≥ 2）。

### XG

买入信号，条件为三项同时满足（`i ≥ 2`）：

- `aa`：当前 bar 的 BRICK > 前一根 bar 的 BRICK（brick 上涨）
- `!aaPrev`：前一根 bar 的 BRICK ≤ 前两根 bar 的 BRICK（上一根未涨）
- `deltaPassed`：`deltaMin ≤ 0 || DELTA[i] ≥ deltaMin`

即 brick 从「非上涨」翻转为「上涨」，且 DELTA 达到最小阈值。

`deltaMin` 来源：
- 行情页：默认 `0`
- 回测弹窗：使用 run 的 `configSnapshot.brickDeltaMin`

## 系列

Brick 副图只有 1 个绘图系列（xAxisIndex 3）：

| 系列 | 类型 | yAxisIndex | 颜色 | 说明 |
|------|------|------------|------|------|
| `BRICK` | custom（rect） | 3 | 上涨 `#0ECB81` / 下跌 `#F6465D` | 浮动柱：起点为上一周期 brick，终点为当前周期 brick |

**DELTA 折线已永久移除**：不再创建 `deltaSeries`，不再需要 yAxisIndex 4（右侧独立 yAxis 可同步删除）。DELTA 数值仍在左上角面板展示。

BRICK custom series 数据格式：`[idx, prevBrick, currentBrick]`（`flatMap` 过滤无 brickChart 的项，禁止含 null 项，见 CLAUDE.md ECharts custom series 规范）。x 坐标从 `api.value(0)` 读取原始索引。

## 图例

Brick 图例位于最下方 pane 右侧（`right: 12, top: '84%'`，垂直排列）：

- `BRICK`（仅此一项，DELTA 不再出现于图例）

## 左上角指标面板

Brick pane 左上角（`left: '9%', top: '84%'`）显示（仅当 `row.brickChart` 存在时才渲染文字）：

- `XG`：显示 `1`（true）或 `0`（false），颜色 `#F0B90B`，加粗
- `DELTA`：颜色 `#1EAEDB`，2 位小数（仅面板显示，无对应折线）
- `BRICK`：颜色 `#0ECB81`（涨色），2 位小数

不显示以下内容：

- 阈值线
- 可触发区色带
- `AA1 / BB1 / CC1`
