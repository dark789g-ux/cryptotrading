# 衍生指标

## 技术指标（custom_index_daily_indicators）

Worker Stage 4 计算，**实现权威描述见** `./03-index-computation.md#indicators`。

---

## 资金流（custom_index_money_flow）

### 口径

与同花顺宽基 `aggregateIndex` 一致：**等权 SUM**，不用 `custom_index_members.weight` 加权。

```text
net_amount(D) = Σ net_amount_stock(c, D)  for c in PIT_members(D)
```

### 依赖

- `money_flow_stocks` 须覆盖成分股日期范围
- 缺失成分：跳过，不补零（与同花顺聚合一致）

### 滚动窗口列

列表展示 `netAmount5d/10d/20d`：在 `GET /api/custom-indices/latest` 服务端用窗口函数聚合最近 N 日 `custom_index_money_flow`，逻辑对齐 `IndexDailyService.getLatest` 对 ths 的处理。

---

## AMV（custom_index_amv）

### 公式

参考 `industry-amv.service.ts`：

```text
amv(D) = Σ (close_c(D) × vol_c(D)) / index_close(D) × K
```

`K` 为缩放常数（与行业 AMV 保持一致，使副图量级可读）。

### K 线 Modal 副图

`category=custom` 时：

```text
并行请求:
  GET /api/custom-indices/:id/kline
  GET /api/custom-indices/:id/amv
→ mergeKlineWithAmv（复用 aSharesIndexKlineFetcher 或抽 shared）
```

副图白名单：`['VOL','KDJ','MACD','0AMV','0AMV_MACD']`

---

## 列设置

`tableId: 'aSharesIndexCustom'`

| 分组 | 列 |
|------|-----|
| 基础 | name, close, pctChange, count, tradeDate |
| 指数属性 | indexType, weightMethod, baseDate, basePoint |
| 状态 | status, computeProgress |
| 资金流 | netAmount, netAmount5d, netAmount10d, netAmount20d, buyLg/Md/Sm |
| 操作 | edit, delete, recompute（非 data 列，列设置中不可隐藏） |

默认可见列：name, close, pctChange, count, status, netAmount。

---

## 不提供的字段

| 字段 | 原因 |
|------|------|
| `pe` / `pb` | 合成指数无统一财报口径 |
| `totalMvWan` / `floatMvWan` | 非官方指数市值定义 |
| `turnover_rate` | V1 不合成 |

K 线 chart 不展示上述列。
