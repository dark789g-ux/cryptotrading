"""train_e2e 编排 runner（spec 04）。

把 labels → features → train 三步串成单个 ml.jobs 行，进度按 0-30 / 30-60 /
60-100 切片回写到父 progress callback。

设计点（spec 04 + 00-index 决策表）：
- D-2 / D-7：单 run_type='train_e2e'，worker 内顺序执行三步 + 进度切片
- D-13：返回 dict 写 ml.jobs.result_payload（feature_set_id + last_completed_step）
- D-14：元字段（factor_version / base_scheme / classify_mode / label_id 等）通过
  `train_model(extra_hyperparams=...)` 落到 ml.model_runs.hyperparams
- D-17：Modal 隐藏 neutralize_cols / robust_z；这里 ValidatedParams 用 None 让
  下游 builder 走 default（不在本层 hardcode default 防双源真理）
- D-18：子 runner 抛任何 Exception → 包装成 StepError，让 dispatcher 写
  error_text 首行 `[step:<name>] <traceback>`
- D-23：train 步骤调用 `train_model(extra_hyperparams=...)` 写元信息

分类后移改造（spec 2026-06-05）：
- _validate_params 改为单路径：只认 base_type/base_params/classify_mode/classify_params
  新形态，移除旧 label_scheme 入参路径。
- dir3_scheme.parse_*/is_* 仅保留用于识别历史 scheme 串，不参与 _validate_params 入参。
- _step_labels 按 base_scheme（base_scheme_codec 生成）物化连续值（已存在则跳过）。
- _step_train 透传 classify_mode/classify_params，label_id/label_version 经
  extra_hyperparams 机制写进 ml.model_runs.hyperparams。

new_listing_min_days=0 是合法值（不过滤新股），全链路绝不用 `if min_days:` 判
falsy，统一 `isinstance(int) and 0 <= x <= 250`。
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID

from quant_pipeline.worker.progress import (
    JobCancelled,
    ProgressCallback,
    check_cancel_requested,
    make_scaled_callback,
)

logger = logging.getLogger(__name__)

# 合法白名单（与 spec 03 / NestJS DTO / 前端 select options 保持一致）
# spec 04 §2.1：新增 lstm 模型 + 分类后移改造 base_type/classify_mode 路径。
# v1 不在此处强制 model↔classify_mode 配对（保持松耦合，允许实验组合）；
# 误配由 train_model 入口的误配护栏兜住报错（见 spec 2026-06-05 §误配护栏）。
_ALLOWED_MODELS = {"lgb-lambdarank", "linear", "gbdt", "lstm", "lgb-multiclass"}

# 分类后移（spec 2026-06-05）：base_type 和 classify_mode 合法枚举。
_ALLOWED_BASE_TYPES = {"fwd_ret", "strategy_aware"}
_ALLOWED_CLASSIFY_MODES: set[str] = {"band", "tercile", "custom"}  # None=连续也合法

# spec 02 §严格校验：lgb 系超参白名单 + 范围（与前端 LgbHyperFields 一致）。
# 未知键 logger.warn + 跳过，不静默接受。范围越界 raise ValueError（禁夹取）。
# value=None 表示「下界不限」（lambda_l1/l2 仅下界 0），(lo, hi) 闭区间。
_LGB_HYPERPARAM_RANGES: dict[str, tuple[float, float | None]] = {
    "num_leaves": (15, 127),
    "min_data_in_leaf": (50, 500),
    "feature_fraction": (0.5, 1.0),
    "learning_rate": (0.01, 0.2),
    "num_boost_round": (50, 2000),
    "early_stopping_rounds": (10, 200),
    "bagging_fraction": (0.5, 1.0),
    "lambda_l1": (0.0, None),
    "lambda_l2": (0.0, None),
}
# 整数型 lgb 超参（其余为浮点）。
_LGB_INT_HYPERPARAMS = {
    "num_leaves",
    "min_data_in_leaf",
    "num_boost_round",
    "early_stopping_rounds",
}

# 哪些 model 走 lgb 超参白名单（lstm 用自己的键，本 spec 不收紧 lstm 校验）。
_LGB_MODELS = {"lgb-lambdarank", "lgb-multiclass"}

# feature/label 参数范围（spec 02 §严格校验表）。
_FACTOR_CLIP_SIGMA_RANGE = (1.5, 5.0)
# fwd_ret horizon: 任意正整数（spec 2026-06-05 §base_scheme_codec）
_FWD_HORIZON_MIN = 1
_MAX_HOLD_DAYS_RANGE = (10, 30)
# neutralize_cols 三档规范组合（去重排序后比对）。
_NEUTRALIZE_COLS_CANONICAL = {
    (),
    ("industry_l1",),
    ("industry_l1", "mv"),
}

# 进度切片窗口（spec 04 §progress 切片工具）
_WINDOW_LABELS = (0, 30)
_WINDOW_FEATURES = (30, 60)
_WINDOW_TRAIN = (60, 100)


# ---------------------------------------------------------------------------
# 数据契约
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ValidatedParams:
    """`_validate_params` 出来的不可变结构。frozen 防中途被改坏。

    分类后移改造（spec 2026-06-05）：
      - 新增 base_type / base_params / base_scheme（codec 生成）
      - 新增 classify_mode / classify_params
      - 新增 label_id / label_version（追溯用，落 ml.model_runs.hyperparams）
      - 移除 label_scheme / fwd_horizon_days / max_hold_days（已合并到 base_params）
    """

    factor_version: str
    base_type: str           # 'fwd_ret' | 'strategy_aware'
    base_params: dict[str, Any]   # {'horizon': N} | {'max_hold_days': N}
    base_scheme: str         # base_scheme_codec(base_type, base_params) 生成
    new_listing_min_days: int
    date_range: str
    model: str
    walk_forward: bool
    seed: int
    # D-17：Modal 隐藏 neutralize_cols / robust_z；None 表示走 builder default。
    neutralize_cols: tuple[str, ...] | None
    robust_z: bool | None
    # 分类后移：classify 参数
    classify_mode: str | None = None   # None=连续 | 'band' | 'tercile' | 'custom'
    classify_params: dict[str, Any] | None = None
    # 追溯用：后端透传的标签定义 id / version（写 ml.model_runs.hyperparams）
    label_id: str | None = None
    label_version: str | None = None
    # 模型超参 / 特征参数（None 表示用下游默认，不传时行为完全不变）
    hyperparams: dict[str, Any] | None = None  # lgb / lstm 模型超参
    factor_clip_sigma: float | None = None
    label_winsorize: tuple[float, float] | None = None


class StepError(Exception):
    """带 step 名的包装异常。

    `dispatcher._runner_train_e2e` 捕获后写 `error_text` 首行
    `[step:<name>] <traceback>`，符合 D-18。

    公开类（无下划线前缀），允许 dispatcher 模块 `import StepError` 做 except 分支。
    """

    def __init__(self, step: str, original: BaseException) -> None:
        super().__init__(f"[step:{step}] {original}")
        self.step = step
        self.original = original


# ---------------------------------------------------------------------------
# 参数校验
# ---------------------------------------------------------------------------


def _validate_hyperparams(
    raw: Any, *, model: str, walk_forward: bool
) -> dict[str, Any] | None:
    """校验 hyperparams（spec 02 §严格校验）。

    - None → None（用下游默认）。
    - 非 dict → raise ValueError。
    - lgb 系 model：逐键按 _LGB_HYPERPARAM_RANGES 白名单 + 范围校验；
      未知键 logger.warn + 跳过（不静默接受、不报错）；越界 raise ValueError
      （信息含字段名 + 值 + 范围，禁夹取）。
    - 非 lgb 系 model（lstm 等）：本 spec 不收紧校验，原样透传（仅类型为 dict）。
    - single_fold（walk_forward=False）下传 early_stopping_rounds：该值在
      lgb-lambdarank single_fold 路径硬编码为 None 不生效，必须 logger.warn
      「不静默丢弃」（CLAUDE.md 禁静默吞错）。前端虽 disabled，后端独立防御。
    """

    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError(
            f"hyperparams: must be a dict if present, got {type(raw).__name__}"
        )
    if model not in _LGB_MODELS:
        # lstm 等：本 spec 不动其校验逻辑，原样返回（浅拷贝防外部 mutate）。
        return dict(raw)

    cleaned: dict[str, Any] = {}
    for key, value in raw.items():
        if key not in _LGB_HYPERPARAM_RANGES:
            logger.warning(
                "train_e2e_unknown_hyperparam_skipped",
                extra={"model": model, "key": key, "value": value},
            )
            continue
        lo, hi = _LGB_HYPERPARAM_RANGES[key]
        # bool 是 int 子类，对数值超参一律拒绝（防 True 被当 1 通过）。
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(
                f"hyperparams.{key}: must be a number, got {value!r}"
            )
        if key in _LGB_INT_HYPERPARAMS and not float(value).is_integer():
            raise ValueError(
                f"hyperparams.{key}: must be an integer, got {value!r}"
            )
        num = float(value)
        if num < lo or (hi is not None and num > hi):
            hi_txt = "inf" if hi is None else hi
            raise ValueError(
                f"hyperparams.{key}: must be in [{lo}, {hi_txt}], got {value!r}"
            )
        cleaned[key] = int(num) if key in _LGB_INT_HYPERPARAMS else num

    if not walk_forward and "early_stopping_rounds" in cleaned:
        # spec 02 §静默失效护栏：single_fold 模式硬编码 early_stopping_rounds=None。
        logger.warning(
            "train_e2e_early_stopping_ignored_single_fold",
            extra={
                "model": model,
                "reason": "single_fold 模式下 early_stopping_rounds 不生效，已忽略",
                "value": cleaned["early_stopping_rounds"],
            },
        )
    return cleaned


def _validate_neutralize_cols(raw: Any) -> tuple[str, ...] | None:
    """校验 neutralize_cols（spec 02 §严格校验）。

    None → None（用 builder 默认）。须为 list；去重排序后 ∈ 三档规范组合
    {[], ['industry_l1'], ['industry_l1','mv']}。非规范组合（['mv'] 单独、
    未知元素等）→ raise ValueError（与前端三档一一对应，杜绝前端无法产生的语义）。
    """

    if raw is None:
        return None
    if not isinstance(raw, (list, tuple)):
        raise ValueError(
            f"neutralize_cols: must be a list if present, got {type(raw).__name__}"
        )
    if not all(isinstance(c, str) for c in raw):
        raise ValueError(
            f"neutralize_cols: all elements must be str, got {raw!r}"
        )
    canonical = tuple(sorted(set(raw)))
    if canonical not in _NEUTRALIZE_COLS_CANONICAL:
        raise ValueError(
            f"neutralize_cols: must be one of [], ['industry_l1'], "
            f"['industry_l1','mv'] (order-insensitive), got {raw!r}"
        )
    return canonical


def _validate_factor_clip_sigma(raw: Any) -> float | None:
    """校验 factor_clip_sigma：None → None；须为 float ∈ [1.5, 5.0]。"""

    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ValueError(
            f"factor_clip_sigma: must be a number, got {raw!r}"
        )
    lo, hi = _FACTOR_CLIP_SIGMA_RANGE
    val = float(raw)
    if val < lo or val > hi:
        raise ValueError(
            f"factor_clip_sigma: must be in [{lo}, {hi}], got {raw!r}"
        )
    return val


def _validate_label_winsorize(raw: Any) -> tuple[float, float] | None:
    """校验 label_winsorize：None → None；须为 [lo, hi]，lo<0<hi 且
    lo∈[-1,0)、hi∈(0,1]。越界 raise ValueError。"""

    if raw is None:
        return None
    if not isinstance(raw, (list, tuple)) or len(raw) != 2:
        raise ValueError(
            f"label_winsorize: must be [lo, hi], got {raw!r}"
        )
    lo_raw, hi_raw = raw
    for v in (lo_raw, hi_raw):
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError(
                f"label_winsorize: lo/hi must be numbers, got {raw!r}"
            )
    lo, hi = float(lo_raw), float(hi_raw)
    if not (lo < 0 < hi):
        raise ValueError(
            f"label_winsorize: require lo<0<hi, got {raw!r}"
        )
    if not (-1.0 <= lo < 0.0):
        raise ValueError(
            f"label_winsorize: lo must be in [-1, 0), got {lo!r}"
        )
    if not (0.0 < hi <= 1.0):
        raise ValueError(
            f"label_winsorize: hi must be in (0, 1], got {hi!r}"
        )
    return (lo, hi)


def _validate_base_type_and_params(
    base_type: Any,
    base_params: Any,
) -> tuple[str, dict[str, Any]]:
    """校验 base_type ∈ {fwd_ret, strategy_aware} + base_params 匹配。

    fwd_ret:      base_params['horizon'] 为 int >= 1（任意正整数）。
    strategy_aware: base_params['max_hold_days'] 为 int ∈ [10,30]（或不传，走下游默认）。

    返回 (validated_base_type, validated_base_params_dict)。
    """

    if not isinstance(base_type, str) or base_type not in _ALLOWED_BASE_TYPES:
        raise ValueError(
            f"base_type: must be one of {sorted(_ALLOWED_BASE_TYPES)}, got {base_type!r}"
        )

    if base_params is None:
        params: dict[str, Any] = {}
    elif not isinstance(base_params, dict):
        raise ValueError(
            f"base_params: must be a dict if present, got {type(base_params).__name__}"
        )
    else:
        params = dict(base_params)

    if base_type == "fwd_ret":
        horizon_raw = params.get("horizon")
        if horizon_raw is None:
            raise ValueError("base_params: fwd_ret requires base_params={'horizon': N}")
        if isinstance(horizon_raw, bool) or not isinstance(horizon_raw, int):
            raise ValueError(
                f"base_params.horizon: must be int, got {horizon_raw!r}"
            )
        if horizon_raw < _FWD_HORIZON_MIN:
            raise ValueError(
                f"base_params.horizon: must be >= {_FWD_HORIZON_MIN}, got {horizon_raw!r}"
            )
        params = {"horizon": int(horizon_raw)}

    elif base_type == "strategy_aware":
        mhd_raw = params.get("max_hold_days")
        if mhd_raw is not None:
            if isinstance(mhd_raw, bool) or not isinstance(mhd_raw, int):
                raise ValueError(
                    f"base_params.max_hold_days: must be int, got {mhd_raw!r}"
                )
            lo, hi = _MAX_HOLD_DAYS_RANGE
            if mhd_raw < lo or mhd_raw > hi:
                raise ValueError(
                    f"base_params.max_hold_days: must be in [{lo}, {hi}], got {mhd_raw!r}"
                )
            params = {"max_hold_days": int(mhd_raw)}
        else:
            params = {}

    return base_type, params


def _validate_classify(
    classify_mode: Any,
    classify_params: Any,
) -> tuple[str | None, dict[str, Any] | None]:
    """校验 classify_mode ∈ {None, band, tercile, custom} + classify_params 匹配。

    返回 (validated_classify_mode, validated_classify_params)。
    """

    if classify_mode is None:
        return None, None

    if not isinstance(classify_mode, str) or classify_mode not in _ALLOWED_CLASSIFY_MODES:
        raise ValueError(
            f"classify_mode: must be None or one of {sorted(_ALLOWED_CLASSIFY_MODES)}, "
            f"got {classify_mode!r}"
        )

    if classify_params is None:
        cp: dict[str, Any] = {}
    elif not isinstance(classify_params, dict):
        raise ValueError(
            f"classify_params: must be a dict if present, got {type(classify_params).__name__}"
        )
    else:
        cp = dict(classify_params)

    if classify_mode == "band":
        eps_raw = cp.get("eps")
        if eps_raw is None:
            raise ValueError("classify_params: band mode requires {'eps': float}")
        if isinstance(eps_raw, bool) or not isinstance(eps_raw, (int, float)):
            raise ValueError(f"classify_params.eps: must be a number, got {eps_raw!r}")
        eps = float(eps_raw)
        if eps <= 0:
            raise ValueError(f"classify_params.eps: must be > 0, got {eps!r}")
        cp = {"eps": eps}

    elif classify_mode == "tercile":
        cp = {}  # tercile 无参

    elif classify_mode == "custom":
        thresholds = cp.get("thresholds")
        if thresholds is None or not isinstance(thresholds, (list, tuple)) or len(thresholds) != 2:
            raise ValueError(
                "classify_params: custom mode requires {'thresholds': [lo, hi]}"
            )
        lo_raw, hi_raw = thresholds
        for v in (lo_raw, hi_raw):
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise ValueError(
                    f"classify_params.thresholds: lo/hi must be numbers, got {thresholds!r}"
                )
        lo_f, hi_f = float(lo_raw), float(hi_raw)
        if lo_f >= hi_f:
            raise ValueError(
                f"classify_params.thresholds: lo < hi required, got {thresholds!r}"
            )
        cp = {"thresholds": [lo_f, hi_f]}

    return classify_mode, cp


def _validate_params(params: dict[str, Any]) -> ValidatedParams:
    """把后端 expandForTraining 透传过来的 dict 严校验成 ValidatedParams（单路径）。

    分类后移改造（spec 2026-06-05）：
      只认 base_type/base_params/classify_mode/classify_params 新形态；
      移除旧 label_scheme 入参路径。训练类 job 一律经后端 expandForTraining 展开。

    非法 case：
    1) factor_version 缺失 / 非字符串 / 空白
    2) base_type 不在合法集合
    3) base_params 缺参 / 参数非法（horizon < 1 / max_hold_days 越界等）
    4) classify_mode 非合法值
    5) classify_params 与 classify_mode 不匹配（缺参 / 范围越界）
    6) new_listing_min_days 非 int（含 None / bool）或越界
    7) date_range 格式错（不是 YYYYMMDD:YYYYMMDD）
    8) date_range start > end
    9) model 不在白名单
    """

    from quant_pipeline.labels.dir3_scheme import base_scheme_codec

    # 1 factor_version
    factor_version = params.get("factor_version")
    if not isinstance(factor_version, str) or not factor_version.strip():
        raise ValueError("factor_version: non-empty string required")

    # 2 & 3 base_type + base_params
    base_type, base_params = _validate_base_type_and_params(
        params.get("base_type"),
        params.get("base_params"),
    )
    # base_scheme 由 codec 决定性生成（max_hold_days 不进 scheme）
    base_scheme = base_scheme_codec(base_type, base_params)

    # 4 & 5 classify_mode + classify_params
    classify_mode, classify_params = _validate_classify(
        params.get("classify_mode"),
        params.get("classify_params"),
    )

    # 可选追溯字段（后端 expandForTraining 透传，不存在时 None）
    label_id = params.get("label_id")
    if label_id is not None and not isinstance(label_id, str):
        raise ValueError(f"label_id: must be str if present, got {label_id!r}")
    label_version = params.get("label_version")
    if label_version is not None and not isinstance(label_version, str):
        raise ValueError(f"label_version: must be str if present, got {label_version!r}")

    # 6 new_listing_min_days —— bool 是 int 子类，先排除（True/False 在 [0,250] 会误判通过）
    new_listing_min_days = params.get("new_listing_min_days", 60)
    if isinstance(new_listing_min_days, bool) or not isinstance(new_listing_min_days, int):
        raise ValueError(
            f"new_listing_min_days: must be int, got {type(new_listing_min_days).__name__}"
        )
    if not (0 <= new_listing_min_days <= 250):
        raise ValueError(
            f"new_listing_min_days: must be in [0,250], got {new_listing_min_days}"
        )

    # 7 & 8 date_range
    date_range = params.get("date_range")
    if not isinstance(date_range, str) or not re.fullmatch(r"\d{8}:\d{8}", date_range):
        raise ValueError(f"date_range: 'YYYYMMDD:YYYYMMDD' required, got {date_range!r}")
    start, end = date_range.split(":")
    if start > end:
        raise ValueError(f"date_range: start <= end required, got {date_range!r}")

    # 9 model
    model = params.get("model")
    if model not in _ALLOWED_MODELS:
        raise ValueError(
            f"model: must be one of {sorted(_ALLOWED_MODELS)}, got {model!r}"
        )

    walk_forward = bool(params.get("walk_forward", True))
    seed = int(params.get("seed", 42))

    hyperparams = _validate_hyperparams(
        params.get("hyperparams"), model=model, walk_forward=walk_forward
    )
    neutralize_cols = _validate_neutralize_cols(params.get("neutralize_cols"))
    robust_z = params.get("robust_z")
    if robust_z is not None and not isinstance(robust_z, bool):
        raise ValueError(f"robust_z: must be bool if present, got {robust_z!r}")
    factor_clip_sigma = _validate_factor_clip_sigma(params.get("factor_clip_sigma"))
    label_winsorize = _validate_label_winsorize(params.get("label_winsorize"))

    return ValidatedParams(
        factor_version=factor_version.strip(),
        base_type=base_type,
        base_params=base_params,
        base_scheme=base_scheme,
        new_listing_min_days=new_listing_min_days,
        date_range=date_range,
        model=model,
        walk_forward=walk_forward,
        seed=seed,
        neutralize_cols=neutralize_cols,
        robust_z=robust_z,
        classify_mode=classify_mode,
        classify_params=classify_params,
        label_id=label_id,
        label_version=label_version,
        hyperparams=hyperparams,
        factor_clip_sigma=factor_clip_sigma,
        label_winsorize=label_winsorize,
    )


# ---------------------------------------------------------------------------
# 三个 step
# ---------------------------------------------------------------------------


def _step_labels(
    p: ValidatedParams,
    job_id: UUID,
    parent_cb: ProgressCallback,
) -> None:
    """labels step（进度窗口 0-30）。

    按 base_scheme 物化连续值（已存在则 upsert 覆盖去重共享，compute_labels 幂等）。
    base_scheme = base_scheme_codec(base_type, base_params)，不含分类参数。
    strategy_aware 的 max_hold_days 从 base_params 解析（None → 走下游默认 20）。
    fwd_ret 的 horizon 已编入 base_scheme 字符串（fwd_ret_hN / fwd_5d_ret legacy）。
    """

    # 延迟 import 避免 worker 模块在 labels 子树未就绪时启动报错
    from quant_pipeline.labels.runner import compute_labels

    lo, hi = _WINDOW_LABELS

    # strategy_aware 的 max_hold_days 从 base_params 解析
    max_hold_days: int | None = None
    if p.base_type == "strategy_aware":
        max_hold_days = p.base_params.get("max_hold_days")

    logger.info(
        "train_e2e_step_start",
        extra={
            "job_id": str(job_id),
            "step": "labels",
            "base_scheme": p.base_scheme,
            "date_range": p.date_range,
            "new_listing_min_days": p.new_listing_min_days,
        },
    )
    try:
        compute_labels(
            scheme=p.base_scheme,
            date_range=p.date_range,
            new_listing_min_days=p.new_listing_min_days,
            max_hold_days=max_hold_days,
            label_winsorize=p.label_winsorize,
            job_id=job_id,
            progress_callback=make_scaled_callback(parent_cb, lo, hi),
        )
    except JobCancelled:
        raise
    except Exception as e:  # noqa: BLE001
        raise StepError("labels", e) from e
    logger.info(
        "train_e2e_step_done",
        extra={"job_id": str(job_id), "step": "labels"},
    )


def _step_features(
    p: ValidatedParams,
    job_id: UUID,
    parent_cb: ProgressCallback,
) -> str:
    """features step（进度窗口 30-60）。返回 feature_set_id。

    按 spec 03 升级后的 `build_feature_matrix` 签名调用：必填
    `new_listing_min_days`，返回 `FeatureMatrixBundle`（取 `.feature_set_id`）。
    """

    from quant_pipeline.features.runner import build_feature_matrix

    lo, hi = _WINDOW_FEATURES
    logger.info(
        "train_e2e_step_start",
        extra={
            "job_id": str(job_id),
            "step": "features",
            "factor_version": p.factor_version,
            "base_scheme": p.base_scheme,
            "date_range": p.date_range,
            "new_listing_min_days": p.new_listing_min_days,
        },
    )
    try:
        bundle = build_feature_matrix(
            factor_version=p.factor_version,
            label_scheme=p.base_scheme,
            date_range=p.date_range,
            new_listing_min_days=p.new_listing_min_days,
            # spec 02 §特征参数透传：None 时 build_feature_matrix 走 builder 默认，
            # 不进 feature_set_id 覆盖层哈希（方案 A），行为完全不变。
            neutralize_cols=p.neutralize_cols,
            robust_z=p.robust_z,
            factor_clip_sigma=p.factor_clip_sigma,
            label_winsorize=p.label_winsorize,
            job_id=job_id,
            progress_callback=make_scaled_callback(parent_cb, lo, hi),
        )
    except JobCancelled:
        raise
    except Exception as e:  # noqa: BLE001
        raise StepError("features", e) from e

    # spec 04 表格规定返回 bundle.feature_set_id；兼容直接返回 str 的老签名（向后保险）
    feature_set_id = getattr(bundle, "feature_set_id", bundle)
    if not isinstance(feature_set_id, str) or not feature_set_id:
        raise StepError(
            "features",
            RuntimeError(
                f"build_feature_matrix returned no feature_set_id: {bundle!r}"
            ),
        )

    logger.info(
        "train_e2e_step_done",
        extra={
            "job_id": str(job_id),
            "step": "features",
            "feature_set_id": feature_set_id,
        },
    )
    return feature_set_id


def _step_train(
    p: ValidatedParams,
    job_id: UUID,
    feature_set_id: str,
    parent_cb: ProgressCallback,
) -> dict[str, Any]:
    """train step（进度窗口 60-100）。返回结果 dict（含 model_version 等）。

    extra_hyperparams 写入 ml.model_runs.hyperparams：
      - factor_version / base_scheme / new_listing_min_days（可复现基础字段）
      - classify_mode / classify_params（分类后移追溯）
      - label_id / label_version（命名标签追溯，Optional，由后端 expandForTraining 透传）
    """

    from quant_pipeline.training.runner import train_model

    lo, hi = _WINDOW_TRAIN
    extra_hyperparams: dict[str, Any] = {
        "factor_version": p.factor_version,
        "base_scheme": p.base_scheme,
        "new_listing_min_days": p.new_listing_min_days,
        "classify_mode": p.classify_mode,
        "classify_params": p.classify_params,
    }
    # label_id / label_version 仅在后端透传时才写（None 不进 extra_hyperparams 防空键污染）
    if p.label_id is not None:
        extra_hyperparams["label_id"] = p.label_id
    if p.label_version is not None:
        extra_hyperparams["label_version"] = p.label_version
    logger.info(
        "train_e2e_step_start",
        extra={
            "job_id": str(job_id),
            "step": "train",
            "feature_set_id": feature_set_id,
            "model": p.model,
            "walk_forward": p.walk_forward,
            "seed": p.seed,
        },
    )
    try:
        raw_result = train_model(
            feature_set_id=feature_set_id,
            model=p.model,
            walk_forward=p.walk_forward,
            seed=p.seed,
            # lgb / lstm 模型超参（已严格校验/未知键剔除）→ train_model(hyperparams=)
            # → train_lambdarank / lgb-multiclass / lstm 的 params。
            # None 时走各模型 DEFAULT_HYPERPARAMS，行为不变。
            hyperparams=p.hyperparams,
            extra_hyperparams=extra_hyperparams,
            # 分类后移：classify_mode/classify_params 透传给 train_model 做误配护栏
            classify_mode=p.classify_mode,
            classify_params=p.classify_params,
            job_id=job_id,
            progress_callback=make_scaled_callback(parent_cb, lo, hi),
        )
    except JobCancelled:
        raise
    except Exception as e:  # noqa: BLE001
        raise StepError("train", e) from e

    # train_model 返回 TrainResult dataclass 或 dict；都归一成 dict 装 result_payload
    result_dict = _normalize_train_result(raw_result)

    logger.info(
        "train_e2e_step_done",
        extra={
            "job_id": str(job_id),
            "step": "train",
            "model_version": result_dict.get("model_version"),
        },
    )
    return result_dict


def _normalize_train_result(raw: Any) -> dict[str, Any]:
    """把 TrainResult dataclass 或裸 dict 都压平成 JSON-safe dict。"""

    if isinstance(raw, dict):
        return raw
    # TrainResult / 类似 dataclass 实例：提取已知字段（缺则 None）
    return {
        "model_run_id": str(getattr(raw, "model_run_id", "")) or None,
        "model_version": getattr(raw, "model_version", None),
        "artifact_uri": getattr(raw, "artifact_uri", None),
        "report_uri": getattr(raw, "report_uri", None),
    }


# ---------------------------------------------------------------------------
# 顶层编排
# ---------------------------------------------------------------------------


def run_train_e2e(
    job_id: UUID,
    params: dict[str, Any],
    progress_callback: ProgressCallback,
) -> dict[str, Any]:
    """单 job 内顺序跑 labels → features → train。

    返回:
        dict 写入 ml.jobs.result_payload（D-13）。形如:
        {"feature_set_id": "fs_...", "model_version": "...", "last_completed_step": "train"}

    异常:
        - JobCancelled：用户主动取消，dispatcher 写 status='cancelled'
        - StepError：子 runner 失败，dispatcher 据 step 名拼 error_text 首行
        - ValueError：`_validate_params` 阶段失败（dispatcher 走 [step:validate] 分支）
        - RuntimeError("factor_definitions unreachable")：DB 连不上（spec 02
          §异常分类），由 dispatcher 上层捕获并 fail job

    spec 2026-05-23-factor-registry-frontend-design 02 §加载与实例化流程：
    job 入口必须 `registry.reload_from_db()`——把 `factors.factor_definitions`
    全表拉进 `_meta_cache`，让随后的 builder/runner 在 `list_active()` /
    `Factor.__init__` 拿到最新元数据。不放在模块 import 期是为了避免长驻
    进程级缓存污染下一个 job。
    """

    # 延迟 import 避免 worker 包加载阶段触发 DB 连接（测试场景常 monkeypatch
    # registry 全套，模块顶部 import 会让 patch 时机晚于实际调用）。
    from quant_pipeline.factors import registry as _factor_registry

    try:
        _factor_registry.reload_from_db()
    except Exception as exc:  # noqa: BLE001
        # CLAUDE.md：禁静默吞错；显式包成 RuntimeError 让 dispatcher 区分
        # "DB 连不上" vs "validate/step 失败"，不要 fallback 到旧缓存。
        logger.error(
            "factor_definitions_reload_failed",
            extra={"job_id": str(job_id), "err": str(exc)},
        )
        raise RuntimeError("factor_definitions unreachable") from exc

    p = _validate_params(params)

    check_cancel_requested_or_cancel(job_id)
    _step_labels(p, job_id, progress_callback)

    check_cancel_requested_or_cancel(job_id)
    feature_set_id = _step_features(p, job_id, progress_callback)

    check_cancel_requested_or_cancel(job_id)
    train_result = _step_train(p, job_id, feature_set_id, progress_callback)

    return {
        "feature_set_id": feature_set_id,
        "model_version": train_result.get("model_version"),
        "last_completed_step": "train",
    }


def check_cancel_requested_or_cancel(job_id: UUID) -> None:
    """在每个 step 入口前查一次，若用户已请求取消立即抛 JobCancelled。

    `check_cancel_requested` 是 bool 返回，加这层壳让顶层 `run_train_e2e` 不重复
    写 `if check_cancel_requested(...): raise JobCancelled` 三遍。
    """

    if check_cancel_requested(job_id):
        raise JobCancelled


__all__ = [
    "StepError",
    "ValidatedParams",
    "run_train_e2e",
]
