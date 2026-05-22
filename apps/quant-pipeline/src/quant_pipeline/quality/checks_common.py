"""quality checks 共享工具。

`_is_trading_day` 被 null_violation（checks_value.py）与 cross_table_alignment
（checks_pit.py）共用：两者都需在「表当日 0 行」时交叉 raw.trade_cal 区分
「非交易日合法空」与「交易日漏同步非法空」。
"""

from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def is_trading_day(session: Session, trade_date: str) -> bool | None:
    """交叉 raw.trade_cal 判断 trade_date 是否为交易日。

    raw.trade_cal 含 (exchange, cal_date YYYYMMDD, is_open 0/1)。A 股两个交易所
    交易日历一致，故只要任一交易所当日 is_open=1 即视为交易日。

    Returns:
        True  —— 确认为交易日（当日表为空属于「漏同步」非法空）
        False —— 确认为非交易日（当日表为空合法）
        None  —— trade_cal 中查不到该日 / 查询失败，无法判定（调用方按保守处理）
    """

    sql = text(
        """
        SELECT
          count(*)                                  AS total,
          count(*) FILTER (WHERE is_open = 1)       AS open_cnt
        FROM raw.trade_cal
        WHERE cal_date = :d
        """
    )
    try:
        row = session.execute(sql, {"d": trade_date}).first()
    except Exception as exc:  # trade_cal 表不存在 / 连接异常
        logger.warning(
            "trade_cal_lookup_failed", extra={"date": trade_date, "err": str(exc)}
        )
        return None
    if row is None or int(row[0] or 0) == 0:
        # trade_cal 未覆盖该日历日，无法判定
        return None
    return int(row[1] or 0) > 0
