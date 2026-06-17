"""美股交易日「收盘封顶」辅助（spec 04 约束A）。

源于 2026-06-17 AMD 盘中同步抓到「在长半根」事故：盘中（未收盘）同步会把当日
未完成的半根 bar 当成已收盘日线写库，污染指标。本模块提供：

- ``cap_to_last_closed_session(user_end)``：把用户选的 end 封顶到「最近一个已收盘交易日」。
  今日（美东）未收盘（< 16:05 ET）→ 返回今日前一自然日；否则 min(user_end, 今日)。
  周末/节假日由「Yahoo 无该日 bar」自然吸收，无需交易日历。
- ``is_today_unclosed_et()`` / ``today_et_yyyymmdd()``：供抓取路径「双保险」判断当日在长 bar。

时区用 stdlib ``zoneinfo`` America/New_York，自动处理夏/冬令时（DST）。
``_now_et()`` 单点封装「现在的美东时间」，单测通过 mock 它注入固定时刻。
"""

from __future__ import annotations

from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

_ET = ZoneInfo("America/New_York")

# 收盘时刻（美东）。正式收盘 16:00，留 5 分钟缓冲覆盖 Yahoo 刚收盘结算抖动（spec §56）。
MARKET_CLOSE_ET = time(16, 5)


def _now_et() -> datetime:
    """现在时间换算到 America/New_York（单测 mock 此函数注入固定时刻）。"""
    return datetime.now(tz=_ET)


def today_et_yyyymmdd() -> str:
    """美东当前自然日 → YYYYMMDD。"""
    return _now_et().strftime("%Y%m%d")


def is_today_unclosed_et() -> bool:
    """美东「今日尚未收盘」= 当前美东时刻早于 16:05 ET。

    周末/节假日同样会返回 True（时间 < 16:05），但抓取路径里今日本就无 Yahoo bar，
    故对结果无害——「今日未收盘」语义只在「今日有在长 bar」时才被双保险消费。
    """
    return _now_et().time() < MARKET_CLOSE_ET


def cap_to_last_closed_session(user_end: str) -> str:
    """把用户选的 end（YYYYMMDD）封顶到最近一个已收盘交易日。

    规则（spec 04 约束A）：
    - user_end < 美东今日 → 原样返回（历史日期不受影响）。
    - user_end >= 美东今日：
        - 今日未收盘（< 16:05 ET）→ 返回今日**前一自然日**（丢弃当日在长 bar；
          周末/节假日由 Yahoo 无该日 bar 自然吸收）。
        - 今日已收盘 → 返回 min(user_end, 今日) = 今日。
    """
    now = _now_et()
    today = now.strftime("%Y%m%d")
    if user_end < today:
        return user_end
    # user_end >= today
    if now.time() < MARKET_CLOSE_ET:
        # 今日未收盘 → 封顶到前一自然日
        prev = now.date() - timedelta(days=1)
        return prev.strftime("%Y%m%d")
    # 今日已收盘 → min(user_end, today) = today（因 user_end >= today）
    return today
