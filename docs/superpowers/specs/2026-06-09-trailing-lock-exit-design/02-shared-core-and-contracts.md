# 02 · 共享纯函数核与接口契约

> 规则语义见 [01](./01-rule-semantics.md)。本文把语义固化成**可测的接口**：Python 共享核 `band_lock_exit.py`
> 是单一真值；NestJS 写**同构** TS 版（不跨语言共享代码），两边跑[第四节](#四对拍样例集)同组样例保证一致。

## 一、Python 共享核 `band_lock_exit.py`

新建：`apps/quant-pipeline/src/quant_pipeline/strategy/band_lock_exit.py`

### 1.1 逐 bar 输入记录（持仓窗口，T+1 起升序）

```python
@dataclass(frozen=True)
class BandLockBar:
    # —— 复权价(各模块基准)，停牌日全部为 None ——
    adj_open:  float | None
    adj_high:  float | None
    adj_low:   float | None
    adj_close: float | None
    ma5:       float | None          # 5日复权收盘均值；预热不足为 None
    # —— 未复权价 + 限停板，用于流动性判定；缺失为 None(该端约束不生效) ——
    raw_open:  float | None
    raw_high:  float | None
    up_limit:  float | None
    down_limit: float | None
    is_suspended: bool = False       # 冗余防御；停牌通常表现为 adj_* 为 None
```

`is_suspended or adj_close is None` 即视为停牌日（与 exit_rules 现有"停牌日缺行被自然跳过"口径一致，
见 `exit_rules.py:501-502`）。

### 1.2 函数签名与返回

```python
def simulate_band_lock(
    bars: Sequence[BandLockBar],
    signal_high: float,              # = 信号K线 T 的复权最高价
    *,
    max_hold: int | None = None,     # None=不设硬上限(默认)
) -> BandLockOutcome:
    ...

@dataclass(frozen=True)
class BandLockOutcome:
    kind: str                        # 'no_entry' | 'exit' | 'no_exit'
    reason: str | None = None        # no_entry: 'suspended'|'limit_up'
                                     # exit: 'stop'|'ma5_exit'|'max_hold'
    exit_index: int | None = None    # bars 下标(命中出场的那根)
    exit_price: float | None = None  # 复权价(各模块再换算/直接用)
    scheme: int | None = None        # 1 | 2
    hold_days: int | None = None     # 已走过的可交易持有日数(停牌不计)
```

- `kind='no_entry'`：买入端不成立（停牌 / 一字涨停）。
- `kind='exit'`：命中 stop / ma5_exit / max_hold；`exit_index/price/reason/scheme/hold_days` 齐全。
- `kind='no_exit'`：窗口耗尽未出场（含顺延未解），调用方按各自终止口径收口（[01 §六](./01-rule-semantics.md#六终止与边界调用方口径核函数不处理退市)）。

**核函数不处理退市 / force_close / 数据末尾兜底**——交由调用方既有机制，保持核聚焦、可独立测试。

## 二、NestJS 同构 TS 版

在 `apps/server/src/strategy-conditions/signal-stats/signal-stats.simulator.ts` 内新增纯函数
`decideBandLock(days: HoldingDaySnapshot[], opts): ExitDecision | null`，与 `decideFixedN/decideStrategy` 并列。

- 复用现有 `HoldingDaySnapshot`，**扩字段**（见 [03 §1](./03-module-integration.md#一signal-statsnestjs)）：
  新增 `qfqHigh/qfqLow/rawHigh/downLimit/ma5/signalHigh`。
- TS 版逻辑须与 Python 核**逐行对应**；`floor2` 在 TS 用 `Math.floor(x*100)/100`。
- 入场端"一字涨停 / 停牌 / 次新"过滤**沿用现有 `simulateTradeCore`**（`signal-stats.simulator.ts:133-152`），
  `decideBandLock` 只接管 buyPrice 之后的出场推进。

## 三、`floor2` 一致性约定

```text
floor2(x) = floor(x * 100) / 100      # 向下截断到 0.01
例：floor2(9.99)      = 9.99
    floor2(10.4895)   = 10.48
    floor2(10.567×0.999)=floor2(10.5564..)=10.55
```

Python 与 TS 必须给出**逐位相同**结果（避免浮点末位差异导致对拍失败）。统一先 `x*100`、`Math.floor/ math.floor`、
再 `/100`；不要用字符串截断。对拍样例覆盖含进位边界的取整。

## 四、对拍样例集

下列样例同时作为 Python 核单测与 TS 版单测的**期望表**（同输入 → 同输出）。价格均为复权价；
未列 `raw_*/limit` 的样例默认不触发限停板。

| # | 场景 | 关键输入(T+1 起) | 期望输出 |
|---|---|---|---|
| S1 | 方案一·跟踪止损出场 | T+1(o10,l9.8,c10.2)；T+2(l10.5,h10.6,c10.5)锁定；T+3(l10.40) | exit@min(10.48,open3), reason=stop, scheme=1 |
| S2 | 方案一·锁定后 MA5 离场 | 锁定后某日 close<ma5 且 ma5<prev_ma5，且未先触止损 | exit@adj_close, reason=ma5_exit, scheme=1 |
| S3 | 方案二·初始止损=low×0.999 | T+1(o10,l9.7,c9.9)→方案二；stop_next=floor2(9.7×0.999)=9.69 | T+2 若 low≤9.69 → exit@min(9.69,open2), scheme=2 |
| S4 | 方案二·保本地板 | 浮盈日 close>cost 后，next stop=max(low×0.999, cost×0.999) | 止损不跌破 floor2(cost×0.999) |
| S5 | 跳空低开 | 触发日 open < stop_eff | exit_price = open（min 取开盘） |
| S6 | 封死跌停顺延 | 止损触发日 raw_high≤down_limit；次日非封死 | 出场顺延到次日 @adj_open, reason 保留 |
| S7 | 停牌跳过 | 持仓中某日 adj_close=None | 该日不计 hold、不触发、不更新止损 |
| S8 | 一字涨停买不进 | T+1 raw_open≥up_limit | no_entry, reason=limit_up |
| S9 | 持仓首日不自止损 | T+1 当天 low 远低于 open×0.999 | 持仓首日**不**出场（初始止损 T+2 才生效） |
| S10 | MA5 预热不足 | 锁定后 ma5=None | 不触发 MA5 离场，仅止损逻辑生效 |
| S11 | max_hold 兜底(可选) | 设 max_hold=10，全程不触发止损/锁定 | 第 10 个可交易日 exit@adj_close, reason=max_hold |
| S12 | 窗口耗尽未出场 | 无 max_hold，窗口短，未触发任何条件 | no_exit（调用方收口） |

> 实现时把 S1–S12 写成**精确数值期望**（含 hold_days / exit_index），Python 与 TS 各跑一遍断言相等。
> 取整边界（如 floor2(10.4895)=10.48）单列断言。
