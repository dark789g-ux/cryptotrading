"""prepare 编排 runner（spec 2026-06-06-labels-features-incremental-prepare-design §03）。

把 labels → features 两步串成单个 ml.jobs 行，进度按 0-50 / 50-100 切片
回写到父 progress callback。_step_train 已随 train_e2e 废弃，不在此处。

设计点：
- run_type='prepare'：备料编排，仅 labels + features，不含 train。
- force_recompute=False（默认）走增量缺口算法（P2/P3 实现）；True 全量重算。
- params 结构复用 train_e2e 的校验逻辑（同 ValidatedParams，少 model/walk_forward/
  seed/hyperparams；这里保留完整校验以与 NestJS DTO 对齐，多余字段 warn+忽略）。
- StepError / ValidatedParams / check_cancel_requested_or_cancel 公开供 dispatcher 用。
- train_e2e_runner.py 已废弃 run_train_e2e/_step_train，校验逻辑统一在本模块。

进度切片窗口（两步均分）：
  labels:   [0, 50]
  features: [50, 100]

new_listing_min_days=0 是合法值（不过滤新股），全链路绝不用 `if min_days:` 判
falsy，统一 `isinstance(int) and 0 <= x <= 250`。
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from quant_pipeline.worker.progress import (
    JobCancelled,
    ProgressCallback,
    check_cancel_requested,
    make_scaled_callback,
)

logger = logging.getLogger(__name__)

# 合法白名单（与 spec 03 / NestJS DTO / 前端 select options 保持一致）
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
# strategy_aware 策略引用校验：id 限小写字母数字下划线、version 限 v 后跟数字。
_STRATEGY_ID_RE = re.compile(r"^[a-z0-9_]{1,64}$")
_STRATEGY_VERSION_RE = re.compile(r"^v\d+$")
# neutralize_cols 三档规范组合（去重排序后比对）。
_NEUTRALIZE_COLS_CANONICAL = {
    (),
    ("industry_l1",),
    ("industry_l1", "mv"),
}

# 进度切片窗口（两步均分）
_WINDOW_LABELS = (0, 50)
_WINDOW_FEATURES = (50, 100)


# ---------------------------------------------------------------------------
# 数据契约
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ValidatedParams:
    """`_validate_params` 出来的不可变结构。frozen 防中途被改坏。

    prepare runner 复用此结构；model/walk_forward/seed/hyperparams 字段保留
    以便校验层与 NestJS DTO 完全对齐（prepare job params 可携带这些字段，
    此处忽略 model 等无用字段，下游 step 只用 labels/features 相关字段）。
    """

    factor_version: str
    base_type: str           # 'fwd_ret' | 'strategy_aware'
    base_params: dict[str, Any]   # {'horizon': N} | {'strategy_id','strategy_version'}
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

    dispatcher._runner_prepare 捕获后写 `error_text` 首行
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
                "prepare_unknown_hyperparam_skipped",
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
            "prepare_early_stopping_ignored_single_fold",
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

    fwd_ret:        base_params['horizon'] 为 int >= 1（任意正整数）。
    strategy_aware: base_params={strategy_id: ^[a-z0-9_]{1,64}$,
                    strategy_version: ^v\\d+$}（策略引用，spec 03 §3.3）。

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
        sid = params.get("strategy_id")
        sver = params.get("strategy_version")
        if not isinstance(sid, str) or not _STRATEGY_ID_RE.fullmatch(sid):
            raise ValueError(
                "base_params.strategy_id: must match ^[a-z0-9_]{1,64}$, "
                f"got {sid!r}"
            )
        if not isinstance(sver, str) or not _STRATEGY_VERSION_RE.fullmatch(sver):
            raise ValueError(
                "base_params.strategy_version: must match ^v\\d+$, "
                f"got {sver!r}"
            )
        params = {"strategy_id": sid, "strategy_version": sver}

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

    prepare runner 复用此校验，model 字段在 prepare 时不参与实际 step 执行，
    但 params 结构与 train_e2e 完全兼容，避免 NestJS DTO 多套逻辑。

    非法 case：
    1) factor_version 缺失 / 非字符串 / 空白
    2) base_type 不在合法集合
    3) base_params 缺参 / 参数非法
    4) classify_mode 非合法值
    5) classify_params 与 classify_mode 不匹配
    6) new_listing_min_days 非 int（含 None / bool）或越界
    7) date_range 格式错（不是 YYYYMMDD:YYYYMMDD）
    8) date_range start > end
    9) model 不在白名单（prepare 不用但仍校验）
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
    # base_scheme 由 codec 决定性生成
    base_scheme = base_scheme_codec(base_type, base_params)

    # 4 & 5 classify_mode + classify_params
    classify_mode, classify_params = _validate_classify(
        params.get("classify_mode"),
        params.get("classify_params"),
    )

    # 可选追溯字段
    label_id = params.get("label_id")
    if label_id is not None and not isinstance(label_id, str):
        raise ValueError(f"label_id: must be str if present, got {label_id!r}")
    label_version = params.get("label_version")
    if label_version is not None and not isinstance(label_version, str):
        raise ValueError(f"label_version: must be str if present, got {label_version!r}")

    # 6 new_listing_min_days —— bool 是 int 子类，先排除
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

    # 9 model（prepare 不用但仍校验；None 时 prepare job 可省略 model 字段）
    model = params.get("model")
    if model is not None and model not in _ALLOWED_MODELS:
        raise ValueError(
            f"model: must be one of {sorted(_ALLOWED_MODELS)}, got {model!r}"
        )
    # prepare 允许 model=None（不训练不需要 model），但若提供则必须合法
    # 为保持 ValidatedParams 不可空，fallback to sentinel
    if model is None:
        model = "lgb-lambdarank"  # sentinel，prepare 步骤不使用

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
# 两个 step
# ---------------------------------------------------------------------------


def _step_labels(
    p: ValidatedParams,
    job_id: UUID,
    parent_cb: ProgressCallback,
    *,
    force_recompute: bool = False,
) -> None:
    """labels step（进度窗口 0-50）。

    按 base_scheme 物化连续值（force_recompute=False 走增量缺口算法）。
    strategy_aware 时从 factors.strategy_definitions 加载引用策略的 exit_rules。
    """

    from quant_pipeline.labels.runner import (
        _load_strategy_definition,
        compute_labels,
    )

    lo, hi = _WINDOW_LABELS

    exit_rules: list[dict] | None = None
    if p.base_type == "strategy_aware":
        exit_rules = _load_strategy_definition(
            p.base_params["strategy_id"],
            p.base_params["strategy_version"],
        )

    logger.info(
        "prepare_step_start",
        extra={
            "job_id": str(job_id),
            "step": "labels",
            "base_scheme": p.base_scheme,
            "date_range": p.date_range,
            "new_listing_min_days": p.new_listing_min_days,
            "force_recompute": force_recompute,
        },
    )
    try:
        compute_labels(
            scheme=p.base_scheme,
            date_range=p.date_range,
            new_listing_min_days=p.new_listing_min_days,
            exit_rules=exit_rules,
            label_winsorize=p.label_winsorize,
            job_id=job_id,
            progress_callback=make_scaled_callback(parent_cb, lo, hi),
            force_recompute=force_recompute,
        )
    except JobCancelled:
        raise
    except Exception as e:  # noqa: BLE001
        raise StepError("labels", e) from e
    logger.info(
        "prepare_step_done",
        extra={"job_id": str(job_id), "step": "labels"},
    )


def _step_features(
    p: ValidatedParams,
    job_id: UUID,
    parent_cb: ProgressCallback,
    *,
    force_recompute: bool = False,
) -> str:
    """features step（进度窗口 50-100）。返回 feature_set_id。

    按 spec 03 升级后的 `build_feature_matrix` 签名调用；返回 FeatureMatrixBundle
    取 `.feature_set_id`。force_recompute 透传给增量算法。
    """

    from quant_pipeline.features.runner import build_feature_matrix

    lo, hi = _WINDOW_FEATURES
    logger.info(
        "prepare_step_start",
        extra={
            "job_id": str(job_id),
            "step": "features",
            "factor_version": p.factor_version,
            "base_scheme": p.base_scheme,
            "date_range": p.date_range,
            "new_listing_min_days": p.new_listing_min_days,
            "force_recompute": force_recompute,
        },
    )
    try:
        bundle = build_feature_matrix(
            factor_version=p.factor_version,
            label_scheme=p.base_scheme,
            date_range=p.date_range,
            new_listing_min_days=p.new_listing_min_days,
            neutralize_cols=p.neutralize_cols,
            robust_z=p.robust_z,
            factor_clip_sigma=p.factor_clip_sigma,
            label_winsorize=p.label_winsorize,
            job_id=job_id,
            progress_callback=make_scaled_callback(parent_cb, lo, hi),
            force_recompute=force_recompute,
        )
    except JobCancelled:
        raise
    except Exception as e:  # noqa: BLE001
        raise StepError("features", e) from e

    feature_set_id = getattr(bundle, "feature_set_id", bundle)
    if not isinstance(feature_set_id, str) or not feature_set_id:
        raise StepError(
            "features",
            RuntimeError(
                f"build_feature_matrix returned no feature_set_id: {bundle!r}"
            ),
        )

    logger.info(
        "prepare_step_done",
        extra={
            "job_id": str(job_id),
            "step": "features",
            "feature_set_id": feature_set_id,
        },
    )
    return feature_set_id


# ---------------------------------------------------------------------------
# 顶层编排
# ---------------------------------------------------------------------------


def run_prepare(
    job_id: UUID,
    params: dict[str, Any],
    progress_callback: ProgressCallback,
) -> dict[str, Any]:
    """单 job 内顺序跑 labels → features（备料，无训练步骤）。

    返回:
        dict 写入 ml.jobs.result_payload。形如:
        {"feature_set_id": "fs_...", "last_completed_step": "features"}

    异常:
        - JobCancelled：用户主动取消，dispatcher 写 status='cancelled'
        - StepError：子 runner 失败，dispatcher 据 step 名拼 error_text 首行
        - ValueError：`_validate_params` 阶段失败
        - RuntimeError("factor_definitions unreachable")：DB 连不上

    force_recompute 从 params 读取（默认 False=增量）：
        True  → 全量重算（忽略已物化数据）
        False → 缺口增量（只补缺失段，P2/P3 实现）
    """

    from quant_pipeline.factors import registry as _factor_registry

    try:
        _factor_registry.reload_from_db()
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "factor_definitions_reload_failed",
            extra={"job_id": str(job_id), "err": str(exc)},
        )
        raise RuntimeError("factor_definitions unreachable") from exc

    p = _validate_params(params)
    force_recompute = bool(params.get("force_recompute", False))

    check_cancel_requested_or_cancel(job_id)
    _step_labels(p, job_id, progress_callback, force_recompute=force_recompute)

    check_cancel_requested_or_cancel(job_id)
    feature_set_id = _step_features(p, job_id, progress_callback, force_recompute=force_recompute)

    return {
        "feature_set_id": feature_set_id,
        "last_completed_step": "features",
    }


def check_cancel_requested_or_cancel(job_id: UUID) -> None:
    """在每个 step 入口前查一次，若用户已请求取消立即抛 JobCancelled。

    `check_cancel_requested` 是 bool 返回，加这层壳让顶层不重复
    写 `if check_cancel_requested(...): raise JobCancelled` 两遍。
    """

    if check_cancel_requested(job_id):
        raise JobCancelled


__all__ = [
    "StepError",
    "ValidatedParams",
    "run_prepare",
    # 校验辅助（供测试直接引用）
    "_validate_params",
    "_validate_hyperparams",
    "_validate_neutralize_cols",
    "_validate_factor_clip_sigma",
    "_validate_label_winsorize",
    "_validate_base_type_and_params",
    "_validate_classify",
    # 常量（供测试断言）
    "_ALLOWED_MODELS",
    "_ALLOWED_CLASSIFY_MODES",
]
