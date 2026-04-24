# MACD 副图

> 父文档：@.spec/kline-chart/kline-chart-spec.md

## 系列

MACD 副图包含 4 个 series（xAxisIndex 2，yAxisIndex 2）：

| 系列 name | 类型 | 颜色 | 说明 |
|-----------|------|------|------|
| `DIF` | line | `#FFFFFF` | EMA12 - EMA26，快线 |
| `DEA` | line | `#F0B90B` | EMA9 of DIF，信号线 |
| `MACD`（上涨） | bar | `#0ECB81`（实心） | 当前值 > 前一根时 |
| `MACD`（下跌） | bar | 透明填充 + `#F6465D` 边框（空心） | 当前值 ≤ 前一根时 |

> MACD 用两个 bar series 实现实心/空心效果，两者 `name` 均为 `'MACD'`，图例只显示一条。  
> 上涨柱数据：`row.MACD`（条件：`MACD != null && MACD > data[i-1].MACD`），其余为 `null`。  
> 下跌柱数据：`row.MACD`（条件：`MACD != null && (i===0 || MACD <= data[i-1].MACD)`），其余为 `null`。

## 零轴参考线

DIF 系列附加零轴水平虚线（`markLine`）：

- `y = 0`，线色 `#848E9C`（Slate），`lineStyle.type: 'dashed'`，`label.show: false`，`symbol: 'none'`

## 图例

MACD 图例位于 MACD pane 右侧（`right: 12, top: '68%'`，垂直排列）：

- `DIF`
- `DEA`
- `MACD`

## 左上角指标面板

MACD pane 左上角（`left: '9%', top: '68%'`）显示：

- `DIF`（颜色 `#FFFFFF`）
- `DEA`（颜色 `#F0B90B`）
- `MACD`（颜色 `#0ECB81`，固定用涨色展示）

每项格式：`DIF: {值}{方向符号}`，值保留 4 位小数。  
方向符号规则见父文档「左上角面板通用规则」。
