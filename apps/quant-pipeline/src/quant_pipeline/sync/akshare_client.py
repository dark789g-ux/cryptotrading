"""AkShare 美股日线封装（新浪源 stock_us_daily）。

仿 tushare_client.py：请求限频 + 指数退避 + 空数据双路径 warn。
唯一可靠接口为 stock_us_daily（东财系本机不可达，见 spec 02）。无需 token。
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import pandas as pd

logger = logging.getLogger(__name__)


@dataclass
class UsFetchResult:
    """df 非空 → empty_path=None；空数据 → df=None, empty_path∈{data_null, items_empty}。"""

    df: "pd.DataFrame | None"
    empty_path: str | None


class AkShareClient:
    def __init__(self, *, min_interval_ms: int | None = None, max_attempts: int = 3) -> None:
        env = os.getenv("US_SYNC_MIN_INTERVAL_MS")
        self.min_interval = (min_interval_ms if min_interval_ms is not None
                             else int(env) if env else 200) / 1000.0
        self.max_attempts = max_attempts
        self._last_call = 0.0

    def _throttle(self) -> None:
        dt = time.monotonic() - self._last_call
        if dt < self.min_interval:
            time.sleep(self.min_interval - dt)
        self._last_call = time.monotonic()

    def fetch_us_daily(self, ticker: str, adjust: str = "") -> UsFetchResult:
        """抓单只美股日线。

        adjust="" 不复权；adjust="qfq" 前复权（仅用 close 派生因子，见 spec 02/04）。
        网络异常重试耗尽则抛出（由 orchestrator 逐 ticker 捕获记 errors，不静默吞）。
        空数据（None / 0 行）双路径 warn 并返回 empty_path。
        """
        import akshare as ak  # 延迟 import：避免非 us_sync run_type 拖入 akshare

        api_name = f"stock_us_daily(adjust={adjust or 'none'})"
        params = {"symbol": ticker, "adjust": adjust}
        last_exc: Exception | None = None

        for attempt in range(1, self.max_attempts + 1):
            self._throttle()
            try:
                df = ak.stock_us_daily(symbol=ticker, adjust=adjust)
            except Exception as exc:  # noqa: BLE001 — 网络/解析异常统一退避重试
                last_exc = exc
                logger.warning(
                    "akshare_fetch_retry",
                    extra={"api_name": api_name, "params": params,
                           "attempt": attempt, "err": str(exc)},
                )
                time.sleep(0.5 * attempt)
                continue

            # 空数据双路径 warn（CLAUDE.md 铁律）
            if df is None:
                logger.warning("akshare_empty_data_null",
                               extra={"api_name": api_name, "params": params})
                return UsFetchResult(df=None, empty_path="data_null")
            if len(df) == 0:
                logger.warning("akshare_empty_items_empty",
                               extra={"api_name": api_name, "params": params})
                return UsFetchResult(df=None, empty_path="items_empty")
            return UsFetchResult(df=df, empty_path=None)

        logger.error("akshare_fetch_failed",
                     extra={"api_name": api_name, "params": params,
                            "attempts": self.max_attempts, "err": str(last_exc)})
        assert last_exc is not None
        raise last_exc
