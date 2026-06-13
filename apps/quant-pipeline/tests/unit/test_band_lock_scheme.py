"""labels/band_lock_scheme.py 单测（A2：band_lock 出场参数 ↔ scheme 串编解码器）。

覆盖（spec 02 §五）：
  - legacy 别名硬门：canonical({}) == 'band_lock'（逐字）；
    canonical({max_hold:10}) == 'band_lock__mh10'（逐字，守现存哈希不漂移）。
  - 量化算法（与 TS Math.round 对齐的关键）：NNNN = math.floor(ratio*1000 + 0.5)，
    round-half-up（非 Python 内建 round() 的 banker's）；中点值确定性。
  - quantize 越界 / 类型 → ValueError。
  - canonical 各非默认参数 → 紧凑后缀，固定顺序 mh→sr→fr→fl→md，等于默认值省略。
  - 往返：parse(canonical(p)) == quantize(p) 对各合法 p（含组合）。
  - parse 畸形（顺序错 / NNNN 越界 / 布尔位非 0|1 / 重复 / 未知后缀 / 非家族）→ None。
  - is_band_lock_scheme 家族判定（= parse is not None）。
  - feature_set_id 回归：'band_lock' / 'band_lock__mh10' 哈希不漂移；非默认参数 → 不同哈希。
"""

from __future__ import annotations

import pytest

from quant_pipeline.features.builder import build_feature_set_id
from quant_pipeline.labels.band_lock_scheme import (
    DEFAULT_FLOOR_ENABLED,
    DEFAULT_FLOOR_RATIO,
    DEFAULT_MA5_REQUIRE_DOWN,
    DEFAULT_STOP_RATIO,
    LEGACY_BAND_LOCK,
    canonical_band_lock_scheme,
    is_band_lock_scheme,
    parse_band_lock_scheme,
    quantize_band_lock_params,
)


def _defaults() -> dict:
    """完整默认 params（全部 canonical 回 legacy 'band_lock'）。"""

    return {
        "max_hold": None,
        "stop_ratio": DEFAULT_STOP_RATIO,
        "floor_ratio": DEFAULT_FLOOR_RATIO,
        "floor_enabled": DEFAULT_FLOOR_ENABLED,
        "ma5_require_down": DEFAULT_MA5_REQUIRE_DOWN,
    }


# ----------------------------------------------------------------------
# 默认常量自洽（守现存核硬编码 0.999 / True / True / None）
# ----------------------------------------------------------------------

def test_defaults_pinned() -> None:
    """默认值钉死：stop/floor=0.999、布尔=True、max_hold 不在 params 默认即 None。

    这些必须与 band_lock_exit.py 现存硬编码一致，否则 canonical 默认不再回 legacy。
    """

    assert DEFAULT_STOP_RATIO == 0.999
    assert DEFAULT_FLOOR_RATIO == 0.999
    assert DEFAULT_FLOOR_ENABLED is True
    assert DEFAULT_MA5_REQUIRE_DOWN is True
    assert LEGACY_BAND_LOCK == "band_lock"


# ----------------------------------------------------------------------
# quantize：先量化后校验
# ----------------------------------------------------------------------

def test_quantize_empty_returns_full_defaults() -> None:
    """空 params → 完整默认回填（量化后 ratio = NNNN/1000）。"""

    assert quantize_band_lock_params({}) == _defaults()


def test_quantize_returns_quantized_ratio() -> None:
    """ratio 量化后还原 NNNN/1000（同一 double）。"""

    out = quantize_band_lock_params({"stop_ratio": 0.997, "floor_ratio": 1.02})
    assert out["stop_ratio"] == pytest.approx(0.997)
    assert out["floor_ratio"] == pytest.approx(1.02)
    # 量化网格还原值：NNNN/1000
    assert out["stop_ratio"] == 997 / 1000
    assert out["floor_ratio"] == 1020 / 1000


@pytest.mark.parametrize(
    ("raw", "expected_nnnn"),
    [
        (0.997, 997),
        (0.999, 999),
        (1.0, 1000),
        (0.001, 1),       # 下界
        (0.0009, 1),      # round-half-up: floor(0.9+0.5)=floor(1.4)=1
        (0.9994, 999),    # floor(999.4+0.5)=floor(999.9)=999
        (0.9995, 1000),   # round-half-up 中点 → 进位（此处 banker's 同得 1000，无分叉）
        (0.9985, 999),    # 中点 → 进位（banker's 会得 998）
    ],
)
def test_quantize_stop_ratio_midpoint_round_half_up(raw: float, expected_nnnn: int) -> None:
    """量化中点值 math.floor(r*1000+0.5) 的确定结果（与 TS Math.round 对齐的关键）。

    特别：0.9995 / 0.9985 这类 .5 中点，round-half-up 必须进位，
    而 Python 内建 round()（banker's）会舍到偶数 → 分叉，故禁用内建 round。
    """

    out = quantize_band_lock_params({"stop_ratio": raw})
    assert out["stop_ratio"] == expected_nnnn / 1000


def test_quantize_floor_ratio_above_one() -> None:
    """floor_ratio 可 > 1（锁盈），NNNN 上界 9999。"""

    out = quantize_band_lock_params({"floor_ratio": 9.999})
    assert out["floor_ratio"] == 9999 / 1000


@pytest.mark.parametrize("bad", [0.0, 0.0004, -0.1, 1.001])
def test_quantize_stop_ratio_out_of_range_raises(bad: float) -> None:
    """stop_ratio NNNN 越界 [1,1000]：<0.0005 量化到 0、量化后 >1000 越上界 → ValueError。

    0.0004 → floor(0.4+0.5)=floor(0.9)=0 < 1 越下界。
    1.001  → floor(1001+0.5)=floor(1001.5)=1001 > 1000 越上界。
    （注意 1.0001 → floor(1000.1+0.5)=floor(1000.6)=1000 合法，不在此列。）
    """

    with pytest.raises(ValueError, match="stop_ratio"):
        quantize_band_lock_params({"stop_ratio": bad})


def test_quantize_stop_ratio_1_0001_quantizes_to_upper_bound() -> None:
    """边界：1.0001 量化 floor(1000.6)=1000=上界 → 合法（ratio=1.0）。"""

    assert quantize_band_lock_params({"stop_ratio": 1.0001})["stop_ratio"] == 1000 / 1000


def test_quantize_stop_ratio_just_over_upper_raises() -> None:
    """stop_ratio 量化 NNNN > 1000 越上界。1.0005 → floor(1000.5+0.5)=1001 > 1000。"""

    with pytest.raises(ValueError, match="stop_ratio"):
        quantize_band_lock_params({"stop_ratio": 1.0005})


@pytest.mark.parametrize("bad", [0.0, 0.0004, -1.0, 10.0])
def test_quantize_floor_ratio_out_of_range_raises(bad: float) -> None:
    """floor_ratio NNNN 越界 [1,9999]：量化到 0 越下界、10.0→10000 越上界。"""

    with pytest.raises(ValueError, match="floor_ratio"):
        quantize_band_lock_params({"floor_ratio": bad})


@pytest.mark.parametrize("key", ["stop_ratio", "floor_ratio"])
@pytest.mark.parametrize("bad", ["0.999", True, [0.999]])
def test_quantize_ratio_non_number_raises(key: str, bad: object) -> None:
    """非数字（含 bool）→ ValueError（None 另测：回默认，不报错）。"""

    with pytest.raises(ValueError, match=key):
        quantize_band_lock_params({key: bad})


@pytest.mark.parametrize("key", ["stop_ratio", "floor_ratio"])
def test_quantize_ratio_none_falls_back_to_default(key: str) -> None:
    """显式传 None → 回默认 0.999（与省略该键等价；便于 job partial params）。"""

    assert quantize_band_lock_params({key: None})[key] == pytest.approx(0.999)


@pytest.mark.parametrize("key", ["floor_enabled", "ma5_require_down"])
@pytest.mark.parametrize("bad", [0, 1, "true", 1.0])
def test_quantize_bool_non_bool_raises(key: str, bad: object) -> None:
    """非 bool（含 0/1 整数）→ ValueError（None 另测：回默认 True）。"""

    with pytest.raises(ValueError, match=key):
        quantize_band_lock_params({key: bad})


@pytest.mark.parametrize("key", ["floor_enabled", "ma5_require_down"])
def test_quantize_bool_none_falls_back_to_default(key: str) -> None:
    """显式传 None → 回默认 True（与省略该键等价）。"""

    assert quantize_band_lock_params({key: None})[key] is True


@pytest.mark.parametrize("bad", [0, -1, 1.5, "10", True, False])
def test_quantize_max_hold_invalid_raises(bad: object) -> None:
    """max_hold 必须正整数或 None；0 / 负 / 浮点 / 字符串 / bool → ValueError。"""

    with pytest.raises(ValueError, match="max_hold"):
        quantize_band_lock_params({"max_hold": bad})


def test_quantize_max_hold_none_and_positive_ok() -> None:
    assert quantize_band_lock_params({"max_hold": None})["max_hold"] is None
    assert quantize_band_lock_params({"max_hold": 10})["max_hold"] == 10


# ----------------------------------------------------------------------
# canonical：默认回 legacy（硬门）+ 紧凑后缀
# ----------------------------------------------------------------------

def test_canonical_all_defaults_is_legacy() -> None:
    """硬门：全默认 canonical 逐字回 'band_lock'（守现存哈希不漂移）。"""

    assert canonical_band_lock_scheme({}) == "band_lock"
    assert canonical_band_lock_scheme({}) == LEGACY_BAND_LOCK
    assert canonical_band_lock_scheme(_defaults()) == "band_lock"


def test_canonical_only_max_hold_legacy_format() -> None:
    """硬门：仅 max_hold canonical 逐字回 'band_lock__mh{N}'（守现存哈希）。"""

    assert canonical_band_lock_scheme({"max_hold": 10}) == "band_lock__mh10"
    assert canonical_band_lock_scheme({"max_hold": 5}) == "band_lock__mh5"


@pytest.mark.parametrize(
    ("params", "scheme"),
    [
        ({"stop_ratio": 0.997}, "band_lock__sr0997"),
        ({"floor_ratio": 1.02}, "band_lock__fr1020"),
        ({"floor_enabled": False}, "band_lock__fl0"),
        ({"ma5_require_down": False}, "band_lock__md0"),
        (
            {
                "max_hold": 10,
                "stop_ratio": 0.997,
                "floor_enabled": False,
                "ma5_require_down": False,
            },
            "band_lock__mh10__sr0997__fl0__md0",
        ),
        # 全字段非默认，固定顺序 mh→sr→fr→fl→md
        (
            {
                "max_hold": 3,
                "stop_ratio": 0.99,
                "floor_ratio": 1.05,
                "floor_enabled": False,
                "ma5_require_down": False,
            },
            "band_lock__mh3__sr0990__fr1050__fl0__md0",
        ),
    ],
)
def test_canonical_non_default_suffixes(params: dict, scheme: str) -> None:
    assert canonical_band_lock_scheme(params) == scheme


def test_canonical_default_ratio_omitted() -> None:
    """ratio 等于默认 0.999 → 省略 sr/fr（即便显式传入默认值）。"""

    assert (
        canonical_band_lock_scheme({"stop_ratio": 0.999, "floor_ratio": 0.999})
        == "band_lock"
    )


def test_canonical_default_bool_omitted() -> None:
    """布尔等于默认 True → 省略 fl/md。"""

    assert (
        canonical_band_lock_scheme({"floor_enabled": True, "ma5_require_down": True})
        == "band_lock"
    )


def test_canonical_off_grid_quantizes() -> None:
    """off-grid ratio canonical 前先量化：0.9966 → NNNN=997 → sr0997。"""

    # floor(996.6+0.5)=floor(997.1)=997
    assert canonical_band_lock_scheme({"stop_ratio": 0.9966}) == "band_lock__sr0997"


# ----------------------------------------------------------------------
# parse：legacy / 合法变体 → 完整 params（含默认回填）
# ----------------------------------------------------------------------

def test_parse_legacy_full_defaults() -> None:
    assert parse_band_lock_scheme("band_lock") == _defaults()


def test_parse_mh_only() -> None:
    expected = _defaults()
    expected["max_hold"] = 10
    assert parse_band_lock_scheme("band_lock__mh10") == expected


def test_parse_full_combo() -> None:
    out = parse_band_lock_scheme("band_lock__mh10__sr0997__fr1050__fl0__md0")
    assert out == {
        "max_hold": 10,
        "stop_ratio": 0.997,
        "floor_ratio": 1.05,
        "floor_enabled": False,
        "ma5_require_down": False,
    }


@pytest.mark.parametrize(
    ("scheme", "key", "value"),
    [
        ("band_lock__sr0997", "stop_ratio", 0.997),
        ("band_lock__fr1020", "floor_ratio", 1.02),
        ("band_lock__fl0", "floor_enabled", False),
        ("band_lock__md0", "ma5_require_down", False),
    ],
)
def test_parse_single_suffix_backfills_defaults(scheme: str, key: str, value: object) -> None:
    out = parse_band_lock_scheme(scheme)
    assert out is not None
    assert out[key] == value
    # 其余回默认
    rest = {k: v for k, v in out.items() if k != key}
    expected_rest = {k: v for k, v in _defaults().items() if k != key}
    assert rest == expected_rest


# ----------------------------------------------------------------------
# 往返：parse(canonical(p)) == quantize(p)
# ----------------------------------------------------------------------

@pytest.mark.parametrize(
    "params",
    [
        {},
        {"max_hold": 10},
        {"stop_ratio": 0.997},
        {"floor_ratio": 1.02},
        {"floor_enabled": False},
        {"ma5_require_down": False},
        {
            "max_hold": 10,
            "stop_ratio": 0.997,
            "floor_enabled": False,
            "ma5_require_down": False,
        },
        {
            "max_hold": 3,
            "stop_ratio": 0.99,
            "floor_ratio": 1.05,
            "floor_enabled": False,
            "ma5_require_down": False,
        },
        # off-grid ratio：往返到量化后网格值
        {"stop_ratio": 0.9966, "floor_ratio": 1.0234},
    ],
)
def test_roundtrip(params: dict) -> None:
    """parse(canonical(p)) == quantize(p)（往返一致）。"""

    scheme = canonical_band_lock_scheme(params)
    assert parse_band_lock_scheme(scheme) == quantize_band_lock_params(params)


# ----------------------------------------------------------------------
# parse 畸形 → None
# ----------------------------------------------------------------------

@pytest.mark.parametrize(
    "scheme",
    [
        # 非家族
        "dir3_band",
        "strategy-aware",
        "fwd_5d_ret",
        "band_lockxxx",
        "",
        # 顺序错（sr 在 mh 前）
        "band_lock__sr0997__mh10",
        # 顺序错（md 在 fl 前）
        "band_lock__md0__fl0",
        # NNNN 越界：sr > 1000
        "band_lock__sr1001",
        # NNNN 下界 0
        "band_lock__sr0000",
        # fr 越上界 9999
        "band_lock__fr99999",
        # 位数不对（sr 非 4 位）
        "band_lock__sr997",
        "band_lock__sr00997",
        # 布尔位非 0|1
        "band_lock__fl2",
        "band_lock__md9",
        # 默认值不应出现在串里（canonical 会省略，故视为畸形非 canonical 串）
        "band_lock__sr0999",
        "band_lock__fr0999",
        "band_lock__fl1",
        "band_lock__md1",
        # 重复后缀
        "band_lock__sr0997__sr0998",
        "band_lock__mh10__mh11",
        # 未知后缀
        "band_lock__xx0001",
        "band_lock__zz",
        # mh 非数字 / 0 / 负
        "band_lock__mh0",
        "band_lock__mhabc",
        "band_lock__mh",
        # 空后缀段
        "band_lock__",
        # 单下划线分隔（应为双下划线）
        "band_lock_mh10",
    ],
)
def test_parse_malformed_returns_none(scheme: str) -> None:
    assert parse_band_lock_scheme(scheme) is None


def test_parse_non_str_returns_none() -> None:
    assert parse_band_lock_scheme(None) is None  # type: ignore[arg-type]
    assert parse_band_lock_scheme(10) is None  # type: ignore[arg-type]


# ----------------------------------------------------------------------
# is_band_lock_scheme 家族判定（= parse is not None）
# ----------------------------------------------------------------------

@pytest.mark.parametrize(
    "scheme",
    [
        "band_lock",
        "band_lock__mh10",
        "band_lock__sr0997",
        "band_lock__mh10__sr0997__fr1050__fl0__md0",
    ],
)
def test_is_family_true(scheme: str) -> None:
    assert is_band_lock_scheme(scheme) is True


@pytest.mark.parametrize(
    "scheme",
    [
        "dir3_band",
        "strategy-aware",
        "band_lock__sr0999",   # 默认值显式入串 → 非 canonical → 畸形
        "band_lock__sr1001",   # 越界
        "band_lock__fl2",      # 布尔位非 0|1
        "band_lock__sr0997__mh10",  # 顺序错
        "",
    ],
)
def test_is_family_false(scheme: str) -> None:
    assert is_band_lock_scheme(scheme) is False


# ----------------------------------------------------------------------
# feature_set_id 回归（legacy 不漂移 + 随参数变化）
# ----------------------------------------------------------------------

def test_feature_set_id_legacy_not_drifting() -> None:
    """canonical({})=='band_lock' → 与裸 'band_lock' 同哈希（守现存标签不变孤儿）。"""

    legacy = build_feature_set_id("v1", "band_lock", new_listing_min_days=60)
    canon = build_feature_set_id(
        "v1", canonical_band_lock_scheme({}), new_listing_min_days=60
    )
    assert legacy == canon


def test_feature_set_id_mh_not_drifting() -> None:
    """canonical({max_hold:10})=='band_lock__mh10' → 与裸串同哈希。"""

    legacy = build_feature_set_id("v1", "band_lock__mh10", new_listing_min_days=60)
    canon = build_feature_set_id(
        "v1", canonical_band_lock_scheme({"max_hold": 10}), new_listing_min_days=60
    )
    assert legacy == canon


def test_feature_set_id_changes_with_params() -> None:
    """不同参数 → 不同 canonical 串 → 不同 feature_set_id（避免缓存污染）。"""

    h_legacy = build_feature_set_id(
        "v1", canonical_band_lock_scheme({}), new_listing_min_days=60
    )
    h_sr = build_feature_set_id(
        "v1", canonical_band_lock_scheme({"stop_ratio": 0.997}), new_listing_min_days=60
    )
    h_fl = build_feature_set_id(
        "v1", canonical_band_lock_scheme({"floor_enabled": False}), new_listing_min_days=60
    )
    assert len({h_legacy, h_sr, h_fl}) == 3


# ----------------------------------------------------------------------
# base_scheme_codec 接线（dir3_scheme 改调 canonical_band_lock_scheme）
# ----------------------------------------------------------------------

def test_base_scheme_codec_band_lock_legacy() -> None:
    from quant_pipeline.labels.dir3_scheme import base_scheme_codec

    assert base_scheme_codec("band_lock", {}) == "band_lock"
    assert base_scheme_codec("band_lock", None) == "band_lock"
    assert base_scheme_codec("band_lock", {"max_hold": None}) == "band_lock"


def test_base_scheme_codec_band_lock_mh() -> None:
    from quant_pipeline.labels.dir3_scheme import base_scheme_codec

    assert base_scheme_codec("band_lock", {"max_hold": 10}) == "band_lock__mh10"


def test_base_scheme_codec_band_lock_new_params() -> None:
    """接线后 base_scheme_codec 透传非默认参数到 canonical（新能力）。"""

    from quant_pipeline.labels.dir3_scheme import base_scheme_codec

    assert (
        base_scheme_codec("band_lock", {"max_hold": 10, "stop_ratio": 0.997})
        == "band_lock__mh10__sr0997"
    )


def test_base_scheme_codec_band_lock_bad_max_hold_raises() -> None:
    from quant_pipeline.labels.dir3_scheme import base_scheme_codec

    with pytest.raises(ValueError, match="max_hold"):
        base_scheme_codec("band_lock", {"max_hold": 0})
    with pytest.raises(ValueError, match="max_hold"):
        base_scheme_codec("band_lock", {"max_hold": -1})
