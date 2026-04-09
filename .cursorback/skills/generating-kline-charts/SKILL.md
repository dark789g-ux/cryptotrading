---
name: generating-kline-charts
description: Generates K-line (candlestick) charts with ECharts for crypto/financial data. Use when creating K-line charts, candlestick charts, OHLC charts, or when adding technical indicators (MA, MACD, KDJ, stop_loss_pct, risk_reward_ratio) to price charts in HTML/JavaScript.
---

# 生成 K 线图

基于 ECharts 的 K 线图实现规范，适用于量化回测报告、行情展示等场景。

## 技术栈

- **图表库**：ECharts 5.x（K 线使用 `candlestick` 类型，不用 Chart.js）
- **数据源**：CSV 或 JSON，需包含 OHLC 及可选指标列

## 数据格式

### CSV 列名约定

| 列名 | 必需 | 说明 |
|------|------|------|
| open_time | ✓ | 时间戳或日期字符串 |
| open, high, low, close | ✓ | 开高低收 |
| MA5, MA30, MA60, MA120, MA240 | - | 均线 |
| DIF, DEA, MACD | - | MACD 指标 |
| KDJ.K, KDJ.D, KDJ.J | - | KDJ 指标 |
| stop_loss_pct | - | 止损幅度（%） |
| risk_reward_ratio | - | 盈亏比 |

### ECharts candlestick 数据格式

每根 K 线为 `[open, close, low, high]`（注意顺序：收盘在第二位）。

```javascript
// 从 CSV 解析后
const ohlc = klines.map(k => [k.o, k.c, k.l, k.h]);
```

## 布局结构

采用四格布局（主图 + 三个副图）：

```javascript
grid: [
  { left: 68, right: 20, top: 30,    bottom: '48%' },  // 主图：K线 + MA5/30/60/120/240
  { left: 68, right: 20, top: '52%', bottom: '36%' },  // MACD
  { left: 68, right: 20, top: '64%', bottom: '20%' },   // KDJ
  { left: 68, right: 20, top: '82%', bottom: '6%'  },  // stop_loss_pct, risk_reward_ratio
]
```

- 主图：K 线、MA5/MA30/MA60/MA120/MA240 均线
- 副图 1：MACD 柱状 + DIF/DEA 线
- 副图 2：KDJ 三条线，参考线 10/80
- 副图 3：stop_loss_pct（左轴）、risk_reward_ratio（右轴），双 Y 轴

## 核心配置

### K 线颜色

```javascript
itemStyle: {
  color: '#e74c3c',      // 涨（实心）
  color0: '#27ae60',     // 跌（实心）
  borderColor: '#e74c3c',
  borderColor0: '#27ae60',
  borderWidth: 1,
}
```

### 买卖标记 (markPoint)

在交易时间点用 B/S 标记：

```javascript
// 买入：红色圆角矩形，标签 "B"
// 卖出：绿色圆角矩形，标签 "S"
markPoint: {
  silent: true,
  animation: false,
  data: marks,  // coord: [time, low], symbol: 'roundRect', symbolSize: [18, 16]
}
```

### 价格小数位

根据价格数量级动态确定：

```javascript
const ref = Math.abs(close) || 1;
const dec = ref >= 1000 ? 2 : ref >= 100 ? 3 : ref >= 10 ? 4 : ref >= 1 ? 5 : ref >= 0.1 ? 6 : ref >= 0.01 ? 7 : 8;
```

### DataZoom

```javascript
dataZoom: [
  { type: 'inside', xAxisIndex: [0, 1, 2, 3], start: sp, end: ep },
  { type: 'slider',  xAxisIndex: [0, 1, 2, 3], bottom: '1%', height: 20, start: sp, end: ep },
]
```

## 容器与响应式

- 对话框内图表容器：`flex: 1; min-height: 0;` 避免 flex 子元素溢出
- 窗口 resize 时调用 `chart.resize()`
- 使用 `animation: false` 提升大数据量下的性能

## 依赖引入

```html
<script src="https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js"></script>
```

## 参考实现

项目内 `report.html` 包含完整 K 线实现，包括：
- CSV 解析 `_parseCsvKlines`
- 时间窗口裁剪 `_sliceKlineWindow`
- 买卖标记 `_buildBSMarks`
- 主图渲染 `_renderKlineChart`
- 左上角指标信息面板（MA、MACD、KDJ、stop_loss_pct/risk_reward_ratio）及 `updateAxisPointer` 联动
