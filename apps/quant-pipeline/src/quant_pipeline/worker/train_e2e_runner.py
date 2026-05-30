"""train_e2e 编排 runner（spec 04）。

把 labels → features → train 三步串成单个 ml.jobs 行，进度按 0-30 / 30-60 /
60-100 切片回写到父 progress callback。

设计点（spec 04 + 00-index 决策表）：
- D-2 / D-7：单 run_type='train_e2e'，worker 内顺序执行三步 + 进度切片
- D-13：返回 dict 写 ml.jobs.result_payload（feature_set_id + last_completed_step）
- D-14：三个元字段（factor_version / label_scheme / new_listing_min_days）通过
  `train_model(extra_hyperparams=...)` 落到 ml.model_runs.hyperparams
- D-17：Modal 隐藏 neutralize_cols / robust_z；这里 ValidatedParams 用 None 让
  下游 builder 走 default（不在本层 hardcode default 防双源真理）
- D-18：子 runner 抛任何 Exception → 包装成 StepError，让 dispatcher 写
  error_text 首行 `[step:<name>] <traceback>`
- D-23：train 步骤调用 `train_model(extra_hyperparams=...)` 写元信息

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
# spec 04 §2.1：新增 lstm 模型 + dir3_band / dir3_tercile 标签方案。
# v1 不在此处强制 model↔scheme 配对（保持松耦合，允许实验组合）；lstm + 连续标签
# 的误配由 LSTM 训练入口的 label 整数护栏兜住报错（见 spec 02 §3 / 04 §2.1 备注）。
_ALLOWED_SCHEMES = {"strategy-aware", "fwd_5d_ret", "dir3_band", "dir3_tercile"}
_ALLOWED_MODELS = {"lgb-lambdarank", "linear", "gbdt", "lstm"}

# 进度切片窗口（spec 04 §progress 切片工具）
_WINDOW_LABELS = (0, 30)
_WINDOW_FEATURES = (30, 60)
_WINDOW_TRAIN = (60, 100)


# ---------------------------------------------------------------------------
# 数据契约
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ValidatedParams:
    """`_validate_params` 出来的不可变结构。frozen 防中途被改坏。"""

    factor_version: str
    label_scheme: str
    new_listing_min_days: int
    date_range: str
    model: str
    walk_forward: bool
    seed: int
    # D-17：Modal 隐藏 neutralize_cols / robust_z；None 表示走 builder default。
    # 留出 hook 是为了将来如果要从前端开放，校验层入口已就位。
    neutralize_cols: tuple[str, ...] | None
    robust_z: bool | None


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


def _validate_params(params: dict[str, Any]) -> ValidatedParams:
    """把前端 / DTO 透传过来的 dict 严校验成 ValidatedParams。

    8 个非法 case（spec 06 单测矩阵 "_validate_params 8 个非法 case"）：
    1) factor_version 缺失 / 非字符串
    2) factor_version 空白
    3) label_scheme 不在白名单
    4) new_listing_min_days 非 int（含 None / "60" / 60.0 / bool）
    5) new_listing_min_days 越界（<0 或 >250）
    6) date_range 格式错（不是 YYYYMMDD:YYYYMMDD）
    7) date_range start > end
    8) model 不在白名单
    """

    # 1 & 2 factor_version
    factor_version = params.get("factor_version")
    if not isinstance(factor_version, str) or not factor_version.strip():
        raise ValueError("factor_version: non-empty string required")

    # 3 label_scheme
    label_scheme = params.get("label_scheme")
    if label_scheme not in _ALLOWED_SCHEMES:
        raise ValueError(
            f"label_scheme: must be one of {sorted(_ALLOWED_SCHEMES)}, got {label_scheme!r}"
        )

    # 4 & 5 new_listing_min_days —— bool 是 int 子类，先排除（True/False 在 [0,250] 会误判通过）
    new_listing_min_days = params.get("new_listing_min_days", 60)
    if isinstance(new_listing_min_days, bool) or not isinstance(new_listing_min_days, int):
        raise ValueError(
            f"new_listing_min_days: must be int, got {type(new_listing_min_days).__name__}"
        )
    if not (0 <= new_listing_min_days <= 250):
        raise ValueError(
            f"new_listing_min_days: must be in [0,250], got {new_listing_min_days}"
        )

    # 6 & 7 date_range
    date_range = params.get("date_range")
    if not isinstance(date_range, str) or not re.fullmatch(r"\d{8}:\d{8}", date_range):
        raise ValueError(f"date_range: 'YYYYMMDD:YYYYMMDD' required, got {date_range!r}")
    start, end = date_range.split(":")
    if start > end:
        raise ValueError(f"date_range: start <= end required, got {date_range!r}")

    # 8 model
    model = params.get("model")
    if model not in _ALLOWED_MODELS:
        raise ValueError(
            f"model: must be one of {sorted(_ALLOWED_MODELS)}, got {model!r}"
        )

    walk_forward = bool(params.get("walk_forward", True))
    seed = int(params.get("seed", 42))

    return ValidatedParams(
        factor_version=factor_version.strip(),
        label_scheme=label_scheme,
        new_listing_min_days=new_listing_min_days,
        date_range=date_range,
        model=model,
        walk_forward=walk_forward,
        seed=seed,
        neutralize_cols=None,
        robust_z=None,
    )


# ---------------------------------------------------------------------------
# 三个 step
# ---------------------------------------------------------------------------


def _step_labels(
    p: ValidatedParams,
    job_id: UUID,
    parent_cb: ProgressCallback,
) -> None:
    """labels step（进度窗口 0-30）。"""

    # 延迟 import 避免 worker 模块在 labels 子树未就绪时启动报错
    from quant_pipeline.labels.runner import compute_labels

    lo, hi = _WINDOW_LABELS
    logger.info(
        "train_e2e_step_start",
        extra={
            "job_id": str(job_id),
            "step": "labels",
            "scheme": p.label_scheme,
            "date_range": p.date_range,
            "new_listing_min_days": p.new_listing_min_days,
        },
    )
    try:
        compute_labels(
            scheme=p.label_scheme,
            date_range=p.date_range,
            new_listing_min_days=p.new_listing_min_days,
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
            "label_scheme": p.label_scheme,
            "date_range": p.date_range,
            "new_listing_min_days": p.new_listing_min_days,
        },
    )
    try:
        bundle = build_feature_matrix(
            factor_version=p.factor_version,
            label_scheme=p.label_scheme,
            date_range=p.date_range,
            new_listing_min_days=p.new_listing_min_days,
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
    """train step（进度窗口 60-100）。返回结果 dict（含 model_version 等）。"""

    from quant_pipeline.training.runner import train_model

    lo, hi = _WINDOW_TRAIN
    extra_hyperparams = {
        "factor_version": p.factor_version,
        "label_scheme": p.label_scheme,
        "new_listing_min_days": p.new_listing_min_days,
    }
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
            extra_hyperparams=extra_hyperparams,
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
