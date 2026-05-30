"""三分类方向标签（LSTM T1，spec 01-data-and-labels.md §1-2）。

LSTM 预测**次日（t+1）方向**，三类 {跌=0, 横盘=1, 涨=2}。
次日收益（与 fwd 标签同口径，后复权）：

    r = close_adj(t+1) / close_adj(t) − 1      # 单交易日前向收益

两种「横盘」划法，由 scheme 字符串切换（必须是两个独立 scheme，
见 spec 01 §feature_set_id 决定性）：

  方案 A  dir3_band（固定阈值带）：
    r > +ε   → 涨(2)　|r| ≤ ε → 横盘(1)　r < −ε → 跌(0)　ε = DIR3_BAND_EPS
  方案 B  dir3_tercile（截面三分位）：
    每个 trade_date 截面内按 r 稳定排序，前 1/3 → 涨(2) 中 1/3 → 横盘(1) 后 1/3 → 跌(0)

落地（spec 01 §2）：复用 factors.labels，value 存类别 id（0.0/1.0/2.0），
exit_reason=NULL，hold_days=1（次日方向，持有 1 日语义）。

实现复用 fallback.py 的 FallbackInputs（后复权报价 + 停牌/退市/新股过滤上下文），
后复权口径单一真理源（_common.apply_hfq 由 runner 注入 close_adj），
仅"r → 类别"逻辑不同。每票末 1 行（无 t+1）被 shift 丢弃属正常。
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Final

import numpy as np
import pandas as pd

from quant_pipeline.labels._common import dedup_labels, empty_labels_frame
from quant_pipeline.labels.dir3_scheme import (
    LEGACY_EPS,
    is_dir3_band_scheme,
    parse_dir3_band_eps,
)
from quant_pipeline.labels.fallback import FallbackInputs
from quant_pipeline.labels.strategy_aware import (
    NEW_LISTING_MIN_DAYS,
    _validate_min_days,
    filter_new_listing,
)

logger = logging.getLogger(__name__)

SCHEME_DIR3_BAND: Final[str] = "dir3_band"
SCHEME_DIR3_TERCILE: Final[str] = "dir3_tercile"
# legacy 默认 ε（scheme=='dir3_band' 时的横盘阈值）；其它 ε 经 dir3_scheme 编解码
# 进 label_scheme 串（如 'dir3_band_eps0080'），决定性 feature_set_id 哈希自然成立。
DIR3_BAND_EPS: Final[float] = LEGACY_EPS
# 次日方向：持有 1 日语义。
DIR3_HOLD_DAYS: Final[int] = 1

# 类别 id（写入 value 列，浮点）
_CLS_DOWN: Final[float] = 0.0   # 跌
_CLS_FLAT: Final[float] = 1.0   # 横盘
_CLS_UP: Final[float] = 2.0     # 涨


def _bucket_band(r: pd.Series, eps: float) -> pd.Series:
    """固定阈值带分桶。r 为已过滤的次日收益 Series（无 NaN）。

    r > +ε → 涨(2)，|r| ≤ ε → 横盘(1)，r < −ε → 跌(0)。
    边界 r == ±ε 落入横盘（|r| ≤ ε 闭区间）。
    """

    value = pd.Series(_CLS_FLAT, index=r.index, dtype=float)
    value[r > eps] = _CLS_UP
    value[r < -eps] = _CLS_DOWN
    return value


def _bucket_tercile(r: pd.Series, trade_date: pd.Series) -> pd.Series:
    """截面三分位分桶。对每个 trade_date 截面内按 r 稳定排序，
    前 1/3 → 涨(2) 中 1/3 → 横盘(1) 后 1/3 → 跌(0)。

    用稳定排序（kind="stable"）保证并列值切分确定；类近似均衡。
    截面内仅 1~2 行时按相同三分位边界落桶（不强行凑满三类）。
    """

    value = pd.Series(_CLS_FLAT, index=r.index, dtype=float)
    for _, idx in r.groupby(trade_date, sort=False).groups.items():
        sub = r.loc[idx]
        n = len(sub)
        # 稳定排序得到组内升序名次（0..n-1）；并列按原序（trade_date 内 ts_code 序）。
        order = sub.sort_values(kind="stable")
        rank = pd.Series(np.arange(n), index=order.index)
        # 三分位边界：[0, lo) 跌，[lo, hi) 横盘，[hi, n) 涨
        lo = n // 3
        hi = n - n // 3
        cls = pd.Series(_CLS_FLAT, index=order.index, dtype=float)
        cls[rank < lo] = _CLS_DOWN
        cls[rank >= hi] = _CLS_UP
        value.loc[cls.index] = cls
    return value


def compute_dir3_labels(inputs: FallbackInputs, scheme: str) -> pd.DataFrame:
    """从后复权 daily_quote 算次日收益 r，按 scheme 分桶成类别。

    返回列 [trade_date, ts_code, scheme, value, exit_reason, hold_days]，
    与 _upsert_labels 期望一致（exit_reason=None，hold_days=1）。
    每票末 1 行（无 t+1）被 shift 丢弃属正常。

    复用 FallbackInputs 与 apply_hfq 注入的 close_adj（后复权口径单一真理源），
    仅"r → 类别"逻辑与 fwd_5d_ret 不同。
    """

    # dir3_band 家族（legacy 'dir3_band' 或 'dir3_band_epsNNNN' 变体）由编解码器
    # 单一判定；tercile 固定串。其它（含畸形 epsXXXX）→ 未知 scheme 报错。
    is_band = is_dir3_band_scheme(scheme)
    if not is_band and scheme != SCHEME_DIR3_TERCILE:
        raise ValueError(
            f"compute_dir3_labels: unsupported scheme={scheme!r} "
            f"(supported: dir3_band family or {SCHEME_DIR3_TERCILE!r})"
        )

    quotes = inputs.daily_quotes
    if quotes is None or quotes.empty:
        # runner 已在调用前对空 quotes raise；此分支仅作直接调用兜底。
        logger.warning("dir3_labels_empty_quotes", extra={"scheme": scheme})
        return empty_labels_frame()

    required = {"ts_code", "trade_date", "close_adj"}
    if not required.issubset(quotes.columns):
        raise ValueError(
            f"daily_quotes 必须含列 {required}, got {list(quotes.columns)}"
        )

    quotes = quotes.copy()
    quotes["ts_code"] = quotes["ts_code"].astype(str)
    quotes["trade_date"] = quotes["trade_date"].astype(str)
    quotes["close_adj"] = pd.to_numeric(quotes["close_adj"], errors="coerce")

    suspended_set: set[tuple[str, str]] = inputs.suspended_set or set()
    delist_map: Mapping[str, str] = inputs.delist_map or {}

    # trade_date 为 YYYYMMDD 定宽字符串，字典序即时序，可直接字符串排序。
    quotes = quotes.sort_values(["ts_code", "trade_date"]).reset_index(drop=True)
    g = quotes.groupby("ts_code", sort=False)
    # 组内 shift(-1)：取该票次日 close_adj 与 trade_date，不跨票。
    c_t = quotes["close_adj"]
    c_t1 = g["close_adj"].shift(-1)
    t_plus_date = g["trade_date"].shift(-1)

    r = c_t1 / c_t - 1.0

    keep = (
        t_plus_date.notna()          # 每票末 1 行 shift 丢弃
        & c_t.notna() & (c_t > 0)
        & c_t1.notna()
    )

    ts = quotes["ts_code"]
    t = quotes["trade_date"]
    # 停牌掩码：t 或 t+1 任一停牌 → 跳过。
    if suspended_set:
        susp_t = pd.Series(list(zip(ts, t, strict=False)), index=quotes.index).isin(suspended_set)
        susp_t1 = pd.Series(
            list(zip(ts, t_plus_date.fillna(""), strict=False)), index=quotes.index
        ).isin(suspended_set)
        keep = keep & ~susp_t & ~susp_t1
    # 退市掩码：t+1 >= delist_date → 跳过。
    if delist_map:
        delist_for_ts = ts.map(delist_map)
        crossed = delist_for_ts.notna() & (
            t_plus_date.fillna("") >= delist_for_ts.fillna("")
        )
        keep = keep & ~crossed

    keep_np = keep.to_numpy(dtype=bool)
    if not keep_np.any():
        logger.warning("dir3_labels_no_outcomes", extra={"scheme": scheme})
        return empty_labels_frame()

    # 过滤到有 t+1 结果的样本后再分桶（tercile 截面统计也只在留存样本上算）。
    kept = quotes.loc[keep_np, ["ts_code", "trade_date"]].copy()
    kept["r"] = r[keep_np].astype(float).to_numpy()

    if is_band:
        # ε 来源从常量变为解析自 scheme 串（'dir3_band'→0.005，epsNNNN→N/10000）。
        eps = parse_dir3_band_eps(scheme)
        assert eps is not None  # is_band 已保证，仅为类型收窄
        value = _bucket_band(kept["r"], eps)
    else:
        value = _bucket_tercile(kept["r"], kept["trade_date"])

    out = pd.DataFrame(
        {
            "trade_date": kept["trade_date"].astype(str).to_numpy(),
            "ts_code": kept["ts_code"].astype(str).to_numpy(),
            "scheme": scheme,
            "value": value.astype(float).to_numpy(),
            "exit_reason": None,
            "hold_days": DIR3_HOLD_DAYS,
        }
    )

    # 新股过滤（D-1 缺口补齐）：仅当显式传入 listing 时启用，向后兼容。
    # 锚列用 trade_date（次日方向，T 日即信号/起算日，与 fwd_5d_ret 一致）。
    if inputs.listing is not None:
        min_days = (
            inputs.new_listing_min_days
            if inputs.new_listing_min_days is not None
            else NEW_LISTING_MIN_DAYS
        )
        _validate_min_days(min_days)
        if min_days > 0:
            listing_df = inputs.listing
            if not listing_df.empty:
                list_date_map = dict(
                    zip(
                        listing_df["ts_code"].astype(str),
                        listing_df["list_date"].astype(str),
                        strict=False,
                    )
                )
                trade_dates_sorted = sorted(
                    quotes["trade_date"].astype(str).unique().tolist()
                )
                out = filter_new_listing(
                    out,
                    list_date_map=list_date_map,
                    trade_dates_sorted=trade_dates_sorted,
                    min_days=min_days,
                    entry_col="trade_date",
                )
                if out.empty:
                    logger.warning(
                        "dir3_labels_all_filtered_new_listing",
                        extra={"scheme": scheme},
                    )
                    return empty_labels_frame()

    out = dedup_labels(out, log_key="dir3_labels_dedup")
    return out[["trade_date", "ts_code", "scheme", "value", "exit_reason", "hold_days"]]


__all__ = [
    "SCHEME_DIR3_BAND",
    "SCHEME_DIR3_TERCILE",
    "DIR3_BAND_EPS",
    "DIR3_HOLD_DAYS",
    "compute_dir3_labels",
]
