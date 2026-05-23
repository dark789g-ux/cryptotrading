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
from typing import Any, Final

import numpy as np
import pandas as pd
from sqlalchemy import text

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
    new_listing_min_days: int,
    neutralize_cols: tuple[str, ...] = DEFAULT_NEUTRALIZE_COLS,
    robust_z: bool = DEFAULT_ROBUST_Z,
    factor_ids: tuple[str, ...] = (),
) -> str:
    """生成 feature_set_id（确定性 SHA256 前 12 位 hash）。

    输入字段（spec 03 §哈希契约升级）：
        factor_version          所选因子版本
        label_scheme            标签方案
        new_listing_min_days    新股门槛（D-12：必填，强制 int 防 60 vs '60'）
        neutralize_cols         中性化使用的列（顺序无关）
        robust_z                是否启用 robust z-score（截尾后再 z-score）
        factor_ids              参与构建的因子 ID 列表（D-22：顺序无关，sorted 入哈希）

    同输入 → 同 id，便于未来增量。形如 `fs_<sha12>`。

    注意：本次升级（spec 03）相对旧版增加了 ``new_listing_min_days`` 与
    ``factor_ids`` 两项，**同一份历史逻辑配置会产生与旧版不同的 ID**——
    这是设计中的一次性升级，已通过 :func:`resolve_feature_set_id` 的预查
    复用机制（D-16）兜底，避免对历史 feature_sets 行的语义重复写入。
    """

    payload = json.dumps(
        {
            "factor_version": factor_version,
            "label_scheme": label_scheme,
            "new_listing_min_days": int(new_listing_min_days),
            "neutralize_cols": sorted(neutralize_cols),
            "robust_z": bool(robust_z),
            "factor_ids": sorted(factor_ids),
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    sha = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]
    return f"fs_{sha}"


def resolve_feature_set_id(
    conn: Any,
    *,
    factor_version: str,
    label_scheme: str,
    new_listing_min_days: int,
    factor_ids: tuple[str, ...],
    neutralize_cols: tuple[str, ...] = DEFAULT_NEUTRALIZE_COLS,
    robust_z: bool = DEFAULT_ROBUST_Z,
) -> tuple[str, bool]:
    """预查复用 feature_set_id（D-16）。

    步骤：
      1. 用新哈希契约（含 new_listing_min_days + factor_ids）算出 ``new_id``
      2. SELECT 同逻辑元组（factor_version, scheme, new_listing_min_days,
         factors._factor_ids_hash(factor_ids)）是否已有行
         - 命中 → 返回 (老 ID, True)（避免哈希契约升级导致语义重复写入）
         - 未命中 → 返回 (new_id, False)，由调用方负责后续 upsert

    与 DB 唯一索引 ``feature_sets_logical_key_uidx`` 的契约：
      索引表达式按 IMMUTABLE wrapper ``factors._factor_ids_hash(factor_ids)``
      折成定长哈希（内部仍是 md5(array_to_string(...,','))），见 20260523_0001
      migration。索引内**不**含 ORDER BY，依赖**写入侧 factor_ids 已排序**。
      故调用本函数前，``factor_ids`` 必须由调用方（runner._load_factor_ids
      之后）``tuple(sorted(...))`` 排序，三处（写入侧 / builder 哈希侧 /
      预查 SQL 侧）才能一致命中。
    """

    new_id = build_feature_set_id(
        factor_version,
        label_scheme,
        new_listing_min_days=new_listing_min_days,
        neutralize_cols=neutralize_cols,
        robust_z=robust_z,
        factor_ids=factor_ids,
    )

    # 与 DB 唯一索引表达式 factors._factor_ids_hash(factor_ids) 对齐：
    # 该函数内部是 md5(array_to_string(factor_ids, ','))，所以本侧也用 ',' 拼接
    # + md5（依赖写入侧已排序，本侧 sorted 仅为防御）。
    fmd5 = hashlib.md5(",".join(sorted(factor_ids)).encode("utf-8")).hexdigest()

    sql = text(
        """
        SELECT feature_set_id
          FROM factors.feature_sets
         WHERE factor_version = :fv
           AND scheme         = :sc
           AND new_listing_min_days = :nd
           AND md5(array_to_string(factor_ids, ',')) = :fmd5
         LIMIT 1
        """
    )
    row = conn.execute(
        sql,
        {
            "fv": factor_version,
            "sc": label_scheme,
            "nd": int(new_listing_min_days),
            "fmd5": fmd5,
        },
    ).fetchone()

    if row is not None:
        existing_id = row[0]
        if existing_id != new_id:
            logger.info(
                "feature_set_id_reused",
                extra={
                    "existing_id": existing_id,
                    "would_be_new_id": new_id,
                    "factor_version": factor_version,
                    "scheme": label_scheme,
                    "new_listing_min_days": int(new_listing_min_days),
                },
            )
        return existing_id, True
    return new_id, False


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


def _grouped_zscore(
    df: pd.DataFrame,
    group_keys: list[str] | str,
    cols: list[str],
) -> pd.DataFrame:
    """对 `cols` 按 `group_keys` 分组做 z-score（单一实现，供各中性化函数复用）。

    实现细节（统一处所，避免散落副本各自实现导致 bug，见 review §10）：
      - `transform("mean")` 取组均值，`transform` + `std(ddof=0)` 取组标准差；
      - sd 缺失 / 过小（< _STD_EPS）的组：z 置 0，避免除 0；
      - **整组恒为常数 / 全 NaN 的列会落入此分支被置 0**——调用方需在外层检测并告警
        （见 review §3：整列算不出来不能静默以全 0 进训练矩阵）。

    入参 `df` 会被原地修改并返回（cols 列被替换为 z-score 值）。
    """

    grouped = df.groupby(group_keys, sort=False)
    for col in cols:
        mu = grouped[col].transform("mean")
        sd = grouped[col].transform(lambda s: s.std(ddof=0))
        # 当 sd 缺失 / 过小：z 置 0，避免除 0
        valid = sd.fillna(0.0) >= _STD_EPS
        safe = sd.where(valid, other=1.0)
        z = (df[col] - mu) / safe
        df[col] = z.where(valid, other=0.0)
    return df


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

    df = _grouped_zscore(df, ["trade_date", "industry_l1"], factor_cols)

    df = df.drop(columns=["industry_l1"]).set_index(["trade_date", "ts_code"]).sort_index()
    return df


def _standardize_cross_sectional(wide: pd.DataFrame) -> pd.DataFrame:
    """每个 trade_date 截面做全市场 z-score。"""

    if wide.empty:
        return wide
    out = wide.reset_index()
    factor_cols = [c for c in out.columns if c not in ("trade_date", "ts_code")]
    out = _grouped_zscore(out, "trade_date", factor_cols)
    return out.set_index(["trade_date", "ts_code"]).sort_index()


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

    实现策略（截面线性回归残差化的**简化近似**）：
      step1: 行业内 z-score（取出行业平均）
      step2: 对 log(mv) 取**全市场截面** z-score 后，从每个因子里减去 (β × mv_z)，
             β 为该因子对 mv_z 的全市场截面单变量回归系数。

    ⚠ 近似偏差说明（review §2）：step2 的 β 是**全市场截面**单变量回归，而非
    行业哑变量 + log(mv) 的多元 OLS。若某行业整体偏小盘，行业中性化后再叠加
    全市场 mv 残差化，会把「行业=小盘」的信息重新部分混入，得到的不是严格
    「行业内 + 市值内」的干净残差。这是**已知并接受的近似**：MVP 阶段 GBDT
    对该量级偏差不敏感；如需严格残差化，应改为按 (trade_date) 截面做
    「行业哑变量 + mv_log」多元 OLS 并取残差（见 doc/07 §7.3）。本实现不构成
    前视偏差，仅是中性化口径的近似。

    mv_map: 列 [trade_date, ts_code, mv]（raw.daily_basic.total_mv 总市值）。
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
    valid_z = sd.fillna(0.0) >= _STD_EPS
    mv_z = (df["mv_log"] - mu) / sd.where(valid_z, other=1.0)
    mv_z = mv_z.where(valid_z, other=0.0)
    mv_z = mv_z.fillna(0.0)
    df["__mv_z"] = mv_z

    # var(mv_z) 按 trade_date：用 transform 而非 groupby.apply。
    # transform 永远返回与 df 对齐、同长度的 Series，与 pandas 版本无关；
    # groupby.apply 在 pandas ≥2.2 对返回 Series 的处理已变更（review §1）。
    grp = df.groupby("trade_date", sort=False)
    vz_broadcast = grp["__mv_z"].transform(lambda s: float(np.var(s.values, ddof=0)))
    vz_valid = vz_broadcast >= _STD_EPS
    ez = grp["__mv_z"].transform("mean")

    # 每个因子按截面对 mv_z 做最小二乘残差化：f_neu = f - β * mv_z
    # β = cov(f, mv_z) / var(mv_z)；按 trade_date 分组
    for col in factor_cols:
        # cov(f,z) = E[f*z] - E[f]*E[z]
        ef = grp[col].transform("mean")
        fz = df[col].astype(float) * df["__mv_z"].astype(float)
        efz = fz.groupby(df["trade_date"], sort=False).transform("mean")
        cov_fz = efz - ef * ez

        beta = cov_fz / vz_broadcast.where(vz_valid, other=1.0)
        beta = beta.where(vz_valid, other=0.0)
        df[col] = df[col].astype(float) - beta * df["__mv_z"].astype(float)

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
    new_listing_min_days: int,
    mv_map: pd.DataFrame | None = None,
    factor_ids: tuple[str, ...] = (),
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
        new_listing_min_days=new_listing_min_days,
        neutralize_cols=neutralize_cols,
        robust_z=robust_z,
        factor_ids=factor_ids,
    )

    wide = pivot_factors_long_to_wide(daily_factors)
    if wide.empty:
        return FeatureMatrixBundle(
            feature_set_id=feature_set_id,
            factor_ids=[],
            matrix=pd.DataFrame(),
        )

    # ⓪ 死因子检测（review §3）：某因子原始值整列全 NaN，会在 z-score 阶段被
    #   静默置 0，以「全 0 常数列」进训练矩阵且不触发 ⑦ 的 dropna，无人察觉。
    #   此处显式告警并剔除该因子列——空数据不得静默跳过（CLAUDE.md 硬约束）。
    dead_factors = [c for c in wide.columns if wide[c].isna().all()]
    if dead_factors:
        logger.warning(
            "feature_matrix_dead_factors_dropped",
            extra={"dead_factors": dead_factors, "n": len(dead_factors)},
        )
        wide = wide.drop(columns=dead_factors)
        if wide.empty or wide.shape[1] == 0:
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

    # ④.5 死因子复检（review §3）：中性化 / z-score 后某因子若整列恒为 0
    #     （例如截面方差始终为 0、被 _grouped_zscore 全部置 0），等同常数列，
    #     对模型无信息且会污染特征重要性——显式告警（不剔除，保留列对齐，
    #     由下游模型层 / 健康度报告决定是否使用）。
    if not standardized.empty:
        const_zero = [
            c for c in standardized.columns
            if (standardized[c].fillna(0.0) == 0.0).all()
        ]
        if const_zero:
            logger.warning(
                "feature_matrix_constant_zero_factors",
                extra={"factors": const_zero, "n": len(const_zero)},
            )

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
    "resolve_feature_set_id",
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
