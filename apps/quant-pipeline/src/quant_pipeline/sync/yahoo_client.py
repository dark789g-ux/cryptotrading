"""Yahoo Finance chart API 美股取数薄封装（stdlib urllib，无第三方）。

沿用原薄封装风格：请求限频 + 指数退避 + 空数据双路径 warn + 重试耗尽 raise。
权威接口：GET https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
  ?period1=<unix秒>&period2=<unix秒>&interval=1d&events=split%2Cdiv
仅需 User-Agent 头即返 200（无需 crumb/cookie）；query1 失败退到 query2。

UsFetchResult 归属此处（取代已删除的 akshare_client），字段沿用原契约。
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import pandas as pd

logger = logging.getLogger(__name__)

# Yahoo chart API 主机：query1 失败退 query2（同结构）。
_HOSTS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")
_USER_AGENT = "Mozilla/5.0"

# 内部 index_code → Yahoo 出网 symbol；可扩展，当前仅 .NDX。
_INDEX_SYMBOL_MAP = {".NDX": "^NDX"}


@dataclass
class UsFetchResult:
    """df 非空 → empty_path=None；空数据 → df=None, empty_path∈{data_null, items_empty}。"""

    df: "pd.DataFrame | None"
    empty_path: str | None


def _f(v: Any) -> float | None:
    """NaN / inf / None → None；否则 float（仿 us_daily._f）。"""
    if v is None:
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    import math

    return None if not math.isfinite(x) else x


def _yyyymmdd_to_unix(date_str: str, *, end_of_day: bool) -> int:
    """YYYYMMDD（按 UTC）→ unix 秒。

    period1 取当日 0 点；period2 取**次日 0 点**，确保 timestamp 含 end_date 当天
    （Yahoo 的 period2 是开区间上界，落在 end_date 当天的 bar 才被包含）。
    """
    dt = datetime(
        int(date_str[0:4]), int(date_str[4:6]), int(date_str[6:8]),
        tzinfo=timezone.utc,
    )
    if end_of_day:
        dt = dt + timedelta(days=1)
    return int(dt.timestamp())


def _unix_to_yyyymmdd(t: int) -> str:
    """unix 秒 → YYYYMMDD（按 UTC，与 timestamp 解码口径一致）。"""
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y%m%d")


def _index_to_yahoo_symbol(index_code: str) -> str:
    """内部 index_code → Yahoo 出网 symbol（仅出网时映射）。"""
    return _INDEX_SYMBOL_MAP.get(index_code, index_code)


class YahooClient:
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

    def _build_url(self, host: str, symbol: str, period1: int, period2: int) -> str:
        # symbol 走 quote 编码（^NDX 的 ^ 需转义）；events 用 split,div（'%2C' 即逗号）。
        from urllib.parse import quote

        return (
            f"https://{host}/v8/finance/chart/{quote(symbol, safe='')}"
            f"?period1={period1}&period2={period2}&interval=1d&events=split%2Cdiv"
        )

    def _http_get_json(self, url: str) -> dict[str, Any]:
        """单次 GET → 解析 JSON（网络/解析异常向上抛，由调用方退避重试）。"""
        req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 — 固定 https 主机
            raw = resp.read()
        return json.loads(raw.decode("utf-8"))

    def _fetch_chart(self, symbol: str, period1: int, period2: int,
                     *, api_name: str, params: dict[str, Any]) -> dict[str, Any]:
        """限频 + 跨 query1/query2 + 指数退避抓 chart JSON；重试耗尽 raise（不静默吞）。"""
        last_exc: Exception | None = None

        for attempt in range(1, self.max_attempts + 1):
            host = _HOSTS[min(attempt - 1, len(_HOSTS) - 1)]
            url = self._build_url(host, symbol, period1, period2)
            self._throttle()
            try:
                return self._http_get_json(url)
            except Exception as exc:  # noqa: BLE001 — 网络/解析异常统一退避重试
                last_exc = exc
                logger.warning(
                    "yahoo_fetch_retry",
                    extra={"api_name": api_name, "params": params,
                           "attempt": attempt, "host": host, "err": str(exc)},
                )
                time.sleep(0.5 * attempt)

        logger.error("yahoo_fetch_failed",
                     extra={"api_name": api_name, "params": params,
                            "attempts": self.max_attempts, "err": str(last_exc)})
        assert last_exc is not None
        raise last_exc

    def _parse_chart(self, data: dict[str, Any], *, with_adj_close: bool,
                     api_name: str, params: dict[str, Any]) -> UsFetchResult:
        """chart JSON → UsFetchResult，空数据双路径 warn（CLAUDE.md 铁律）。

        - error 非 null（坏 symbol） / result 缺失或为空 → data_null
        - timestamp 为空列表 → items_empty
        - 否则逐字段对齐成 df（列全小写）
        """
        import pandas as pd

        chart = data.get("chart") or {}
        error = chart.get("error")
        results = chart.get("result")
        if error is not None or not results:
            logger.warning("yahoo_empty_data_null",
                           extra={"api_name": api_name, "params": params,
                                  "err": str(error) if error is not None else "no_result"})
            return UsFetchResult(df=None, empty_path="data_null")

        result = results[0]
        timestamps = result.get("timestamp") or []
        if len(timestamps) == 0:
            logger.warning("yahoo_empty_items_empty",
                           extra={"api_name": api_name, "params": params})
            return UsFetchResult(df=None, empty_path="items_empty")

        indicators = result.get("indicators") or {}
        quote = (indicators.get("quote") or [{}])[0]
        opens = quote.get("open") or []
        highs = quote.get("high") or []
        lows = quote.get("low") or []
        closes = quote.get("close") or []
        volumes = quote.get("volume") or []

        n = len(timestamps)
        cols: dict[str, list[Any]] = {
            "date": [_unix_to_yyyymmdd(int(t)) for t in timestamps],
            "open": [_f(opens[i]) if i < len(opens) else None for i in range(n)],
            "high": [_f(highs[i]) if i < len(highs) else None for i in range(n)],
            "low": [_f(lows[i]) if i < len(lows) else None for i in range(n)],
            "close": [_f(closes[i]) if i < len(closes) else None for i in range(n)],
            "volume": [_f(volumes[i]) if i < len(volumes) else None for i in range(n)],
        }
        if with_adj_close:
            adj_list = (indicators.get("adjclose") or [{}])[0].get("adjclose") or []
            cols["adj_close"] = [_f(adj_list[i]) if i < len(adj_list) else None
                                 for i in range(n)]

        return UsFetchResult(df=pd.DataFrame(cols), empty_path=None)

    def fetch_us_daily(self, ticker: str, start_date: str, end_date: str) -> UsFetchResult:
        """抓单只美股日线（含复权收盘 adj_close）。

        ticker 裸传（AAPL→AAPL）。start_date/end_date 为 YYYYMMDD。
        返回 df 列：date/open/high/low/close/volume/adj_close（全小写）。
        网络异常重试耗尽则抛出（由 orchestrator 逐 ticker 捕获记 errors，不静默吞）。
        空数据（error/无 result → data_null；timestamp 空 → items_empty）双路径 warn。
        """
        symbol = ticker
        period1 = _yyyymmdd_to_unix(start_date, end_of_day=False)
        period2 = _yyyymmdd_to_unix(end_date, end_of_day=True)
        api_name = "yahoo_chart(us_daily)"
        params = {"symbol": symbol, "ticker": ticker,
                  "start_date": start_date, "end_date": end_date,
                  "period1": period1, "period2": period2}

        data = self._fetch_chart(symbol, period1, period2, api_name=api_name, params=params)
        return self._parse_chart(data, with_adj_close=True, api_name=api_name, params=params)

    def fetch_us_index(self, index_code: str, start_date: str, end_date: str) -> UsFetchResult:
        """抓单个美股指数日线（无复权概念 → 无 adj_close）。

        index_code 内部码（.NDX）→ 出网映射为 Yahoo symbol（^NDX）。
        start_date/end_date 为 YYYYMMDD。返回 df 列：date/open/high/low/close/volume。
        网络异常重试耗尽则抛出；空数据双路径 warn（同 fetch_us_daily）。
        """
        symbol = _index_to_yahoo_symbol(index_code)
        period1 = _yyyymmdd_to_unix(start_date, end_of_day=False)
        period2 = _yyyymmdd_to_unix(end_date, end_of_day=True)
        api_name = "yahoo_chart(us_index)"
        params = {"symbol": symbol, "index_code": index_code,
                  "start_date": start_date, "end_date": end_date,
                  "period1": period1, "period2": period2}

        data = self._fetch_chart(symbol, period1, period2, api_name=api_name, params=params)
        return self._parse_chart(data, with_adj_close=False, api_name=api_name, params=params)
