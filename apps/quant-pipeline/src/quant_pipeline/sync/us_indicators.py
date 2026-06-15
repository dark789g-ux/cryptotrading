"""美股技术指标计算 —— 精确移植自 apps/server/src/indicators/indicators.ts。

公式与 TS 版逐项对齐（EMA 种子 / strict-SMA 空值 / KDJ 初值 50 / Wilder ATR /
舍入），确保美股展示指标与 A 股语义一致（spec 04 §3：TS↔Python 对拍护门）。

仅产出美股需要的标准 TA 子集（无 10_quote_volume / loss_atr_14 / brick / amv）。
输入为前复权(qfq) OHLC 序列（按 trade_date 升序）。
"""

from __future__ import annotations

import math
from collections.abc import Sequence

# 输出键 = raw.us_daily_indicator 列名
INDICATOR_KEYS = (
    "ma5", "ma30", "ma60", "ma120", "ma240",
    "bbi",
    "kdj_k", "kdj_d", "kdj_j",
    "dif", "dea", "macd",
    "atr_14",
    "low_9", "high_9",
    "stop_loss_pct", "risk_reward_ratio",
)


def _js_round(y: float) -> float:
    """JS Math.round 语义：half-up 向 +∞（Math.round(-2.5) == -2），避开 Python banker's。"""
    return math.floor(y + 0.5)


def _round_sig(x: float | None, sig: int = 8) -> float | None:
    if x is None:
        return None
    if x == 0 or not math.isfinite(x):
        return x
    magnitude = math.floor(math.log10(abs(x)))
    factor = 10 ** max(sig - 1 - magnitude, 0)
    return _js_round(x * factor) / factor


def _round_fixed(x: float, decimals: int) -> float:
    f = 10 ** decimals
    return _js_round(x * f) / f


def _ema(values: Sequence[float], period: int) -> list[float]:
    k = 2.0 / (period + 1)
    out: list[float] = []
    for i, v in enumerate(values):
        out.append(v if i == 0 else v * k + out[i - 1] * (1 - k))
    return out


def _sma(values: Sequence[float], period: int) -> list[float]:
    """不足 period 时取已有数据均值（用于 BBI）。"""
    out: list[float] = []
    for i in range(len(values)):
        start = max(0, i - period + 1)
        window = values[start : i + 1]
        out.append(sum(window) / len(window))
    return out


def _strict_sma(values: Sequence[float], period: int) -> list[float | None]:
    """不足 period 返回 None（用于 MA5/30/60/120/240）。"""
    out: list[float | None] = []
    for i in range(len(values)):
        if i < period - 1:
            out.append(None)
            continue
        window = values[i - period + 1 : i + 1]
        out.append(sum(window) / len(window))
    return out


def _atr(highs: Sequence[float], lows: Sequence[float], closes: Sequence[float], period: int) -> list[float]:
    n = len(highs)
    tr = [highs[0] - lows[0]]
    for i in range(1, n):
        tr.append(
            max(
                highs[i] - lows[i],
                abs(highs[i] - closes[i - 1]),
                abs(lows[i] - closes[i - 1]),
            )
        )
    atr: list[float] = []
    for i in range(n):
        if i < period - 1:
            atr.append(sum(tr[: i + 1]) / (i + 1))
        elif i == period - 1:
            atr.append(sum(tr[:period]) / period)
        else:
            atr.append((atr[i - 1] * (period - 1) + tr[i]) / period)
    return atr


def calc_us_indicators(
    *,
    opens: Sequence[float],
    highs: Sequence[float],
    lows: Sequence[float],
    closes: Sequence[float],
) -> list[dict[str, float | None]]:
    """返回逐行指标 dict 列表（与输入等长、同序）。输入应为 qfq 价、按日升序。"""
    n = len(closes)
    if n == 0:
        return []

    # MACD
    ema12 = _ema(closes, 12)
    ema26 = _ema(closes, 26)
    dif = [ema12[i] - ema26[i] for i in range(n)]
    dea = _ema(dif, 9)
    macd = [2.0 * (dif[i] - dea[i]) for i in range(n)]

    # KDJ（周期 9，初值 K=D=50）
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
        prev_k = k
        prev_d = d

    # BBI = (MA3+MA6+MA12+MA24)/4
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

    atr14 = _atr(highs, lows, closes, 14)

    out: list[dict[str, float | None]] = []
    for i in range(n):
        s = max(0, i - 8)
        h9 = max(highs[s : i + 1])
        l9 = min(lows[s : i + 1])
        sl_pct = (1 - l9 / closes[i]) * 100 if closes[i] else 0.0
        loss = closes[i] - l9
        rr = (h9 - closes[i]) / loss if loss else 0.0
        out.append(
            {
                "ma5": _round_sig(ma5[i], 8),
                "ma30": _round_sig(ma30[i], 8),
                "ma60": _round_sig(ma60[i], 8),
                "ma120": _round_sig(ma120[i], 8),
                "ma240": _round_sig(ma240[i], 8),
                "bbi": _round_sig(bbi[i], 8),
                "kdj_k": _round_fixed(k_vals[i], 4),
                "kdj_d": _round_fixed(d_vals[i], 4),
                "kdj_j": _round_fixed(j_vals[i], 4),
                "dif": _round_sig(dif[i], 8),
                "dea": _round_sig(dea[i], 8),
                "macd": _round_sig(macd[i], 8),
                "atr_14": _round_sig(atr14[i], 8),
                "low_9": _round_sig(l9, 8),
                "high_9": _round_sig(h9, 8),
                "stop_loss_pct": _round_fixed(sl_pct, 4),
                "risk_reward_ratio": _round_sig(rr, 4),
            }
        )
    return out
