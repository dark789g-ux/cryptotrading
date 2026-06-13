"""phase_lock 出场参数 ↔ label_scheme 字符串的**唯一**编解码器（spec 02）。

phase_lock（阶段锁定出场）把出场参数编进 `factors.labels.scheme` 串。
该串进 `feature_set_id` 的确定性哈希（哈希输入含 `label_scheme`），所以参数编码不是
「可读性」问题，是**哈希稳定性 / 缓存不污染**的硬约束（与 band_lock_scheme.py 同理）。

**逐函数镜像 band_lock_scheme.py**，仅参数集替换为 phase_lock 的三个可配参数
（lookback / init_factor / lock_factor），其余校验纪律 / 量化算法 / legacy 别名机制
完全照搬。

scheme 串格式（4 位定宽 ratio，固定顺序）：
    phase_lock[__lb{N}][__if{NNNN}][__lf{NNNN}]
                  │         │           │
                  │         │           └ lock_factor  NNNN=round_half_up(ratio*1000)
                  │         └ init_factor  NNNN=round_half_up(ratio*1000)
                  └ lookback 正整数（沿用 band_lock mh 风格，不补零）
    顺序固定：lb → if → lf（与 spec 02 §canonical scheme 编码 一致）。

**唯一量化算法（两语言必须一致）**：`NNNN = math.floor(ratio*1000 + 0.5)`
（round-half-up，**非** Python 内建 `round()` 的 banker's；TS 用 `Math.round`，ratio 恒正）。
还原 `ratio = NNNN/1000`。

**回归约束（关键）**：等于默认值的参数一律不进串。
  - 全默认 → legacy 串 `'phase_lock'`（不是 `'phase_lock__lb10__if0999__lf0999'`）；
  - 仅 lookback=15 → `'phase_lock__lb15'`（守现存标签的 feature_set_id 哈希不漂移）。
否则现存 phase_lock 标签的哈希漂移、老特征集变孤儿。

默认值钉死共享核 strategy/phase_lock_exit.py 硬编码（DEFAULT_INIT_FACTOR /
DEFAULT_LOCK_FACTOR / DEFAULT_LOOKBACK 是**唯一权威源**，本模块只 import 引用）：
init/lock 系数 0.999、lookback 10。

纯计算：不连 DB、不读文件、无副作用。
"""

from __future__ import annotations

import math
import re
from typing import Final

# ── 默认值（**唯一权威源**是 phase_lock_exit.py；本模块只 import，不重新定义）──
# canonical 默认必须回 legacy → 默认值改一处（phase_lock_exit.py）即全链路同步。
from quant_pipeline.strategy.phase_lock_exit import (
    DEFAULT_INIT_FACTOR,
    DEFAULT_LOCK_FACTOR,
    DEFAULT_LOOKBACK,
)

# ── 量化网格 / NNNN 范围（spec 02 §参数范围）──
RATIO_GRID: Final[int] = 1000                   # 千分位网格（NNNN = round_half_up(ratio*1000)）
INIT_FACTOR_NNNN_MIN: Final[int] = 1            # init_factor ∈ (0, 2.0]
INIT_FACTOR_NNNN_MAX: Final[int] = 2000
LOCK_FACTOR_NNNN_MIN: Final[int] = 1            # lock_factor ∈ (0, 2.0]
LOCK_FACTOR_NNNN_MAX: Final[int] = 2000
LOOKBACK_MIN: Final[int] = 1                    # lookback ∈ [1, 250]
LOOKBACK_MAX: Final[int] = 250                  # 上界 ≈ 一年交易日，防误填巨值

LEGACY_PHASE_LOCK: Final[str] = "phase_lock"    # 全默认 canonical 别名（守哈希不漂移）

# 默认值对应的 NNNN（等于此值的 ratio 省略后缀；0999 永不作为后缀产出）。
_DEFAULT_INIT_NNNN: Final[int] = math.floor(DEFAULT_INIT_FACTOR * RATIO_GRID + 0.5)
_DEFAULT_LOCK_NNNN: Final[int] = math.floor(DEFAULT_LOCK_FACTOR * RATIO_GRID + 0.5)

# 解析用正则：每个后缀段（双下划线分隔后的一段）。4 位定宽 ratio / 任意位 lb。
_LB_RE: Final[re.Pattern[str]] = re.compile(r"^lb(\d+)$")
_IF_RE: Final[re.Pattern[str]] = re.compile(r"^if(\d{4})$")
_LF_RE: Final[re.Pattern[str]] = re.compile(r"^lf(\d{4})$")

# 后缀固定顺序（lb→if→lf），用于解析时的顺序校验。
_SUFFIX_ORDER: Final[tuple[str, ...]] = ("lb", "if", "lf")


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
            f"phase_lock {name}: must be a number, got {type(value).__name__}"
        )
    nnnn = _round_half_up_nnnn(float(value))
    if nnnn < nnnn_min or nnnn > nnnn_max:
        raise ValueError(
            f"phase_lock {name}: NNNN must be in [{nnnn_min}, {nnnn_max}] after quantize, "
            f"got {value!r} -> NNNN={nnnn}"
        )
    return nnnn / RATIO_GRID


def _validate_lookback(value: object) -> int:
    """lookback 必须为正整数（∈[1,250]）或 None（回默认）。

    bool / 0 / 负 / 浮点 / 字符串 / 越界 → ValueError。
    """

    if value is None:
        return DEFAULT_LOOKBACK
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(
            f"phase_lock lookback: must be a positive int or None, got {value!r}"
        )
    if value < LOOKBACK_MIN or value > LOOKBACK_MAX:
        raise ValueError(
            f"phase_lock lookback: must be in [{LOOKBACK_MIN}, {LOOKBACK_MAX}], got {value!r}"
        )
    return int(value)


def quantize_phase_lock_params(params: dict) -> dict:
    """phase_lock 出场参数 → 量化 + 校验后的完整 params（默认回填）。

    **顺序：先量化后校验**。ratio 先 `NNNN = math.floor(ratio*1000 + 0.5)`，再校验
    `init_factor` / `lock_factor` NNNN∈[1,2000]；lookback 为正整数 [1,250]。越界
    （含输入 <0.0005 量化到 0 越下界）或类型错 → ValueError。

    返回 dict（键：lookback / init_factor / lock_factor），ratio = NNNN/1000
    （与编码、与其它入口同一 double）。
    """

    if not isinstance(params, dict):
        raise ValueError(
            f"phase_lock params: must be a dict, got {type(params).__name__}"
        )

    lookback = _validate_lookback(params.get("lookback"))

    init_factor = (
        _quantize_ratio(
            params["init_factor"],
            name="init_factor",
            nnnn_min=INIT_FACTOR_NNNN_MIN,
            nnnn_max=INIT_FACTOR_NNNN_MAX,
        )
        if "init_factor" in params and params["init_factor"] is not None
        else DEFAULT_INIT_FACTOR
    )
    lock_factor = (
        _quantize_ratio(
            params["lock_factor"],
            name="lock_factor",
            nnnn_min=LOCK_FACTOR_NNNN_MIN,
            nnnn_max=LOCK_FACTOR_NNNN_MAX,
        )
        if "lock_factor" in params and params["lock_factor"] is not None
        else DEFAULT_LOCK_FACTOR
    )

    return {
        "lookback": lookback,
        "init_factor": init_factor,
        "lock_factor": lock_factor,
    }


def canonical_phase_lock_scheme(params: dict) -> str:
    """phase_lock 出场参数 → canonical scheme 串。

    量化 → 逐参数判断是否默认 → 非默认者按固定顺序 lb→if→lf 拼后缀。
    全默认 → 'phase_lock'；仅 lookback → 'phase_lock__lb{N}'（守现存哈希）。
    if/lf 用 4 位定宽 `{NNNN:04d}`；等于默认值的参数省略。
    """

    p = quantize_phase_lock_params(params)
    parts: list[str] = [LEGACY_PHASE_LOCK]

    if int(p["lookback"]) != DEFAULT_LOOKBACK:
        parts.append(f"lb{int(p['lookback'])}")

    init_nnnn = _round_half_up_nnnn(p["init_factor"])
    if init_nnnn != _DEFAULT_INIT_NNNN:
        parts.append(f"if{init_nnnn:04d}")

    lock_nnnn = _round_half_up_nnnn(p["lock_factor"])
    if lock_nnnn != _DEFAULT_LOCK_NNNN:
        parts.append(f"lf{lock_nnnn:04d}")

    return "__".join(parts)


def parse_phase_lock_scheme(scheme: str) -> dict | None:
    """scheme 串 → 完整 params（含默认回填）。非 phase_lock 家族或畸形 → None。

    'phase_lock' → 全默认；'phase_lock__...' 合法变体 → 解析非默认后缀 + 默认回填。
    校验：后缀顺序正确（lb→if→lf）、NNNN 落网格且在范围内、无重复 / 未知后缀、
    ratio 非默认值（默认值 0999 被 legacy 省略抢占，显式入串视为畸形）、lb 为正整数
    且非默认 10。任一不满足 → None（调用方按未知 scheme 报错）。
    """

    if not isinstance(scheme, str):
        return None
    if scheme == LEGACY_PHASE_LOCK:
        return _backfill_defaults({})
    prefix = LEGACY_PHASE_LOCK + "__"
    if not scheme.startswith(prefix):
        return None

    suffix_str = scheme[len(prefix):]
    if suffix_str == "":
        return None  # 'phase_lock__' 空后缀
    segments = suffix_str.split("__")
    if any(seg == "" for seg in segments):
        return None  # 连续/末尾双下划线产生空段

    parsed: dict[str, object] = {}
    seen_order: list[str] = []

    for seg in segments:
        key, value = _parse_segment(seg)
        if key is None:
            return None  # 未知后缀 / NNNN 越界 / 默认值入串 / lb 非正整数或为默认
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

    返回的 key 用顺序标识 lb/if/lf（与 _SUFFIX_ORDER 对齐）便于顺序/重复判定，
    随后由 _backfill_defaults 翻译为参数名。
    """

    m = _LB_RE.match(seg)
    if m is not None:
        n = int(m.group(1))
        if n < LOOKBACK_MIN or n > LOOKBACK_MAX:
            return None, None  # lb0 / 负 / 越界不合法
        if n == DEFAULT_LOOKBACK:
            return None, None  # 默认值显式入串 → 非 canonical → 畸形
        return "lb", n

    m = _IF_RE.match(seg)
    if m is not None:
        nnnn = int(m.group(1))
        if nnnn < INIT_FACTOR_NNNN_MIN or nnnn > INIT_FACTOR_NNNN_MAX:
            return None, None
        if nnnn == _DEFAULT_INIT_NNNN:
            return None, None  # 默认值显式入串 → 非 canonical → 畸形
        return "if", nnnn / RATIO_GRID

    m = _LF_RE.match(seg)
    if m is not None:
        nnnn = int(m.group(1))
        if nnnn < LOCK_FACTOR_NNNN_MIN or nnnn > LOCK_FACTOR_NNNN_MAX:
            return None, None
        if nnnn == _DEFAULT_LOCK_NNNN:
            return None, None  # 默认值显式入串 → 畸形
        return "lf", nnnn / RATIO_GRID

    return None, None  # 未知后缀


_SUFFIX_TO_PARAM: Final[dict[str, str]] = {
    "lb": "lookback",
    "if": "init_factor",
    "lf": "lock_factor",
}


def _backfill_defaults(parsed: dict) -> dict:
    """已解析的非默认后缀（key=lb/if/lf）+ 默认回填 → 完整 params。"""

    out: dict[str, object] = {
        "lookback": DEFAULT_LOOKBACK,
        "init_factor": DEFAULT_INIT_FACTOR,
        "lock_factor": DEFAULT_LOCK_FACTOR,
    }
    for suffix_key, value in parsed.items():
        out[_SUFFIX_TO_PARAM[suffix_key]] = value
    return out


def is_phase_lock_scheme(scheme: str) -> bool:
    """scheme 是否属 phase_lock 家族（legacy 或合法变体）。

    判定单一源：与 parse_phase_lock_scheme 同口径（畸形不算家族成员）。
    """

    return parse_phase_lock_scheme(scheme) is not None


__all__ = [
    "DEFAULT_INIT_FACTOR",
    "DEFAULT_LOCK_FACTOR",
    "DEFAULT_LOOKBACK",
    "RATIO_GRID",
    "INIT_FACTOR_NNNN_MIN",
    "INIT_FACTOR_NNNN_MAX",
    "LOCK_FACTOR_NNNN_MIN",
    "LOCK_FACTOR_NNNN_MAX",
    "LOOKBACK_MIN",
    "LOOKBACK_MAX",
    "LEGACY_PHASE_LOCK",
    "quantize_phase_lock_params",
    "canonical_phase_lock_scheme",
    "parse_phase_lock_scheme",
    "is_phase_lock_scheme",
]
