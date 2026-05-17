# -*- coding: utf-8 -*-
"""feature_matrix 构建器（factors 长格式 + labels → 训练矩阵宽格式）。

步骤（spec m2-training-mvp.md §交付物 3）：
1. 从 factors.feature_sets 获取或创建 feature_set_id（factor_version × label_scheme 元数据）
2. 透视 factors.daily_factors 长格式 → 宽格式（每 ts_code/trade_date 一行，列是 factor_id）
3. 行业中性化：每个截面日，按 industry_l1 内 z-score
4. 标准化：每个截面日全市场 z-score
5. 与 factors.labels 按 (trade_date, ts_code) 内连接
6. 缺失因子用截面中位数填充（极端情形）
7. upsert 到 factors.feature_matrix

纯计算部分（pivot / neutralize / standardize / merge / impute）写成可测的纯函数，
DB IO 在 features.runner.py 完成。
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from typing import Final

import numpy as np
import pandas as pd

from quant_pipeline.labels.strategy_aware import (
    WINSORIZE_HI as LABEL_WINSORIZE_HI,
)
from quant_pipeline.labels.strategy_aware import (
    WINSORIZE_LO as LABEL_WINSORIZE_LO,
)
from quant_pipeline.labels.strategy_aware import (
    winsorize_label_value,
)

logger = logging.getLogger(__name__)

# 数值稳定阈值：标准差 < EPS 时不缩放（避免除 0）
_STD_EPS: Final[float] = 1e-9

# 因子层温和截尾：±3σ（spec m2 §交付物 3）
FACTOR_CLIP_SIGMA: Final[float] = 3.0

# 默认中性化列（市值 + 行业）；feature_set_id 据此哈希
DEFAULT_NEUTRALIZE_COLS: Final[tuple[str, ...]] = ("industry_l1", "mv")

# 默认是否启用 robust z（截尾后再 z-score）
DEFAULT_ROBUST_Z: Final[bool] = True


@dataclass(frozen=True)
class FeatureMatrixBundle:
    """构建后的 feature_matrix 结果容器。"""

    feature_set_id: str
    factor_ids: list[str]
    matrix: pd.DataFrame  # 列：trade_date, ts_code, <factor_id 1>, <factor_id 2>, ..., label


def build_feature_set_id(
    factor_version: str,
    label_scheme: str,
    *,
    neutralize_cols: tuple[str, ...] = DEFAULT_NEUTRALIZE_COLS,
    robust_z: bool = DEFAULT_ROBUST_Z,
) -> str:
    """生成 feature_set_id（确定性 SHA256 前 12 位 hash）。

    输入字段（spec m2 §交付物 3 严格要求）：
        factor_version    所选因子版本
        label_scheme      标签方案
        neutralize_cols   中性化使用的列（顺序无关）
        robust_z          是否启用 robust z-score（截尾后再 z-score）

    同输入 → 同 id，便于未来增量。形如 `fs_<sha12>`。
    """

    payload = json.dumps(
        {
            "factor_version": factor_version,
            "label_scheme": label_scheme,
            "neutralize_cols": sorted(neutralize_cols),
            "robust_z": bool(robust_z),
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    sha = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]
    return f"fs_{sha}"


def pivot_factors_long_to_wide(daily_factors: pd.DataFrame) -> pd.DataFrame:
    """长格式 → 宽格式。

    入参：DataFrame，列 [trade_date, ts_code, factor_id, value]
    返回：DataFrame，索引 [trade_date, ts_code]，列为 factor_id
    """

    required = {"trade_date", "ts_code", "factor_id", "value"}
    if not required.issubset(daily_factors.columns):
        raise ValueError(
            f"daily_factors 必须含列 {required}, got {list(daily_factors.columns)}"
        )
    if daily_factors.empty:
        return pd.DataFrame()
    wide = (
        daily_factors.pivot_table(
            index=["trade_date", "ts_code"],
            columns="factor_id",
            values="value",
            aggfunc="last",
        )
        .sort_index()
    )
    wide.columns.name = None
    return wide


def neutralize_by_industry(
    wide: pd.DataFrame,
    industry_map: pd.DataFrame,
) -> pd.DataFrame:
    """每个截面日按行业内 z-score 中性化。

    入参：
        wide: 宽格式 [trade_date, ts_code] × factor_id；
        industry_map: DataFrame，列 [trade_date, ts_code, industry_l1]（PIT 安全）
    返回：与 wide 同 shape 的中性化后矩阵。

    行业未知时回退到全市场 z-score（保守，避免数据丢失）。
    """

    if wide.empty:
        return wide
    if industry_map is None or industry_map.empty:
        logger.warning("industry_map_empty_fallback_to_market", extra={})
        return _standardize_cross_sectional(wide)

    df = wide.reset_index()
    ind = industry_map[["trade_date", "ts_code", "industry_l1"]].drop_duplicates(
        subset=["trade_date", "ts_code"], keep="last"
    )
    df = df.merge(ind, on=["trade_date", "ts_code"], how="left")
    factor_cols = [c for c in df.columns if c not in ("trade_date", "ts_code", "industry_l1")]
    # 无行业归属的行：先标记为占位行业（不与其它行业混在一起做 z-score）
    df["industry_l1"] = df["industry_l1"].fillna("__UNK__")

    grouped = df.groupby(["trade_date", "industry_l1"], sort=False)
    for col in factor_cols:
        mu = grouped[col].transform("mean")
        sd = grouped[col].transform(lambda s: s.std(ddof=0))
        # 当 sd 缺失 / 过小：填 0，避免除 0
        safe = sd.where(sd.fillna(0.0) >= _STD_EPS, other=1.0)
        z = (df[col] - mu) / safe
        z = z.where(sd.fillna(0.0) >= _STD_EPS, other=0.0)
        df[col] = z

    df = df.drop(columns=["industry_l1"]).set_index(["trade_date", "ts_code"]).sort_index()
    return df


def _standardize_cross_sectional(wide: pd.DataFrame) -> pd.DataFrame:
    """每个 trade_date 截面做全市场 z-score。"""

    if wide.empty:
        return wide
    out = wide.copy()
    grouped = out.groupby(level="trade_date", sort=False)
    for col in out.columns:
        mu = grouped[col].transform("mean")
        sd = grouped[col].transform(lambda s: s.std(ddof=0))
        safe = sd.where(sd.fillna(0.0) >= _STD_EPS, other=1.0)
        z = (out[col] - mu) / safe
        z = z.where(sd.fillna(0.0) >= _STD_EPS, other=0.0)
        out[col] = z
    return out


def standardize_cross_sectional(wide: pd.DataFrame) -> pd.DataFrame:
    """公开接口（test 友好）：截面 z-score。"""

    return _standardize_cross_sectional(wide)


def impute_missing_with_cs_median(wide: pd.DataFrame) -> pd.DataFrame:
    """按截面中位数填充因子 NaN（极端情形兜底）。"""

    if wide.empty:
        return wide
    out = wide.copy()
    grouped = out.groupby(level="trade_date", sort=False)
    for col in out.columns:
        median = grouped[col].transform("median")
        out[col] = out[col].fillna(median)
    # 仍残留 NaN（整列截面都 NaN）：填 0
    return out.fillna(0.0)


def impute_missing_with_industry_median(
    wide: pd.DataFrame,
    industry_map: pd.DataFrame,
) -> pd.DataFrame:
    """spec m2 §3 缺失处理：行业内中位数填充，仍缺失 → 该行被调用方丢弃。

    与 impute_missing_with_cs_median 的区别：本函数**不**fillna(0.0) 兜底，
    残留 NaN 由调用方按行 drop（spec 明确要求）。
    """

    if wide.empty:
        return wide
    if industry_map is None or industry_map.empty:
        # 退化为截面中位数
        out = wide.copy()
        grouped = out.groupby(level="trade_date", sort=False)
        for col in out.columns:
            med = grouped[col].transform("median")
            out[col] = out[col].fillna(med)
        return out

    df = wide.reset_index()
    ind = industry_map[["trade_date", "ts_code", "industry_l1"]].drop_duplicates(
        subset=["trade_date", "ts_code"], keep="last"
    )
    df = df.merge(ind, on=["trade_date", "ts_code"], how="left")
    df["industry_l1"] = df["industry_l1"].fillna("__UNK__")
    factor_cols = [c for c in df.columns if c not in ("trade_date", "ts_code", "industry_l1")]
    grouped = df.groupby(["trade_date", "industry_l1"], sort=False)
    for col in factor_cols:
        med = grouped[col].transform("median")
        df[col] = df[col].fillna(med)
    df = df.drop(columns=["industry_l1"]).set_index(["trade_date", "ts_code"]).sort_index()
    return df


def winsorize_factors(
    wide: pd.DataFrame,
    *,
    sigma: float = FACTOR_CLIP_SIGMA,
) -> pd.DataFrame:
    """因子层温和截尾：每个截面对每个因子在 [μ-Nσ, μ+Nσ] 截断（spec m2 §3）。

    防极端值；与 features 输出维度无关，仅平滑分布。
    """

    if wide.empty or sigma <= 0:
        return wide
    out = wide.copy()
    grouped = out.groupby(level="trade_date", sort=False)
    for col in out.columns:
        mu = grouped[col].transform("mean")
        sd = grouped[col].transform(lambda s: s.std(ddof=0))
        lo = mu - sigma * sd
        hi = mu + sigma * sd
        out[col] = out[col].clip(lower=lo, upper=hi)
    return out


def neutralize_by_industry_and_market_cap(
    wide: pd.DataFrame,
    industry_map: pd.DataFrame,
    mv_map: pd.DataFrame,
) -> pd.DataFrame:
    """市值 + 行业双重中性化（spec m2 §3 + doc/07）。

    实现策略（截面线性回归残差化的简化版）：
      step1: 行业内 z-score（取出行业平均）
      step2: 对 log(mv) 同样取截面 z-score 后，从每个因子里减去 (β × mv_z)

    mv_map: 列 [trade_date, ts_code, mv]（raw.daily_basic.mv 流通市值）。
    mv 缺失行：仅做行业中性化（不强行 drop）。
    """

    if wide.empty:
        return wide

    # 1) 行业中性化
    out = neutralize_by_industry(wide, industry_map)

    if mv_map is None or mv_map.empty:
        logger.warning("mv_map_empty_skip_mv_neutralization")
        return out

    mv = mv_map[["trade_date", "ts_code", "mv"]].drop_duplicates(
        subset=["trade_date", "ts_code"], keep="last"
    ).copy()
    mv["mv"] = pd.to_numeric(mv["mv"], errors="coerce")
    # log(mv) 更接近正态
    mv["mv_log"] = np.log(mv["mv"].where(mv["mv"] > 0, np.nan))

    df = out.reset_index().merge(
        mv[["trade_date", "ts_code", "mv_log"]],
        on=["trade_date", "ts_code"],
        how="left",
    )
    factor_cols = [c for c in df.columns if c not in ("trade_date", "ts_code", "mv_log")]

    # 截面 z-score(mv_log)
    grp = df.groupby("trade_date", sort=False)["mv_log"]
    mu = grp.transform("mean")
    sd = grp.transform(lambda s: s.std(ddof=0))
    mv_z = (df["mv_log"] - mu) / sd.where(sd.fillna(0.0) >= _STD_EPS, other=1.0)
    mv_z = mv_z.where(sd.fillna(0.0) >= _STD_EPS, other=0.0)
    mv_z = mv_z.fillna(0.0)

    # 每个因子按截面对 mv_z 做最小二乘残差化：f_neu = f - β * mv_z
    # β = cov(f, mv_z) / var(mv_z)；按 trade_date 分组
    df["__mv_z"] = mv_z
    for col in factor_cols:
        def _resid(g: pd.DataFrame, c: str = col) -> pd.Series:
            f = g[c].astype(float)
            z = g["__mv_z"].astype(float)
            var_z = float(np.var(z, ddof=0))
            if var_z < _STD_EPS:
                return f
            beta = float(np.cov(f, z, ddof=0)[0, 1] / var_z)
            return f - beta * z

        df[col] = (
            df.groupby("trade_date", sort=False, group_keys=False)
            .apply(lambda g, c=col: _resid(g, c))
            .reset_index(level=0, drop=True)
        )
    df = df.drop(columns=["mv_log", "__mv_z"]).set_index(["trade_date", "ts_code"]).sort_index()
    return df


def merge_with_labels(
    wide: pd.DataFrame,
    labels: pd.DataFrame,
    label_scheme: str,
) -> pd.DataFrame:
    """与 factors.labels 按 (trade_date, ts_code) 内连接。

    labels 列：[trade_date, ts_code, scheme, value, ...]
    返回 wide 索引 + 多一列 'label'。
    """

    if wide.empty:
        return pd.DataFrame()
    if labels is None or labels.empty:
        return pd.DataFrame()
    lab = labels.loc[labels["scheme"] == label_scheme, ["trade_date", "ts_code", "value"]]
    lab = lab.rename(columns={"value": "label"})
    df = wide.reset_index().merge(lab, on=["trade_date", "ts_code"], how="inner")
    if df.empty:
        return pd.DataFrame()
    return df.set_index(["trade_date", "ts_code"]).sort_index()


def build_feature_matrix_from_frames(
    *,
    daily_factors: pd.DataFrame,
    labels: pd.DataFrame,
    industry_map: pd.DataFrame | None,
    factor_version: str,
    label_scheme: str,
    mv_map: pd.DataFrame | None = None,
    neutralize_cols: tuple[str, ...] = DEFAULT_NEUTRALIZE_COLS,
    robust_z: bool = DEFAULT_ROBUST_Z,
    label_winsorize: tuple[float, float] = (LABEL_WINSORIZE_LO, LABEL_WINSORIZE_HI),
    factor_clip_sigma: float = FACTOR_CLIP_SIGMA,
) -> FeatureMatrixBundle:
    """纯计算入口（无 DB）。

    流程（spec m2 §交付物 3）：
      1. pivot 长 → 宽
      2. 行业中位数填充缺失；仍缺失的行将被丢弃
      3. 因子值 ±3σ 截尾
      4. 中性化：industry + (可选) mv 双重
      5. 截面 z-score（robust_z=True 时启用）
      6. 与 labels 内连接；label value 在 ±50% winsorize
      7. 仍含 NaN 的行 drop
    """

    feature_set_id = build_feature_set_id(
        factor_version,
        label_scheme,
        neutralize_cols=neutralize_cols,
        robust_z=robust_z,
    )

    wide = pivot_factors_long_to_wide(daily_factors)
    if wide.empty:
        return FeatureMatrixBundle(
            feature_set_id=feature_set_id,
            factor_ids=[],
            matrix=pd.DataFrame(),
        )

    # ① 行业中位数填充（spec 要求）
    industry_df = industry_map if industry_map is not None else pd.DataFrame()
    wide_filled = impute_missing_with_industry_median(wide, industry_df)

    # ② 因子层 ±3σ 截尾（截面 winsorize）
    wide_clipped = winsorize_factors(wide_filled, sigma=factor_clip_sigma)

    # ③ 中性化：industry-only 或 industry + mv
    if "mv" in neutralize_cols and mv_map is not None and not mv_map.empty:
        neutralized = neutralize_by_industry_and_market_cap(
            wide_clipped, industry_df, mv_map
        )
    else:
        neutralized = neutralize_by_industry(wide_clipped, industry_df)

    # ④ 截面 z-score（如启用 robust_z）
    if robust_z:
        standardized = standardize_cross_sectional(neutralized)
    else:
        standardized = neutralized

    # ⑤ 与 labels 内连接
    merged = merge_with_labels(standardized, labels, label_scheme=label_scheme)
    if merged.empty:
        return FeatureMatrixBundle(
            feature_set_id=feature_set_id,
            factor_ids=list(wide.columns),
            matrix=pd.DataFrame(),
        )

    # ⑥ label 温和截尾 ±50%（spec 5 个坑之 5；features 层处理）
    lo, hi = label_winsorize
    merged["label"] = winsorize_label_value(merged["label"], lo=lo, hi=hi)

    # ⑦ 行级 drop（任一列仍为 NaN → 丢）
    final = merged.dropna(how="any")
    if len(final) < len(merged):
        logger.warning(
            "feature_matrix_dropna",
            extra={"raw": len(merged), "kept": len(final)},
        )

    factor_ids = list(wide.columns)
    return FeatureMatrixBundle(
        feature_set_id=feature_set_id,
        factor_ids=factor_ids,
        matrix=final.reset_index(),
    )


__all__ = [
    "FeatureMatrixBundle",
    "FACTOR_CLIP_SIGMA",
    "DEFAULT_NEUTRALIZE_COLS",
    "DEFAULT_ROBUST_Z",
    "build_feature_set_id",
    "pivot_factors_long_to_wide",
    "neutralize_by_industry",
    "neutralize_by_industry_and_market_cap",
    "standardize_cross_sectional",
    "impute_missing_with_cs_median",
    "impute_missing_with_industry_median",
    "winsorize_factors",
    "merge_with_labels",
    "build_feature_matrix_from_frames",
]
