"""bug5 回归锁：停牌股 MA 窗口依赖 —— 增量(+head 行修复) == FULL，且无修复必分歧。

背景（spec 2026-06-06 recompute / prompts/finish-recompute-production-labels.md 任务A）：
  strategy/exit_rules.py::_ensure_ma 用**行位移** close.shift(j)：MA(t)=最近 ma_window 个
  **在场行** close 之和/w。但缺口加载下界 g0_load 按**日历交易日**回看 ma_window-1 天
  （runner._compute_g0_load）。**停牌股**在该日历窗内在场行不足 → MA 取行更少/NaN →
  MABreakRule 严格 `close < ma` 翻转 → exit_reason/hold_days/value 增量与 FULL 分歧。
  修复（runner._load_daily_quotes head_rows_per_code）：每股补 g0_load 前 ma_window-1
  个在场行 → MA 真正窗口无关。

本脚本单股（002499.SZ：停牌 20230203→20230324，缺 36 天）直接对真 DB 验证三路 simulate_exit：
  - FULL        ：从 20230103 全量加载（含跨缺口在场行）→ 正确 MA 基线
  - INCR_FIX    ：增量窗口 [g0_load, end] + 每股 head 行（= 修复后 _load_daily_quotes）
  - INCR_NOFIX  ：增量窗口 [g0_load, end] 无 head 行（= 修复前，复现 bug）
断言：FULL == INCR_FIX（逐 signal 的 value/exit_reason/hold_days）；INCR_NOFIX != FULL
      （至少一个边界 signal 分歧，证明 bug 真实且修复有效）。

pytest 不收集（verify_ 前缀）；手动跑（单股，秒级）：
  cd apps/quant-pipeline; uv run python tests/integration/verify_bug5_suspended_ma.py
"""

from __future__ import annotations

import sys

import numpy as np
import pandas as pd
from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.labels._common import apply_hfq
from quant_pipeline.strategy.exit_rules import (
    MA_WINDOW,
    default_rules,
    simulate_exit,
)

TS_CODE = "002499.SZ"          # 停牌 20230203→20230324（缺 36 天）
FULL_START = "20230103"        # 全局原点
G0_LOAD = "20230223"           # 增量缺口加载下界（落在停牌区内 → 复现 bug）
END = "20230430"               # 含 max_hold 缓冲尾部
SIGNALS = ["20230327", "20230328", "20230329", "20230330"]  # 跨缺口边界的入场信号
HEAD_ROWS = MA_WINDOW - 1      # 每股补的 start 前在场行数（= 4）


def _load_stock(start: str, end: str) -> pd.DataFrame:
    """单股主窗口 [start, end]，注入后复权（与 runner._load_daily_quotes 主窗口同口径）。"""
    sql = text(
        """
        SELECT q.ts_code, q.trade_date, q.close, q.low, q.high, a.adj_factor
        FROM raw.daily_quote q
        LEFT JOIN raw.adj_factor a
               ON a.ts_code = q.ts_code AND a.trade_date = q.trade_date
        WHERE q.ts_code = :c AND q.trade_date >= :s AND q.trade_date <= :e
        ORDER BY q.trade_date
        """
    )
    with session_scope() as s:
        rows = s.execute(sql, {"c": TS_CODE, "s": start, "e": end}).fetchall()
    df = pd.DataFrame(
        rows, columns=["ts_code", "trade_date", "close", "low", "high", "adj_factor"]
    )
    for c in ("close", "low", "high", "adj_factor"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return apply_hfq(df)


def _load_head(before: str, n: int) -> pd.DataFrame:
    """单股 trade_date < before 的最近 n 个在场行（= 修复后 LATERAL head 查询单股版）。"""
    sql = text(
        """
        SELECT q.ts_code, q.trade_date, q.close, q.low, q.high, a.adj_factor
        FROM raw.daily_quote q
        LEFT JOIN raw.adj_factor a
               ON a.ts_code = q.ts_code AND a.trade_date = q.trade_date
        WHERE q.ts_code = :c AND q.trade_date < :b
        ORDER BY q.trade_date DESC
        LIMIT :n
        """
    )
    with session_scope() as s:
        rows = s.execute(sql, {"c": TS_CODE, "b": before, "n": n}).fetchall()
    df = pd.DataFrame(
        rows, columns=["ts_code", "trade_date", "close", "low", "high", "adj_factor"]
    )
    for c in ("close", "low", "high", "adj_factor"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return apply_hfq(df)


def _prices(df: pd.DataFrame) -> pd.DataFrame:
    """转 simulate_exit 价格表：close_adj→close / low_adj→low / high_adj→high。"""
    out = df.copy()
    out["close"] = out["close_adj"]
    out["low"] = out["low_adj"]
    out["high"] = out["high_adj"]
    return out.sort_values("trade_date").reset_index(drop=True)


def _next_day(frame: pd.DataFrame, signal: str) -> str | None:
    """frame 内 signal 的下一交易日（buy_date=T+1）。"""
    days = sorted(frame["trade_date"].astype(str).tolist())
    if signal not in days:
        return None
    i = days.index(signal)
    return days[i + 1] if i + 1 < len(days) else None


def _outcomes(frame: pd.DataFrame) -> dict[str, tuple]:
    """对每个 SIGNALS 跑 simulate_exit，返回 {signal: (value, exit_reason, hold_days)}。

    frame 须为该股价格表（含 close=close_adj 等）。buy_date=signal 的 T+1。
    value = exit_price / buy_close - 1（毛收益，与 strategy_aware 一致）。
    """
    rules = default_rules()
    prices = _prices(frame)
    res: dict[str, tuple] = {}
    for sig in SIGNALS:
        buy = _next_day(prices, sig)
        if buy is None:
            res[sig] = ("NO_BUY", None, None)
            continue
        oc = simulate_exit(
            buy_date=buy, ts_code=TS_CODE, prices_df=prices,
            rules=rules, ma_window=MA_WINDOW,
        )
        if oc is None:
            res[sig] = ("NO_OUTCOME", None, None)
            continue
        buy_row = prices.loc[prices["trade_date"] == buy]
        buy_close = float(buy_row.iloc[0]["close"])
        value = float(oc.exit_price) / buy_close - 1.0
        res[sig] = (round(value, 9), oc.exit_reason, int(oc.hold_days))
    return res


def _eq(a: tuple, b: tuple) -> bool:
    """逐字段比 (value, exit_reason, hold_days)；value 用 atol=1e-9。"""
    if a[1] != b[1] or a[2] != b[2]:
        return False
    va, vb = a[0], b[0]
    if isinstance(va, str) or isinstance(vb, str):
        return va == vb
    return bool(np.isclose(va, vb, rtol=0, atol=1e-9))


def main() -> int:
    full_main = _load_stock(FULL_START, END)
    incr_main = _load_stock(G0_LOAD, END)
    head = _load_head(G0_LOAD, HEAD_ROWS)

    print(f"[load] FULL rows={len(full_main)}  INCR_main rows={len(incr_main)}  "
          f"head rows={len(head)} ({sorted(head['trade_date'].tolist())})", flush=True)

    incr_fix = pd.concat([head, incr_main], ignore_index=True)
    incr_fix = incr_fix.sort_values("trade_date").reset_index(drop=True)

    full = _outcomes(full_main)
    fix = _outcomes(incr_fix)
    nofix = _outcomes(incr_main)

    print(f"\n{'signal':>10} | {'FULL':>28} | {'INCR_FIX':>28} | {'INCR_NOFIX':>28}")
    for sig in SIGNALS:
        print(f"{sig:>10} | {str(full[sig]):>28} | {str(fix[sig]):>28} | "
              f"{str(nofix[sig]):>28}")

    fix_ok = all(_eq(full[s], fix[s]) for s in SIGNALS)
    nofix_diverges = any(not _eq(full[s], nofix[s]) for s in SIGNALS)

    print()
    print(f"  {'✅' if fix_ok else '❌'} INCR_FIX == FULL（修复后逐 signal 一致）")
    print(f"  {'✅' if nofix_diverges else '❌'} INCR_NOFIX != FULL（无修复确有分歧 → bug 真实）")

    ok = fix_ok and nofix_diverges
    print("\n" + ("RESULT: ✅ PASS bug5 修复有效（增量+head==FULL，无 head 复现 bug）"
                  if ok else
                  "RESULT: ❌ FAIL 见上表"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
