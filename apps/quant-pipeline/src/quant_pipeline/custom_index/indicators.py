"""自定义指数技术指标（port NestJS indicators-stream / us_indicators）。"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from quant_pipeline.custom_index.types import IndexQuoteRow
from quant_pipeline.sync.us_indicators import (
    _ema,
    _round_fixed,
    _round_sig,
    _sma,
    _strict_sma,
)

BRICK_P = 4
BRICK_N1 = 4
BRICK_N2 = 6


@dataclass
class _BrickState:
    sma2a: float = 0.0
    sma4a: float = 0.0
    sma5a: float = 0.0
    prev1: float = 0.0
    prev2: float = 0.0
    inited: bool = False
    highs: list[float] | None = None
    lows: list[float] | None = None


def _append_window(values: list[float], value: float, limit: int) -> list[float]:
    nxt = [*values, value]
    return nxt[-limit:] if len(nxt) > limit else nxt


def _calc_next_brick(
    prev: _BrickState | None,
    high: float,
    low: float,
    close: float,
) -> tuple[float, float, float, float]:
    highs = _append_window(prev.highs if prev else [], high, BRICK_P)
    lows = _append_window(prev.lows if prev else [], low, BRICK_P)
    hhv = max(highs)
    llv = min(lows)
    rng = hhv - llv
    var1a = (hhv - close) / rng * 100 - 90 if rng > 0 else -90.0
    var3a = (close - llv) / rng * 100 if rng > 0 else 50.0
    if prev is None or not prev.inited:
        sma2a, sma4a, sma5a = var1a, var3a, var3a
    else:
        sma2a = (var1a + (BRICK_N1 - 1) * prev.sma2a) / BRICK_N1
        sma4a = (var3a + (BRICK_N2 - 1) * prev.sma4a) / BRICK_N2
        sma5a = (sma4a + (BRICK_N2 - 1) * prev.sma5a) / BRICK_N2
    var6a = (sma5a + 100) - (sma2a + 100)
    brick = var6a - 4 if var6a > 4 else 0.0
    return brick, sma2a, sma4a, sma5a


def _calc_brick_delta(current: float, prev1: float, prev2: float) -> float:
    diff1 = abs(current - prev1)
    diff2 = abs(prev1 - prev2)
    return diff1 / diff2 if diff2 > 1e-10 else 0.0


def calc_index_indicators(quotes: list[IndexQuoteRow]) -> list[dict[str, Any]]:
    """从指数 close/high/low 序列计算 MA/MACD/KDJ/BBI/砖图。"""

    if not quotes:
        return []

    closes = [float(q.close) for q in quotes if q.close is not None]
    highs = [float(q.high) for q in quotes if q.high is not None]
    lows = [float(q.low) for q in quotes if q.low is not None]
    n = len(quotes)
    if n == 0 or len(closes) != n:
        return []

    ema12 = _ema(closes, 12)
    ema26 = _ema(closes, 26)
    dif = [ema12[i] - ema26[i] for i in range(n)]
    dea = _ema(dif, 9)
    macd = [2.0 * (dif[i] - dea[i]) for i in range(n)]

    k_vals: list[float] = []
    d_vals: list[float] = []
    j_vals: list[float] = []
    prev_k = 50.0
    prev_d = 50.0
    for i in range(n):
        s = max(0, i - 8)
        h_max = max(highs[s : i + 1])
        l_min = min(lows[s : i + 1])
        rsv = ((closes[i] - l_min) / (h_max - l_min)) * 100 if h_max != l_min else 50.0
        k = prev_k * (2 / 3) + rsv / 3
        d = prev_d * (2 / 3) + k / 3
        k_vals.append(k)
        d_vals.append(d)
        j_vals.append(3 * k - 2 * d)
        prev_k, prev_d = k, d

    sma3 = _sma(closes, 3)
    sma6 = _sma(closes, 6)
    sma12 = _sma(closes, 12)
    sma24 = _sma(closes, 24)
    bbi = [(sma3[i] + sma6[i] + sma12[i] + sma24[i]) / 4 for i in range(n)]

    ma5 = _strict_sma(closes, 5)
    ma30 = _strict_sma(closes, 30)
    ma60 = _strict_sma(closes, 60)
    ma120 = _strict_sma(closes, 120)
    ma240 = _strict_sma(closes, 240)

    brick_state: _BrickState | None = None
    out: list[dict[str, Any]] = []
    for i in range(n):
        brick, sma2a, sma4a, sma5a = _calc_next_brick(
            brick_state,
            highs[i],
            lows[i],
            closes[i],
        )
        prev1 = brick_state.prev1 if brick_state else 0.0
        prev2 = brick_state.prev2 if brick_state else 0.0
        aa = i >= 1 and brick > prev1
        aa_prev = i >= 2 and prev1 > prev2
        brick_delta = _calc_brick_delta(brick, prev1, prev2) if i >= 2 else 0.0
        brick_xg = i >= 2 and not aa_prev and aa

        prev_state = brick_state
        brick_state = _BrickState(
            sma2a=sma2a,
            sma4a=sma4a,
            sma5a=sma5a,
            prev1=brick,
            prev2=prev1,
            inited=True,
            highs=_append_window(prev_state.highs if prev_state else [], highs[i], BRICK_P),
            lows=_append_window(prev_state.lows if prev_state else [], lows[i], BRICK_P),
        )

        out.append(
            {
                "trade_date": quotes[i].trade_date,
                "ma5": _round_sig(ma5[i], 8),
                "ma30": _round_sig(ma30[i], 8),
                "ma60": _round_sig(ma60[i], 8),
                "ma120": _round_sig(ma120[i], 8),
                "ma240": _round_sig(ma240[i], 8),
                "dif": _round_sig(dif[i], 8),
                "dea": _round_sig(dea[i], 8),
                "macd": _round_sig(macd[i], 8),
                "kdj_k": _round_fixed(k_vals[i], 4),
                "kdj_d": _round_fixed(d_vals[i], 4),
                "kdj_j": _round_fixed(j_vals[i], 4),
                "bbi": _round_sig(bbi[i], 8),
                "brick": _round_sig(brick, 8),
                "brick_delta": _round_sig(brick_delta, 8),
                "brick_xg": brick_xg,
            }
        )
    return out


def calc_simple_ma(values: Sequence[float | None], period: int) -> list[float | None]:
    """AMV 均线辅助。"""

    out: list[float | None] = []
    buf: list[float] = []
    for v in values:
        if v is None or (isinstance(v, float) and math.isnan(v)):
            out.append(None)
            continue
        buf.append(float(v))
        window = buf[-period:]
        if len(window) < period:
            out.append(None)
        else:
            out.append(sum(window) / period)
    return out
