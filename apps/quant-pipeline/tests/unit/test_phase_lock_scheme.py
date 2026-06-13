"""labels/phase_lock_scheme.py 单测（D3：phase_lock 出场参数 ↔ scheme 串编解码器）。

逐镜像 test_band_lock_scheme.py，仅参数集替换为 phase_lock 的 lookback / init_factor /
lock_factor（后缀 lb / if / lf）。覆盖（spec 02 §canonical scheme 编码）：
  - legacy 别名硬门：canonical({}) == 'phase_lock'（逐字）；
    canonical({lookback:15}) == 'phase_lock__lb15'（逐字，守现存哈希不漂移）。
  - 量化算法（与 TS Math.round 对齐）：NNNN = math.floor(ratio*1000 + 0.5)，round-half-up。
  - quantize 越界 / 类型 → ValueError。
  - canonical 各非默认参数 → 紧凑后缀，固定顺序 lb→if→lf，等于默认值省略。
  - 往返：parse(canonical(p)) == quantize(p) 对各合法 p（含组合）。
  - parse 畸形（顺序错 / NNNN 越界 / 重复 / 未知后缀 / 默认值入串 / 非家族）→ None。
  - is_phase_lock_scheme 家族判定（= parse is not None）。
  - feature_set_id 回归：'phase_lock' / 'phase_lock__lb15' 哈希不漂移；非默认参数 → 不同哈希。
  - 默认常量钉死共享核 phase_lock_exit.py（同一权威源）。
"""

from __future__ import annotations

import pytest

from quant_pipeline.features.builder import build_feature_set_id
from quant_pipeline.labels.phase_lock_scheme import (
    DEFAULT_INIT_FACTOR,
    DEFAULT_LOCK_FACTOR,
    DEFAULT_LOOKBACK,
    LEGACY_PHASE_LOCK,
    canonical_phase_lock_scheme,
    is_phase_lock_scheme,
    parse_phase_lock_scheme,
    quantize_phase_lock_params,
)
from quant_pipeline.strategy import phase_lock_exit


def _defaults() -> dict:
    """完整默认 params（全部 canonical 回 legacy 'phase_lock'）。"""

    return {
        "lookback": DEFAULT_LOOKBACK,
        "init_factor": DEFAULT_INIT_FACTOR,
        "lock_factor": DEFAULT_LOCK_FACTOR,
    }


# ----------------------------------------------------------------------
# 默认常量自洽（守共享核 phase_lock_exit.py 硬编码 0.999 / 0.999 / 10）
# ----------------------------------------------------------------------

def test_defaults_pinned() -> None:
    """默认值钉死：init/lock=0.999、lookback=10；且**同一权威源** phase_lock_exit.py。

    scheme 模块只 import phase_lock_exit 的默认常量，不重新定义 → 改一处即同步。
    """

    assert DEFAULT_INIT_FACTOR == 0.999
    assert DEFAULT_LOCK_FACTOR == 0.999
    assert DEFAULT_LOOKBACK == 10
    assert LEGACY_PHASE_LOCK == "phase_lock"
    # 唯一权威源：scheme 的默认常量 is 共享核的常量（同对象 / 同值）。
    assert DEFAULT_INIT_FACTOR == phase_lock_exit.DEFAULT_INIT_FACTOR
    assert DEFAULT_LOCK_FACTOR == phase_lock_exit.DEFAULT_LOCK_FACTOR
    assert DEFAULT_LOOKBACK == phase_lock_exit.DEFAULT_LOOKBACK


# ----------------------------------------------------------------------
# quantize：先量化后校验
# ----------------------------------------------------------------------

def test_quantize_empty_returns_full_defaults() -> None:
    """空 params → 完整默认回填（量化后 ratio = NNNN/1000）。"""

    assert quantize_phase_lock_params({}) == _defaults()


def test_quantize_returns_quantized_ratio() -> None:
    """ratio 量化后还原 NNNN/1000（同一 double）。"""

    out = quantize_phase_lock_params({"init_factor": 0.98, "lock_factor": 1.005})
    assert out["init_factor"] == pytest.approx(0.98)
    assert out["lock_factor"] == pytest.approx(1.005)
    assert out["init_factor"] == 980 / 1000
    assert out["lock_factor"] == 1005 / 1000


@pytest.mark.parametrize(
    ("raw", "expected_nnnn"),
    [
        (0.997, 997),
        (0.999, 999),
        (1.0, 1000),
        (0.001, 1),       # 下界
        (0.0009, 1),      # round-half-up: floor(0.9+0.5)=floor(1.4)=1
        (0.9994, 999),    # floor(999.4+0.5)=floor(999.9)=999
        (0.9995, 1000),   # round-half-up 中点 → 进位（banker's 同得 1000，无分叉）
        (0.9985, 999),    # 中点 → 进位（banker's 会得 998）
        (2.0, 2000),      # 上界
    ],
)
def test_quantize_init_factor_midpoint_round_half_up(raw: float, expected_nnnn: int) -> None:
    """量化中点值 math.floor(r*1000+0.5) 的确定结果（与 TS Math.round 对齐的关键）。

    0.9995 / 0.9985 这类 .5 中点，round-half-up 必须进位，
    而 Python 内建 round()（banker's）会舍到偶数 → 分叉，故禁用内建 round。
    """

    out = quantize_phase_lock_params({"init_factor": raw})
    assert out["init_factor"] == expected_nnnn / 1000


def test_quantize_factor_above_one() -> None:
    """init/lock_factor 可 > 1（极少用，但 spec 不禁止），NNNN 上界 2000。"""

    out = quantize_phase_lock_params({"init_factor": 2.0, "lock_factor": 1.5})
    assert out["init_factor"] == 2000 / 1000
    assert out["lock_factor"] == 1500 / 1000


@pytest.mark.parametrize("key", ["init_factor", "lock_factor"])
@pytest.mark.parametrize("bad", [0.0, 0.0004, -0.1, 2.001])
def test_quantize_factor_out_of_range_raises(key: str, bad: float) -> None:
    """factor NNNN 越界 [1,2000]：<0.0005 量化到 0 越下界、量化后 >2000 越上界 → ValueError。

    0.0004 → floor(0.4+0.5)=floor(0.9)=0 < 1 越下界。
    2.001  → floor(2001+0.5)=2001 > 2000 越上界。
    """

    with pytest.raises(ValueError, match=key):
        quantize_phase_lock_params({key: bad})


def test_quantize_factor_2_0001_quantizes_to_upper_bound() -> None:
    """边界：2.0001 量化 floor(2000.6)=2000=上界 → 合法（ratio=2.0）。"""

    assert quantize_phase_lock_params({"init_factor": 2.0001})["init_factor"] == 2000 / 1000


@pytest.mark.parametrize("key", ["init_factor", "lock_factor"])
@pytest.mark.parametrize("bad", ["0.999", True, [0.999]])
def test_quantize_ratio_non_number_raises(key: str, bad: object) -> None:
    """非数字（含 bool）→ ValueError（None 另测：回默认，不报错）。"""

    with pytest.raises(ValueError, match=key):
        quantize_phase_lock_params({key: bad})


@pytest.mark.parametrize("key", ["init_factor", "lock_factor"])
def test_quantize_ratio_none_falls_back_to_default(key: str) -> None:
    """显式传 None → 回默认 0.999（与省略该键等价；便于 job partial params）。"""

    assert quantize_phase_lock_params({key: None})[key] == pytest.approx(0.999)


@pytest.mark.parametrize("bad", [0, -1, 1.5, "10", True, False, 251])
def test_quantize_lookback_invalid_raises(bad: object) -> None:
    """lookback 必须正整数 [1,250]；0 / 负 / 浮点 / 字符串 / bool / 越界 → ValueError。"""

    with pytest.raises(ValueError, match="lookback"):
        quantize_phase_lock_params({"lookback": bad})


def test_quantize_lookback_none_and_positive_ok() -> None:
    """lookback None → 回默认 10；正整数（含边界 1/250）原样。"""

    assert quantize_phase_lock_params({"lookback": None})["lookback"] == DEFAULT_LOOKBACK
    assert quantize_phase_lock_params({"lookback": 15})["lookback"] == 15
    assert quantize_phase_lock_params({"lookback": 1})["lookback"] == 1
    assert quantize_phase_lock_params({"lookback": 250})["lookback"] == 250


# ----------------------------------------------------------------------
# canonical：默认回 legacy（硬门）+ 紧凑后缀
# ----------------------------------------------------------------------

def test_canonical_all_defaults_is_legacy() -> None:
    """硬门：全默认 canonical 逐字回 'phase_lock'（守现存哈希不漂移）。"""

    assert canonical_phase_lock_scheme({}) == "phase_lock"
    assert canonical_phase_lock_scheme({}) == LEGACY_PHASE_LOCK
    assert canonical_phase_lock_scheme(_defaults()) == "phase_lock"


def test_canonical_only_lookback_legacy_format() -> None:
    """硬门：仅 lookback canonical 逐字回 'phase_lock__lb{N}'（守现存哈希）。"""

    assert canonical_phase_lock_scheme({"lookback": 15}) == "phase_lock__lb15"
    assert canonical_phase_lock_scheme({"lookback": 5}) == "phase_lock__lb5"


@pytest.mark.parametrize(
    ("params", "scheme"),
    [
        ({"init_factor": 0.98}, "phase_lock__if0980"),
        ({"lock_factor": 1.005}, "phase_lock__lf1005"),
        ({"lookback": 20}, "phase_lock__lb20"),
        (
            {"init_factor": 0.98, "lock_factor": 1.005},
            "phase_lock__if0980__lf1005",
        ),
        # 全字段非默认，固定顺序 lb→if→lf
        (
            {"lookback": 5, "init_factor": 0.97, "lock_factor": 0.99},
            "phase_lock__lb5__if0970__lf0990",
        ),
    ],
)
def test_canonical_non_default_suffixes(params: dict, scheme: str) -> None:
    assert canonical_phase_lock_scheme(params) == scheme


def test_canonical_default_ratio_omitted() -> None:
    """ratio 等于默认 0.999 → 省略 if/lf（即便显式传入默认值）。"""

    assert (
        canonical_phase_lock_scheme({"init_factor": 0.999, "lock_factor": 0.999})
        == "phase_lock"
    )


def test_canonical_default_lookback_omitted() -> None:
    """lookback 等于默认 10 → 省略 lb（即便显式传入默认值）。"""

    assert canonical_phase_lock_scheme({"lookback": 10}) == "phase_lock"


def test_canonical_off_grid_quantizes() -> None:
    """off-grid ratio canonical 前先量化：0.9766 → NNNN=977 → if0977。"""

    # floor(976.6+0.5)=floor(977.1)=977
    assert canonical_phase_lock_scheme({"init_factor": 0.9766}) == "phase_lock__if0977"


# ----------------------------------------------------------------------
# parse：legacy / 合法变体 → 完整 params（含默认回填）
# ----------------------------------------------------------------------

def test_parse_legacy_full_defaults() -> None:
    assert parse_phase_lock_scheme("phase_lock") == _defaults()


def test_parse_lb_only() -> None:
    expected = _defaults()
    expected["lookback"] = 15
    assert parse_phase_lock_scheme("phase_lock__lb15") == expected


def test_parse_full_combo() -> None:
    out = parse_phase_lock_scheme("phase_lock__lb5__if0970__lf1005")
    assert out == {
        "lookback": 5,
        "init_factor": 0.97,
        "lock_factor": 1.005,
    }


@pytest.mark.parametrize(
    ("scheme", "key", "value"),
    [
        ("phase_lock__lb20", "lookback", 20),
        ("phase_lock__if0980", "init_factor", 0.98),
        ("phase_lock__lf1005", "lock_factor", 1.005),
    ],
)
def test_parse_single_suffix_backfills_defaults(scheme: str, key: str, value: object) -> None:
    out = parse_phase_lock_scheme(scheme)
    assert out is not None
    assert out[key] == value
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
        {"lookback": 15},
        {"init_factor": 0.98},
        {"lock_factor": 1.005},
        {"lookback": 5, "init_factor": 0.98},
        {"lookback": 5, "init_factor": 0.97, "lock_factor": 0.99},
        # off-grid ratio：往返到量化后网格值
        {"init_factor": 0.9766, "lock_factor": 1.0234},
    ],
)
def test_roundtrip(params: dict) -> None:
    """parse(canonical(p)) == quantize(p)（往返一致）。"""

    scheme = canonical_phase_lock_scheme(params)
    assert parse_phase_lock_scheme(scheme) == quantize_phase_lock_params(params)


# ----------------------------------------------------------------------
# parse 畸形 → None
# ----------------------------------------------------------------------

@pytest.mark.parametrize(
    "scheme",
    [
        # 非家族
        "band_lock",
        "strategy-aware",
        "fwd_5d_ret",
        "phase_lockxxx",
        "",
        # 顺序错（if 在 lb 前）
        "phase_lock__if0980__lb5",
        # 顺序错（lf 在 if 前）
        "phase_lock__lf0990__if0980",
        # NNNN 越界：if > 2000
        "phase_lock__if2001",
        # NNNN 下界 0
        "phase_lock__if0000",
        # lf 越上界 2000
        "phase_lock__lf99999",
        # 位数不对（if 非 4 位）
        "phase_lock__if980",
        "phase_lock__if00980",
        # 默认值不应出现在串里（canonical 会省略，故视为畸形非 canonical 串）
        "phase_lock__if0999",
        "phase_lock__lf0999",
        "phase_lock__lb10",
        # 重复后缀
        "phase_lock__if0980__if0970",
        "phase_lock__lb5__lb6",
        # 未知后缀
        "phase_lock__xx0001",
        "phase_lock__zz",
        # 老 band_lock 后缀混入（不属 phase_lock 家族后缀）
        "phase_lock__sr0997",
        "phase_lock__mh10",
        # lb 非数字 / 0 / 负 / 越界
        "phase_lock__lb0",
        "phase_lock__lb251",
        "phase_lock__lbabc",
        "phase_lock__lb",
        # 空后缀段
        "phase_lock__",
        # 单下划线分隔（应为双下划线）
        "phase_lock_lb15",
    ],
)
def test_parse_malformed_returns_none(scheme: str) -> None:
    assert parse_phase_lock_scheme(scheme) is None


def test_parse_non_str_returns_none() -> None:
    assert parse_phase_lock_scheme(None) is None  # type: ignore[arg-type]
    assert parse_phase_lock_scheme(10) is None  # type: ignore[arg-type]


# ----------------------------------------------------------------------
# is_phase_lock_scheme 家族判定（= parse is not None）
# ----------------------------------------------------------------------

@pytest.mark.parametrize(
    "scheme",
    [
        "phase_lock",
        "phase_lock__lb15",
        "phase_lock__if0980",
        "phase_lock__lb5__if0970__lf1005",
    ],
)
def test_is_family_true(scheme: str) -> None:
    assert is_phase_lock_scheme(scheme) is True


@pytest.mark.parametrize(
    "scheme",
    [
        "band_lock",
        "strategy-aware",
        "phase_lock__if0999",   # 默认值显式入串 → 非 canonical → 畸形
        "phase_lock__if2001",   # 越界
        "phase_lock__lb0",      # lb 非正整数
        "phase_lock__if0980__lb5",  # 顺序错
        "",
    ],
)
def test_is_family_false(scheme: str) -> None:
    assert is_phase_lock_scheme(scheme) is False


# ----------------------------------------------------------------------
# feature_set_id 回归（legacy 不漂移 + 随参数变化）
# ----------------------------------------------------------------------

def test_feature_set_id_legacy_not_drifting() -> None:
    """canonical({})=='phase_lock' → 与裸 'phase_lock' 同哈希（守现存标签不变孤儿）。"""

    legacy = build_feature_set_id("v1", "phase_lock", new_listing_min_days=60)
    canon = build_feature_set_id(
        "v1", canonical_phase_lock_scheme({}), new_listing_min_days=60
    )
    assert legacy == canon


def test_feature_set_id_lb_not_drifting() -> None:
    """canonical({lookback:15})=='phase_lock__lb15' → 与裸串同哈希。"""

    legacy = build_feature_set_id("v1", "phase_lock__lb15", new_listing_min_days=60)
    canon = build_feature_set_id(
        "v1", canonical_phase_lock_scheme({"lookback": 15}), new_listing_min_days=60
    )
    assert legacy == canon


def test_feature_set_id_changes_with_params() -> None:
    """不同参数 → 不同 canonical 串 → 不同 feature_set_id（避免缓存污染）。"""

    h_legacy = build_feature_set_id(
        "v1", canonical_phase_lock_scheme({}), new_listing_min_days=60
    )
    h_if = build_feature_set_id(
        "v1", canonical_phase_lock_scheme({"init_factor": 0.98}), new_listing_min_days=60
    )
    h_lb = build_feature_set_id(
        "v1", canonical_phase_lock_scheme({"lookback": 20}), new_listing_min_days=60
    )
    assert len({h_legacy, h_if, h_lb}) == 3
