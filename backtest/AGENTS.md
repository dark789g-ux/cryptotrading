# AGENTS.md — backtest/ 回测库

> L2 层：编写回测相关代码前阅读本文件。需要实现细节时再读对应源文件（L3）。

---

## 模块职责

`backtest/` 是一个纯 Python 包，被 `backtest_strategy.py` 调用，**不直接运行**。
它封装了从配置到引擎、再到报告输出的完整回测流水线。

---

## 文件速查

| 文件 | 职责 | 关键导出 |
|------|------|---------|
| `config.py` | 所有运行常量与路径 | `INITIAL_CAPITAL`, `POSITION_RATIO`, `MAX_POSITIONS`, `KLINES_DIR`, `OUTPUT_DIR`, `EXCLUDED_SYMBOLS` 等 |
| `models.py` | 数据结构定义 | `Position`, `TradeRecord`（dataclass） |
| `data.py` | CSV 加载、预热裁剪、全局时间轴构建 | `load_data() → (dict[str,DataFrame], dict[str,int])` |
| `indicators.py` | 近期高低价计算（回溯窗口） | `calc_recent_high(df, idx)`, `calc_recent_low(df, idx)` |
| `engine.py` | 主回测循环 | `run_backtest()` |
| `position_handler.py` | 单根 K 线持仓处理 | `process_candle()`, `process_entry_candle()` |
| `signal_scanner.py` | 入场信号扫描与盈亏比计算 | `scan_signals()` |
| `trade_helper.py` | 交易记录创建辅助 | `create_trade_record()` |
| `cooldown.py` | 交易对冷却期管理 | `set_cooldown()` |
| `loss_tracker.py` | 连续亏损追踪与全局冷却 | `LossTracker` |
| `report.py` | 统计计算、CSV/JSON 输出 | `calc_stats()`, `save_results()` |

---

## 回测数据规范

### 输入 CSV 列（来自 `cache/1h_klines/*.csv`）

回测引擎依赖以下列，列名缺失时会抛出 `KeyError`：

```
open_time   # UTC+8 字符串，格式 YYYY-MM-DD HH:MM:SS
open, high, low, close, volume
MA30, MA60, MA120, MA240     # 移动均线
KDJ.K, KDJ.D, KDJ.J         # KDJ 指标
MACD, MACD_Signal, MACD_Hist # MACD 指标
loss_atr_14                  # ATR 止损价（close - 1.5×ATR14）
stop_loss_pct                # 止损幅度百分比
risk_reward_ratio            # 盈亏比（近期高低点计算）
```

### 预热期

`config.WARMUP_BARS = 240`：每个标的至少需要 240 根有效 K 线，MA240 才稳定，
不足则该标的跳过（`data.py` 负责裁剪）。

---

## 策略逻辑摘要

### 入场信号（`signal_scanner.scan_signals`）

```
close > MA60
AND MA30 > MA60 > MA120
AND close > MA240
AND KDJ.J < 10
```

满足条件后计算盈亏比 = (近期高点 − 买入价) / (买入价 − 近期低点)，
按盈亏比降序取优先标的，**下一根 K 线开盘价买入**（挂单延迟一根）。

### 仓位管理

- 最大同时持仓：`MAX_POSITIONS = 2`
- 单仓资金比例：`POSITION_RATIO = 0.45`（基于当前净值）
- 若 2 仓均已完成阶段止盈（`half_sold=True`），允许开第 3 仓

### 出场条件（优先级从高到低）

1. **阶段止盈**：当根 `high ≥ 近期高点` → 卖出一半
2. **止损**：当根 `low ≤ stop_price` → 全平（开盘跳空时以 open 成交）
3. **收盘跌破成本**：第 3 根及之后，`close ≤ entry_price` → 全平
4. **MACD 从未上升**：持仓第 5 根及之后，MACD 从未上升 → 全平
5. **MACD 趋势转正后收阴**：MACD 首次上升但收盘跌破新止损价 → 全平
6. **MACD 回落后**：MACD 由升转降，止损价收紧至盈利的 80%

### 止损价动态调整

- 初始止损：`max(loss_atr_14, entry_price × (1 − MAX_INIT_LOSS))`
- MACD 首次上升后：止损上移至 `entry + (max_close − entry) × 0.2`
- MACD 由升转降：止损上移至 `entry + (max_close − entry) × 0.8`

---

## 输出格式

每次回测在 `backtest_results/{YYYYMMDD_HHMMSS}/` 下生成：

```
trades.csv          # 每笔已完结交易（含半仓止盈记录）
portfolio.csv       # 每根 K 线的净值快照
report_data.json    # 供 Vue 回测结果等使用的完整数据（含统计与持仓快照）
```

---

## 修改指引

| 想做的事 | 改哪里 |
|---------|-------|
| 调整资金/仓位参数 | `config.py` 顶部常量 |
| 修改入场信号条件 | `signal_scanner.scan_signals()` |
| 修改止损/止盈规则 | `position_handler.process_candle()` |
| 修改买入当根处理逻辑 | `position_handler.process_entry_candle()` |
| 修改冷却期设置 | `cooldown.py` |
| 修改连续亏损追踪 | `loss_tracker.py` |
| 增加新指标列 | `fetch_klines.py`（采集侧）+ `data.py`（加载侧）+ `engine`（使用侧）|
| 增加统计指标 | `report.calc_stats()` |
| 排除某标的 | `config.EXCLUDED_SYMBOLS` |

---

## 不变量

- `open_time` 格式必须为 UTC+8 字符串，引擎用它做时间轴对齐（`ts_to_idx` 字典）
- `position_handler.process_candle` 返回 `(action, cash_delta, trades)`，**不直接修改 cash**；由 `run_backtest` 统一管理现金
- `TradeRecord.is_half=True` 表示阶段止盈半仓，不代表完整出场
- 各模块保持单一职责：`engine.py` 仅包含主回测循环，具体逻辑分散到 `position_handler`、`signal_scanner` 等子模块

---

## 延伸阅读

- [持仓周期完整流程](HOLDING_CYCLE.md) — 每笔交易从信号产生到出场的逐阶段详解
