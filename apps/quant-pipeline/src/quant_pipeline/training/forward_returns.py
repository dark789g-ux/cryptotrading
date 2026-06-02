"""真实次日后复权收益加载（A1：LSTM oos_metrics IC/RankIC 用真实收益）。

给定验证样本的 (ts_code, trade_date) 列表，回表算每个样本的真实次日后复权收益：

    r = close_adj(t+1) / close_adj(t) − 1

口径权威定义在 labels/direction_3class.compute_dir3_labels（次日方向标签同源），
本模块仅为 LSTM walk-forward 的 oos 排序兼容指标（ic / rank_ic）回表取真实收益，
**不进训练、不改 labels / feature_matrix schema、不动决定性 feature_set_id 哈希**。

只读复用 labels/_common.apply_hfq 注入 close_adj（唯一后复权真理源，不改 _common）。
"""

from __future__ import annotations

import logging

import pandas as pd
from sqlalchemy import text
from sqlalchemy.orm import Session

from quant_pipeline.db.engine import session_scope
from quant_pipeline.labels._common import apply_hfq

logger = logging.getLogger(__name__)

# 取 t+1 收益需把日期上界向后延若干交易日（覆盖跨周末 / 节假日的下一个交易日）。
# trade_date 为 Tushare YYYYMMDD 定宽字符串，字典序即时序，可直接字符串比较。
_FORWARD_PAD_TRADE_DAYS: int = 10


def _query_daily_quotes(
    ts_codes: list[str], start: str, end_padded: str, *, session: Session
) -> pd.DataFrame:
    """查 raw.daily_quote LEFT JOIN raw.adj_factor，注入后复权 close_adj。

    返回列 [ts_code, trade_date, close, adj_factor, close_adj, ...]。
    DB 0 行 → 返回空 DataFrame（由调用方双路径 warn）。
    """

    sql = text(
        """
        SELECT q.ts_code, q.trade_date, q.close, a.adj_factor
        FROM raw.daily_quote q
        LEFT JOIN raw.adj_factor a
               ON a.ts_code = q.ts_code AND a.trade_date = q.trade_date
        WHERE q.ts_code = ANY(:codes)
          AND q.trade_date >= :start
          AND q.trade_date <= :end
        ORDER BY q.ts_code, q.trade_date
        """
    )
    rows = session.execute(
        sql, {"codes": list(ts_codes), "start": start, "end": end_padded}
    ).fetchall()
    cols = ["ts_code", "trade_date", "close", "adj_factor"]
    if not rows:
        return pd.DataFrame(columns=cols)
    df = pd.DataFrame(rows, columns=cols)
    for c in ("close", "adj_factor"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def load_forward_returns(
    pairs: list[tuple[str, str]],
    *,
    session: Session | None = None,
) -> dict[tuple[str, str], float]:
    """返回 {(ts_code, trade_date): r}。

    r = close_adj(t+1) / close_adj(t) − 1，后复权口径同
    labels/direction_3class.compute_dir3_labels（权威定义在彼处）。

    取不到 t+1 收益的样本（停牌 / 退市 / 末日 / DB 缺数）**不出现在返回 dict** 里，
    由调用方填 NaN。双路径 warn：① DB 查询 0 行；② 部分 (ts_code, t) 无 t+1 收益。

    Args:
        pairs: [(ts_code, trade_date=YYYYMMDD), ...]，需算真实次日收益的样本。
        session: 可注入 session 便于测试；None 时走 session_scope()。
    """

    if not pairs:
        return {}

    # 规范化请求键（ts_code/trade_date 一律 str），求 ts_code 集合与日期跨度。
    requested: set[tuple[str, str]] = {(str(c), str(d)) for c, d in pairs}
    ts_codes = sorted({c for c, _ in requested})
    dates = sorted({d for _, d in requested})
    start, max_req_date = dates[0], dates[-1]

    if session is not None:
        quotes = _query_daily_quotes(
            ts_codes, start, _end_padded(max_req_date, session=session), session=session
        )
    else:
        with session_scope() as sess:
            quotes = _query_daily_quotes(
                ts_codes, start, _end_padded(max_req_date, session=sess), session=sess
            )

    # 路径①：DB 0 行（整段窗口 daily_quote 缺数）。
    if quotes.empty:
        logger.warning(
            "forward_returns_db_empty",
            extra={
                "apiName": "daily_quote_empty",
                "n_ts_codes": len(ts_codes),
                "start": start,
                "end_request": max_req_date,
                "requested": len(requested),
            },
        )
        return {}

    quotes = quotes.copy()
    quotes["ts_code"] = quotes["ts_code"].astype(str)
    quotes["trade_date"] = quotes["trade_date"].astype(str)
    # 注入后复权 close_adj（唯一真理源，只读复用 _common.apply_hfq）。
    quotes = apply_hfq(quotes)
    quotes["close_adj"] = pd.to_numeric(quotes["close_adj"], errors="coerce")

    quotes = quotes.sort_values(["ts_code", "trade_date"]).reset_index(drop=True)
    g = quotes.groupby("ts_code", sort=False)
    c_t = quotes["close_adj"]
    c_t1 = g["close_adj"].shift(-1)  # 组内次日 close_adj，不跨票

    # r 口径同 labels/direction_3class.compute_dir3_labels（权威定义在彼处）：
    # r = close_adj(t+1) / close_adj(t) − 1。
    r = c_t1 / c_t - 1.0
    keep = c_t.notna() & (c_t > 0) & c_t1.notna()

    result: dict[tuple[str, str], float] = {}
    keep_np = keep.to_numpy(dtype=bool)
    ts_arr = quotes["ts_code"].to_numpy()
    td_arr = quotes["trade_date"].to_numpy()
    r_arr = r.to_numpy()
    for i in range(len(quotes)):
        if not keep_np[i]:
            continue
        key = (ts_arr[i], td_arr[i])
        if key in requested:
            result[key] = float(r_arr[i])

    # 路径②：部分 (ts_code, t) 请求样本无 t+1 收益（停牌 / 退市 / 末日 / 缺数）。
    missing = requested - result.keys()
    if missing:
        sample = sorted(missing)[:5]
        logger.warning(
            "forward_returns_partial_missing",
            extra={
                "apiName": "forward_return_missing",
                "missing": len(missing),
                "requested": len(requested),
                "resolved": len(result),
                "sample": sample,
            },
        )

    return result


def _end_padded(max_req_date: str, *, session: Session) -> str:
    """请求最大日期向后延若干交易日，确保能取到 t+1。

    数据来源 raw.trade_cal（is_open=1），参考 labels/runner._compute_end_padded 的尾部
    缓冲思路（不改 runner，本模块自实现尾缓冲）。trade_cal 在 max_req_date 之后不足
    缓冲交易日（数据本身到期）→ 取能取到的最后一日；完全取不到则回退原日期 + warn。
    """

    sql = text(
        """
        SELECT cal_date FROM raw.trade_cal
        WHERE is_open = 1 AND cal_date > :end
        ORDER BY cal_date
        LIMIT :limit
        """
    )
    rows = session.execute(
        sql, {"end": max_req_date, "limit": _FORWARD_PAD_TRADE_DAYS}
    ).fetchall()
    dates = [str(r[0]) for r in rows]
    if not dates:
        logger.warning(
            "forward_returns_end_padded_empty",
            extra={
                "apiName": "trade_cal_empty",
                "end": max_req_date,
                "note": "trade_cal 在请求末日后无交易日 → 末日样本无 t+1（填 NaN）",
            },
        )
        return max_req_date
    return dates[-1]


__all__ = ["load_forward_returns"]
