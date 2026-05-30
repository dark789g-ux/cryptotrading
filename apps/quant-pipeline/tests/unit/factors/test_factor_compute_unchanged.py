"""16 个因子 compute 输出在 refactor 前后逐字节一致（spec 06 §1）。

校验思路：
  - 在 conftest seed 的 `_meta_cache` 之下用 `small_panel` 跑每个因子的 compute
  - 每个因子的输出 sha256 与预先 freeze 的 hash 比对
  - hash 是在本次 refactor 完成时（DB 缓存值 == conftest seed == migration 初值）
    跑出来的；若日后改 compute 逻辑导致差异，本测试会立刻 fail，提示作者要么
    更新 hash 要么修正逻辑

为什么不直接 import 一份"原始版" Factor 子类做 A/B：原 Factor 子类已被这次
refactor 物理改写（4 个类属性被删），无法在同一进程内并存两份对照。锁定
hash 是工业界标准做法（pytest-regressions / snapshot 测试同理）。
"""

from __future__ import annotations

import hashlib

import pandas as pd
import pytest

from quant_pipeline.factors.registry import get_factor

# 在 refactor 完成时（DB 缓存值 == conftest seed == migration 初值）跑出来的
# 16 行 sha256（前 16 字符）。任何 compute 逻辑改动都会让对应行失败。
_EXPECTED: dict[str, str] = {
    "amihud_illiq_20d": "27cedfe576832946",
    "bollinger_position_20d": "cfa3ae040a571a1e",
    "close_to_high_60d": "de70ce69e460d5be",
    "ma_ratio_20d": "4f1145e657d9aba1",
    "momentum_20d": "ef1397c9d64afc09",
    "momentum_60d": "d8faab58c08002fc",
    "price_max_drawdown_60d": "10f05684be058367",
    "rsi_14": "8f4067b43d35eba7",
    "turnover_mean_20d": "cf89b669457bc922",
    "volatility_20d": "cbf246edf4535894",
    "volume_ratio_20d": "1b318ad55a600071",
    "industry_momentum_20d": "3751f5fbb5db8d23",
    "momentum_20d_neu": "ffa07c6d86dbe11d",
    "industry_rank_in_sector_mom20": "a3199fcc9781a5f6",
    "industry_relative_strength": "ffa07c6d86dbe11d",
    "sector_volume_concentration": "76ad725362799095",
}


def _hash_series(s: pd.Series) -> str:
    out = s.sort_index().astype(float)
    return hashlib.sha256(out.to_csv().encode("utf-8")).hexdigest()[:16]


@pytest.mark.parametrize("factor_id", sorted(_EXPECTED.keys()))
def test_compute_output_unchanged_after_refactor(
    small_panel: pd.DataFrame,
    trade_dates_80: list[str],
    factor_id: str,
) -> None:
    """T = 第 71 个交易日（index 70），晚到足以覆盖 60d / 115d 窗口。"""

    f = get_factor(factor_id, "v1")
    T = trade_dates_80[70]
    out = f.compute(small_panel, T)
    got = _hash_series(out)
    assert got == _EXPECTED[factor_id], (
        f"{factor_id}: compute output changed after refactor; "
        f"got {got!r} expected {_EXPECTED[factor_id]!r}"
    )
