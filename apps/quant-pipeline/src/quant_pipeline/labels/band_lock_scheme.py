"""band_lock 出场参数 ↔ label_scheme 字符串的**唯一**编解码器（spec A2/02）。

band_lock（波段跟踪止损 trailing_lock）把出场参数编进 `factors.labels.scheme` 串。
该串进 `feature_set_id` 的确定性哈希（哈希输入含 `label_scheme`），所以参数编码不是
「可读性」问题，是**哈希稳定性 / 缓存不污染**的硬约束（参 dir3_scheme.py 模块 docstring）。

scheme 串格式（4 位定宽整数，固定顺序）：
    band_lock[__mh{N}][__sr{NNNN}][__fr{NNNN}][__fl{0|1}][__md{0|1}]
                │         │           │          │          │
                │         │           │          │          └ ma5_require_down (0=false)
                │         │           │          └ floor_enabled    (0=false)
                │         │           └ floor_ratio  NNNN=round_half_up(ratio*1000)
                │         └ stop_ratio  NNNN=round_half_up(ratio*1000)
                └ max_hold 正整数（沿用现状，不补零）
    顺序固定：mh → sr → fr → fl → md（与 spec 01 §四 一致）。

**唯一量化算法（两语言必须一致）**：`NNNN = math.floor(ratio*1000 + 0.5)`
（round-half-up，**非** Python 内建 `round()` 的 banker's；TS 用 `Math.round`，ratio 恒正）。
还原 `ratio = NNNN/1000`。

**回归约束（关键）**：等于默认值的参数一律不进串。
  - 全默认 → legacy 串 `'band_lock'`（不是 `'band_lock__sr0999__fl1__md1'`）；
  - 仅 max_hold → `'band_lock__mh{N}'`（守现存标签的 feature_set_id 哈希不漂移）。
否则现存 band_lock 标签的哈希漂移、老特征集变孤儿。

默认值钉死现存共享核 strategy/band_lock_exit.py 硬编码：止损/地板系数 0.999、
布尔门控默认 True、max_hold 默认 None（不设硬上限）。

纯计算：不连 DB、不读文件、无副作用。
"""

from __future__ import annotations

import math
import re
from typing import Final

# ── 默认值（钉死共享核 band_lock_exit.py 现存硬编码；canonical 默认必须回 legacy）──
DEFAULT_STOP_RATIO: Final[float] = 0.999       # band_lock_exit.py 止损基准 ×0.999
DEFAULT_FLOOR_RATIO: Final[float] = 0.999      # band_lock_exit.py 成本地板 ×0.999
DEFAULT_FLOOR_ENABLED: Final[bool] = True      # 成本地板默认启用
DEFAULT_MA5_REQUIRE_DOWN: Final[bool] = True   # MA5 离场默认要求均线下行
# max_hold 默认 None（不设硬上限）——不放进常量字典，缺省即 None。

# ── 量化网格 / NNNN 范围 ──
RATIO_GRID: Final[int] = 1000                  # 千分位网格（NNNN = round_half_up(ratio*1000)）
STOP_RATIO_NNNN_MIN: Final[int] = 1            # stop_ratio ∈ [0.001, 1.0]
STOP_RATIO_NNNN_MAX: Final[int] = 1000
FLOOR_RATIO_NNNN_MIN: Final[int] = 1           # floor_ratio ∈ [0.001, 9.999]（可 >1 锁盈）
FLOOR_RATIO_NNNN_MAX: Final[int] = 9999

LEGACY_BAND_LOCK: Final[str] = "band_lock"     # 全默认 canonical 别名（守哈希不漂移）

# 默认值对应的 NNNN（等于此值的 ratio 省略后缀；0999 永不作为后缀产出）。
_DEFAULT_STOP_NNNN: Final[int] = 999
_DEFAULT_FLOOR_NNNN: Final[int] = 999

# 解析用正则：每个后缀段（双下划线分隔后的一段）。4 位定宽 ratio / 单位布尔 / 任意位 mh。
_MH_RE: Final[re.Pattern[str]] = re.compile(r"^mh(\d+)$")
_SR_RE: Final[re.Pattern[str]] = re.compile(r"^sr(\d{4})$")
_FR_RE: Final[re.Pattern[str]] = re.compile(r"^fr(\d{4})$")
_FL_RE: Final[re.Pattern[str]] = re.compile(r"^fl([01])$")
_MD_RE: Final[re.Pattern[str]] = re.compile(r"^md([01])$")

# 后缀固定顺序（mh→sr→fr→fl→md），用于解析时的顺序校验。
_SUFFIX_ORDER: Final[tuple[str, ...]] = ("mh", "sr", "fr", "fl", "md")


def _round_half_up_nnnn(ratio: float) -> int:
    """量化 ratio 到千分位 NNNN：NNNN = math.floor(ratio*1000 + 0.5)（round-half-up）。

    **禁用** Python 内建 round()（banker's 舍入会与 TS Math.round 分叉）。ratio 恒正，
    故 floor(x+0.5) 即正数 round-half-up，与 TS `Math.round(ratio*1000)` 逐位一致。
    """

    return math.floor(ratio * RATIO_GRID + 0.5)


def _quantize_ratio(
    value: object, *, name: str, nnnn_min: int, nnnn_max: int
) -> float:
    """量化单个 ratio 参数：先量化（round-half-up）后校验 NNNN 范围；越界/类型 → ValueError。

    返回量化后 ratio = NNNN/1000（与编码、与其它入口同一 double）。
    """

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(
            f"band_lock {name}: must be a number, got {type(value).__name__}"
        )
    nnnn = _round_half_up_nnnn(float(value))
    if nnnn < nnnn_min or nnnn > nnnn_max:
        raise ValueError(
            f"band_lock {name}: NNNN must be in [{nnnn_min}, {nnnn_max}] after quantize, "
            f"got {value!r} -> NNNN={nnnn}"
        )
    return nnnn / RATIO_GRID


def _validate_bool(value: object, *, name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(
            f"band_lock {name}: must be a bool, got {type(value).__name__}"
        )
    return value


def _validate_max_hold(value: object) -> int | None:
    """max_hold 必须为正整数或 None；bool / 0 / 负 / 浮点 / 字符串 → ValueError。"""

    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(
            f"band_lock max_hold: must be a positive int or None, got {value!r}"
        )
    return int(value)


def quantize_band_lock_params(params: dict) -> dict:
    """band_lock 出场参数 → 量化 + 校验后的完整 params（默认回填）。

    **顺序：先量化后校验**。ratio 先 `NNNN = math.floor(ratio*1000 + 0.5)`，再校验
    `stop_ratio` NNNN∈[1,1000]、`floor_ratio` NNNN∈[1,9999]；布尔为 bool；max_hold 为
    正整数或 None。越界（含输入 <0.0005 量化到 0 越下界）或类型错 → ValueError。

    返回 dict（键：max_hold / stop_ratio / floor_ratio / floor_enabled / ma5_require_down），
    ratio = NNNN/1000（与编码、与其它入口同一 double）。
    """

    if not isinstance(params, dict):
        raise ValueError(
            f"band_lock params: must be a dict, got {type(params).__name__}"
        )

    max_hold = _validate_max_hold(params.get("max_hold"))

    stop_ratio = (
        _quantize_ratio(
            params["stop_ratio"],
            name="stop_ratio",
            nnnn_min=STOP_RATIO_NNNN_MIN,
            nnnn_max=STOP_RATIO_NNNN_MAX,
        )
        if "stop_ratio" in params and params["stop_ratio"] is not None
        else DEFAULT_STOP_RATIO
    )
    floor_ratio = (
        _quantize_ratio(
            params["floor_ratio"],
            name="floor_ratio",
            nnnn_min=FLOOR_RATIO_NNNN_MIN,
            nnnn_max=FLOOR_RATIO_NNNN_MAX,
        )
        if "floor_ratio" in params and params["floor_ratio"] is not None
        else DEFAULT_FLOOR_RATIO
    )
    floor_enabled = (
        _validate_bool(params["floor_enabled"], name="floor_enabled")
        if "floor_enabled" in params and params["floor_enabled"] is not None
        else DEFAULT_FLOOR_ENABLED
    )
    ma5_require_down = (
        _validate_bool(params["ma5_require_down"], name="ma5_require_down")
        if "ma5_require_down" in params and params["ma5_require_down"] is not None
        else DEFAULT_MA5_REQUIRE_DOWN
    )

    return {
        "max_hold": max_hold,
        "stop_ratio": stop_ratio,
        "floor_ratio": floor_ratio,
        "floor_enabled": floor_enabled,
        "ma5_require_down": ma5_require_down,
    }


def canonical_band_lock_scheme(params: dict) -> str:
    """band_lock 出场参数 → canonical scheme 串。

    量化 → 逐参数判断是否默认 → 非默认者按固定顺序 mh→sr→fr→fl→md 拼后缀。
    全默认 → 'band_lock'；仅 max_hold → 'band_lock__mh{N}'（守现存哈希）。
    sr/fr 用 4 位定宽 `{NNNN:04d}`；fl/md 用 0/1；等于默认值的参数省略。
    """

    p = quantize_band_lock_params(params)
    parts: list[str] = [LEGACY_BAND_LOCK]

    if p["max_hold"] is not None:
        parts.append(f"mh{int(p['max_hold'])}")

    stop_nnnn = _round_half_up_nnnn(p["stop_ratio"])
    if stop_nnnn != _DEFAULT_STOP_NNNN:
        parts.append(f"sr{stop_nnnn:04d}")

    floor_nnnn = _round_half_up_nnnn(p["floor_ratio"])
    if floor_nnnn != _DEFAULT_FLOOR_NNNN:
        parts.append(f"fr{floor_nnnn:04d}")

    if p["floor_enabled"] != DEFAULT_FLOOR_ENABLED:
        parts.append("fl0")  # 仅 false（非默认）出现

    if p["ma5_require_down"] != DEFAULT_MA5_REQUIRE_DOWN:
        parts.append("md0")  # 仅 false（非默认）出现

    return "__".join(parts)


def parse_band_lock_scheme(scheme: str) -> dict | None:
    """scheme 串 → 完整 params（含默认回填）。非 band_lock 家族或畸形 → None。

    'band_lock' → 全默认；'band_lock__...' 合法变体 → 解析非默认后缀 + 默认回填。
    校验：后缀顺序正确（mh→sr→fr→fl→md）、NNNN 落网格且在范围内、布尔位 ∈ {0,1}、
    无重复 / 未知后缀、ratio 非默认值（默认值 0999 被 legacy 省略抢占，显式入串视为畸形）、
    mh 为正整数。任一不满足 → None（调用方按未知 scheme 报错）。
    """

    if not isinstance(scheme, str):
        return None
    if scheme == LEGACY_BAND_LOCK:
        return _backfill_defaults({})
    prefix = LEGACY_BAND_LOCK + "__"
    if not scheme.startswith(prefix):
        return None

    suffix_str = scheme[len(prefix):]
    if suffix_str == "":
        return None  # 'band_lock__' 空后缀
    segments = suffix_str.split("__")
    if any(seg == "" for seg in segments):
        return None  # 连续/末尾双下划线产生空段

    parsed: dict[str, object] = {}
    seen_order: list[str] = []

    for seg in segments:
        key, value = _parse_segment(seg)
        if key is None:
            return None  # 未知后缀 / NNNN 越界 / 布尔位非法 / 默认值入串 / mh 非正整数
        if key in parsed:
            return None  # 重复后缀
        parsed[key] = value
        seen_order.append(key)

    # 顺序校验：seen_order 必须是 _SUFFIX_ORDER 的子序列（严格递增）。
    expected_index = [_SUFFIX_ORDER.index(k) for k in seen_order]
    if expected_index != sorted(expected_index):
        return None

    return _backfill_defaults(parsed)


def _parse_segment(seg: str) -> tuple[str | None, object]:
    """单个后缀段 → (key, value)。畸形 → (None, None)。

    key ∈ {max_hold, stop_ratio, floor_ratio, floor_enabled, ma5_require_down}（解析后名）；
    但返回的 key 用顺序标识 mh/sr/fr/fl/md（与 _SUFFIX_ORDER 对齐）便于顺序/重复判定，
    随后由 _backfill_defaults 翻译为参数名。
    """

    m = _MH_RE.match(seg)
    if m is not None:
        n = int(m.group(1))
        if n < 1:
            return None, None  # mh0 / 负不合法
        return "mh", n

    m = _SR_RE.match(seg)
    if m is not None:
        nnnn = int(m.group(1))
        if nnnn < STOP_RATIO_NNNN_MIN or nnnn > STOP_RATIO_NNNN_MAX:
            return None, None
        if nnnn == _DEFAULT_STOP_NNNN:
            return None, None  # 默认值显式入串 → 非 canonical → 畸形
        return "sr", nnnn / RATIO_GRID

    m = _FR_RE.match(seg)
    if m is not None:
        nnnn = int(m.group(1))
        if nnnn < FLOOR_RATIO_NNNN_MIN or nnnn > FLOOR_RATIO_NNNN_MAX:
            return None, None
        if nnnn == _DEFAULT_FLOOR_NNNN:
            return None, None  # 默认值显式入串 → 畸形
        return "fr", nnnn / RATIO_GRID

    m = _FL_RE.match(seg)
    if m is not None:
        bit = m.group(1)
        # 仅非默认 false（'fl0'）合法；'fl1'(=默认 True) 被 canonical 省略 → 畸形。
        if bit != "0":
            return None, None
        return "fl", False

    m = _MD_RE.match(seg)
    if m is not None:
        bit = m.group(1)
        if bit != "0":
            return None, None  # 'md1'(=默认 True) 被省略 → 畸形
        return "md", False

    return None, None  # 未知后缀


_SUFFIX_TO_PARAM: Final[dict[str, str]] = {
    "mh": "max_hold",
    "sr": "stop_ratio",
    "fr": "floor_ratio",
    "fl": "floor_enabled",
    "md": "ma5_require_down",
}


def _backfill_defaults(parsed: dict) -> dict:
    """已解析的非默认后缀（key=mh/sr/fr/fl/md）+ 默认回填 → 完整 params。"""

    out: dict[str, object] = {
        "max_hold": None,
        "stop_ratio": DEFAULT_STOP_RATIO,
        "floor_ratio": DEFAULT_FLOOR_RATIO,
        "floor_enabled": DEFAULT_FLOOR_ENABLED,
        "ma5_require_down": DEFAULT_MA5_REQUIRE_DOWN,
    }
    for suffix_key, value in parsed.items():
        out[_SUFFIX_TO_PARAM[suffix_key]] = value
    return out


def is_band_lock_scheme(scheme: str) -> bool:
    """scheme 是否属 band_lock 家族（legacy 或合法变体）。

    判定单一源：与 parse_band_lock_scheme 同口径（畸形不算家族成员）。
    """

    return parse_band_lock_scheme(scheme) is not None


__all__ = [
    "DEFAULT_STOP_RATIO",
    "DEFAULT_FLOOR_RATIO",
    "DEFAULT_FLOOR_ENABLED",
    "DEFAULT_MA5_REQUIRE_DOWN",
    "RATIO_GRID",
    "STOP_RATIO_NNNN_MIN",
    "STOP_RATIO_NNNN_MAX",
    "FLOOR_RATIO_NNNN_MIN",
    "FLOOR_RATIO_NNNN_MAX",
    "LEGACY_BAND_LOCK",
    "quantize_band_lock_params",
    "canonical_band_lock_scheme",
    "parse_band_lock_scheme",
    "is_band_lock_scheme",
]
