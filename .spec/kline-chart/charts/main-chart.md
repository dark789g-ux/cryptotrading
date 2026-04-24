# 主图

> 父文档：@.spec/kline-chart/kline-chart-spec.md

## 系列

| 系列 | 类型 | 颜色 |
|------|------|------|
| `K` | candlestick | 涨 `#0ECB81`（绿）/ 跌 `#F6465D`（红） |
| `MA5` | line | `#F0B90B` |
| `MA30` | line | `#1EAEDB` |
| `MA60` | line | `#0ECB81` |
| `MA120` | line | `#E8804C` |
| `MA240` | line | `#C882E7` |

所有 MA 线 `showSymbol: false`，`lineStyle.width: 1`。

## 回测弹窗特有元素

以下内容仅在回测弹窗（有 `currentTs` 参数时）渲染：

- **markLine**：在 `currentTs` 对应的 x 位置绘制一条竖向虚线（`#F0B90B`），标记当前成交时刻
- **markPoint**：在每根有交易记录的 bar 的 K 线下方渲染圆形标记
  - 入场（Entry）：绿色（`#0ECB81`），标签文字 `B`
  - 出场（Exit）：红色（`#F6465D`），标签文字 `S`
  - 当前成交 bar（`open_time === currentTs`）：符号放大（22px）、标签字体加粗（13px）
  - 非当前 bar：符号较小（13px）、颜色半透明（45% opacity）
  - 同一 bar 有多笔交易时按索引纵向偏移（`symbolOffset: [0, index * 14]`）

## 图例

主图图例位于右上方（`right: 12, top: '8%'`，垂直排列）：

- `K`
- `MA5`
- `MA30`
- `MA60`
- `MA120`
- `MA240`

## 左上角指标面板

主图左上角（`left: '9%', top: '10%'`）显示：

- `MA5`
- `MA30`
- `MA60`
- `MA120`
- `MA240`

每项格式：`MA5: {值}{方向符号}`，颜色与对应 MA 线一致。  
方向符号规则见父文档「左上角面板通用规则」。
