"""monitor.py 的 DB loader 段（从 monitor.py 抽出）。

拆分原因（06-quality.md 问题 12）：monitor.py 超 500 行。

单 session 复用（06-quality.md 问题 13）：原实现每个 loader 各自
`with session_scope()`，一次 monitor 开 6~7 个独立事务——连接/事务开销重，
且彼此读到不同时刻快照（不一致读）。现改为所有 loader 接受同一个 session，
由 `build_default_loaders(session)` 绑定，`run_daily_monitor` 只开一个
`session_scope()` 贯穿整个 monitor。

`build_default_loaders` 返回的闭包签名与测试注入的 mock loader 一致
（不含 session 参数），故测试注入契约不受影响。
"""

from __future__ import annotations

from typing import Any, Callable

import numpy as np
import pandas as pd
from sqlalchemy import text
from sqlalchemy.orm import Session


# ----------------------------------------------------------------------
# 底层 loader —— 均接受外部传入的共享 session（不再各自开事务）
# ----------------------------------------------------------------------

def load_current_scores(
    session: Session, model_version: str, trade_date: str
) -> pd.DataFrame:
    sql = text(
        """
        SELECT ts_code, score
        FROM ml.scores_daily
        WHERE model_version = :mv AND trade_date = :td
        """
    )
    rows = (
        session.execute(sql, {"mv": model_version, "td": trade_date})
        .mappings()
        .all()
    )
    return pd.DataFrame(
        [{"ts_code": r["ts_code"], "score": float(r["score"])} for r in rows]
    )


def load_train_oos_metrics(session: Session, model_version: str) -> dict[str, Any]:
    sql = text(
        """
        SELECT id, oos_metrics, feature_set_id
        FROM ml.model_runs
        WHERE model_version = :mv
        ORDER BY created_at DESC
        LIMIT 1
        """
    )
    row = session.execute(sql, {"mv": model_version}).mappings().first()
    if row is None:
        raise ValueError(f"ml.model_runs 找不到 model_version={model_version!r}")
    return {
        "model_run_id": str(row["id"]),
        "feature_set_id": row["feature_set_id"],
        "oos_metrics": dict(row["oos_metrics"] or {}),
    }


def load_rolling_ic(
    session: Session, model_version: str, end_date: str, window: int
) -> float:
    """计算滚动 window 日 IC 均值：用 ml.scores_daily JOIN factors.labels。

    若 ml.scores_daily 无足量数据，返回 NaN。
    """

    sql = text(
        """
        WITH dates AS (
            SELECT DISTINCT trade_date
            FROM ml.scores_daily
            WHERE model_version = :mv AND trade_date <= :td
            ORDER BY trade_date DESC
            LIMIT :w
        ),
        joined AS (
            SELECT s.trade_date, s.ts_code, s.score, l.value AS label
            FROM ml.scores_daily s
            JOIN factors.labels l
              ON l.trade_date = s.trade_date AND l.ts_code = s.ts_code
            WHERE s.model_version = :mv
              AND s.trade_date IN (SELECT trade_date FROM dates)
        )
        SELECT trade_date, score, label FROM joined
        """
    )
    rows = (
        session.execute(sql, {"mv": model_version, "td": end_date, "w": window})
        .mappings()
        .all()
    )
    if not rows:
        return float("nan")
    df = pd.DataFrame([dict(r) for r in rows])
    # 按 trade_date 求截面 IC，再对 window 内的 IC 求均值
    ics: list[float] = []
    for _td, g in df.groupby("trade_date"):
        if len(g) < 2:
            continue
        s = g["score"].to_numpy(dtype=float)
        y = g["label"].to_numpy(dtype=float)
        if np.std(s) < 1e-12 or np.std(y) < 1e-12:
            continue
        ics.append(float(np.corrcoef(s, y)[0, 1]))
    if not ics:
        return float("nan")
    return float(np.mean(ics))


def load_train_scores_sample(
    session: Session, model_version: str, trade_date: str, n_samples: int = 5000
) -> np.ndarray:
    """取该 model_version 当日之前的历史 ml.scores_daily 作为 train 分布的代理。

    必须带 `trade_date < :td` 过滤：否则当日 scores 同时进基准与当前分布，
    PSI 被系统性压低、漂移漏报（见 06-quality.md 问题 6）。

    注意：这仍是「近期推理输出」而非训练期 OOS 分布，只是漂移检测的代理基线；
    若要严格对训练分布比较，应改从 ml.model_runs 存的 OOS scores 取。

    若历史无样本（首次推理后立即监控），返回空数组。
    """

    sql = text(
        """
        SELECT score
        FROM ml.scores_daily
        WHERE model_version = :mv
          AND trade_date < :td
        ORDER BY trade_date DESC
        LIMIT :lim
        """
    )
    rows = session.execute(
        sql, {"mv": model_version, "td": trade_date, "lim": n_samples}
    ).all()
    return np.asarray([float(r[0]) for r in rows], dtype=float)


def _features_to_df(rows: list[Any]) -> pd.DataFrame:
    records: list[dict[str, Any]] = []
    for r in rows:
        feats = dict(r["features"]) if r["features"] else {}
        rec = {
            "ts_code": r["ts_code"],
            **{k: float(v) if v is not None else np.nan for k, v in feats.items()},
        }
        records.append(rec)
    return pd.DataFrame(records)


def load_current_features(
    session: Session, feature_set_id: str, trade_date: str
) -> pd.DataFrame:
    sql = text(
        """
        SELECT ts_code, features
        FROM factors.feature_matrix
        WHERE feature_set_id = :fs AND trade_date = :td
        """
    )
    rows = (
        session.execute(sql, {"fs": feature_set_id, "td": trade_date})
        .mappings()
        .all()
    )
    return _features_to_df(list(rows))


def load_train_features_sample(
    session: Session, feature_set_id: str, trade_date: str, n_dates: int = 60
) -> pd.DataFrame:
    """取该 feature_set 距 trade_date 之前 n_dates 个交易日的全样本，作为训练分布代理。"""

    sql = text(
        """
        WITH dates AS (
            SELECT DISTINCT trade_date
            FROM factors.feature_matrix
            WHERE feature_set_id = :fs AND trade_date < :td
            ORDER BY trade_date DESC
            LIMIT :n
        )
        SELECT ts_code, features
        FROM factors.feature_matrix
        WHERE feature_set_id = :fs
          AND trade_date IN (SELECT trade_date FROM dates)
        """
    )
    rows = (
        session.execute(sql, {"fs": feature_set_id, "td": trade_date, "n": n_dates})
        .mappings()
        .all()
    )
    return _features_to_df(list(rows))


# ----------------------------------------------------------------------
# 默认 loader 工厂 —— 把共享 session 绑定进闭包
# ----------------------------------------------------------------------

def build_default_loaders(session: Session) -> dict[str, Callable[..., Any]]:
    """返回绑定到同一 session 的 6 个默认 loader。

    闭包签名与测试注入的 mock loader 一致（不含 session 参数），故 monitor
    主入口对「默认 loader」与「注入 loader」可一视同仁地调用。
    """

    return {
        "load_current_scores": lambda mv, td: load_current_scores(session, mv, td),
        "load_train_oos_metrics": lambda mv: load_train_oos_metrics(session, mv),
        "load_rolling_ic": lambda mv, td, w: load_rolling_ic(session, mv, td, w),
        "load_train_scores_sample": (
            lambda mv, td, n_samples=5000: load_train_scores_sample(
                session, mv, td, n_samples
            )
        ),
        "load_current_features": lambda fs, td: load_current_features(
            session, fs, td
        ),
        "load_train_features_sample": (
            lambda fs, td, n_dates=60: load_train_features_sample(
                session, fs, td, n_dates
            )
        ),
    }
