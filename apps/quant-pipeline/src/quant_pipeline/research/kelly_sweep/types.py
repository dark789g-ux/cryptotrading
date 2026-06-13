"""数据契约：kelly_sweep harness 各模块共用的核心类型。

所有日期字段均为 8 位 YYYYMMDD 字符串，与项目 raw.* 表 trade_date 字段口径一致。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional


@dataclass(frozen=True)
class BaseTrigger:
    """基础触发条件，表示「field op value」的单一布尔判断。

    示例：kdj_j < 0 → BaseTrigger(field='kdj_j', op='lt', value=0.0)

    op 取值：
        lt  — 严格小于（<）
        lte — 小于等于（<=）
        gt  — 严格大于（>）
        gte — 大于等于（>=）
        eq  — 等于（==）
        neq — 不等于（!=）
    """

    field: str
    op: Literal["lt", "lte", "gt", "gte", "eq", "neq"]
    value: float

    @staticmethod
    def default() -> "BaseTrigger":
        """返回默认触发条件：kdj_j < 0。"""
        return BaseTrigger(field="kdj_j", op="lt", value=0.0)


@dataclass(frozen=True)
class Bar:
    """买入后某个有行情的可交易日的 OHLC 数据。

    注意：加载时已剔除停牌日——停牌日不会出现在 ForwardPath.bars 中。
    价格均为前复权（qfq），与项目 signal_forward_stats 口径一致。

    band_lock 出场族追加字段（其它出场族不读）：
      - ma5：raw.daily_indicator.ma5（qfq_close 的 5 个非停牌交易日滚动均值，DB 现成，
        与项目其它指标同口径；预热不足/无记录为 None）。
      - raw_open/raw_high：未复权开/高价（raw.daily_quote.open/high），供一字涨停 / 封死跌停判定。
      - up_limit/down_limit：raw.stk_limit 当日涨/跌停价（未复权）；缺该行时为 None（该端约束不生效）。
    旧出场族（fixed_n/tp_sl/trailing/atr_stop）完全不读这些字段，故全部带默认值 None，
    保证既有 Bar 构造点（含测试 make_bar）无需改动、零回归。
    """

    trade_date: str
    """8 位 YYYYMMDD，可交易日（非停牌）。"""

    qfq_open: float
    """当日前复权开盘价（元）。"""

    qfq_high: float
    """当日前复权最高价（元）。"""

    qfq_low: float
    """当日前复权最低价（元）。"""

    qfq_close: float
    """当日前复权收盘价（元）。"""

    # ── band_lock 出场族专用（其它族不读；默认 None 保证旧构造点零改动）──────────
    ma5: Optional[float] = None
    """当日 MA5（raw.daily_indicator.ma5，qfq_close 5 非停牌交易日滚动均值）；无记录为 None。"""

    raw_open: Optional[float] = None
    """当日未复权开盘价（raw.daily_quote.open）；用于一字涨停判定。无则 None。"""

    raw_high: Optional[float] = None
    """当日未复权最高价（raw.daily_quote.high）；用于封死跌停判定。无则 None。"""

    up_limit: Optional[float] = None
    """当日涨停价（raw.stk_limit.up_limit，未复权）；缺行为 None（约束不生效）。"""

    down_limit: Optional[float] = None
    """当日跌停价（raw.stk_limit.down_limit，未复权）；缺行为 None（约束不生效）。"""


@dataclass(frozen=True)
class ForwardPath:
    """单条信号触发后的前向行情序列。

    buy_price 为 buy_date 的 qfq_open，即开盘买入价。
    bars 从 buy_date **之后**第一个可交易日起（**不含 buy_date 当日**），按时间正序排列，
    长度 ≤ SweepConfig.max_window，停牌日已剔除。口径对齐 NestJS fixed_n（见 paths.py）。
    """

    ts_code: str
    """标的代码，如 '000001.SZ'。"""

    signal_date: str
    """信号触发日（8 位 YYYYMMDD）。"""

    buy_date: str
    """实际买入日（通常为 signal_date 次日，8 位 YYYYMMDD）。"""

    buy_price: float
    """买入价格，等于 buy_date 的 qfq_open（元）。"""

    bars: list[Bar]
    """buy_date 之后第一个可交易日起（**不含 buy_date 当日**）、按时间升序、停牌已剔除的
    前向有行情可交易日序列，长度 ≤ max_window。"""

    delist_date: Optional[str]
    """退市日（8 位 YYYYMMDD）；若无退市风险则为 None。"""

    atr14_at_signal: Optional[float]
    """signal_date 当日的 ATR-14（元），供 atr_stop 出场规则使用；无数据则为 None。"""

    # ── band_lock 出场族专用（其它族不读；默认 None 保证旧构造点零改动）──────────
    signal_bar_high: Optional[float] = None
    """信号日 T（signal_date）的前复权最高价 qfq_high，= 共享核 signal_high 入参。

    band_lock 锁定条件 adj_low > signal_high 需此值；无数据则 None
    （band_lock 模拟时缺此值无法锁定 → simulate_band_lock_exit 跳过该路径）。
    """

    buy_bar: Optional["Bar"] = None
    """持仓首日 = buy_date(T+1) 当日的完整 Bar（含 ma5/raw/limit）。

    kelly_sweep 的 bars[0] 是 buy_date **之后**第一日（不含 buy_date），而 band_lock 共享核
    要求 bars[0] = 持仓首日 T+1、cost=adj_open(T+1)、方案由 adj_close(T+1) 判定。故 band_lock
    适配时须把 buy_bar 拼回序列开头（[buy_bar] + bars）喂核。其它出场族不读此字段（它们用
    path.buy_price 表达入场价、bars 表达持有日，口径独立、不受影响）。无数据则 None。
    """

    # ── phase_lock 出场族专用（其它族不读；默认空列表保证旧构造点零改动）──────────
    recent_lows_window: list[float] = field(default_factory=list)
    """含 T+1（buy_bar）的最近 W 个**非停牌**复权 qfq_low，**按时间升序**（末元素 = buy_date 的 low）。

    W = 本次扫描请求的最大 lookback（load_forward_paths 的 recent_lows_window 参数）。
    phase_lock 初始止损 = floor2(min(含 T+1 的最近 lookback 个非停牌复权 low) × init_factor)，
    需 buy_date(T+1) **及之前**的历史 low；而 path.bars 从 buy_date 之后起、不含 T+1 前的历史行，
    故由 load_forward_paths 单独沿日历向前回溯（含 buy_date、跳停牌）收集这 W 个 low 存于此。
    simulate_phase_lock_exit 取末尾 lookback 个（recent_lows_window[-lookback:]）喂核，使 kelly 侧
    lookback 真正生效（区别于历史「kelly 路径无 T+1 前历史 → lookback 失效」的退化行为）。

    其它出场族（fixed_n/tp_sl/trailing/atr_stop/band_lock）完全不读此字段，默认空列表，
    保证既有 ForwardPath 构造点（含测试 make_path）无需改动、零回归。
    PIT 安全：只含 buy_date 及之前的行，绝不含 buy_date 之后的未来数据。
    """


@dataclass(frozen=True)
class TradeResult:
    """单次交易的完整执行结果。

    ret 为算术收益率，口径：(exit_price - buy_price) / buy_price。
    hold_days 为可交易持有日数（停牌日不计，对齐 simulator.ts tradableCount）。

    exit_reason 取值：
        max_hold  — 到达 max_window / band_lock max_hold 强制平仓
        delist    — 退市前强制平仓
        tp        — 固定比例止盈触发
        sl        — 固定比例止损触发
        trailing  — 移动止损触发
        atr       — ATR 倍数止损触发
        stop      — band_lock 跟踪止损触发
        ma5_exit  — band_lock 锁定后 MA5 收盘离场
    """

    ts_code: str
    signal_date: str
    buy_date: str
    exit_date: str
    """实际出场日（8 位 YYYYMMDD）。"""

    buy_price: float
    """买入价格（元，qfq_open）。"""

    exit_price: float
    """出场价格（元，qfq 对应价位）。"""

    ret: float
    """算术收益率 = (exit_price - buy_price) / buy_price。"""

    hold_days: int
    """持仓可交易日数（停牌日不计）。"""

    exit_reason: Literal[
        "max_hold", "delist", "tp", "sl", "trailing", "atr", "stop", "ma5_exit"
    ]
    """出场原因；同日双触发时按 SweepConfig.same_day_rule 决定。
    stop/ma5_exit 仅 band_lock 出场族产出。"""


@dataclass(frozen=True)
class MetricResult:
    """一组 TradeResult 汇总后的统计指标。

    胜负口径（与 signal-stats.metrics.ts 一致，T2 须照此实现）：
    ret>0 算赢、ret<0 算亏、**ret==0 既不计入 wins 也不计入 losses，但计入 n 分母**。
    即 win_rate = wins / n，其中 wins 仅计 ret>0，n 含全部样本（含 ret==0）。

    payoff_b、kelly 在无亏损样本（无 ret<0 样本）时为 None（公式无定义）。
    win_rate、avg_win、avg_loss 在 n=0 时为 None。

    kelly 口径：f* = p - (1-p) / b，其中 p = win_rate，b = payoff_b。
    """

    n: int
    """样本总数。"""

    wins: int
    """盈利笔数（ret > 0）。"""

    win_rate: Optional[float]
    """胜率 = wins / n；n=0 时为 None。"""

    avg_win: Optional[float]
    """平均盈利收益率（仅 ret>0 的样本）；无盈利样本时为 None。"""

    avg_loss: Optional[float]
    """平均亏损收益率（仅 ret<0 的样本，通常为负数）；ret==0 不计入此侧、亦不计入 wins，仅计入 n；无亏损样本时为 None。"""

    payoff_b: Optional[float]
    """盈亏比 b = avg_win / |avg_loss|；无亏损样本时为 None。"""

    profit_factor: Optional[float]
    """利润因子 = sum(wins_ret) / |sum(losses_ret)|；无亏损样本时为 None。"""

    kelly: Optional[float]
    """凯利仓位上界 f* = p - (1-p)/b；payoff_b 为 None 时为 None。"""
