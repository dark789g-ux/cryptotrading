"""入场特征计算库（纯函数）。

在 signal_date 截面计算附加入场特征，用于生成「更严的入场变体」。
本模块不查 DB——所有数据由调用方（T5/T6）以 pandas 对象喂入。

口径假设（调用方负责满足）：
- dev_ma：close 与 ma 必须是**同一复权口径**的价格序列（如均为 qfq）。
  指标表 ma* / atr_14 若为原始价计算，则混用时会引入系统性偏差，调用方须
  在喂数据前核实口径一致性。
- vol_contract：vol_series 按时间升序，索引含义为可交易日序列（停牌日已剔除）。
- rs_vs_index：两条 close 序列按交易日对齐，调用方保证同日。
"""

from __future__ import annotations

from typing import Literal, Optional

import numpy as np
import pandas as pd

# THS 指数日线仅 2024-01-02 起（8 位字符串比较）
_THS_MIN_DATE = "20240102"

# RS 基准代码映射
_RS_BENCHMARK_CODE: dict[str, str] = {
    "hs300": "883300.TI",
    "zz500": "883304.TI",
}

OpLiteral = Literal["lt", "lte", "gt", "gte", "eq", "neq"]


# ---------------------------------------------------------------------------
# dev_ma
# ---------------------------------------------------------------------------


def dev_ma(close: float | pd.Series, ma: float | pd.Series) -> float | pd.Series:
    """超跌幅度：close / ma - 1。

    Args:
        close: 个股收盘价（标量或 Series）。
        ma:    对应均线值（标量或 Series），形状须与 close 一致。

    Returns:
        偏离率（负值表示破均线向下偏离）。

    口径假设：
        close 与 ma 必须是**同一复权口径**（如均为 qfq_close / qfq_maN）。
        本函数不验证口径一致性，由调用方负责。
    """
    return close / ma - 1


# ---------------------------------------------------------------------------
# down_streak
# ---------------------------------------------------------------------------


def down_streak(pct_chg_series: pd.Series) -> int:
    """截至最后一日连续涨跌幅 < 0 的天数。

    Args:
        pct_chg_series: 按时间**升序**排列的单股 pct_chg 序列（如 qfq_pct_chg）。
                        可含 NaN；NaN 视为中断连阴（保守处理）。

    Returns:
        连续负收益天数（int，0 表示最后一日非负或序列为空）。
    """
    if len(pct_chg_series) == 0:
        return 0

    count = 0
    # 从最后一日往前倒数
    for val in reversed(pct_chg_series.values):
        if pd.isna(val) or val >= 0:
            break
        count += 1
    return count


# ---------------------------------------------------------------------------
# vol_contract
# ---------------------------------------------------------------------------


def vol_contract(vol_series: pd.Series) -> float:
    """缩量比：最后一日成交量 / 过去 5 个可交易日均量。

    窗口定义：
        - 分子：vol_series 最后一个元素（信号日当日量）。
        - 分母：信号日**之前** 5 个可交易日的均量（不含当日）。
        - 序列按时间升序，停牌日（无行情）由调用方在喂数据前剔除。

    Args:
        vol_series: 按时间升序排列的成交量 Series（可交易日序列，已去停牌）。
                    长度须 >= 6（1 当日 + 5 历史），否则返回 NaN。

    Returns:
        缩量比（float）；历史数据不足时返回 float('nan')。

    示例：
        vol < 1.0 → 缩量；vol >= 1.0 → 放量。
        阈值参考 spec 02：< 0.7（明显缩量）/ < 0.5（极度缩量）。
    """
    if len(vol_series) < 6:
        return float("nan")

    current = float(vol_series.iloc[-1])
    prior_5 = vol_series.iloc[-6:-1]  # 倒数第 6 至第 2 位（共 5 个，不含当日）
    denom = float(prior_5.mean())
    if denom == 0:
        return float("nan")
    return current / denom


# ---------------------------------------------------------------------------
# vol_regime_percentile
# ---------------------------------------------------------------------------


def vol_regime_percentile(df: pd.DataFrame) -> pd.Series:
    """横截面波动区制分位：atr_14 / qfq_close 在全市场的当日分位（0~1）。

    Args:
        df: 当日全市场 DataFrame，须含列：
            - ts_code  (str)   : 标的代码（作为索引依据）
            - atr_14   (float) : 14 日 ATR
            - qfq_close (float): 前复权收盘价

            index 保持调用方原样，输出 Series 与输入 df.index 对齐。

    Returns:
        每只个股 atr_14/qfq_close 的横截面分位 Series（(0, 1]，最大值=1.0），
        NaN 行（atr_14 或 qfq_close 缺失 / qfq_close=0）保留为 NaN。

    口径假设：
        atr_14 须与 qfq_close 同复权口径，否则分位值系统性偏移，由调用方保证。
    """
    ratio = df["atr_14"] / df["qfq_close"].replace(0, float("nan"))
    # pandas rank(pct=True) 跳过 NaN，返回 (0, 1] 区间（最大值=1.0）；spec 仅要求 0~1 分位，不做端点映射
    # 用 method='average' 处理并列；NaN 保持 NaN
    return ratio.rank(pct=True, method="average", na_option="keep")


# ---------------------------------------------------------------------------
# rs_vs_index
# ---------------------------------------------------------------------------


def rs_vs_index(
    stock_close: pd.Series,
    index_close: pd.Series,
    lookback: int,
    signal_date: Optional[str] = None,
) -> float:
    """个股相对强弱：个股 lookback 日收益 − 基准同期收益。

    定义：
        ret_stock = stock_close[-1] / stock_close[-lookback-1] - 1
        ret_index = index_close[-1] / index_close[-lookback-1] - 1
        rs = ret_stock - ret_index

    Args:
        stock_close:  个股 qfq_close，按交易日升序，长度须 >= lookback+1。
        index_close:  基准指数 close（无需复权），与 stock_close 按交易日对齐，
                      同样按升序排列，长度须 >= lookback+1。
                      调用方保证两序列最后一日为同一交易日。
        lookback:     回看可交易日数（正整数），对应 SweepConfig.rs_lookback。
        signal_date:  信号触发日（8 位 YYYYMMDD 字符串，可选）。
                      若提供且 < '20240102'，因 THS 指数仅 2024-01-02 起，
                      直接返回 float('nan') 并表示 RS 不可用（硬约束）。

    Returns:
        相对强弱值（float）；数据不足或 signal_date < 2024-01-02 时返回 NaN。

    口径假设：
        stock_close 与 index_close 须已按相同交易日对齐（调用方保证）。
        个股用 qfq_close，指数用 ths_index_daily_quotes.close（无需复权）。
    """
    # THS 数据时间硬约束
    if signal_date is not None and signal_date < _THS_MIN_DATE:
        return float("nan")

    if len(stock_close) < lookback + 1 or len(index_close) < lookback + 1:
        return float("nan")

    s_now = float(stock_close.iloc[-1])
    s_prev = float(stock_close.iloc[-lookback - 1])
    i_now = float(index_close.iloc[-1])
    i_prev = float(index_close.iloc[-lookback - 1])

    if s_prev == 0 or i_prev == 0:
        return float("nan")

    ret_stock = s_now / s_prev - 1
    ret_index = i_now / i_prev - 1
    return ret_stock - ret_index


# ---------------------------------------------------------------------------
# pick_industry_index
# ---------------------------------------------------------------------------


def pick_industry_index(member_df: pd.DataFrame, ts_code: str) -> Optional[str]:
    """为个股选取默认行业基准指数代码。

    规则（spec 02§3.2）：
        1. 过滤 member_df 中 ts_code == 个股代码 的行。
        2. 仅保留 type == 'I'（行业指数）的成份关系。
        3. 按行业指数的**成份股数最多**者选取。
        4. 并列时按 index_code (ts_code 升序) 取第一。
        5. 映射缺失（无 type I 行业）返回 None。

    Args:
        member_df: ths_member_stocks 内容，须含列：
                   - con_code   (str) : 成份股代码（个股 ts_code）
                   - index_code (str) : 所属指数代码
                   - type       (str) : 指数类型（'I'=行业 / 'N'=概念 / ...）
        ts_code:   目标个股代码，如 '000001.SZ'。

    Returns:
        行业指数 ts_code 字符串（如 '884011.TI'），或 None（无映射）。
    """
    # 筛选该股的所有 type=I 行业指数
    mask = (member_df["con_code"] == ts_code) & (member_df["type"] == "I")
    stock_indices = member_df.loc[mask, "index_code"]
    if stock_indices.empty:
        return None

    # 统计每个行业指数的全量成份股数（不限于目标个股）
    type_i_members = member_df[member_df["type"] == "I"]
    counts = type_i_members.groupby("index_code")["con_code"].count()

    # 候选行业指数
    candidate_indices = stock_indices.unique().tolist()
    candidate_counts = counts.reindex(candidate_indices).fillna(0)

    # 取成份股数最多者；并列按 index_code 字典序升序取第一
    max_count = candidate_counts.max()
    top_candidates = sorted(
        candidate_counts[candidate_counts == max_count].index.tolist()
    )
    return top_candidates[0]


# ---------------------------------------------------------------------------
# apply_threshold（辅助掩码）
# ---------------------------------------------------------------------------


def apply_threshold(series: pd.Series, op: OpLiteral, value: float) -> pd.Series:
    """对 Series 按 op + value 生成布尔掩码，供 T6 组合 AND 变体。

    Args:
        series: 特征值 Series（如 dev_ma5_series、down_streak_series）。
        op:     比较运算符，取值 lt/lte/gt/gte/eq/neq。
        value:  阈值（float）。

    Returns:
        同 index 的布尔 Series；NaN 值位置对应 False（安全保守）。

    Raises:
        ValueError: op 不在合法取值内。
    """
    _ops = {
        "lt": lambda s: s < value,
        "lte": lambda s: s <= value,
        "gt": lambda s: s > value,
        "gte": lambda s: s >= value,
        "eq": lambda s: s == value,
        "neq": lambda s: s != value,
    }
    if op not in _ops:
        raise ValueError(f"op 须为 lt/lte/gt/gte/eq/neq，收到 '{op}'")
    result = _ops[op](series)
    # NaN 比较结果为 False（pandas 默认），无需额外处理
    return result.fillna(False)
