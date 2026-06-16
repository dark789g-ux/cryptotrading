"""美股指数 AMV（活跃市值）公式 —— 逐式照抄自
``apps/server/src/market-data/active-mv/amv-formula.ts``（A 股行业/概念/个股 AMV
公共纯函数，已通篇核验）。

七个纯函数，全部无副作用、可单测，口径与 TS 版 **逐元素一致**（parity 测试用
``tests/fixtures/amv_parity_golden.json`` 锁定，rel=1e-9）：

- ``td_sma`` —— 通达信式 SMA(X, N, M) 递推；**不是简单窗口均值**
  （``us_indicators.py`` 的 ``_sma`` 是简单均线，**不可复用**）。
- ``td_ema`` —— 通达信式 EMA(X, N) 递推（NaN-skip 语义，``_ema`` 无此语义不复用）。
- ``calc_macd`` —— DIF/DEA/柱。
- ``ma5`` —— 5 窗简单均（用于 v3），模块内部用；TS 侧未 export，故只经
  ``calc_amv_series`` 端到端被 parity 间接覆盖。
- ``calc_amv_series`` —— AMV 四价合成 + invalid 标记。
- ``calc_zdf`` —— AMV 收盘涨跌幅（展示用）。
- ``calc_signal`` —— 三态信号判据。

NaN 语义：本模块用 Python ``float('nan')``（``math.nan``）表「无效值」，与 TS 的
``NaN`` 对齐。入参里的 ``None`` 也按无效处理（对齐 TS 的 ``null/undefined``）。
"""

from __future__ import annotations

import math
from collections.abc import Sequence

NAN = float("nan")


def _is_invalid(x: float | None) -> bool:
    """对齐 TS ``x === null || x === undefined || isNaN(x)``。"""
    return x is None or (isinstance(x, float) and math.isnan(x))


def td_sma(values: Sequence[float | None], n: int = 10, m: int = 1) -> list[float]:
    """通达信风格 SMA 递推：``SMA(X, N, M) = (M*X + (N-M)*prev) / N``。

    首值以第一个有效数据为种子。无效值（None/NaN）落 NaN 且不推进种子。
    逐式照抄 amv-formula.ts:20-38。
    """
    result: list[float] = []
    sma: float | None = None

    for x in values:
        if _is_invalid(x):
            result.append(NAN)
            continue
        if sma is None:
            sma = float(x)  # type: ignore[arg-type]
        else:
            sma = (m * x + (n - m) * sma) / n  # type: ignore[operator]
        result.append(sma)

    return result


def td_ema(values: Sequence[float | None], n: int = 12) -> list[float]:
    """通达信风格 EMA 递推：``EMA(X, N) = (2*X + (N-1)*prev) / (N+1)``。

    首值以第一个有效数据为种子。无效值落 NaN 且不推进种子。
    逐式照抄 amv-formula.ts:44-62。
    """
    result: list[float] = []
    ema: float | None = None

    for x in values:
        if _is_invalid(x):
            result.append(NAN)
            continue
        if ema is None:
            ema = float(x)  # type: ignore[arg-type]
        else:
            ema = (2 * x + (n - 1) * ema) / (n + 1)  # type: ignore[operator]
        result.append(ema)

    return result


def calc_macd(
    values: Sequence[float | None],
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
) -> dict[str, list[float]]:
    """在给定序列上自写 MACD（通达信式 td_ema）。

    ``DIF = td_ema(values, fast) - td_ema(values, slow)``；
    ``DEA = td_ema(DIF, signal)``；``柱 = 2*(DIF - DEA)``。
    逐式照抄 amv-formula.ts:77-89。返回 ``{"dif", "dea", "macd"}``。

    NaN 传播：TS 里 ``v - emaSlow[i]`` 中任一为 NaN → NaN（JS 算术语义），
    Python ``nan - x``/``x - nan`` 同样得 nan，逐元素一致。
    """
    ema_fast = td_ema(values, fast)
    ema_slow = td_ema(values, slow)
    dif = [ema_fast[i] - ema_slow[i] for i in range(len(values))]
    dea = td_ema(dif, signal)
    macd = [2 * (dif[i] - dea[i]) for i in range(len(values))]
    return {"dif": dif, "dea": dea, "macd": macd}


def ma5(values: Sequence[float]) -> list[float]:
    """5 日简单滑动均值（不足 5 日取已有有效值均值，全 NaN 落 NaN）。

    用于 ``v3 = MA5(REF(close, 1))``。逐式照抄 amv-formula.ts:108-116。
    """
    out: list[float] = []
    for i in range(len(values)):
        start = max(0, i - 4)
        window = [v for v in values[start : i + 1] if not (isinstance(v, float) and math.isnan(v))]
        out.append(sum(window) / len(window) if len(window) > 0 else NAN)
    return out


def calc_amv_series(
    *,
    volume: Sequence[float | None],
    open: Sequence[float],
    high: Sequence[float],
    low: Sequence[float],
    close: Sequence[float],
) -> dict[str, list]:
    """AMV 序列合成（个股 / 行业 / 美股指数通用）。逐式照抄 amv-formula.ts:130-178。

    ``v1   = td_sma(volume, 10, 1)``
    ``ref1 = [NaN] + close[:-1]``  （REF(close, 1)）
    ``v3   = ma5(ref1)``           （MA5(REF(close, 1))）
    ``MULT = 0.1``
    逐 i：
      - ``v3i <= 0`` → 四价 NaN，invalid[i]=True（停牌/脏数据）
      - ``c = (v1i * close[i]) / v3i * MULT``；``c <= 0`` 或 NaN → 四价 NaN，invalid[i]=True
      - 否则四价 = ``(v1i * {o,h,l,c}) / v3i * MULT``，invalid[i]=False

    ⚠️ 美股口径差异（vs A 股行业 AMV）：``volume`` 入参对美股是 ``Σ(close×volume)``，
    **已经是美元，调用方不得再 ×1000**。A 股行业侧的 ×1000 是「千元→元」换算，
    美股 amount 本就是美元，**勿照抄那一步**（详见 spec 03「美股口径差异」）。
    本函数只做合成，不关心单位换算 —— 量纲由调用方负责，与 TS calcAmvSeries 一致。

    返回 ``{"amv_open", "amv_high", "amv_low", "amv_close"}``（list[float]，NaN 表无效）
    + ``"invalid"``（list[bool]）。
    """
    length = len(close)

    v1 = td_sma(volume, 10, 1)

    # v3 = MA5(REF(close, 1))：先取前一日收盘（首行 NaN），再 5 日均
    ref_close1 = [NAN] + list(close[: length - 1])
    v3 = ma5(ref_close1)

    amv_open: list[float] = [NAN] * length
    amv_high: list[float] = [NAN] * length
    amv_low: list[float] = [NAN] * length
    amv_close: list[float] = [NAN] * length
    invalid: list[bool] = [False] * length

    mult = 0.1

    for i in range(length):
        v3i = v3[i]
        v1i = v1[i]
        # v3 <= 0 视为异常（停牌/脏数据），整日不产指标。
        # 对齐 TS `!(v3i > 0)`：NaN 比较为 False → 取反为 True，也判异常。
        if not (v3i > 0):
            amv_open[i] = NAN
            amv_high[i] = NAN
            amv_low[i] = NAN
            amv_close[i] = NAN
            invalid[i] = True
            continue
        c = (v1i * close[i]) / v3i * mult
        # AMVc <= 0 视为异常。对齐 TS `!(c > 0) || isNaN(c)`。
        if not (c > 0) or (isinstance(c, float) and math.isnan(c)):
            amv_open[i] = NAN
            amv_high[i] = NAN
            amv_low[i] = NAN
            amv_close[i] = NAN
            invalid[i] = True
            continue
        amv_open[i] = (v1i * open[i]) / v3i * mult
        amv_high[i] = (v1i * high[i]) / v3i * mult
        amv_low[i] = (v1i * low[i]) / v3i * mult
        amv_close[i] = c
        invalid[i] = False

    return {
        "amv_open": amv_open,
        "amv_high": amv_high,
        "amv_low": amv_low,
        "amv_close": amv_close,
        "invalid": invalid,
    }


def calc_zdf(amv_close: Sequence[float]) -> list[float | None]:
    """AMV 收盘涨跌幅（仅展示，不驱动信号）：
    ``zdf[t] = (AMVc[t] - AMVc[t-1]) / AMVc[t-1] * 100``。

    逐式照抄 amv-formula.ts:184-200（两段独立判定）：
      - ``i == 0`` → None
      - ``!(prev > 0)``（prev <= 0 或 prev=NaN）→ None
      - ``isNaN(cur)`` → None
      - 否则 ``(cur - prev) / prev * 100``

    分母 ≤ 0 或 NaN、当前值 NaN → 落 None（不写 Inf/NaN，spec 03）。
    """
    out: list[float | None] = []
    for i in range(len(amv_close)):
        if i == 0:
            out.append(None)
            continue
        prev = amv_close[i - 1]
        cur = amv_close[i]
        if not (prev > 0) or (isinstance(cur, float) and math.isnan(cur)):
            out.append(None)
            continue
        out.append((cur - prev) / prev * 100)
    return out


def calc_signal(dif: float, macd_bar: float) -> int:
    """三态信号判据（含边界）。逐式照抄 amv-formula.ts:97-102。

      - 多头 +1：``dif > 0 且 macd_bar > 0``
      - 空头 -1：``dif < 0 且 macd_bar < 0``
      - 中性  0：其余（含 dif=0 或 macd_bar=0 边界、NaN）
    """
    if (isinstance(dif, float) and math.isnan(dif)) or (
        isinstance(macd_bar, float) and math.isnan(macd_bar)
    ):
        return 0
    if dif > 0 and macd_bar > 0:
        return 1
    if dif < 0 and macd_bar < 0:
        return -1
    return 0
