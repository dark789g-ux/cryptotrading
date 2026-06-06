"""train_e2e_runner — 已废弃（spec 2026-06-06-labels-features-incremental-prepare-design §03）。

`run_train_e2e` / `_step_train` 已随 train_e2e run_type 一并废弃。
现有校验逻辑（ValidatedParams / StepError / _validate_params 及辅助函数）
统一移至 prepare_runner，本模块 re-export 保持测试向后兼容。

新代码请直接 import quant_pipeline.worker.prepare_runner。
dispatcher 已删除 train_e2e 路由，不会再有新 train_e2e job 进入。
"""

from __future__ import annotations

# Re-export 全部公共 API 及内部校验函数，保持旧测试文件
# `from quant_pipeline.worker import train_e2e_runner as tr` + `tr._validate_params` 等不断。
from quant_pipeline.worker.prepare_runner import (
    StepError,
    ValidatedParams,
    _ALLOWED_CLASSIFY_MODES,
    _ALLOWED_MODELS,
    _validate_base_type_and_params,
    _validate_classify,
    _validate_factor_clip_sigma,
    _validate_hyperparams,
    _validate_label_winsorize,
    _validate_neutralize_cols,
    _validate_params,
    check_cancel_requested_or_cancel,
)

__all__ = [
    "StepError",
    "ValidatedParams",
    "_ALLOWED_CLASSIFY_MODES",
    "_ALLOWED_MODELS",
    "_validate_base_type_and_params",
    "_validate_classify",
    "_validate_factor_clip_sigma",
    "_validate_hyperparams",
    "_validate_label_winsorize",
    "_validate_neutralize_cols",
    "_validate_params",
    "check_cancel_requested_or_cancel",
]
