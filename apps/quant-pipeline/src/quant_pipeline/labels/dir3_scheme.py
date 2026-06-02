"""dir3_band 横盘阈值 ε ↔ label_scheme 字符串的**唯一**编解码器（spec A2）。

`dir3_band` 把「次日收益 |r| ≤ ε 判横盘」。ε 必须进 `feature_set_id` 的确定性
哈希（哈希输入含 `label_scheme`），否则不同 ε 哈希到同一 id → 缓存污染。方案：
把 ε 规范化后**编进 scheme 字符串**，决定性天然成立，零改动 `build_feature_set_id`
签名。本模块是 ε↔scheme 串的**单一源**，杜绝「散点白名单漏改一处」。

scheme 串格式（4 位定宽，`NNNN = round(eps*10000)`）：
    0.1%  → 'dir3_band_eps0010'
    1%    → 'dir3_band_eps0100'
    2%    → 'dir3_band_eps0200'
    10%   → 'dir3_band_eps1000'

**回归约束（关键）**：ε=0.005 量化后**必须**回到 legacy 串 `'dir3_band'`
（不是 `'dir3_band_eps0050'`），否则现存 dir3_band 的 feature_set_id 哈希漂移、
老特征集变孤儿。`'0050'`（=0.005）被 legacy 别名抢占，**永不**作为 scheme 串产出。
"""

from __future__ import annotations

import re
from typing import Final

EPS_GRID: Final[float] = 0.001        # 0.1% 网格步长
EPS_MIN: Final[float] = 0.001         # 合法范围下界（一个网格）
EPS_MAX: Final[float] = 0.1           # 合法范围上界（0<ε≤0.1）
LEGACY_DIR3_BAND: Final[str] = "dir3_band"
LEGACY_EPS: Final[float] = 0.005      # legacy 默认 ε，canonical 回 legacy 串

# epsNNNN 变体串正则（4 位定宽）。
_EPS_SCHEME_RE: Final[re.Pattern[str]] = re.compile(r"^dir3_band_eps(\d{4})$")
# round(LEGACY_EPS*10000) == 50 → 被 legacy 别名抢占，永不作为 scheme 串产出。
_LEGACY_NNNN: Final[int] = 50


def quantize_eps(eps: float) -> float:
    """量化 ε 到 0.1% 网格（四舍五入），并校验范围；越界抛 ValueError。

    `ε < 半个网格`（< 0.0005）量化后为 0，按 ≤0 越界报错——故有效最小可表示
    ε 即 EPS_MIN=0.001（一个网格），与文字范围 0<ε≤0.1 由网格步长天然咬合。
    """

    if not isinstance(eps, (int, float)) or isinstance(eps, bool):
        raise ValueError(f"dir3_band_eps: must be a number, got {type(eps).__name__}")
    eps_f = float(eps)
    # round(eps/grid) 四舍五入到网格步数，再乘回网格步长。
    steps = round(eps_f / EPS_GRID)
    quantized = steps * EPS_GRID
    # 浮点对齐：网格步长可整除，round 到 4 位小数消除二进制漂移。
    quantized = round(quantized, 4)
    if quantized < EPS_MIN or quantized > EPS_MAX:
        raise ValueError(
            f"dir3_band_eps: must be in ({EPS_MIN - EPS_GRID:.4f}, {EPS_MAX:.4f}] "
            f"after quantize, got eps={eps_f!r} → {quantized!r}"
        )
    return quantized


def canonical_dir3_band_scheme(eps: float) -> str:
    """ε → canonical scheme 串。

    量化后若 == LEGACY_EPS(0.005) → 'dir3_band'（legacy 别名，守哈希不漂移）；
    否则 f'dir3_band_eps{round(eps*10000):04d}'，例 0.008 → 'dir3_band_eps0080'。
    """

    quantized = quantize_eps(eps)
    nnnn = round(quantized * 10000)
    if nnnn == _LEGACY_NNNN:
        return LEGACY_DIR3_BAND
    return f"dir3_band_eps{nnnn:04d}"


def parse_dir3_band_eps(scheme: str) -> float | None:
    """scheme 串 → ε。非 dir3_band 家族 → None。

    'dir3_band' → LEGACY_EPS(0.005)；'dir3_band_epsNNNN' → NNNN/10000，
    且要求落网格、在 (0, EPS_MAX] 内、且 != legacy NNNN（'0050' 被别名抢占，
    非 canonical 串视为畸形）。畸形 → None（调用方按未知 scheme 报错）。
    """

    if not isinstance(scheme, str):
        return None
    if scheme == LEGACY_DIR3_BAND:
        return LEGACY_EPS
    m = _EPS_SCHEME_RE.match(scheme)
    if m is None:
        return None
    nnnn = int(m.group(1))
    # '0050' 是 legacy 别名的专属编码，非 canonical 串 → 视为畸形。
    if nnnn == _LEGACY_NNNN:
        return None
    eps = nnnn / 10000.0
    if eps < EPS_MIN or eps > EPS_MAX:
        return None
    return round(eps, 4)


def is_dir3_band_scheme(scheme: str) -> bool:
    """scheme 是否属 dir3_band 家族（legacy 或合法 epsNNNN 变体）。

    判定单一源：与 parse_dir3_band_eps 同口径（畸形 epsXXXX 不算家族成员）。
    """

    return parse_dir3_band_eps(scheme) is not None


__all__ = [
    "EPS_GRID",
    "EPS_MIN",
    "EPS_MAX",
    "LEGACY_DIR3_BAND",
    "LEGACY_EPS",
    "quantize_eps",
    "canonical_dir3_band_scheme",
    "parse_dir3_band_eps",
    "is_dir3_band_scheme",
]
