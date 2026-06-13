# 01 · 算法精确化

[← index](./index.md) · 参数与编码见 [02](./02-params-scheme-grid.md) · 对拍样例见 [06](./06-fixtures-and-testing.md)

## 方案选型与边界复用

| 方案 | 做法 | 取舍 |
|------|------|------|
| **A. 全新独立纯函数核（采用）** | 与 band_lock 平行新建 `phase_lock_exit.py` / `decidePhaseLock` / `phase_lock_scheme.py` / `phase_lock_grid`，**复制（非共享）** band_lock 的 A 股边界骨架 | ✅ 互不污染、band_lock 对拍/哈希守门零风险；❌ ~30 行边界骨架重复 |
| B. 抽公共"A 股出场骨架" | 重构 band_lock 出可插拔决策核 | ❌ 动 band_lock = 赌它已绿的 S1~S19 对拍 + 哈希守门；YAGNI（才第 2 条规则） |
| C. band_lock 加 mode 开关 | `simulate_band_lock` 加分支 | ❌ 两者触发条件/初始止损根本不同，污染概念纯度、哈希漂移风险最高 |

**采用 A**。两条规则的决策核本质不同（触发条件、初始止损基准、阶段 A 固定 vs band_lock 逐日上移），现在抽公共核是过早抽象。复制 ~30 行边界骨架（停牌跳过、涨停不入场、封死跌停顺延、`floor2` 两位截断）比跨切面重构更便宜更安全。等出现第 3 条规则再抽。

> ⚠️ **路径纠偏**：`exit_rules.py` 的 `_RULE_BUILDERS` / `ExitRuleType` 是 **strategy_aware 可组合规则**路径（stop_loss/ma_break/...），**不是** band_lock 的路子。band_lock 是**独立 scheme**（专属 labels 模块 + scheme 编码器 + runner 独立有状态分支，绕开 strategy_aware 的 first-match `build_exit_rules`）。phase_lock 对齐 band_lock，**绝不碰** `_RULE_BUILDERS` / `ExitRuleType`。

## 状态机

```text
              建仓 T+1 开盘买入 (cost = T+1 复权 open)
                        │  止损 T+2 起盘中生效, 持仓首日(T+1)不出场
                        ▼
        ┌───────────────────────────────────┐
        │  阶段 A：初始止损（固定，不上移）   │
        │  stop = floor2( min(最近 lookback 根 │
        │    含 T+1 的非停牌复权 low) × init_factor)│
        └───────────────────────────────────┘
              │                         │
  盘中 low≤stop│                         │收盘 close>MA5 且 MA5>前一非停牌日MA5
  (止损优先)   │                         │(仅一次 → 阶段切换, 新止损次日生效)
              ▼                         ▼
        ╳ phase_lock_stop      ┌───────────────────────────────────┐
        fill=min(stop,open)    │  阶段 B：锁定（止损冻结不再动）     │
                               │  stop = floor2( MAX(cost,当日low)    │
                               │           × lock_factor )            │
                               └───────────────────────────────────┘
                                     │                    │
                        盘中 low≤stop │                    │收盘 close<MA5 且 MA5<前一非停牌日MA5
                        (止损优先)    │                    │
                                     ▼                    ▼
                               ╳ phase_lock_stop    ╳ phase_lock_ma5
                                                    (按收盘价出场)
```

## 每个交易日内判断顺序（钉死优先级）

```text
 停牌? ──是──▶ 跳过: 不计 hold / 不动止损 / 不动 prev_ma5
  │否
 上日封死跌停顺延中? ──是──▶ 今日非封死跌停→按顺延原因出场(开盘价); 否则继续顺延
  │否
 ① 盘中止损  low ≤ stop_eff ?  ──是──▶ 封死跌停→置顺延; 否则出场 fill=min(stop,open)   ◀ 最高优先
  │否 (当日未触止损)
 ② 收盘判断
     阶段A: 满足切换(close>MA5 且 MA5↑)? → 上移止损 + 锁定(次日生效); 否则止损不动(固定)
     阶段B: 满足清仓(close<MA5 且 MA5↓)? → 按收盘价出场; 否则止损冻结
  ▼
 (无 max_hold 兜底 —— 按用户选择不设硬上限)
```

## 纯函数核接口（Python / TS 同构）

为让"min(最近 lookback 根低)"在 core 内被两侧逐位对拍，**数据层左扩 `max(lookback, MA5 窗口=5)` 根**，
把切好的 `recent_lows`（含 T+1 的最近 lookback 个**非停牌**复权 low，按时间升序）作为标量数组传入 core
（类比 band_lock 传 `signal_high`）。`ma5` 仍按各 bar 预先附好。

```text
simulate_phase_lock(
    bars,            # bars[0]=T+1 持仓首日；每根含 OHLC(复权+raw)/ma5/限停板/停牌标志
    recent_lows,     # 含 T+1 的最近 lookback 个非停牌复权 low（数据层切好，升序）
    init_factor,     # 初始止损系数（× min(recent_lows)）
    lock_factor,     # 锁定止损系数（× MAX(cost, 当日 low)）
) -> Outcome{
    kind,            # 'exit' | 'no_exit' | 'no_entry'
    reason,          # 'phase_lock_stop' | 'phase_lock_ma5' | 'suspended' | 'limit_up' | None
    exit_index,      # bars 中出场下标（no_exit/no_entry 为 None）
    exit_price,      # 复权出场价
    hold_days,       # 已走过的可交易持有日数
    locked,          # 是否曾进入阶段 B（调试/统计用）
}
```

固定常量（不入参、不可配）：`ma5_require_down = True`、`ma5_require_up = True`、无 `max_hold`。

## 逐 bar 算法（伪代码，基于精确化语义）

```text
simulate_phase_lock(bars, recent_lows, init_factor, lock_factor):
  entry = bars[0]                          # T+1 持仓首日
  若 entry 停牌 → no_entry(suspended)
  若 entry.raw_open >= entry.up_limit（两者非 None）→ no_entry(limit_up)   # 涨停开盘不入场
  cost = entry.adj_open

  # 初始止损（阶段 A，固定）：含 T+1 的最近 lookback 根非停牌低的最小值 × init_factor
  # recent_lows 已由数据层切好；不足 lookback 根 → 用现有可用根数（至少含 T+1 一根），不 fail
  init_stop = None if recent_lows 为空 else floor2( min(recent_lows) × init_factor )
  # 注：T+1 必有一根，recent_lows 理论非空；空仅为防御（init_stop=None → 阶段 A 无盘中止损，交由阶段切换接管）

  stop_next = init_stop                    # T+2 起盘中生效
  locked = False
  pending = None
  hold = 0
  prev_ma5 = entry.ma5

  对每个 bar = bars[i], i in 1..N-1:
    若 bar 停牌: continue                   # 不计 hold / 不动止损 / 不动 prev_ma5
    hold += 1
    stop_eff = stop_next
    dead_limit_down = (bar.raw_high <= bar.down_limit)   # 封死跌停

    # (0) 顺延中（上日封死跌停未能出场）
    若 pending is not None:
      若 not dead_limit_down: 返回 exit(reason=pending, index=i, price=bar.adj_open, hold)
      else: continue

    # (1) 盘中止损 [最高优先]
    若 stop_eff is not None 且 bar.adj_low <= stop_eff:
      若 dead_limit_down: pending = 'phase_lock_stop'; continue
      fill = min(stop_eff, bar.adj_open)   # 跳空低开取开盘价
      返回 exit(reason='phase_lock_stop', index=i, price=fill, hold)

    # (2) 收盘判断（当日未触止损）
    若 not locked:
      # 阶段切换：close>MA5 且 MA5>prev_ma5（ma5_require_up 钉死 True），仅一次
      若 bar.ma5 is not None 且 prev_ma5 is not None
         且 bar.adj_close > bar.ma5 且 bar.ma5 > prev_ma5:
        stop_next = floor2( max(cost, bar.adj_low) × lock_factor )   # 上移并冻结
        locked = True
      # 否则：stop_next 保持初始值不变（阶段 A 固定，关键差异）
    else:   # 阶段 B
      # 清仓：close<MA5 且 MA5<prev_ma5（ma5_require_down 钉死 True）
      若 bar.ma5 is not None 且 bar.adj_close < bar.ma5
         且 prev_ma5 is not None 且 bar.ma5 < prev_ma5:
        若 dead_limit_down: pending = 'phase_lock_ma5'; prev_ma5 = bar.ma5; continue
        返回 exit(reason='phase_lock_ma5', index=i, price=bar.adj_close, hold)
      # 否则：止损冻结，stop_next 不变

    prev_ma5 = bar.ma5

  返回 no_exit
```

## 关键语义钉死（避免对拍分叉）

1. **阶段 A 止损固定不上移** —— 这是与 band_lock 最大差异。band_lock 未锁定时每日用当日 low 上移 `stop_next`；phase_lock 阶段 A `stop_next` 恒为 `init_stop`。
2. **止损 T+2 起生效** —— 循环从 `i=1`（T+2）起，持仓首日 T+1 不出场。阶段切换当日设的新止损同样**次日生效**（当日已过盘中止损检查）。
3. **阶段切换与清仓互斥** —— 切换要求 MA5↑+close>MA5；清仓要求 MA5↓+close<MA5，同 bar 不可能同时满足；阶段切换当日不评估清仓。
4. **两个独立 factor** —— `init_factor` 仅作用于初始止损，`lock_factor` 仅作用于锁定止损。
5. **`floor2(x) = math.floor(x*100)/100`（Py）= `Math.floor(x*100)/100`（TS）** —— 逐位一致。
6. **MA5 口径**：5 个非停牌交易日复权 close 均值（行位移 `close.shift`，与日历无关）；"前一非停牌日 MA5" = 上一个**非停牌** bar 处理结束时记录的 `prev_ma5`。
7. **复权口径**：Python 用 hfq（`*_adj`），TS 用 qfq（`qfq*`），各自与所在模块的 band_lock 现状一致；同一笔交易两侧结果须一致（band_lock 已验证此等价性）。

## A 股边界处理（复制 band_lock 现状语义）

- **停牌**：`bar` 停牌（复权 close 为 None 或停牌标志）→ 跳过，不计 hold、不动止损、不动 `prev_ma5`。
- **涨停开盘不入场**：T+1 `raw_open >= up_limit` → `no_entry(limit_up)`。
- **封死跌停顺延**：止损 / 清仓本应触发但当日 `raw_high <= down_limit`（封死跌停，卖不出）→ 置 `pending`，后续首个非封死跌停日按 `pending` 原因以开盘价出场。
- **不足 lookback 根（次新股 / 窗口不够）**：`recent_lows` 用现有可用根数（至少含 T+1），不 fail、不 no_entry。
