# KDJ 副图

> 父文档：@.spec/kline-chart/kline-chart-spec.md

## 系列

| 系列 | 类型 | 颜色 | xAxisIndex | yAxisIndex |
|------|------|------|------------|------------|
| `KDJ.K` | line | `#F0B90B` | 1 | 1 |
| `KDJ.D` | line | `#1EAEDB` | 1 | 1 |
| `KDJ.J` | line | `#0ECB81` | 1 | 1 |

所有线 `showSymbol: false`，`lineStyle.width: 1`。

## 水平参考线

KDJ pane 的 `KDJ.K` 系列上附加三条水平虚线（通过 `markLine`，挂在 xAxisIndex 1 上）：

| y 值 | 含义 |
|------|------|
| 0 | 零轴 |
| 10 | 超卖下边界 |
| 90 | 超买上边界 |

线色：`#848E9C`（Slate），`lineStyle.type: 'dashed'`，`label.show: false`，`symbol: 'none'`。

## 区间背景色

`KDJ.K` 系列通过 `markArea` 添加基于**数据索引区间**的背景色区块，仅当 J 值在该时间段内满足条件时才渲染：

| 条件 | 含义 | 背景色 |
|------|------|--------|
| `J < 10` | 超卖区 | `rgba(14,203,129,0.15)`（绿） |
| `J > 90` | 超买区 | `rgba(246,70,93,0.15)`（红） |

实现要点：
- 遍历所有 bar 数据，根据每根 bar 的 `KDJ.J` 值判断：
  - 若 `J < 10`，将该 bar 的索引纳入绿色区间集合
  - 若 `J > 90`，将该 bar 的索引纳入红色区间集合
- 将连续的索引合并为区间段，每个区间段生成一个 markArea 区块
- markArea 区块格式：`[{ xAxis: startIndex }, { xAxis: endIndex }]`，覆盖该时间段内 pane 的整个纵向区域
- `itemStyle.color` 填入对应 rgba；`label.show: false`；`silent: true`
- markArea 挂在 `KDJ.K` 系列（xAxisIndex 1），不单独占用系列槽位
- J 值在 10~90 之间时，该时间段不渲染任何背景色

## 图例

KDJ 图例位于 KDJ pane 右侧（`right: 12, top: '52%'`，垂直排列）：

- `KDJ.K`
- `KDJ.D`
- `KDJ.J`

## 左上角指标面板

KDJ pane 左上角（`left: '9%', top: '52%'`）显示：

- `K`（对应 `KDJ.K`，颜色 `#F0B90B`）
- `D`（对应 `KDJ.D`，颜色 `#1EAEDB`）
- `J`（对应 `KDJ.J`，颜色 `#0ECB81`）

每项格式：`K: {值}{方向符号}`，值保留 2 位小数。  
方向符号规则见父文档「左上角面板通用规则」。
