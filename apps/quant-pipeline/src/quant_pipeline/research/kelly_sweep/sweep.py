"""网格扫描编排：入场变体 × 出场参数 → ResultRow 列表。

责任边界：
  - 调用已实现的 T1-T5 零件（enumerate/paths/entry_features/exits/metrics）。
  - 对每个 (入场变体 v, 出场配置 e) 组合：
      1. 按变体掩码取信号子集
      2. 在缓存的 ForwardPath 上运行出场模拟
      3. 按 signal_date 切分 train/valid 区间
      4. 计算指标（MetricResult），标注 window_group / below_floor
  - 返回 list[ResultRow]，供 T7 report 消费。

CI 取数方案（option b）：
  ResultRow 不携带 valid_rets（省内存）。T7 可调 valid_rets_for(row, paths)
  从 ResultRow.valid_keys（(ts_code, signal_date) 对列表）+ 缓存路径重算 rets。
  valid_keys 精确记录每条实际参与计算的 (ts_code, signal_date) 对，无歧义。
  对外暴露 valid_rets_for() 便捷函数（接收 ResultRow + paths 缓存即可，无需重查 DB）。

不做报告/CLI（T7 负责），不改 types.py，不改 __init__.py。
"""

from __future__ import annotations

import itertools
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import pandas as pd

from quant_pipeline.labels.band_lock_scheme import (
    DEFAULT_FLOOR_ENABLED,
    DEFAULT_FLOOR_RATIO,
    DEFAULT_MA5_REQUIRE_DOWN,
    DEFAULT_STOP_RATIO,
    quantize_band_lock_params,
)
from quant_pipeline.labels.phase_lock_scheme import quantize_phase_lock_params
from quant_pipeline.research.kelly_sweep.config import SweepConfig
from quant_pipeline.research.kelly_sweep.entry_features import (
    apply_threshold,
    dev_ma,
    down_streak,
    rs_vs_index,
    vol_contract,
    vol_regime_percentile,
)
from quant_pipeline.research.kelly_sweep.exits import (
    simulate_atr_stop,
    simulate_band_lock_exit,
    simulate_fixed_n,
    simulate_phase_lock_exit,
    simulate_tp_sl,
    simulate_trailing,
)
from quant_pipeline.research.kelly_sweep.metrics import compute_metrics
from quant_pipeline.research.kelly_sweep.types import ForwardPath, MetricResult
from quant_pipeline.strategy.phase_lock_exit import (
    DEFAULT_INIT_FACTOR as DEFAULT_INIT_FACTOR_PL,
)
from quant_pipeline.strategy.phase_lock_exit import (
    DEFAULT_LOCK_FACTOR as DEFAULT_LOCK_FACTOR_PL,
)
from quant_pipeline.strategy.phase_lock_exit import (
    DEFAULT_LOOKBACK as DEFAULT_LOOKBACK_PL,
)

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# RS 数据时间硬约束（与 entry_features._THS_MIN_DATE 同源）
# ─────────────────────────────────────────────────────────────────────────────
_THS_MIN_DATE = "20240102"

# ─────────────────────────────────────────────────────────────────────────────
# RS 基准名 → THS 指数代码映射（单一真相源）
# cli.py / kelly_sweep_runner.py 均从此处 import，禁止在别处硬编码副本。
# ─────────────────────────────────────────────────────────────────────────────
BENCH_CODE_MAP: dict[str, str] = {
    "hs300": "883300.TI",
    "zz500": "883304.TI",
}

# ─────────────────────────────────────────────────────────────────────────────
# 默认网格常量（可被 run_sweep 的 entry_grid / exit_grid 参数覆盖）
# ─────────────────────────────────────────────────────────────────────────────

# 附加特征阈值候选（spec 02§1）
# 格式：list of (feature_name, op, value)
# feature_name 是 _compute_feature_df 计算后的列名
DEFAULT_ENTRY_FILTER_CANDIDATES: list[tuple[str, str, float]] = [
    # kdj_j 更严档
    ("kdj_j", "lt", -10.0),
    ("kdj_j", "lt", -20.0),
    # dev_ma5
    ("dev_ma5", "lt", -0.03),
    ("dev_ma5", "lt", -0.05),
    ("dev_ma5", "lt", -0.08),
    # dev_ma30
    ("dev_ma30", "lt", -0.08),
    ("dev_ma30", "lt", -0.12),
    # down_streak
    ("down_streak", "gte", 3.0),
    ("down_streak", "gte", 4.0),
    ("down_streak", "gte", 5.0),
    # vol_contract
    ("vol_contract", "lt", 0.7),
    ("vol_contract", "lt", 0.5),
    # vol_regime（低波动档：分位 < 0.3）
    ("vol_regime", "lt", 0.3),
    # rs_vs_index 强于基准
    ("rs_vs_index", "gt", 0.0),
    # rs_vs_index 跟跌（弱于基准）
    ("rs_vs_index", "lt", 0.0),
]

# 出场参数网格（spec 03§1）
# 格式：ExitConfig 字典列表（type 字段标识出场类型）
DEFAULT_EXIT_GRID: list[dict[str, Any]] = []

# fixed_n: N ∈ {1, 2, 3, 5, 10}
for _n in [1, 2, 3, 5, 10]:
    DEFAULT_EXIT_GRID.append({"type": "fixed_n", "n": _n})

# tp_sl: TP ∈ {.03,.05,.08,.12} × SL ∈ {.02,.03,.05} × maxHold ∈ {5,10,20}
for _tp, _sl, _mh in itertools.product([0.03, 0.05, 0.08, 0.12], [0.02, 0.03, 0.05], [5, 10, 20]):
    DEFAULT_EXIT_GRID.append({"type": "tp_sl", "tp_pct": _tp, "sl_pct": _sl, "max_hold": _mh})

# trailing: Z ∈ {.03,.05,.08} × maxHold ∈ {10,20}
for _z, _mh in itertools.product([0.03, 0.05, 0.08], [10, 20]):
    DEFAULT_EXIT_GRID.append({"type": "trailing", "z_pct": _z, "max_hold": _mh})

# atr_stop: k ∈ {1.5,2,3} × maxHold ∈ {10,20}
for _k, _mh in itertools.product([1.5, 2.0, 3.0], [10, 20]):
    DEFAULT_EXIT_GRID.append({"type": "atr_stop", "k": _k, "max_hold": _mh})

# band_lock: 波段跟踪止损（共享核 strategy/band_lock_exit.py）。
# 参数仅 max_hold（已走过可交易持有日硬上限）；None=不封顶（核走窗口耗尽 no_exit→调用方兜底）。
# 候选 {None, 10, 20}：不封顶 + 两档封顶，照 trailing/atr_stop 的 {10,20} 风格并补一条不封顶。
for _mh in [None, 10, 20]:
    DEFAULT_EXIT_GRID.append({"type": "band_lock", "max_hold": _mh})

# 组合数警告阈值（spec 04§1）
_COMBO_WARN_THRESHOLD = 5000

# band_lock 族网格爆炸护栏阈值（spec 05§3.4）：band_lock 族 cfg 数 > 此值 → warn，
# 不拒绝、不截断（data-integrity「no silent caps」，尊重用户意图）。
_BAND_LOCK_GRID_WARN_THRESHOLD = 200

# phase_lock 族网格爆炸护栏阈值（spec 02 §kelly 默认网格）：对齐 band_lock 的 200。
_PHASE_LOCK_GRID_WARN_THRESHOLD = 200

# phase_lock 默认候选集（spec 02 §kelly 默认网格 → 4×4×3=48）。
_PHASE_LOCK_DEFAULT_LOOKBACKS: list[int] = [5, 10, 15, 20]
_PHASE_LOCK_DEFAULT_INIT_FACTORS: list[float] = [0.97, 0.98, 0.99, 1.00]
_PHASE_LOCK_DEFAULT_LOCK_FACTORS: list[float] = [0.99, 0.999, 1.005]

# 合法出场族名称（与 DEFAULT_EXIT_GRID 的 type 字段一一对应 + presence-driven 的 phase_lock）。
# 注：band_lock/phase_lock 在 kelly **不进** exit_families 白名单（presence-driven by
# band_lock_grid / phase_lock_grid），但 _KNOWN_EXIT_FAMILIES 是 _exit_id/_run_exit 的全集合法性
# 校验源，故仍登记（build_exit_grid 可显式取 band_lock 子集；phase_lock 无 DEFAULT 子集，
# build_exit_grid 取它得空列表，正常）。
_KNOWN_EXIT_FAMILIES: frozenset[str] = frozenset(
    ["fixed_n", "tp_sl", "trailing", "atr_stop", "band_lock", "phase_lock"]
)


def build_exit_grid(families: list[str]) -> list[dict[str, Any]]:
    """从 DEFAULT_EXIT_GRID 按 type 过滤出指定族的子集。

    runner 和 CLI 共用同一个函数，保证 Web 端与 CLI 端出场网格口径一致。

    Args:
        families: 出场族名称列表，子集 of {"fixed_n","tp_sl","trailing","atr_stop","band_lock"}。

    Returns:
        DEFAULT_EXIT_GRID 中 type 属于 families 的子列表（顺序保持与 DEFAULT_EXIT_GRID 一致）。

    Raises:
        ValueError: families 为空（至少选一族）或含未知 type（fail-fast）。
    """
    if not families:
        raise ValueError(
            "build_exit_grid: families 不能为空，"
            "至少选一族（fixed_n/tp_sl/trailing/atr_stop/band_lock）"
        )
    unknown = set(families) - _KNOWN_EXIT_FAMILIES
    if unknown:
        raise ValueError(
            f"build_exit_grid: 含未知出场族 {sorted(unknown)!r}，"
            f"合法值为 {sorted(_KNOWN_EXIT_FAMILIES)!r}"
        )
    family_set = set(families)
    return [cfg for cfg in DEFAULT_EXIT_GRID if cfg["type"] in family_set]


def build_band_lock_grid(
    max_hold_list: list[Optional[int]] = [None, 10, 20],
    stop_ratio_list: list[float] = [DEFAULT_STOP_RATIO],
    floor_ratio_list: list[float] = [DEFAULT_FLOOR_RATIO],
    floor_enabled_list: list[bool] = [DEFAULT_FLOOR_ENABLED],
    ma5_require_down_list: list[bool] = [DEFAULT_MA5_REQUIRE_DOWN],
) -> list[dict[str, Any]]:
    """band_lock 出场族候选集 → 笛卡尔积 + 依赖坍缩去重 → ExitConfig 字典列表（spec 05§3）。

    band_lock 网格 = max_hold × stop_ratio × floor_ratio × floor_enabled × ma5_require_down。

    **零漂移硬门**：默认候选集（不传参）= 现状 DEFAULT_EXIT_GRID 中 band_lock 3 个 cfg
    （max_hold ∈ {None,10,20}，4 新参数取核默认 0.999/0.999/True/True），且 _exit_id 逐字不变。

    各 ratio 候选进笛卡尔积前经 `quantize_band_lock_params` 量化（千分位 round-half-up，
    单一源，与 scheme 编码 / labels / TS 同一量化算法，避免分叉）。

    依赖坍缩去重（spec 01§依赖 + 05§3.2）：floor_ratio 仅在 floor_enabled=True 时生效。
      - floor_enabled=True  分支：正常展开 floor_ratio 候选。
      - floor_enabled=False 分支：floor_ratio 不影响结果 → 不展开（取占位默认 DEFAULT_FLOOR_RATIO）。
      按「有效参数指纹」去重：指纹 = (max_hold, stop_ratio, floor_enabled, ma5_require_down,
      floor_enabled ? floor_ratio : None)——False 时 floor_ratio 从指纹剔除。
      例：floor_enabled:[T,F] × floor_ratio:[0.998,0.999] → 3 个（非 4）。

    网格爆炸护栏（spec 05§3.4）：band_lock 族 cfg 数 > 200 → logger.warning（含各维度候选数），
    **不拒绝、不截断**（data-integrity「no silent caps」）。

    Args:
        max_hold_list:         max_hold 候选（None=不封顶 / 正整数）。
        stop_ratio_list:       stop_ratio 候选（量化前原始 ratio）。
        floor_ratio_list:      floor_ratio 候选（量化前原始 ratio）。
        floor_enabled_list:    floor_enabled 候选（bool）。
        ma5_require_down_list:  ma5_require_down 候选（bool）。

    Returns:
        [{type:'band_lock', max_hold, stop_ratio, floor_ratio, floor_enabled, ma5_require_down}, ...]，
        坍缩去重后顺序稳定（首次出现的指纹保留）。

    Raises:
        ValueError: 任一 ratio / max_hold 量化校验失败（透传 quantize_band_lock_params）。
    """
    # ── 各 ratio 候选预量化（单一源），并去重保稳定顺序 ─────────────────────────
    # quantize_band_lock_params 一次性量化 + 校验全部字段；ratio 用其量化结果（NNNN/1000）。
    quant_stop: list[float] = _dedup_keep_order(
        [quantize_band_lock_params({"stop_ratio": r})["stop_ratio"] for r in stop_ratio_list]
    )
    quant_floor: list[float] = _dedup_keep_order(
        [quantize_band_lock_params({"floor_ratio": r})["floor_ratio"] for r in floor_ratio_list]
    )
    quant_max_hold: list[Optional[int]] = _dedup_keep_order(
        [quantize_band_lock_params({"max_hold": mh})["max_hold"] for mh in max_hold_list]
    )
    quant_floor_enabled: list[bool] = _dedup_keep_order(list(floor_enabled_list))
    quant_ma5: list[bool] = _dedup_keep_order(list(ma5_require_down_list))

    grid: list[dict[str, Any]] = []
    seen: set[tuple] = set()  # 有效参数指纹集合（坍缩去重）

    for mh, sr, fe, md in itertools.product(
        quant_max_hold, quant_stop, quant_floor_enabled, quant_ma5
    ):
        # floor_enabled=False 时 floor_ratio 不展开（取占位默认），指纹剔除 floor_ratio。
        fr_candidates = quant_floor if fe else [DEFAULT_FLOOR_RATIO]
        for fr in fr_candidates:
            fingerprint = (mh, sr, fe, md, fr if fe else None)
            if fingerprint in seen:
                continue
            seen.add(fingerprint)
            grid.append(
                {
                    "type": "band_lock",
                    "max_hold": mh,
                    "stop_ratio": sr,
                    "floor_ratio": fr,
                    "floor_enabled": fe,
                    "ma5_require_down": md,
                }
            )

    if len(grid) > _BAND_LOCK_GRID_WARN_THRESHOLD:
        logger.warning(
            "band_lock 出场族生成 %d 个配置，超过软阈值 %d（"
            "max_hold=%d × stop_ratio=%d × floor_ratio=%d × floor_enabled=%d × ma5_require_down=%d，"
            "坍缩去重后 %d）。不截断，但多重检验过拟合风险高，请谨慎解读。",
            len(grid),
            _BAND_LOCK_GRID_WARN_THRESHOLD,
            len(quant_max_hold),
            len(quant_stop),
            len(quant_floor),
            len(quant_floor_enabled),
            len(quant_ma5),
            len(grid),
        )

    return grid


def build_phase_lock_grid(
    *,
    lookback_list: Optional[list[int]] = None,
    init_factor_list: Optional[list[float]] = None,
    lock_factor_list: Optional[list[float]] = None,
) -> list[dict[str, Any]]:
    """phase_lock 出场族候选集 → 笛卡尔积 + 去重 → ExitConfig 字典列表（spec 02/04）。

    **逐结构镜像 build_band_lock_grid**，差异仅参数集（lookback/init_factor/lock_factor，
    无 floor/ma5 依赖坍缩）。phase_lock 网格 = lookback × init_factor × lock_factor。

    默认候选集（不传参 / 传 None）= spec 02 §kelly 默认网格：
      lookback{5,10,15,20} × init_factor{0.97,0.98,0.99,1.00}
      × lock_factor{0.99,0.999,1.005} = 48 组。

    各候选进笛卡尔积前经 `quantize_phase_lock_params` 量化（千分位 round-half-up + lookback
    正整数校验，单一源，与 scheme 编码 / labels / TS 同一量化算法）。量化后去重保稳定顺序。

    网格爆炸护栏（spec 02 §kelly 默认网格）：cfg 数 > 200（对齐 band_lock）→ logger.warning
    （含各维度候选数），**不拒绝、不截断**（data-integrity「no silent caps」）。

    Args:
        lookback_list:     lookback 候选（正整数 [1,250]）；None → 默认 {5,10,15,20}。
        init_factor_list:  init_factor 候选（量化前原始 ratio）；None → 默认 {0.97,0.98,0.99,1.00}。
        lock_factor_list:  lock_factor 候选（量化前原始 ratio）；None → 默认 {0.99,0.999,1.005}。

    Returns:
        [{type:'phase_lock', lookback, init_factor, lock_factor}, ...]，去重后顺序稳定。

    Raises:
        ValueError: 任一候选量化 / 校验失败（透传 quantize_phase_lock_params）。
    """
    if lookback_list is None:
        lookback_list = list(_PHASE_LOCK_DEFAULT_LOOKBACKS)
    if init_factor_list is None:
        init_factor_list = list(_PHASE_LOCK_DEFAULT_INIT_FACTORS)
    if lock_factor_list is None:
        lock_factor_list = list(_PHASE_LOCK_DEFAULT_LOCK_FACTORS)

    # ── 各候选预量化（单一源 quantize_phase_lock_params），去重保稳定顺序 ──────────
    quant_lookback: list[int] = _dedup_keep_order(
        [quantize_phase_lock_params({"lookback": lb})["lookback"] for lb in lookback_list]
    )
    quant_init: list[float] = _dedup_keep_order(
        [
            quantize_phase_lock_params({"init_factor": r})["init_factor"]
            for r in init_factor_list
        ]
    )
    quant_lock: list[float] = _dedup_keep_order(
        [
            quantize_phase_lock_params({"lock_factor": r})["lock_factor"]
            for r in lock_factor_list
        ]
    )

    grid: list[dict[str, Any]] = []
    seen: set[tuple] = set()  # 量化后参数指纹（去重）

    for lb, if_, lf in itertools.product(quant_lookback, quant_init, quant_lock):
        fingerprint = (lb, if_, lf)
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        grid.append(
            {
                "type": "phase_lock",
                "lookback": lb,
                "init_factor": if_,
                "lock_factor": lf,
            }
        )

    if len(grid) > _PHASE_LOCK_GRID_WARN_THRESHOLD:
        logger.warning(
            "phase_lock 出场族生成 %d 个配置，超过软阈值 %d（"
            "lookback=%d × init_factor=%d × lock_factor=%d，去重后 %d）。"
            "不截断，但多重检验过拟合风险高，请谨慎解读。",
            len(grid),
            _PHASE_LOCK_GRID_WARN_THRESHOLD,
            len(quant_lookback),
            len(quant_init),
            len(quant_lock),
            len(grid),
        )

    return grid


def _dedup_keep_order(items: list) -> list:
    """去重保留首次出现顺序（候选集可能含重复值，如用户重复填 0.999）。"""
    seen: set = set()
    out: list = []
    for x in items:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 数据类型
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class EntryVariant:
    """一个入场变体：base + 若干附加特征阈值的 AND 组合。

    filters 中每项为 (feature_name, op, value)，
    is_rs_variant 标记是否含 rs_vs_index 特征（影响窗口 clamp）。
    """

    variant_id: str
    """唯一标识字符串，便于 ResultRow 引用。"""

    filters: list[tuple[str, str, float]]
    """附加特征过滤条件（除 base 外）。空列表 = 仅 base。"""

    is_rs_variant: bool
    """是否含 rs_vs_index 特征（需 clamp 到 >= 20240102）。"""


@dataclass
class ResultRow:
    """扫描结果行，供 T7 report 消费。

    CI 字段（kelly_ci_low/high）**不在本任务计算**，由 T7 对 top-K 按需调
    bootstrap_kelly_ci 填充——此处留 None 占位。

    valid_rets 不存储（省内存）：T7 需要时调 valid_rets_for()。
    valid_keys 存储 (ts_code, signal_date) 对，作为 valid_rets_for() 重算的键集。
    """

    # ── 变体与出场标识 ──────────────────────────────────────────────────────
    variant_id: str
    """入场变体 ID（格式见 EntryVariant.variant_id）。"""

    variant_filters: list[tuple[str, str, float]]
    """附加特征过滤条件列表（可序列化，报告用）。"""

    exit_id: str
    """出场配置唯一标识字符串（格式见 _exit_id）。"""

    exit_cfg: dict[str, Any]
    """出场配置字典（type/参数）。"""

    window_group: str  # 'with_rs' | 'no_rs'
    """窗口分组：含 RS 的变体 = 'with_rs'；不含 RS = 'no_rs'。"""

    # ── 训练集指标 ──────────────────────────────────────────────────────────
    n_train: int
    """训练集信号数。"""

    kelly_train: Optional[float]
    """训练集 Kelly f*。"""

    win_rate_train: Optional[float]
    """训练集胜率。"""

    payoff_b_train: Optional[float]
    """训练集盈亏比。"""

    profit_factor_train: Optional[float]
    """训练集利润因子。"""

    # ── 验证集指标 ──────────────────────────────────────────────────────────
    n_valid: int
    """验证集信号数。"""

    kelly_valid: Optional[float]
    """验证集 Kelly f*（out-of-sample 主排序指标）。"""

    win_rate_valid: Optional[float]
    """验证集胜率。"""

    payoff_b_valid: Optional[float]
    """验证集盈亏比。"""

    profit_factor_valid: Optional[float]
    """验证集利润因子。"""

    below_floor: bool
    """验证集 n < config.min_samples → True（不参与 top-K，但保留用于帕累托灰点）。"""

    # ── CI 占位（T7 填充）───────────────────────────────────────────────────
    kelly_ci_low: Optional[float] = None
    kelly_ci_high: Optional[float] = None

    # ── 重算 rets 所需元数据（option b：valid_rets_for 重算用）───────────────
    valid_keys: list[tuple[str, str]] = field(default_factory=list)
    """验证集中使用的 (ts_code, signal_date) 对列表（用于 valid_rets_for 重算）。

    存 (ts_code, signal_date) 而非仅 signal_date，以确保在多只个股同日触发时唯一定位路径。
    """

    same_day_rule: str = "sl_first"
    """出场同日双触发规则，从 config.same_day_rule 复制，供 valid_rets_for 默认使用。

    T7 调 valid_rets_for(row, paths) 时无需再手动透传 same_day_rule，口径与扫描时一致。
    """


# ─────────────────────────────────────────────────────────────────────────────
# 辅助：出场 ID / 出场模拟调用
# ─────────────────────────────────────────────────────────────────────────────


def _exit_id(exit_cfg: dict[str, Any]) -> str:
    """生成出场配置的唯一可读字符串 ID。"""
    t = exit_cfg["type"]
    if t == "fixed_n":
        return f"fixed_n(n={exit_cfg['n']})"
    if t == "tp_sl":
        return (
            f"tp_sl(tp={exit_cfg['tp_pct']},sl={exit_cfg['sl_pct']},"
            f"mh={exit_cfg['max_hold']})"
        )
    if t == "trailing":
        return f"trailing(z={exit_cfg['z_pct']},mh={exit_cfg['max_hold']})"
    if t == "atr_stop":
        return f"atr_stop(k={exit_cfg['k']},mh={exit_cfg['max_hold']})"
    if t == "band_lock":
        return _band_lock_exit_id(exit_cfg)
    if t == "phase_lock":
        return _phase_lock_exit_id(exit_cfg)
    raise ValueError(f"未知出场类型 type={t!r}")


def _band_lock_exit_id(exit_cfg: dict[str, Any]) -> str:
    """band_lock 出场配置 → 唯一可读 _exit_id（spec 05§3.3）。

    全默认 → `band_lock(mh=X)`（守现存扫描结果可比对，逐字不变）。
    非默认参数按固定顺序 sr→fr→fl→md 追加，**fr 省略规则与坍缩指纹同口径**：
      - floor_enabled=False(fl=0) → 省 fr（floor_ratio 不参与计算）；
      - floor_enabled=True(默认) 且 fr 非默认 → 含 fr。
    布尔仅在取 False（非默认）时出现 fl=0 / md=0（与 scheme 后缀同口径）。

    max_hold 始终写出（None=不封顶，与 mh=10/20 区分），守现存 `band_lock(mh=X)` 格式。
    """
    parts: list[str] = [f"mh={exit_cfg.get('max_hold')}"]

    stop_ratio = exit_cfg.get("stop_ratio", DEFAULT_STOP_RATIO)
    floor_ratio = exit_cfg.get("floor_ratio", DEFAULT_FLOOR_RATIO)
    floor_enabled = exit_cfg.get("floor_enabled", DEFAULT_FLOOR_ENABLED)
    ma5_require_down = exit_cfg.get("ma5_require_down", DEFAULT_MA5_REQUIRE_DOWN)

    if stop_ratio != DEFAULT_STOP_RATIO:
        parts.append(f"sr={_fmt_ratio(stop_ratio)}")
    # fr 仅在 floor_enabled=True（地板生效）且 floor_ratio 非默认时出现；fl=0 时省略。
    if floor_enabled and floor_ratio != DEFAULT_FLOOR_RATIO:
        parts.append(f"fr={_fmt_ratio(floor_ratio)}")
    if floor_enabled != DEFAULT_FLOOR_ENABLED:
        parts.append("fl=0")  # 仅 False（非默认）出现
    if ma5_require_down != DEFAULT_MA5_REQUIRE_DOWN:
        parts.append("md=0")  # 仅 False（非默认）出现

    return f"band_lock({','.join(parts)})"


def _phase_lock_exit_id(exit_cfg: dict[str, Any]) -> str:
    """phase_lock 出场配置 → 唯一可读 _exit_id（spec 02/04，格式镜像 _band_lock_exit_id）。

    格式：`phase_lock(lb={N},if={ratio},lf={ratio})`。
      - lookback（lb）**始终写出**（spec 02 §_exit_id 格式：lookback 始终写出）。
      - init_factor（if）/ lock_factor（lf）用 `_fmt_ratio` 格式化（千分位量化值去尾零，
        如 0.99→'0.99'、0.999→'0.999'、1.005→'1.005'、1.00→'1'），与 band_lock ratio 同款。
    phase_lock 全 3 参数都进 id（与 band_lock「非默认才追加」不同——phase_lock 是全新族、无
    DEFAULT_EXIT_GRID 既存条目要守哈希，全写出更直观且保证同量化值产出同 id）。
    """
    lookback = exit_cfg.get("lookback", DEFAULT_LOOKBACK_PL)
    init_factor = exit_cfg.get("init_factor", DEFAULT_INIT_FACTOR_PL)
    lock_factor = exit_cfg.get("lock_factor", DEFAULT_LOCK_FACTOR_PL)
    return (
        f"phase_lock(lb={int(lookback)},"
        f"if={_fmt_ratio(init_factor)},"
        f"lf={_fmt_ratio(lock_factor)})"
    )


def _fmt_ratio(ratio: float) -> str:
    """ratio（千分位量化值）→ 紧凑字符串：去尾零（0.997→'0.997'，1.02→'1.02'）。

    千分位量化保证 ratio 至多 3 位小数；用定点 3 位再去尾零，规避浮点末位脏值
    （如 0.997 的 IEEE754 表示），保证 _exit_id 在同一量化值上确定唯一。
    """
    return f"{ratio:.3f}".rstrip("0").rstrip(".")


def _run_exit(path: ForwardPath, exit_cfg: dict[str, Any], same_day_rule: str) -> Optional[float]:
    """对单条路径运行出场模拟，返回 ret；无交易时返回 None（不计入凯利样本）。

    None（跳过该信号）场景：
      - atr_stop：atr14_at_signal 为 None（simulate_atr_stop 抛 ValueError）。
      - band_lock：入场买不进（no_entry）或 buy_bar/signal_bar_high 缺失（simulate_band_lock_exit
        直接返回 None）。
    """
    t = exit_cfg["type"]
    try:
        if t == "fixed_n":
            trade = simulate_fixed_n(path, exit_cfg["n"])
        elif t == "tp_sl":
            trade = simulate_tp_sl(
                path,
                tp_pct=exit_cfg["tp_pct"],
                sl_pct=exit_cfg["sl_pct"],
                max_hold=exit_cfg["max_hold"],
                same_day_rule=same_day_rule,  # type: ignore[arg-type]
            )
        elif t == "trailing":
            trade = simulate_trailing(path, z_pct=exit_cfg["z_pct"], max_hold=exit_cfg["max_hold"])
        elif t == "atr_stop":
            trade = simulate_atr_stop(path, k=exit_cfg["k"], max_hold=exit_cfg["max_hold"])
        elif t == "band_lock":
            # max_hold 可缺/为 None（不封顶）；4 新参数缺省 .get 兜底核默认（现状零漂移）；
            # simulate_band_lock_exit 无交易时返回 None。
            band_trade = simulate_band_lock_exit(
                path,
                max_hold=exit_cfg.get("max_hold"),
                stop_ratio=exit_cfg.get("stop_ratio", DEFAULT_STOP_RATIO),
                floor_ratio=exit_cfg.get("floor_ratio", DEFAULT_FLOOR_RATIO),
                floor_enabled=exit_cfg.get("floor_enabled", DEFAULT_FLOOR_ENABLED),
                ma5_require_down=exit_cfg.get("ma5_require_down", DEFAULT_MA5_REQUIRE_DOWN),
            )
            if band_trade is None:
                return None
            return band_trade.ret
        elif t == "phase_lock":
            # 3 参数缺省 .get 兜底核默认；simulate_phase_lock_exit 无交易时返回 None。
            phase_trade = simulate_phase_lock_exit(
                path,
                init_factor=exit_cfg.get("init_factor", DEFAULT_INIT_FACTOR_PL),
                lock_factor=exit_cfg.get("lock_factor", DEFAULT_LOCK_FACTOR_PL),
                lookback=exit_cfg.get("lookback", DEFAULT_LOOKBACK_PL),
                same_day_rule=same_day_rule,
            )
            if phase_trade is None:
                return None
            return phase_trade.ret
        else:
            raise ValueError(f"未知出场类型 type={t!r}")
    except ValueError:
        # atr_stop: atr14_at_signal 为 None，跳过此信号
        return None
    return trade.ret


# ─────────────────────────────────────────────────────────────────────────────
# 入场变体生成
# ─────────────────────────────────────────────────────────────────────────────


def _build_variants(
    max_entry_filters: int,
    filter_candidates: list[tuple[str, str, float]],
) -> list[EntryVariant]:
    """生成所有入场变体（base + 0~max_entry_filters 个附加特征阈值的 AND 组合）。

    变体集合 = base（空附加过滤）+ 所有 C(candidates, k) 组合（k=1..max_entry_filters）。
    variant_id 格式：'base' 或 'base+feat1(op,val)+feat2(op,val)'。

    Args:
        max_entry_filters: 单变体最多附加特征数（0 = 仅 base）。
        filter_candidates: 候选阈值列表 [(feature_name, op, value), ...]。

    Returns:
        EntryVariant 列表（含 base 变体）。
    """
    variants: list[EntryVariant] = []

    # base 变体（无附加过滤）
    variants.append(EntryVariant(variant_id="base", filters=[], is_rs_variant=False))

    if max_entry_filters <= 0:
        return variants

    for k in range(1, max_entry_filters + 1):
        for combo in itertools.combinations(filter_candidates, k):
            filters = list(combo)
            has_rs = any(feat == "rs_vs_index" for feat, _, _ in filters)
            # 生成可读 variant_id
            filter_str = "+".join(f"{feat}({op},{val})" for feat, op, val in filters)
            v_id = f"base+{filter_str}"
            variants.append(
                EntryVariant(variant_id=v_id, filters=filters, is_rs_variant=has_rs)
            )

    return variants


# ─────────────────────────────────────────────────────────────────────────────
# 特征列计算
# ─────────────────────────────────────────────────────────────────────────────


def _compute_feature_df(
    cross_section_df: pd.DataFrame,
    history_map: dict[tuple[str, str], pd.DataFrame],
    index_daily_df: pd.DataFrame,
    member_df: Optional[pd.DataFrame],
    rs_benchmarks: list[str],
    rs_lookback: int,
) -> pd.DataFrame:
    """计算所有入场特征，返回含特征列的 DataFrame（行对齐 cross_section_df）。

    输入列（cross_section_df）：ts_code, signal_date, qfq_close, ma5, ma30, atr_14, kdj_j, vol
    输出列（追加）：dev_ma5, dev_ma30, down_streak, vol_contract, vol_regime, rs_vs_index
                    以及 cross_section_df 原有列（ts_code, signal_date, kdj_j 等）。

    kdj_j 列由 load_feature_inputs 直接从 raw.daily_indicator 取出，已含在
    cross_section_df 中，本函数透传（不重算）。

    rs_benchmarks 中每个基准对应一个 rs_vs_index 列（仅含宽基时 rs_vs_index = 单列；
    多基准时各自命名为 rs_vs_hs300 / rs_vs_zz500 / rs_vs_industry）。
    为简化：统一使用列名 'rs_vs_index'——多基准场景下由调用方在 filter_candidates
    中指定具体列名（当前默认只用单基准，列名固定 'rs_vs_index'）。
    """
    df = cross_section_df.copy()

    # ── dev_ma5 / dev_ma30 ────────────────────────────────────────────────────
    df["dev_ma5"] = dev_ma(df["qfq_close"], df["ma5"])
    df["dev_ma30"] = dev_ma(df["qfq_close"], df["ma30"])

    # ── down_streak / vol_contract（依赖 history_map）─────────────────────────
    down_streak_vals: list[float] = []
    vol_contract_vals: list[float] = []

    for _, row in df.iterrows():
        key = (row["ts_code"], row["signal_date"])
        hist = history_map.get(key)
        if hist is None or hist.empty:
            down_streak_vals.append(float("nan"))
            vol_contract_vals.append(float("nan"))
        else:
            down_streak_vals.append(float(down_streak(hist["qfq_pct_chg"])))
            vol_contract_vals.append(vol_contract(hist["vol"]))

    df["down_streak"] = down_streak_vals
    df["vol_contract"] = vol_contract_vals

    # ── vol_regime（横截面分位，需有 atr_14 + qfq_close）────────────────────
    # vol_regime_percentile 要求 df 含 atr_14 + qfq_close；cross_section_df 已有这两列
    # 按 signal_date 横截面分别计算分位（同日全市场）
    vol_regime_series = pd.Series(float("nan"), index=df.index)
    for sig_date, grp in df.groupby("signal_date"):
        if grp.empty:
            continue
        percentile = vol_regime_percentile(grp)
        vol_regime_series.loc[grp.index] = percentile.values

    df["vol_regime"] = vol_regime_series

    # ── rs_vs_index（依赖 index_daily_df + path_map 中的 qfq_close 历史）───────
    # 构建 rs 列：使用 cross_section_df 中的 qfq_close（信号日）+历史 qfq_close（来自 history_map）
    # rs_vs_index 需要 lookback+1 个可交易日的 qfq_close 序列
    # 基准 close 来自 index_daily_df
    rs_vals: list[float] = []

    # 按 rs_benchmark 取基准 close 字典：{(code, date): close}
    # 默认只用 hs300；多基准未来可扩展
    # 这里统一合并为 rs_vs_index 单列（单基准场景）
    # 注：基准代码映射使用模块级 BENCH_CODE_MAP，禁止在此重复硬编码。

    # 构建 index close 查找表：{(ts_code, trade_date): close}
    idx_close_lookup: dict[tuple[str, str], float] = {}
    if not index_daily_df.empty:
        for _, irow in index_daily_df.iterrows():
            idx_close_lookup[(str(irow["ts_code"]), str(irow["trade_date"]))] = float(
                irow["close"]
            )

    for _, row in df.iterrows():
        ts_code = row["ts_code"]
        signal_date = str(row["signal_date"])

        # THS 硬约束
        if signal_date < _THS_MIN_DATE:
            rs_vals.append(float("nan"))
            continue

        hist = history_map.get((ts_code, signal_date))
        if hist is None or hist.empty:
            rs_vals.append(float("nan"))
            continue

        # 个股历史 qfq_close：从 history_map 的 qfq_pct_chg 反推不现实；
        # 这里使用 cross_section_df 的 qfq_close 作为信号日收盘，history_map 只有 pct_chg。
        # 需要 lookback+1 点的 close 序列 → 从 path_map 中找不到（路径是 buy_date 之后的）。
        #
        # 实际可行方案：历史 close 需要额外数据（history_map 已含 qfq_pct_chg，
        # 可以从当日 close 反推历史 close）。
        # 从信号日 close 向前还原：c_t-k = c_t / prod(1 + r_t-k+1 .. r_t) (pct_chg 以小数表示)
        #
        # history_map 中 qfq_pct_chg 单位：根据 paths.py 注释，qfq_pct_chg 来自 raw.daily_quote
        # 该字段通常以百分比(%)存储；需确认——
        # 根据 paths.py docstring："qfq_pct_chg 为前复权涨跌幅（%）"（以%存储，如 1.5 表示 1.5%）
        hist_pct = hist["qfq_pct_chg"].values  # 升序，%
        if len(hist_pct) < rs_lookback:
            rs_vals.append(float("nan"))
            continue

        # 还原 rs_lookback+1 个可交易日的 close 序列（最后一点 = signal_date 的 qfq_close）
        # 共需 rs_lookback 步 pct_chg 向前反推（不含信号日自身的 pct_chg，因为信号日
        # close 已由 base_close 直接给出；取信号日之前恰好 rs_lookback 个 pct_chg 即可）。
        base_close = float(row["qfq_close"])
        if pd.isna(base_close) or base_close == 0:
            rs_vals.append(float("nan"))
            continue

        # pct_tail：最近 rs_lookback 行的 pct_chg（含信号日当日，共 rs_lookback 个）
        # 还原顺序：从信号日 close 向前逐步还原
        #   closes[0] = base_close（信号日）
        #   closes[-1] → closes[-rs_lookback-1] 还原 rs_lookback 步，共 rs_lookback+1 点
        # 还原：close[i-1] = close[i] / (1 + pct_tail[i] / 100)
        pct_tail = hist_pct[-rs_lookback:]  # 最近 rs_lookback 行（含信号日当日）
        closes = [base_close]
        for pct in reversed(pct_tail):
            if pd.isna(pct):
                closes = []
                break
            denom = 1.0 + pct / 100.0
            if denom == 0:
                closes = []
                break
            closes.insert(0, closes[0] / denom)

        if len(closes) < rs_lookback + 1:
            rs_vals.append(float("nan"))
            continue

        stock_close_series = pd.Series(closes)

        # 基准 close 序列（取信号日及前 lookback 个可交易日）
        # 从 hist 的 trade_date 序列取最近 rs_lookback+1 个日期
        # （hist_dates 包含信号日当日，共 rs_lookback+1 个点，与 stock_close_series 对齐）
        hist_dates = hist["trade_date"].values[-(rs_lookback + 1):]
        if len(hist_dates) < rs_lookback + 1:
            rs_vals.append(float("nan"))
            continue

        # 选择基准（默认 hs300，rs_benchmarks 列表第一项）
        bench_code = BENCH_CODE_MAP.get(rs_benchmarks[0] if rs_benchmarks else "hs300")
        if bench_code is None:
            # industry 基准（单信号时逻辑复杂，当前版本 rs 置 nan，避免静默出错）
            rs_vals.append(float("nan"))
            continue

        index_closes: list[float] = []
        for d in hist_dates:
            ic = idx_close_lookup.get((bench_code, str(d)))
            if ic is None:
                index_closes = []
                break
            index_closes.append(ic)

        if len(index_closes) < rs_lookback + 1:
            rs_vals.append(float("nan"))
            continue

        index_close_series = pd.Series(index_closes)
        rs_val = rs_vs_index(
            stock_close_series, index_close_series, rs_lookback, signal_date=signal_date
        )
        rs_vals.append(rs_val)

    df["rs_vs_index"] = rs_vals

    return df


# ─────────────────────────────────────────────────────────────────────────────
# 掩码应用
# ─────────────────────────────────────────────────────────────────────────────


def _apply_variant_mask(
    feature_df: pd.DataFrame,
    variant: EntryVariant,
) -> pd.DataFrame:
    """对 feature_df 应用 variant.filters，返回满足所有条件的子集。

    base 变体（filters=[]）返回全 feature_df。
    """
    if not variant.filters:
        return feature_df

    mask = pd.Series(True, index=feature_df.index)
    for feat, op, val in variant.filters:
        if feat not in feature_df.columns:
            # 特征列不存在（如 rs_vs_index 在无 RS 数据时全 NaN），全掩为 False
            logger.warning("特征列 %r 不在 feature_df 中，变体 %s 全掩为 False", feat, variant.variant_id)
            mask &= False
            break
        col_mask = apply_threshold(feature_df[feat], op, val)  # type: ignore[arg-type]
        mask &= col_mask

    return feature_df[mask]


# ─────────────────────────────────────────────────────────────────────────────
# train/valid 切分
# ─────────────────────────────────────────────────────────────────────────────


def _split_signal_dates(
    signal_dates: list[str],
    train_range: tuple[str, str],
    valid_range: tuple[str, str],
    is_rs_variant: bool,
) -> tuple[list[str], list[str], str]:
    """将 signal_date 列表切分为 train / valid 子集。

    RS 变体硬约束（spec 02§3.3 / 04§3.1）：
      - 有效窗口 >= 20240102；train 起点 clamp 到 20240102。
      - 若 train_range[0] 早于 20240102，train 子集从 20240102 起计。
      - window_group 标注 'with_rs'（vs 不含 RS 的 'no_rs'）。

    Returns:
        (train_dates, valid_dates, window_group)
    """
    train_start, train_end = train_range
    valid_start, valid_end = valid_range

    if is_rs_variant:
        effective_train_start = max(train_start, _THS_MIN_DATE)
        if effective_train_start > train_start:
            logger.info(
                "RS 变体训练起点从 %s clamp 到 %s（THS 数据约束）",
                train_start,
                effective_train_start,
            )
        train_dates = [
            d for d in signal_dates if effective_train_start <= d <= train_end
        ]
        window_group = "with_rs"
    else:
        train_dates = [d for d in signal_dates if train_start <= d <= train_end]
        window_group = "no_rs"

    valid_dates = [d for d in signal_dates if valid_start <= d <= valid_end]

    return train_dates, valid_dates, window_group


# ─────────────────────────────────────────────────────────────────────────────
# 主扫描入口
# ─────────────────────────────────────────────────────────────────────────────


def run_sweep(
    config: SweepConfig,
    signals_raw: list,  # list[SignalRecord]（enumerate_signals 产出）
    paths: list[ForwardPath],
    cross_section_df: pd.DataFrame,
    history_map: dict[tuple[str, str], pd.DataFrame],
    index_daily_df: Optional[pd.DataFrame] = None,
    member_df: Optional[pd.DataFrame] = None,
    entry_filter_candidates: Optional[list[tuple[str, str, float]]] = None,
    exit_grid: Optional[list[dict[str, Any]]] = None,
    on_progress: Optional[Callable[[int, int], None]] = None,
    check_cancel: Optional[Callable[[], None]] = None,
) -> list[ResultRow]:
    """网格扫描主入口。

    Args:
        config:               SweepConfig（参数模型）。
        signals_raw:          enumerate_signals 产出的 SignalRecord 列表。
        paths:                load_forward_paths 产出的 ForwardPath 列表。
        cross_section_df:     load_feature_inputs 产出的截面 DataFrame。
        history_map:          load_feature_inputs 产出的历史窗口 map。
        index_daily_df:       load_index_daily 产出的指数日线 DataFrame（可选，None 时 RS 全 NaN）。
        member_df:            load_member_map 产出的成份股映射（可选，industry RS 用）。
        entry_filter_candidates: 附加特征阈值候选列表（None 时用默认值）。
        exit_grid:            出场参数网格（None 时用默认值）。
        on_progress:          可选进度回调 `(done: int, total: int) -> None`；
                              **细化到 (variant × exit_cfg) 粒度**：每处理完一个出场配置
                              emit (done, total)，其中 done = 已完成的 (变体 × 出场) 组合数、
                              total = n_variants × len(exit_grid)，保证 done 单调递增
                              （前端步骤条依赖单调；空子集变体一次性补齐其全部 cfg 计数）。
                              默认 None → 不回调，对现有 CLI/单测路径零影响。
        check_cancel:         可选取消检查回调 `() -> None`；在内层 for exit_cfg 每个配置
                              处理完后调用一次。约定：若用户已请求取消，回调内部直接抛
                              JobCancelled（与 worker/progress.check_cancel_requested_or_cancel
                              同契约），run_sweep 不捕获、令其向上传播走既有取消路径。
                              **纯旁路**：只读 cancel 标志，绝不触碰 kelly/ret/bootstrap 计算，
                              结果逐字不变。默认 None → 不检查，对现有 CLI/单测路径零影响。

    Returns:
        ResultRow 列表（每行 = 一个 (variant, exit) 组合的结果）。

    Raises:
        JobCancelled:         check_cancel 命中取消请求时由其抛出并向上传播
                              （dispatcher 捕获后写 status='cancelled'）。
    """
    if entry_filter_candidates is None:
        entry_filter_candidates = DEFAULT_ENTRY_FILTER_CANDIDATES
    if exit_grid is None:
        exit_grid = DEFAULT_EXIT_GRID
    if index_daily_df is None:
        index_daily_df = pd.DataFrame(
            columns=["ts_code", "trade_date", "open", "high", "low", "close", "pct_change"]
        )

    # ── industry RS 显式护门（data-integrity：降级不得静默）────────────────
    if "industry" in config.rs_benchmark:
        raise NotImplementedError(
            "industry RS 暂未接通：ths_member_stocks 无 type 列，"
            "需 join ths_index_catalog(type='I') + 逐股加载所属行业指数日线；"
            "当前仅支持 hs300/zz500。"
        )

    # ── 1. 生成入场变体 ────────────────────────────────────────────────────
    variants = _build_variants(
        max_entry_filters=config.max_entry_filters,
        filter_candidates=entry_filter_candidates,
    )

    # ── 2. 总组合数日志（spec 04§1）────────────────────────────────────────
    n_variants = len(variants)
    n_exits = len(exit_grid)
    n_combos = n_variants * n_exits
    logger.info(
        "网格扫描：|V|=%d 入场变体 × |E|=%d 出场配置 = %d 总组合",
        n_variants,
        n_exits,
        n_combos,
    )
    if n_combos > _COMBO_WARN_THRESHOLD:
        logger.warning(
            "总组合数 %d 超过警告阈值 %d，多重检验过拟合风险较高，请谨慎解读 top-K 结果。",
            n_combos,
            _COMBO_WARN_THRESHOLD,
        )

    # ── 3. 计算所有特征列 ──────────────────────────────────────────────────
    # cross_section_df 含 kdj_j 列（来自 raw.daily_indicator，load_feature_inputs
    # 已在 SQL 中 SELECT i.kdj_j）；_compute_feature_df 直接透传 kdj_j 列，
    # 无需调用方补全。
    feature_df = _compute_feature_df(
        cross_section_df=cross_section_df,
        history_map=history_map,
        index_daily_df=index_daily_df,
        member_df=member_df,
        rs_benchmarks=config.rs_benchmark,
        rs_lookback=config.rs_lookback,
    )

    # feature_df 行 = (ts_code, signal_date) 唯一对；建立信号日期集合用于快速查找
    # key_set: 包含 feature_df 中所有 (ts_code, signal_date) 的集合
    # path_lookup: (ts_code, signal_date) -> ForwardPath（对齐 paths 列表）
    path_lookup: dict[tuple[str, str], ForwardPath] = {
        (fp.ts_code, fp.signal_date): fp for fp in paths
    }

    # feature_df 以 (ts_code, signal_date) 为主键；对齐后带 feature_key 列便于子集查路径
    feature_df = feature_df.reset_index(drop=True)

    # ── 4. 扫描 ────────────────────────────────────────────────────────────
    results: list[ResultRow] = []

    # 进度按 (变体 × 出场) 组合计数：done 单调递增到 progress_total = n_variants × n_exits。
    # 细化到 exit_cfg 级，使单变体 job（max_entry_filters=0）也能在 sweep 阶段持续推进度，
    # 而非整段只在最末 emit 一次（修 fix-kelly-sweep-cancel-granularity 现状）。
    progress_total = n_combos  # = n_variants * n_exits
    done_combos = 0

    for _variant_i, variant in enumerate(variants):
        # 4a. 掩码取变体子集
        subset_df = _apply_variant_mask(feature_df, variant)
        if subset_df.empty:
            # 变体被跳过：该变体的全部 n_exits 个组合一次性计入 done，保持 done 单调递增、
            # 且最终累加恰好等于 progress_total（不漏不冗）。
            done_combos += n_exits
            if on_progress is not None:
                on_progress(done_combos, progress_total)
            continue

        # 4b. 按 signal_date 切 train/valid（含 RS clamp 逻辑）
        all_signal_dates = subset_df["signal_date"].tolist()
        train_dates, valid_dates, window_group = _split_signal_dates(
            signal_dates=all_signal_dates,
            train_range=config.train_range,
            valid_range=config.valid_range,
            is_rs_variant=variant.is_rs_variant,
        )

        train_date_set = set(train_dates)
        valid_date_set = set(valid_dates)

        # 4c. 取 subset 中 train / valid 信号的 ts_code+signal_date 集合
        train_keys = [
            (row["ts_code"], row["signal_date"])
            for _, row in subset_df.iterrows()
            if row["signal_date"] in train_date_set
        ]
        valid_keys = [
            (row["ts_code"], row["signal_date"])
            for _, row in subset_df.iterrows()
            if row["signal_date"] in valid_date_set
        ]

        # 4d. 对每个出场配置计算指标
        for exit_cfg in exit_grid:
            e_id = _exit_id(exit_cfg)

            # 训练集 rets
            train_rets: list[float] = []
            for key in train_keys:
                fp = path_lookup.get(key)
                if fp is None:
                    continue
                ret = _run_exit(fp, exit_cfg, config.same_day_rule)
                if ret is not None:
                    train_rets.append(ret)

            # 验证集 rets
            valid_rets: list[float] = []
            valid_keys_used: list[tuple[str, str]] = []
            for key in valid_keys:
                fp = path_lookup.get(key)
                if fp is None:
                    continue
                ret = _run_exit(fp, exit_cfg, config.same_day_rule)
                if ret is not None:
                    valid_rets.append(ret)
                    valid_keys_used.append(key)  # (ts_code, signal_date)

            # 计算指标
            train_metrics: MetricResult = compute_metrics(train_rets)
            valid_metrics: MetricResult = compute_metrics(valid_rets)

            below_floor = valid_metrics.n < config.min_samples

            results.append(
                ResultRow(
                    variant_id=variant.variant_id,
                    variant_filters=variant.filters,
                    exit_id=e_id,
                    exit_cfg=exit_cfg,
                    window_group=window_group,
                    n_train=train_metrics.n,
                    kelly_train=train_metrics.kelly,
                    win_rate_train=train_metrics.win_rate,
                    payoff_b_train=train_metrics.payoff_b,
                    profit_factor_train=train_metrics.profit_factor,
                    n_valid=valid_metrics.n,
                    kelly_valid=valid_metrics.kelly,
                    win_rate_valid=valid_metrics.win_rate,
                    payoff_b_valid=valid_metrics.payoff_b,
                    profit_factor_valid=valid_metrics.profit_factor,
                    below_floor=below_floor,
                    kelly_ci_low=None,
                    kelly_ci_high=None,
                    valid_keys=valid_keys_used,
                    same_day_rule=config.same_day_rule,
                )
            )

            # ── 旁路：进度细化到 exit_cfg 级 + 取消检查（纯旁路，不碰上面任何计算）──
            # 计算与落库均已完成后再推进度 / 查取消，保证 done 计数对应"已产出的组合"。
            done_combos += 1
            if on_progress is not None:
                on_progress(done_combos, progress_total)
            # check_cancel 命中取消时内部抛 JobCancelled，向上传播走既有取消路径
            # （dispatcher 写 status='cancelled'）；此处不捕获、不吞错。
            if check_cancel is not None:
                check_cancel()

    logger.info(
        "run_sweep 完成：%d ResultRow（变体=%d，出场=%d）",
        len(results),
        n_variants,
        n_exits,
    )
    return results


# ─────────────────────────────────────────────────────────────────────────────
# valid_rets_for（option b：T7 按需重算验证集 rets，省内存）
# ─────────────────────────────────────────────────────────────────────────────


def valid_rets_for(
    row: ResultRow,
    paths: list[ForwardPath],
    same_day_rule: Optional[str] = None,
) -> list[float]:
    """根据 ResultRow.valid_keys 从缓存 paths 重算验证集 rets。

    T7 对 top-K 调用此函数取 rets 后再做 bootstrap_kelly_ci。
    由于 valid_keys 存储 (ts_code, signal_date) 对，可精确定位每条路径，无歧义。

    Args:
        row:            目标 ResultRow（含 valid_keys + exit_cfg + same_day_rule）。
        paths:          run_sweep 使用的同一批 ForwardPath（T7 保存引用即可）。
        same_day_rule:  同日双触发规则；None 时取 row.same_day_rule（与扫描时口径一致）。
                        显式传值时以传值为准（测试/调试用）。

    Returns:
        验证集收益率列表（与 ResultRow.n_valid 数量一致，排除 atr_stop 无 ATR 的信号）。
    """
    effective_rule = same_day_rule if same_day_rule is not None else row.same_day_rule
    key_set = set(row.valid_keys)
    path_lookup: dict[tuple[str, str], ForwardPath] = {
        (fp.ts_code, fp.signal_date): fp
        for fp in paths
        if (fp.ts_code, fp.signal_date) in key_set
    }

    rets: list[float] = []
    for key in row.valid_keys:
        fp = path_lookup.get(key)
        if fp is None:
            continue
        ret = _run_exit(fp, row.exit_cfg, effective_rule)
        if ret is not None:
            rets.append(ret)
    return rets
