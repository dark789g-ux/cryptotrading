# -*- coding: utf-8 -*-
"""K 线列定义与技术指标计算，供 fetch_klines.py 和 patch_klines_indicators.py 共用。"""
import math

KLINE_COLUMNS = [
    "open_time", "open", "high", "low", "close", "volume",
    "close_time", "quote_volume", "trades",
    "taker_buy_base_vol", "taker_buy_quote_vol", "ignore",
]
KLINE_OUTPUT_COLUMNS = KLINE_COLUMNS[:-1]
INDICATOR_COLUMNS = [
    "DIF", "DEA", "MACD", "KDJ.K", "KDJ.D", "KDJ.J", "BBI",
    "MA5", "MA30", "MA60", "MA120", "MA240",
    "10_quote_volume", "atr_14", "loss_atr_14",
    "low_9", "high_9", "stop_loss_pct", "risk_reward_ratio",
]
ALL_OUTPUT_COLUMNS = KLINE_OUTPUT_COLUMNS + INDICATOR_COLUMNS


def _calc_ema(values: list[float], period: int) -> list[float]:
    """EMA，首值以第一个数据为种子。"""
    k = 2.0 / (period + 1)
    result: list[float] = []
    for i, v in enumerate(values):
        result.append(v if i == 0 else v * k + result[-1] * (1 - k))
    return result


def _calc_sma(values: list[float], period: int) -> list[float]:
    """SMA，不足 period 时取已有数据的均值。"""
    result = []
    for i in range(len(values)):
        window = values[max(0, i - period + 1): i + 1]
        result.append(sum(window) / len(window))
    return result


def _round_sig(x: float, sig: int = 8) -> float:
    """按有效数字位数四舍五入，避免极小价格币种指标被截断为 0。"""
    if x == 0.0 or not math.isfinite(x):
        return x
    magnitude = math.floor(math.log10(abs(x)))
    return round(x, max(sig - 1 - magnitude, 0))


def _calc_atr(highs: list[float], lows: list[float], closes: list[float], period: int) -> list[float]:
    """Wilder's ATR：TR = max(H-L, |H-prevC|, |L-prevC|)，首值为前 period 根 TR 的简单均值。"""
    n = len(highs)
    tr = [highs[0] - lows[0]] + [
        max(highs[i] - lows[i], abs(highs[i] - closes[i-1]), abs(lows[i] - closes[i-1]))
        for i in range(1, n)
    ]
    atr: list[float] = []
    for i in range(n):
        if i < period - 1:
            atr.append(sum(tr[:i+1]) / (i+1))
        elif i == period - 1:
            atr.append(sum(tr[:period]) / period)
        else:
            atr.append((atr[-1] * (period - 1) + tr[i]) / period)
    return atr


def calc_indicators(rows: list[dict]) -> list[dict]:
    """
    原地计算并填充技术指标：MACD、KDJ、BBI、MA、ATR、9日高低、止损幅度、盈亏比。
    rows 的 open/high/low/close/quote_volume 字段可为字符串或数值。
    """
    closes = [float(r["close"]) for r in rows]
    highs  = [float(r["high"])  for r in rows]
    lows   = [float(r["low"])   for r in rows]
    n = len(closes)

    # MACD
    ema12 = _calc_ema(closes, 12)
    ema26 = _calc_ema(closes, 26)
    dif   = [a - b for a, b in zip(ema12, ema26)]
    dea   = _calc_ema(dif, 9)
    macd  = [2.0 * (d - e) for d, e in zip(dif, dea)]

    # KDJ（周期 9，初始 K=D=50）
    k_vals, d_vals, j_vals = [], [], []
    prev_k = prev_d = 50.0
    for i in range(n):
        s = max(0, i - 8)
        h_max, l_min = max(highs[s:i+1]), min(lows[s:i+1])
        rsv = (closes[i] - l_min) / (h_max - l_min) * 100 if h_max != l_min else 50.0
        k = prev_k * 2/3 + rsv / 3
        d = prev_d * 2/3 + k   / 3
        k_vals.append(k); d_vals.append(d); j_vals.append(3*k - 2*d)
        prev_k, prev_d = k, d

    # BBI = (MA3+MA6+MA12+MA24)/4
    bbi = [(a+b+c+d)/4 for a, b, c, d in zip(
        _calc_sma(closes, 3), _calc_sma(closes, 6),
        _calc_sma(closes, 12), _calc_sma(closes, 24)
    )]

    ma5   = _calc_sma(closes, 5)
    ma30  = _calc_sma(closes, 30)
    ma60  = _calc_sma(closes, 60)
    ma120 = _calc_sma(closes, 120)
    ma240 = _calc_sma(closes, 240)
    qvol10 = _calc_sma([float(r["quote_volume"]) for r in rows], 10)
    atr14  = _calc_atr(highs, lows, closes, 14)

    # 9日高低、止损幅度、盈亏比
    low9, high9, sl_pct, rr = [], [], [], []
    for i in range(n):
        s = max(0, i - 8)
        h9, l9 = max(highs[s:i+1]), min(lows[s:i+1])
        high9.append(h9); low9.append(l9)
        sl_pct.append((1 - l9 / closes[i]) * 100 if closes[i] else 0.0)
        loss = closes[i] - l9
        rr.append((h9 - closes[i]) / loss if loss else 0.0)

    for i, row in enumerate(rows):
        row["DIF"]              = _round_sig(dif[i],            8)
        row["DEA"]              = _round_sig(dea[i],            8)
        row["MACD"]             = _round_sig(macd[i],           8)
        row["KDJ.K"]            = round(k_vals[i],              4)
        row["KDJ.D"]            = round(d_vals[i],              4)
        row["KDJ.J"]            = round(j_vals[i],              4)
        row["BBI"]              = _round_sig(bbi[i],            8)
        row["MA5"]              = _round_sig(ma5[i],            8)
        row["MA30"]             = _round_sig(ma30[i],           8)
        row["MA60"]             = _round_sig(ma60[i],           8)
        row["MA120"]            = _round_sig(ma120[i],          8)
        row["MA240"]            = _round_sig(ma240[i],          8)
        row["10_quote_volume"]  = round(qvol10[i],              2)
        row["atr_14"]           = _round_sig(atr14[i],          8)
        row["loss_atr_14"]      = _round_sig(closes[i]-atr14[i],8)
        row["low_9"]            = _round_sig(low9[i],           8)
        row["high_9"]           = _round_sig(high9[i],          8)
        row["stop_loss_pct"]    = round(sl_pct[i],              4)
        row["risk_reward_ratio"]= _round_sig(rr[i],             4)

    return rows
