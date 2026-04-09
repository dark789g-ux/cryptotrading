# 持仓周期完整流程

> 本文档基于 `engine.py` 源码，逐阶段描述一笔交易从信号产生到最终出场的完整生命周期。

---

## 总览

```
[ 收盘扫描信号 ] → [ 挂单（延迟一根）] → [ 开仓当根处理 ] → [ 持仓中每根处理 ] → [ 出场 ]
  scan_signals       pending_buys            entry bar           process_candle      exit_full
```

---

## 阶段 1：收盘扫描信号（`scan_signals`）

> 触发时机：`run_backtest` 主循环每根 K 线收盘后，步骤 4 调用

### 过滤条件（全部满足才进候选）

| 条件 | 说明 |
|------|------|
| `close > MA60` | 收盘在 60 均线上方 |
| `MA30 > MA60 > MA120` | 均线多头排列 |
| `close > MA240` | 收盘在 240 均线上方（长期趋势向上） |
| `KDJ.J < 10` | KDJ.J 处于超卖区域，短期超跌 |

### 盈亏比计算

```
风险   = 买入价（close） - 近期低点（最近 5 根最低价）
收益   = 近期高点（最近 5 根最高价）- 买入价
盈亏比 = 收益 / 风险
```

### 候选排序与入队

- 按盈亏比**降序**排列所有候选标的
- 取第一名，将 `(symbol, signal_ts, rr_ratio)` 加入 `pending_buys` 队列
- 已持仓或已挂单的标的**跳过**

---

## 阶段 2：下一根开盘买入（执行挂单）

> 触发时机：`run_backtest` 主循环，步骤 1，信号产生后的**第一根**可用 K 线开盘

### 资金分配

```
position_size = 上根净值快照 × POSITION_RATIO（0.45）
alloc         = min(position_size, 当前现金)
```

若 `alloc < MIN_OPEN_CASH`，本次挂单取消。

### 初始止损价计算

```
ATR止损价    = 前一根 loss_atr_14（即 close - 1.5×ATR14）
最大亏损止损  = 开仓价 × (1 - MAX_INIT_LOSS)
stop_price   = max(ATR止损价, 最大亏损止损)    ← 取较高者（更严格）
```

- 若 `ATR止损价 >= 最大亏损止损`：`stop_reason = "ATR止损"`
- 否则：`stop_reason = "最大亏损止损"`

### 创建 Position 对象

| 字段 | 值 |
|------|----|
| `entry_price` | 当根开盘价 |
| `entry_time` | 当根时间戳 |
| `shares` | `alloc / open_price` |
| `stop_price` | 上方计算值 |
| `recent_high` | 当根前的近期高点（止盈触发价） |
| `max_close` | 初始为 `open_price` |
| `candle_count` | 初始为 `0` |
| `broke_ma5` | `False` |
| `ma5_stop_adjusted` | `False` |

---

## 阶段 3：开仓当根处理（特殊逻辑）

> 触发时机：`run_backtest` 步骤 2，`ts == pos.entry_time`

由于开盘买入后当根就可能触发止盈/止损，引擎对开仓当根单独处理（**不走 `process_candle`**）。

### 3.1 阶段止盈检查

```
条件：high >= recent_high  AND  not half_sold
动作：卖出一半仓位 @ recent_high
      cash += proceeds_half
      pos.half_sold = True
```

### 3.2 止损检查

```
条件：low <= stop_price
动作：全平剩余仓位 @ stop_price（不跳空）
      exit_reason = stop_reason
      → 当根结束，不再继续
```

### 3.3 收盘处理（未触及止损时）

收盘处理按以下优先级依次执行：

#### ①' 阶段止盈后止损调节（仅本根触发半仓止盈时）

```
条件：hit_profit == True（3.1 已卖出半仓）

更新 max_close = max(max_close, close)
new_stop = (entry_price + max_close) / 2
new_stop = max(stop_price, new_stop)   ← 只上移，不下调
更新 stop_price = new_stop
stop_reason = "阶段止盈后止损"

若 close < new_stop:
    全平剩余仓位 @ close
    exit_reason = "阶段止盈后收盘止损"
    → 当根结束
若 close >= new_stop:
    继续持仓，进入 MA5 规则
```

#### ② MA5 收盘规则（无论 hit_profit 真假均执行）

```
更新 max_close = max(max_close, close)

规则 A（突破 MA5 标记）：
  若 not broke_ma5 AND close > MA5:
      broke_ma5 = True

规则 B（MA5 下跌破线出场，优先于规则 C）：
  若 close < MA5 AND MA5 <= prev_MA5 AND broke_ma5:
      全平 @ close，exit_reason = "MA5下跌破线"
      → 当根结束

规则 C（MA5 首次上升 → 调节动态止损）：
  若 not ma5_stop_adjusted AND MA5 > prev_MA5:
      new_stop = (entry_price + max_close) / 2
      new_stop = max(stop_price, new_stop)
      若 close < new_stop → 全平 @ close，exit_reason = "MA5上升后止损"
      若 close >= new_stop → 更新止损，stop_reason = "MA5首次上升止损"
                             ma5_stop_adjusted = True
```

> 开仓当根存活的持仓 `candle_count` **不递增**（仍为 0），进入阶段 4。

---

## 阶段 4：持仓中每根 K 线处理（`process_candle`）

> 触发时机：`run_backtest` 步骤 2，`ts != pos.entry_time` 的所有后续 K 线

### 处理顺序（严格按优先级）

```
步骤 ① 盘中：阶段止盈（half_sold）+ 止损（low <= stop_price）
              │
              ├─ hit_stop=True → return "exit_full"（不进入 close bar）
              │
              └─ hit_stop=False → 进入 close bar 处理
                    │
                    ├─ if hit_profit:（步骤 ①' 新增）
                    │      阶段止盈后止损线调节 + close 二次止损检查
                    │      若 close < new_stop → return "exit_full"
                    │
                    ↓（无论 hit_profit 真假均继续）
步骤 ② 收盘：MA5 规则 A/B/C
              ↓ 若存活
步骤 ③：candle_count += 1
```

---

### 步骤 ①：盘中止盈与止损（同根同时触发时：先止盈后止损）

#### 阶段止盈（半仓）

```
条件：high >= recent_high  AND  not half_sold
动作：卖出一半 @ recent_high
      cash_delta += proceeds_half
      pos.half_sold = True
      记录 TradeRecord（is_half=True）
```

#### 止损（全平）

```
条件：low <= stop_price
动作：
  若开盘跳空（open < stop_price）→ 以 open 成交（滑点保护）
  否则                           → 以 stop_price 成交
  cash_delta += proceeds
  记录 TradeRecord（is_half=False）
  → return "exit_full"，当根结束
```

> 同一根 K 线先触发阶段止盈再触发止损时：先半仓止盈，再对**剩余仓位**止损全平。

---

### 步骤 ①'：阶段止盈后止损调节（仅 hit_profit 时）

```
条件：hit_profit == True（本根已触发半仓止盈）

更新 max_close = max(max_close, close)
new_stop = (entry_price + max_close) / 2
new_stop = max(stop_price, new_stop)
更新 stop_price = new_stop，stop_reason = "阶段止盈后止损"

若 close < new_stop:
    全平剩余仓位 @ close
    exit_reason = "阶段止盈后收盘止损"
    → return "exit_full"
若 close >= new_stop:
    继续持仓，进入步骤 ②
```

---

### 步骤 ②：收盘价检查（MA5 规则，无论 hit_profit 真假均执行）

更新 `max_close = max(max_close, close)`，然后：

#### 规则 A：突破 MA5 标记

```
条件：not broke_ma5 AND close > MA5
动作：broke_ma5 = True
→ 不出场，继续
```

#### 规则 B：MA5 下跌破线出场（优先级高于规则 C）

```
条件：close < MA5 AND MA5 <= prev_MA5 AND broke_ma5
动作：全平 @ close
      exit_reason = "MA5下跌破线"
      → return "exit_full"
```

#### 规则 C：MA5 首次上升 → 调节动态止损

```
条件：not ma5_stop_adjusted AND MA5 > prev_MA5
计算：new_stop = (entry_price + max_close) / 2
      new_stop = max(current_stop, new_stop)
子情况：
  若 close < new_stop → 全平 @ close，exit_reason = "MA5上升后止损"
  若 close >= new_stop → 上移止损至 new_stop
                         stop_reason 更新为 "MA5首次上升止损"
                         ma5_stop_adjusted = True
```

> 规则 B 与规则 C 互斥（B 需 `MA5 <= prev_MA5`，C 需 `MA5 > prev_MA5`），不会在同一根 K 线同时触发。

---

### 步骤 ③：更新持仓计数

```
pos.candle_count += 1
return None, cash_delta, trades    ← None 表示继续持仓
```

---

## 阶段 5：出场汇总

所有出场动作均返回 `"exit_full"` 或产生 `TradeRecord`，由 `run_backtest` 统一处理：

| 出场原因 | 触发阶段 | 成交价 |
|---------|---------|-------|
| 阶段止盈（半仓，`is_half=True`） | 盘中 high | `recent_high` |
| ATR止损 / 最大亏损止损 | 盘中 low | `stop_price`（或 open，跳空时） |
| 阶段止盈后收盘止损 | 开仓当根/持仓当根收盘（hit_profit 后）| `close` |
| MA5下跌破线 | 收盘（规则 B） | `close` |
| MA5上升后止损 | 收盘（规则 C，MA5 首次上升） | `close` |
| 回测结束强制平仓 | 最后一根 K 线 | `close` |

---

## 止损价动态变化轨迹

```
开仓
  │
  ├─ 初始止损 = max(loss_atr_14[前一根], entry × (1 - MAX_INIT_LOSS))
  │
  ├─ 阶段止盈触发（high >= recent_high）
  │      → 止损上移至 (entry + max_close) / 2
  │         stop_reason = "阶段止盈后止损"
  │
  └─ MA5 首次上升（规则 C）
         → 止损上移至 max(当前止损, (entry + max_close) / 2)
            stop_reason = "MA5首次上升止损"
```

---

## 仓位管理规则

| 规则 | 值 |
|------|---|
| 最大同时持仓数 | `MAX_POSITIONS = 2` |
| 单仓资金比例 | `POSITION_RATIO = 0.45`（基于当前净值） |
| 特例：2 仓均已阶段止盈 | 允许开第 3 仓（`all_half = True`） |
| 最小开仓资金 | `MIN_OPEN_CASH`（低于此值跳过挂单） |

---

## 主循环每根 K 线执行顺序

```
for ts in timestamps:
  ① 执行上一时间步挂单的买入（open 价成交）
  ② 遍历所有持仓，执行 process_candle 或开仓当根逻辑
  ③ 计算持仓市值，记录净值快照与持仓快照
  ④ 判断是否允许开新仓 → scan_signals → 挂入 pending_buys
```
