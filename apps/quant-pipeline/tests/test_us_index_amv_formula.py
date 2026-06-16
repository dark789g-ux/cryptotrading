"""美股指数 AMV 公式 parity 测试（T2）。

逐式对拍 ``us_index_amv_formula.py`` 与 TS ``amv-formula.ts``：金标准
``tests/fixtures/amv_parity_golden.json`` 由 TS 的 6 个 export 函数
（tdSma/tdEma/calcMacd/calcSignal/calcZdf/calcAmvSeries）对一组确定性输入跑出，
checked-in。Python 喂同一输入，逐元素 ``approx(rel=1e-9)`` 断言一致。

``ma5`` 在 TS 侧未 export、不可单测 → golden 不单列；Python 的 ``ma5`` 经
``calc_amv_series`` 端到端间接覆盖（其内部用 ma5 算 v3，parity 一致即证 ma5 正确）。

golden 含 NaN / 边界 / ``v3<=0`` / ``amv_close<=0`` 用例。
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from quant_pipeline.sync.us_index_amv_formula import (
    calc_amv_series,
    calc_macd,
    calc_signal,
    calc_zdf,
    td_ema,
    td_sma,
)

_FIXTURE = Path(__file__).parent / "fixtures" / "amv_parity_golden.json"


def _decode(v):
    """把 JSON 里的哨兵字符串还原成 float：'__NaN__'/'__Inf__'/'__-Inf__'。"""
    if v == "__NaN__":
        return math.nan
    if v == "__Inf__":
        return math.inf
    if v == "__-Inf__":
        return -math.inf
    return v


def _decode_list(arr):
    return [_decode(v) for v in arr]


@pytest.fixture(scope="module")
def golden() -> dict:
    with _FIXTURE.open(encoding="utf-8") as f:
        return json.load(f)


def _assert_seq_parity(actual, expected) -> None:
    """逐元素断言一致：NaN↔NaN、None↔None、数值 approx(rel=1e-9)。"""
    assert len(actual) == len(expected), f"长度不一致 {len(actual)} != {len(expected)}"
    for i, (a, e) in enumerate(zip(actual, expected, strict=True)):
        if e is None:
            assert a is None, f"idx={i}: 期望 None，得 {a!r}"
            continue
        e_dec = _decode(e)
        if isinstance(e_dec, float) and math.isnan(e_dec):
            assert isinstance(a, float) and math.isnan(a), f"idx={i}: 期望 NaN，得 {a!r}"
            continue
        # 非 NaN 数值：a 不应是 NaN/None
        assert a is not None, f"idx={i}: 期望 {e_dec}，得 None"
        assert not (isinstance(a, float) and math.isnan(a)), f"idx={i}: 期望 {e_dec}，得 NaN"
        assert a == pytest.approx(e_dec, rel=1e-9, abs=1e-12), f"idx={i}: {a} != {e_dec}"


# ---------------------------------------------------------------------------
# td_sma
# ---------------------------------------------------------------------------
def test_td_sma_parity(golden):
    cases = golden["td_sma"]
    assert len(cases) > 0
    for case in cases:
        values = _decode_list(case["input"]["values"])
        n = case["input"]["n"]
        m = case["input"]["m"]
        actual = td_sma(values, n, m)
        _assert_seq_parity(actual, case["expected"])


# ---------------------------------------------------------------------------
# td_ema
# ---------------------------------------------------------------------------
def test_td_ema_parity(golden):
    cases = golden["td_ema"]
    assert len(cases) > 0
    for case in cases:
        values = _decode_list(case["input"]["values"])
        n = case["input"]["n"]
        actual = td_ema(values, n)
        _assert_seq_parity(actual, case["expected"])


# ---------------------------------------------------------------------------
# calc_macd
# ---------------------------------------------------------------------------
def test_calc_macd_parity(golden):
    cases = golden["calc_macd"]
    assert len(cases) > 0
    for case in cases:
        values = _decode_list(case["input"]["values"])
        result = calc_macd(
            values,
            case["input"]["fast"],
            case["input"]["slow"],
            case["input"]["signal"],
        )
        exp = case["expected"]
        _assert_seq_parity(result["dif"], exp["dif"])
        _assert_seq_parity(result["dea"], exp["dea"])
        _assert_seq_parity(result["macd"], exp["macd"])


# ---------------------------------------------------------------------------
# calc_signal（标量）
# ---------------------------------------------------------------------------
def test_calc_signal_parity(golden):
    cases = golden["calc_signal"]
    assert len(cases) > 0
    for case in cases:
        dif = _decode(case["input"]["dif"])
        macd_bar = _decode(case["input"]["macd_bar"])
        actual = calc_signal(dif, macd_bar)
        assert actual == case["expected"], f"{case['name']}: {actual} != {case['expected']}"


# ---------------------------------------------------------------------------
# calc_zdf
# ---------------------------------------------------------------------------
def test_calc_zdf_parity(golden):
    cases = golden["calc_zdf"]
    assert len(cases) > 0
    for case in cases:
        amv_close = _decode_list(case["input"]["amv_close"])
        actual = calc_zdf(amv_close)
        _assert_seq_parity(actual, case["expected"])


# ---------------------------------------------------------------------------
# calc_amv_series（含 ma5 端到端间接覆盖）
# ---------------------------------------------------------------------------
def test_calc_amv_series_parity(golden):
    cases = golden["calc_amv_series"]
    assert len(cases) > 0
    # 必须含 v3<=0 / amv_close<=0 用例
    names = {c["name"] for c in cases}
    assert "with_nonpositive_close" in names, "缺 amv_close<=0 边界用例"
    for case in cases:
        inp = case["input"]
        result = calc_amv_series(
            volume=_decode_list(inp["volume"]),
            open=_decode_list(inp["open"]),
            high=_decode_list(inp["high"]),
            low=_decode_list(inp["low"]),
            close=_decode_list(inp["close"]),
        )
        exp = case["expected"]
        _assert_seq_parity(result["amv_open"], exp["amv_open"])
        _assert_seq_parity(result["amv_high"], exp["amv_high"])
        _assert_seq_parity(result["amv_low"], exp["amv_low"])
        _assert_seq_parity(result["amv_close"], exp["amv_close"])
        assert result["invalid"] == exp["invalid"], (
            f"{case['name']} invalid: {result['invalid']} != {exp['invalid']}"
        )
