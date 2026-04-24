# MACD 副图

> 父文档：@.spec/kline-chart/kline-chart-spec.md

## 系列

MACD 副图包含 3 个系列：

| 系列 | 类型 | 说明 |
|------|------|------|
| `DIF` | line | EMA12 - EMA26，快线 |
| `DEA` | line | EMA9 of DIF，信号线 |
| `MACD` | bar | 2 * (DIF - DEA)，柱状图 |

## 颜色

| 系列 | 颜色 | 色值 |
|------|------|------|
| DIF | 白色 | `#FFFFFF` |
| DEA | 币安黄 | `#F0B90B` |
| MACD 正柱 | Crypto Green | `#0ECB81`，实心 |
| MACD 负柱 | Crypto Red | `#F6465D`，空心 |
| 零轴参考线 | 灰色虚线 | `#848E9C` |

## 图例

MACD 图例位于 MACD pane 右侧，内容为：

- `DIF`
- `DEA`
- `MACD`

## 零轴参考线

MACD pane 显示零轴水平虚线（y = 0），线色 `#848E9C`（Slate），`lineStyle.type = 'dashed'`。

## 左上角指标面板

MACD pane 左上角显示：

- `DIF`
- `DEA`
- `MACD`

规则与主图/KDJ 一致：

- 随十字光标定位刷新
- 离开后显示最新一根
- 与上一根比较显示方向标记
