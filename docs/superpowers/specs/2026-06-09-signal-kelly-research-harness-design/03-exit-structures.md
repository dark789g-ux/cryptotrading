# 03 · 新出场结构库（撬动盈亏比 b — 系统当前空白）

← 返回 [index](./index.md)　|　上一篇 [02 入场](./02-entry-features.md)　|　下一篇 [04 扫描与护栏](./04-grid-sweep-guardrails.md)

出场结构是作用在「前向 qfq O/H/L/C 路径」上的**纯函数**，输入 (路径, 参数)，输出 `exit_date / exit_price / ret / hold_days / exit_reason`。所有出场都带 `maxHold` 兜底。

## 1. 出场结构与参数网格

| 结构 | 参数 | 候选网格 | 触发逻辑 |
|---|---|---|---|
| `fixed_n`（基线/复现） | N | 1 / 2 / 3 / 5 / 10 | 第 N 个可交易日出场，`exit_price = 当日 qfq_close` |
| `tp_sl` 固定止盈止损 | TP%, SL%, maxHold | TP∈{3,5,8,12}% × SL∈{2,3,5}% × maxHold∈{5,10,20} | 见 §2–§5 |
| `trailing` 移动止损 | Z%, maxHold | Z∈{3,5,8}% × maxHold∈{10,20} | 见 §6 |
| `atr_stop` ATR 止损 | k, maxHold, 可选移动 | k∈{1.5,2,3} × maxHold∈{10,20} | 见 §7 |

其中 `tp_sl` 的**非对称**结构（如 +8% / −3%）是直接结构性抬高 b 的核心杠杆。

## 2. 价格基准与触发位

- 基准价 `entry = buy_date 的 qfq_open`（与 [index §6](./index.md#6-已核对的事实锚点实现时直接信任禁止再凭二手转述改写) 的 ret 口径一致）。
- 止盈位 `TP_level = entry × (1 + TP)`；止损位 `SL_level = entry × (1 − SL)`。
- 逐个可交易日（停牌跳过）按时间序检查触发。

## 3. 盘中触发判定（硬口径）

对每个可交易日 d（有行情）：

```text
触止盈?  qfq_high[d] >= TP_level
触止损?  qfq_low[d]  <= SL_level
```

只要当日满足其一即在 d 出场。**exit_price 不取收盘价**，取触发位（受 §4 跳空修正）——这是 TP/SL 引入的新口径，与现有 simulator 用 `qfq_close` 不同，Phase 2 交叉验证必须照此对齐。

## 4. 跳空修正（不许卖在不存在的价位）

若当日**开盘已越过触发位**，按开盘价成交，不假装卖在触发位：

```text
止损: 若 qfq_open[d] <= SL_level  → exit_price = qfq_open[d]   (跳空低开，比止损位更差)
止盈: 若 qfq_open[d] >= TP_level  → exit_price = qfq_open[d]   (跳空高开，比止盈位更好)
否则                              → exit_price = 对应触发位
```

## 5. 同日双触发：止损优先（保守）

当同一日 `qfq_high>=TP_level` **且** `qfq_low<=SL_level`（日内先后顺序无法从日线判定）：

```text
┌──────────────────────────────────────────┐
│  同日 high≥TP 且 low≤SL                    │
│        │                                   │
│        ▼   日内顺序未知 → 取保守            │
│  判定为「先触止损」                         │
│  exit_reason = 'sl'                        │
│  exit_price  = SL_level（若跳空低开取 open）│
└──────────────────────────────────────────┘
```

**理由**：保守假设使报出的凯利不虚高，作为"可信上界"主口径。`metrics.py` 留一个 `same_day_rule ∈ {sl_first, tp_first}` 开关（默认 `sl_first`），需要看乐观上界时可切 `tp_first`，但默认与报告主口径恒为 `sl_first`。

## 6. trailing（移动止损）

- 维护持有期内 `peak = max(qfq_high[buy_date..d])`。
- 触发：`qfq_low[d] <= peak × (1 − Z)` → 出场，`exit_reason='trailing'`。
- exit_price：回撤位 `peak×(1−Z)`；若当日跳空低于该位则取 `qfq_open[d]`（同 §4）。
- peak 更新与触发同日的次序：**先用昨日 peak 判触发，再用今日 high 更新 peak**（避免用未来高点豁免今日触发）。

## 7. atr_stop（ATR 止损）

- 初始止损 `SL_level = entry − k × ATR14(signal_date)`（ATR 取信号日值；口径见 [02 口径警告](./02-entry-features.md#1-特征定义表)）。
- 触发同 §3/§4（`qfq_low<=SL_level`）。
- 可选移动模式 `atr_trailing=true`：止损位随 `peak − k×ATR` 上移（ATR 用信号日固定值，避免每日重算引入路径噪声；是否每日重算留作配置 `atr_dynamic`，默认固定）。
- `exit_reason='atr'`。

## 8. maxHold 兜底、停牌与退市（沿用现有口径）

- 到 `maxHold` 个可交易日仍未触发任何止盈/止损 → 第 maxHold 日 `qfq_close` 强平，`exit_reason='max_hold'`。
- 停牌日跳过、不占 maxHold 额度（与 `simulator.ts:239` 一致）。
- 退市优先：`calDate >= delistDate`（当前交易日已到/过退市日）取上一有效日 `qfq_close` 强平，`exit_reason='delist'`。

## 9. exit_reason 取值集（Phase 1 扩展）

`max_hold | delist | tp | sl | trailing | atr`。其中 `tp/sl/trailing/atr` 为 Phase 1 新增（现有库只有 `max_hold/signal/delist`）。Phase 2 回迁 NestJS 时同步扩展 `signal_test_trade.exit_reason` 取值。
