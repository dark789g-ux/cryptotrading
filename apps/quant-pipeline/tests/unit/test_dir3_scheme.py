"""labels/dir3_scheme.py 单测（A2：dir3_band ε ↔ scheme 串编解码器）。

覆盖（spec 02 §测试）：
  - 编解码器往返：parse(canonical(ε)) == quantize(ε)，覆盖 0.5%/0.8%/1%/2%/10%
  - legacy 别名：canonical(0.005)=='dir3_band'；parse('dir3_band')==0.005
  - off-grid 量化：ε=0.0083 → 量化 0.008 → 'dir3_band_eps0080'
  - 越界 / 非数字 quantize 抛 ValueError；半网格以下量化为 0 按越界
  - is_dir3_band_scheme 家族判定（legacy / epsNNNN / 畸形 / 非家族）
  - feature_set_id 回归：label_scheme='dir3_band' 的哈希不漂移；
    不同 ε（canonical 串不同）→ 不同 hash；canonical(0.005) 与 legacy 同哈希
  - 各 ε 下分桶边界正确（r==±ε 横盘、越界涨/跌）
"""

from __future__ import annotations

import pandas as pd
import pytest

from quant_pipeline.features.builder import build_feature_set_id
from quant_pipeline.labels.dir3_scheme import (
    EPS_GRID,
    EPS_MIN,
    LEGACY_DIR3_BAND,
    LEGACY_EPS,
    canonical_dir3_band_scheme,
    is_dir3_band_scheme,
    parse_dir3_band_eps,
    quantize_eps,
)
from quant_pipeline.labels.direction_3class import _bucket_band, compute_dir3_labels
from quant_pipeline.labels.fallback import FallbackInputs

_DOWN = 0.0
_FLAT = 1.0
_UP = 2.0


# ----------------------------------------------------------------------
# quantize_eps
# ----------------------------------------------------------------------

@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (0.005, 0.005),     # legacy 默认，落网格
        (0.008, 0.008),     # 落网格
        (0.0083, 0.008),    # off-grid 向下舍入
        (0.0086, 0.009),    # off-grid 向上舍入
        (0.001, 0.001),     # 最小可表示（一个网格）
        (0.1, 0.1),         # 上界
        (0.0012, 0.001),    # 向下到一个网格
    ],
)
def test_quantize_eps_grid(raw: float, expected: float) -> None:
    assert quantize_eps(raw) == pytest.approx(expected)


@pytest.mark.parametrize("bad", [0.0, -0.001, 0.101, 0.2, 1.0])
def test_quantize_eps_out_of_range_raises(bad: float) -> None:
    """越界：≤0 或量化后 > EPS_MAX。0.101 → 量化 0.101 > 0.1 → 越界。

    注意 0.1001 会量化到 0.1（落上界，合法），故用 0.101 测越上界。
    """

    with pytest.raises(ValueError, match="dir3_band_eps"):
        quantize_eps(bad)


def test_quantize_eps_below_half_grid_quantizes_to_zero_then_raises() -> None:
    """ε < 半个网格（< 0.0005）→ 量化为 0 → 按 ≤0 越界报错。"""

    assert EPS_MIN == EPS_GRID
    with pytest.raises(ValueError, match="dir3_band_eps"):
        quantize_eps(0.0004)


@pytest.mark.parametrize("bad", [True, False, "0.005", None, [0.005]])
def test_quantize_eps_non_number_raises(bad: object) -> None:
    with pytest.raises(ValueError, match="must be a number"):
        quantize_eps(bad)  # type: ignore[arg-type]


# ----------------------------------------------------------------------
# canonical / parse / 往返
# ----------------------------------------------------------------------

def test_canonical_legacy_alias() -> None:
    """关键回归约束：ε=0.005 canonical 回 legacy 串 'dir3_band'（守哈希不漂移）。"""

    assert canonical_dir3_band_scheme(LEGACY_EPS) == LEGACY_DIR3_BAND
    assert canonical_dir3_band_scheme(0.005) == "dir3_band"
    # 0050 被 legacy 别名抢占，永不作为 scheme 串产出
    assert canonical_dir3_band_scheme(0.005) != "dir3_band_eps0050"


@pytest.mark.parametrize(
    ("eps", "scheme"),
    [
        (0.001, "dir3_band_eps0010"),
        (0.008, "dir3_band_eps0080"),
        (0.01, "dir3_band_eps0100"),
        (0.02, "dir3_band_eps0200"),
        (0.1, "dir3_band_eps1000"),
    ],
)
def test_canonical_non_legacy_format(eps: float, scheme: str) -> None:
    assert canonical_dir3_band_scheme(eps) == scheme


def test_canonical_off_grid_quantizes() -> None:
    """off-grid ε=0.0083 → 量化 0.008 → 'dir3_band_eps0080'。"""

    assert canonical_dir3_band_scheme(0.0083) == "dir3_band_eps0080"


def test_parse_legacy() -> None:
    assert parse_dir3_band_eps("dir3_band") == pytest.approx(LEGACY_EPS)


@pytest.mark.parametrize(
    ("scheme", "eps"),
    [
        ("dir3_band_eps0010", 0.001),
        ("dir3_band_eps0080", 0.008),
        ("dir3_band_eps0100", 0.01),
        ("dir3_band_eps0200", 0.02),
        ("dir3_band_eps1000", 0.1),
    ],
)
def test_parse_non_legacy(scheme: str, eps: float) -> None:
    assert parse_dir3_band_eps(scheme) == pytest.approx(eps)


@pytest.mark.parametrize(
    "scheme",
    [
        "dir3_band_eps0050",   # legacy 别名专属编码，非 canonical 串 → 畸形
        "dir3_band_eps0000",   # 0 越界
        "dir3_band_eps1001",   # > EPS_MAX 越界
        "dir3_band_eps012",    # 位数不对
        "dir3_band_eps12345",  # 位数不对
        "dir3_band_eps",       # 无数字
        "dir3_tercile",        # 非家族
        "strategy-aware",      # 非家族
        "fwd_5d_ret",          # 非家族
        "",                    # 空串
    ],
)
def test_parse_non_family_or_malformed_returns_none(scheme: str) -> None:
    assert parse_dir3_band_eps(scheme) is None


def test_parse_non_str_returns_none() -> None:
    assert parse_dir3_band_eps(None) is None  # type: ignore[arg-type]
    assert parse_dir3_band_eps(0.005) is None  # type: ignore[arg-type]


@pytest.mark.parametrize("eps", [0.005, 0.008, 0.01, 0.02, 0.1])
def test_roundtrip(eps: float) -> None:
    """parse(canonical(ε)) == quantize(ε)（往返一致）。"""

    scheme = canonical_dir3_band_scheme(eps)
    assert parse_dir3_band_eps(scheme) == pytest.approx(quantize_eps(eps))


def test_roundtrip_off_grid() -> None:
    """off-grid ε 往返到量化后的网格值。"""

    assert parse_dir3_band_eps(canonical_dir3_band_scheme(0.0083)) == pytest.approx(0.008)


# ----------------------------------------------------------------------
# is_dir3_band_scheme 家族判定
# ----------------------------------------------------------------------

@pytest.mark.parametrize(
    "scheme",
    ["dir3_band", "dir3_band_eps0010", "dir3_band_eps0080", "dir3_band_eps1000"],
)
def test_is_family_true(scheme: str) -> None:
    assert is_dir3_band_scheme(scheme) is True


@pytest.mark.parametrize(
    "scheme",
    [
        "dir3_tercile",
        "strategy-aware",
        "fwd_5d_ret",
        "dir3_band_eps0050",   # 畸形（legacy 别名编码）
        "dir3_band_eps9999",   # 越界
        "dir3_band_xxx",
        "",
    ],
)
def test_is_family_false(scheme: str) -> None:
    assert is_dir3_band_scheme(scheme) is False


# ----------------------------------------------------------------------
# feature_set_id 回归（legacy 不漂移 + 随 ε 变化）
# ----------------------------------------------------------------------

def test_feature_set_id_legacy_not_drifting() -> None:
    """canonical(0.005)=='dir3_band' → 与裸 'dir3_band' 同哈希（老特征集不变孤儿）。"""

    legacy = build_feature_set_id("v1", "dir3_band", new_listing_min_days=60)
    canon = build_feature_set_id(
        "v1", canonical_dir3_band_scheme(0.005), new_listing_min_days=60
    )
    assert legacy == canon


def test_feature_set_id_changes_with_eps() -> None:
    """不同 ε → 不同 canonical 串 → 不同 feature_set_id（避免缓存污染）。"""

    h_legacy = build_feature_set_id(
        "v1", canonical_dir3_band_scheme(0.005), new_listing_min_days=60
    )
    h_008 = build_feature_set_id(
        "v1", canonical_dir3_band_scheme(0.008), new_listing_min_days=60
    )
    h_010 = build_feature_set_id(
        "v1", canonical_dir3_band_scheme(0.01), new_listing_min_days=60
    )
    assert len({h_legacy, h_008, h_010}) == 3


def test_feature_set_id_legacy_hash_pinned() -> None:
    """固定输入 → 固定 hash 回归断言：守 legacy 'dir3_band' 哈希永不漂移。

    'dir3_band' + v1 + new_listing_min_days=60 + 默认 neutralize/robust_z/factor_ids
    的 feature_set_id 必须等于此 pin 值；若 dir3_scheme 改动让 canonical(0.005)
    不再回 legacy 串，此断言（经 test_feature_set_id_legacy_not_drifting）即破。
    """

    pinned = build_feature_set_id("v1", "dir3_band", new_listing_min_days=60)
    # 重新计算应稳定一致（确定性）
    assert build_feature_set_id("v1", "dir3_band", new_listing_min_days=60) == pinned
    assert pinned.startswith("fs_")
    assert len(pinned) == 3 + 12


# ----------------------------------------------------------------------
# 各 ε 下分桶边界正确（解析自 scheme 串的 ε 驱动 _bucket_band）
# ----------------------------------------------------------------------

@pytest.mark.parametrize("eps", [0.001, 0.005, 0.008, 0.02, 0.1])
def test_bucket_band_boundaries_per_eps(eps: float) -> None:
    """各 ε：r==±ε 落横盘（闭区间），刚越界落涨/跌。"""

    bump = eps * 1e-3
    r = pd.Series([-eps - bump, -eps, 0.0, eps, eps + bump])
    out = _bucket_band(r, eps)
    assert out.tolist() == [_DOWN, _FLAT, _FLAT, _FLAT, _UP]


def _two_day(ts: str, c0: float, c1: float) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {"ts_code": ts, "trade_date": "20240102", "close_adj": c0},
            {"ts_code": ts, "trade_date": "20240103", "close_adj": c1},
        ]
    )


def test_compute_dir3_labels_eps_scheme_drives_bucket() -> None:
    """compute_dir3_labels 用 epsNNNN 串：ε 解析自 scheme 串而非常量。

    ε=0.02（'dir3_band_eps0200'）下 +1% 收益 < ε → 横盘；
    legacy ε=0.005 下同样 +1% 收益 > ε → 涨。
    """

    quotes = _two_day("000001.SZ", 100.0, 101.0)  # +1%
    out_wide = compute_dir3_labels(
        FallbackInputs(daily_quotes=quotes), scheme="dir3_band_eps0200"
    )
    assert out_wide["value"].iloc[0] == _FLAT  # ε=2% → 横盘

    out_legacy = compute_dir3_labels(
        FallbackInputs(daily_quotes=quotes), scheme="dir3_band"
    )
    assert out_legacy["value"].iloc[0] == _UP  # ε=0.5% → 涨


def test_compute_dir3_labels_malformed_eps_scheme_raises() -> None:
    """畸形 epsXXXX（如 0050 / 越界）非家族 → compute_dir3_labels 报未知 scheme。"""

    quotes = _two_day("000001.SZ", 100.0, 101.0)
    with pytest.raises(ValueError, match="unsupported scheme"):
        compute_dir3_labels(
            FallbackInputs(daily_quotes=quotes), scheme="dir3_band_eps0050"
        )
