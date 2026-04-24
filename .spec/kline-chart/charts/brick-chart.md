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

Brick 副图包含 2 个绘图系列：

- `BRICK`：浮动柱状主体，每根柱子起点为上一周期 brick 值、终点为当前周期 brick 值；brick 上涨时用涨色，下跌时用跌色
- `DELTA`：折线辅助，绑定独立的右侧 yAxis，不影响 BRICK 的量程

## 图例

Brick 图例位于最下方 pane 右侧，内容为：

- `BRICK`
- `DELTA`

## 左上角指标面板

Brick pane 左上角只显示：

- `XG`（文本数值，不在图中绘制散点）
- `DELTA`
- `BRICK`

不显示以下内容：

- 阈值线
- 可触发区色带
- `AA1 / BB1 / CC1`
