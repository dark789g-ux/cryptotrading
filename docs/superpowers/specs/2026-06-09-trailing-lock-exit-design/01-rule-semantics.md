# 01 · 规范算法（单一真值）

> 本文是三模块共用的**唯一行为真值**。共享纯函数核（[02](./02-shared-core-and-contracts.md)）与
> 同构 TS 版必须逐字实现本文逻辑，并用同组样例对拍。

## 一、通用约定

- **价格基准**：每个模块用各自原生复权价（signal-stats=qfq，exit_rules=hfq，kelly_sweep=qfq）。
  本文统一记复权价为 `adj_open/adj_high/adj_low/adj_close`；限停板判定用未复权价 `raw_open/raw_high`
  与 `up_limit/down_limit`（均未复权）。同一交易日两套价取自 `raw.daily_quote` 同一行 + `raw.stk_limit` 同一行。
- **止损价取整**：`止损价 = floor2(基准价 × 0.999)`，`floor2(x)` = 向下截断到 0.01（`Math.floor(x*100)/100`，
  Python `math.floor(x*100)/100`）。施加在复权价上，属标称取整（复权价不在真实 0.01 跳价格点上，接受此近似）。
- **信号 K 线 / 持仓首日 / 成本价**：信号 K 线 = T（触发买入那根）；持仓首日 = T+1，**开盘买入**；
  成本价 `cost = adj_open(T+1)`。**信号 K 线最高价 `signal_high = adj_high(T)`**（与持仓期 low 同为复权基准）。
- **"次日 / 此后每个交易日"**：均指**下一个可交易日**（跳过停牌日）。
- **停牌**：停牌日 `raw.daily_quote` 无行 / 复权价为空 → 该日**不计持有、不触发、不更新止损**（等复牌）。

## 二、入场（持仓首日 T+1 = bars[0]）

```text
若 T+1 停牌 / 无 quote                         → 信号不成立 (no_entry: suspended)
若 raw_open(T+1) ≥ up_limit(T+1)  (limit 非空) → 买不进，信号不成立 (no_entry: limit_up)
否则：
  cost   = adj_open(T+1)
  方案    = 1  若 adj_close(T+1) >  adj_open(T+1)
          = 2  若 adj_close(T+1) ≤  adj_open(T+1)
  # 持仓首日"收盘后"设定、T+2 生效的初始止损：
  stop_next = floor2(adj_open(T+1) × 0.999)   (方案一)
            = floor2(adj_low (T+1) × 0.999)   (方案二)
  状态: locked=False, floor_active=False, pending=None, prev_ma5=ma5(T+1)
```

注：持仓首日**不会被自身当天止损**——它的止损价在其收盘后才设定，T+2 才生效。买入端"一字涨停买不进"
用 `raw_open ≥ up_limit`（买入只能开盘成交，开盘顶格即买不进），不顺延、不追高，该信号直接判不成立。

## 三、逐日推进（从 T+2 起，i = 1, 2, …）

每个交易日 `bars[i]`（i=1,2,…）**先判停牌**：停牌日 `continue`（不计 hold / 不触发 / 不更新止损 / 不动 prev_ma5）。
非停牌日：

```text
hold += 1                            # 已走过的可交易持有日数；持仓首日 bars[0] 记 hold=0，此处从 1 起递增
stop_eff = stop_next                 # 今日生效的止损 = 昨日收盘设定的那个

── (0) 顺延中？ pending ≠ None:
        若 非封死跌停(raw_high > down_limit) → 出场 @adj_open, reason=pending, scheme, hold_days=hold, 结束
        否则 → 仍封死，continue（继续顺延）

── (1) 日内止损： stop_eff 非空 且 adj_low ≤ stop_eff ?
        若 封死跌停(raw_high ≤ down_limit) → pending='stop'，continue（卖不出，顺延）
        否则 → 出场 @min(stop_eff, adj_open), reason='stop', hold_days=hold, 结束
        # 跳空低开（open<stop）按开盘价成交，故取 min

── (2) 收盘处理（未被止损）：
     (2-pre) 方案二保本地板激活（每个交易日都评估，含锁定当日；sticky）：
             若 方案二 且 adj_close > cost → floor_active = True
     (2a) 未锁定 且 adj_low > signal_high  →  锁定：
             stop_next = floor2(adj_low × 0.999)
             若 方案二 且 floor_active     →  stop_next = max(stop_next, floor2(cost × 0.999))
             locked = True                #（从此冻结，stop_next 不再更新）
     (2b) 已锁定（含本日刚锁定）→ MA5 收盘离场：
             若 ma5 非空 且 prev_ma5 非空 且 adj_close < ma5 且 ma5 < prev_ma5 :
                 若 封死跌停 → pending='ma5_exit'，prev_ma5=ma5，continue（顺延；本日不再评估 max_hold）
                 否则 → 出场 @adj_close, reason='ma5_exit', hold_days=hold, 结束
     (2c) 未锁定 → 更新"次日生效"止损 stop_next：
             方案二: floor_active → stop_next = max(floor2(adj_low×0.999), floor2(cost×0.999))
                     否则         → stop_next = floor2(adj_low × 0.999)
             方案一: stop_next = floor2(adj_low × 0.999)
     (2d) （可选）max_hold 兜底：hold ≥ max_hold → 出场 @adj_close, reason='max_hold', hold_days=hold, 结束
     prev_ma5 = ma5

── 窗口耗尽未出场 → 返回 no_exit，由调用方按各自终止口径处理（见第六节）
```

> 计数说明：`hold` 数的是 buy_date 之后**已走过的可交易日**（停牌不计），与 signal-stats 现有
> `tradableCount` / `holdDays` 口径一致（持仓首日 = 第 0 天）。`max_hold=N` 即在第 N 个可交易持有日强平。
> `floor_active` 的激活上移到 (2-pre)，确保"某日首次 close>cost 当天恰好也锁定"时保本地板即刻生效（P3 裁决）。
> (2b) 顺延一旦置 `pending` 即 `continue`，**不落 (2d)**，避免同 bar 被 max_hold 覆盖 ma5_exit 意图（P4 裁决）。

**执行顺序铁律**：同一交易日内 **日内止损（1）优先于 收盘 MA5 离场（2b）**（止损盘中成交、MA5 收盘才判）。
锁定从 **T+2 起**评估，持仓首日只定方案 + 初始止损、不评估锁定、不触发任何出场。锁定后 `stop_next` 冻结、
不再随低点更新；MA5 离场**仅锁定后**生效。

## 四、两套方案差异速查

```text
                         方案一 (持仓首日 close>open)   方案二 (持仓首日 close≤open)
初始止损(T+2生效)         open(T+1)×0.999               low(T+1)×0.999
此后每日跟踪止损(未锁定)   low(D)×0.999                  max(low(D)×0.999, cost×0.999) 若已浮盈站上成本
保本地板                  无                            有：某日 close>cost 后永久 max(…, cost×0.999)
锁定条件                  low(D) > signal_high          同左
锁定后止损                冻结当日 low×0.999             冻结 max(low×0.999, [地板])
锁定后 MA5 收盘离场        有                            有
```

## 五、限停板流动性

| 场景 | 判定（未复权价 vs stk_limit） | 处理 |
|---|---|---|
| 一字涨停买不进 | `raw_open(T+1) ≥ up_limit(T+1)` | 信号不成立（no_entry: limit_up），不顺延 |
| 封死跌停卖不出 | 出场触发日 `raw_high(D) ≤ down_limit(D)` | 顺延：置 `pending`，到下一个**非封死跌停且非停牌**日按其 `adj_open` 成交，reason 保留 |
| 涨停日卖出 | —— | **不挡**（有买盘，可正常卖出） |

- 买入用 `raw_open`（买入只能开盘成交，开盘顶格即买不进）；卖出用 `raw_high`（盘中只要离开过跌停板就有机会卖，
  全天最高价都没超过跌停价才算封死）。两端口径不对称是**有意为之**，各自匹配"买在开盘 / 卖在任意时刻"的现实。
- `up_limit/down_limit` 缺失（stk_limit 无该行）→ 该端约束**不生效**（不因缺数据误杀）。
- 顺延期间不再重新跟踪/锁定，只等第一个可卖日开盘卖出；若直到窗口末仍封死 → no_exit → 调用方 force_close 兜底。

## 六、终止与边界（调用方口径，核函数不处理退市）

- **核函数职责边界**：`band_lock_exit` 只负责跟踪 + 锁定 + MA5 + 限停板顺延，**不处理退市**。
  窗口内未出场 → 返回 `no_exit`，由各模块用既有终止机制收口：
  - exit_rules：`force_close_date` / 数据末尾 → 按 `_last_valid_close` 强平（`exit_reason='force_close'`，沿用
    `exit_rules.py:476/639-643`）。
  - signal-stats：退市强平沿用 `delistDate` 分支（`exit_reason='delist'`），窗口不足 → `insufficient_data`。
  - kelly_sweep：`delist_date` / maxHold 兜底沿用现有出场族口径。
- **MA5 预热**：MA5 = **5 个非停牌交易日**的复权收盘均值（停牌日不进窗口，与 `_ensure_ma` /
  `buildHoldingDays` 实际口径一致），持仓首日 T+1 需 T-3..T+1 这 5 个有行交易日的收盘价。数据窗口须
  **左扩 ≥4 个交易日**；预热不足时 `ma5=None`，(2b) 因 `ma5 非空` 守卫自然跳过 MA5 离场（止损逻辑不受影响）。
- **prev_ma5**：取**上一个已处理（非停牌）交易日**的 MA5，对应"前一交易日 MA5"。
- **scheme 落库**：出场结果带 `scheme ∈ {1,2}`，供复盘区分两套方案命中分布。

## 七、最小可复算例（方案一，便于对拍）

```text
设 signal_high=10.00；T+1: open=10.0, low=9.8, close=10.2（close>open→方案一）, cost=10.0
  → stop_next(给T+2) = floor2(10.0×0.999)=floor2(9.99)=9.99
T+2: low=10.5, high=10.6（>signal_high 10.0）, close=10.5
  → (1) low 10.5 ≤ stop_eff 9.99? 否
  → (2a) 未锁定 且 low 10.5 > signal_high 10.0 → 锁定：stop_next=floor2(10.5×0.999)=floor2(10.4895)=10.48, locked
  → (2b) 需 prev_ma5/ma5，略
T+3: low=10.40 ≤ stop_eff 10.48 → (1) 触发，非封死跌停 → 出场 @min(10.48, open(T+3))，reason='stop'
```

完整对拍样例集（含方案二保本地板、顺延、停牌、MA5 离场）见 [02 §对拍样例](./02-shared-core-and-contracts.md#四对拍样例集)。
