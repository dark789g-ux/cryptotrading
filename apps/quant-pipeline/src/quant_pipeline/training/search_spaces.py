"""Optuna 搜索空间配置 + 工具函数。

从 training/tuning.py 拆出的搜索空间常量与工具。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from quant_pipeline.config.settings import get_settings


# ----------------------------------------------------------------------
# 搜索空间（doc/05 §5.5 四主旋钮）
# ----------------------------------------------------------------------

# 暴露给单测的常量；保持与 doc/05 同步
SEARCH_SPACES: dict[str, dict[str, tuple[Any, Any] | tuple[Any, Any, bool]]] = {
    "default": {
        "num_leaves": (15, 127),                # int, uniform
        "min_data_in_leaf": (50, 500),          # int, uniform
        "feature_fraction": (0.5, 1.0),         # float, uniform
        "learning_rate": (0.01, 0.2, True),     # float, log=True
    },
}


def suggest_hyperparams(trial: Any, space_name: str) -> dict[str, Any]:
    """根据 space_name 在 trial 上 suggest 出 4 个主旋钮。"""

    if space_name not in SEARCH_SPACES:
        raise ValueError(
            f"未知搜索空间 {space_name!r}；可选: {sorted(SEARCH_SPACES)}"
        )
    space = SEARCH_SPACES[space_name]
    nl_lo, nl_hi = space["num_leaves"]
    ml_lo, ml_hi = space["min_data_in_leaf"]
    ff_lo, ff_hi = space["feature_fraction"]
    lr_lo, lr_hi, lr_log = space["learning_rate"]
    return {
        "num_leaves": int(trial.suggest_int("num_leaves", int(nl_lo), int(nl_hi))),
        "min_data_in_leaf": int(
            trial.suggest_int("min_data_in_leaf", int(ml_lo), int(ml_hi))
        ),
        "feature_fraction": float(
            trial.suggest_float("feature_fraction", float(ff_lo), float(ff_hi))
        ),
        "learning_rate": float(
            trial.suggest_float(
                "learning_rate", float(lr_lo), float(lr_hi), log=bool(lr_log)
            )
        ),
    }


# ----------------------------------------------------------------------
# 工具：构建 storage URL / study name
# ----------------------------------------------------------------------


def build_study_name(feature_set_id: str, today_yyyymmdd: str | None = None) -> str:
    """study 名规则：`optuna_<feature_set_id>_<YYYYMMDD>`。"""

    if today_yyyymmdd is None:
        today_yyyymmdd = datetime.now(timezone.utc).strftime("%Y%m%d")
    return f"optuna_{feature_set_id}_{today_yyyymmdd}"


def build_storage_url() -> str:
    """Optuna PG RDB storage URL。

    复用 quant_pipeline.config.settings 的 PG_DSN；Optuna 表会落在 ml schema
    （Optuna 自建 `optuna_*`，由 library 自己创建，不走 Alembic）。
    """

    dsn = get_settings().pg_dsn
    # Optuna 接受 SQLAlchemy URL；前缀必须 postgresql+psycopg2 或 postgresql
    return dsn
