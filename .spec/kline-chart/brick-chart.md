# Brick 副图

> 父文档：@.spec/kline-chart/kline-chart-spec.md

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
