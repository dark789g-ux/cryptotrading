"""数据契约：kelly_sweep harness 各模块共用的核心类型。

所有日期字段均为 8 位 YYYYMMDD 字符串，与项目 raw.* 表 trade_date 字段口径一致。
"""

from __future__ import annotations

from dataclasses import dataclass
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


@dataclass(frozen=True)
class TradeResult:
    """单次交易的完整执行结果。

    ret 为算术收益率，口径：(exit_price - buy_price) / buy_price。
    hold_days 为可交易持有日数（停牌日不计，对齐 simulator.ts tradableCount）。

    exit_reason 取值：
        max_hold  — 到达 max_window 强制平仓
        delist    — 退市前强制平仓
        tp        — 固定比例止盈触发
        sl        — 固定比例止损触发
        trailing  — 移动止损触发
        atr       — ATR 倍数止损触发
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

    exit_reason: Literal["max_hold", "delist", "tp", "sl", "trailing", "atr"]
    """出场原因；同日双触发时按 SweepConfig.same_day_rule 决定。"""


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
