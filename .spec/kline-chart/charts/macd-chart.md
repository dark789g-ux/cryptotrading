# MACD 副图

> 父文档：@.spec/kline-chart/kline-chart-spec.md

## 系列

MACD 副图包含 4 个 series（xAxisIndex 2，yAxisIndex 2）：

| 系列 name | 类型 | 颜色 | 说明 |
|-----------|------|------|------|
| `DIF` | line | `#FFFFFF` | EMA12 - EMA26，快线 |
| `DEA` | line | `#F0B90B` | EMA9 of DIF，信号线 |
| `MACD`（正） | bar | `#0ECB81` | `MACD > 0`；增长时实心，下降时空心（透明填充 + 绿边框） |
| `MACD`（负） | bar | `#F6465D` | `MACD < 0`；增长时实心，下降时空心（透明填充 + 红边框） |

> MACD 用两个 bar series 按正负分色，两者 `name` 均为 `'MACD'`，图例只显示一条。  
> 正柱数据：对象为 `{ value, itemStyle }`，条件 `MACD != null && MACD > 0`，`itemStyle` 根据 `MACD > data[i-1].MACD` 决定实心（`color: '#0ECB81'`）或空心（`color: 'transparent', borderColor: '#0ECB81', borderWidth: 1`），其余为 `null`。  
> 负柱数据：同理，条件 `MACD != null && MACD < 0`，实心/空心颜色换为 `#F6465D`。  
> `MACD === 0` 时不渲染柱子。

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
