"""可复用辅助模块：月度驱动、标签 dump/diff、PeakRSS 内存监控。

供 probe_recompute_diff.py 使用；纯函数部分（_month_ends_from_caldates / diff_labels）
由 test_recompute_helpers.py 单独单测。

⚠️  PeakRSS 依赖 psutil，psutil 在 dev 可选依赖
    （pyproject [project.optional-dependencies].dev）。
    导入 PeakRSS 会尝试 import psutil；若不可用则在 __enter__ 时抛出
    ImportError（含明确提示），以便控制者决定是否 uv add psutil。
    其它类/函数不依赖 psutil，可正常导入使用。
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from itertools import groupby
from typing import Any

import numpy as np
import pandas as pd
from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.labels.runner import compute_labels  # noqa: F401（re-export 供 probe 用）


# ──────────────────────────────────────────────────────────────
# 内部纯函数（可单测，不依赖 DB）
# ──────────────────────────────────────────────────────────────

def _trading_day_before_from_caldates(cal_dates: list[str], date: str, n: int) -> str:
    """升序交易日列表中，返回 ≤ date 的那天往前数第 n 个交易日（含自身，n=0 返回自身/最近≤date）。

    参数：
        cal_dates: 升序排列的 YYYYMMDD 交易日字符串列表（由调用方保证升序）。
        date:      参考日期 YYYYMMDD（可以是非交易日）。
        n:         往前数的步数；0 表示 ≤date 的最近交易日本身。
    返回：
        目标交易日字符串 YYYYMMDD。不足 n 步时返回最早可得交易日（即 cal_dates[0]）。

    纯函数，不访问 DB，可直接单测。
    """
    if not cal_dates:
        raise ValueError("cal_dates 不能为空")
    # 找所有 ≤ date 的交易日（升序）
    eligible = [d for d in cal_dates if d <= date]
    if not eligible:
        # 所有交易日都在 date 之后，返回最早一天
        return cal_dates[0]
    # eligible 末尾是 ≤date 的最近交易日，往前数 n 步
    # index 从末尾往前跳 n 步；不足则取 eligible[0]
    idx = len(eligible) - 1 - n
    if idx < 0:
        return eligible[0]
    return eligible[idx]


def _month_ends_from_caldates(cal_dates: list[str]) -> list[str]:
    """按月分组取每月最后一个交易日。

    参数：
        cal_dates: 升序排列的 YYYYMMDD 交易日字符串列表（由调用方保证升序）。
    返回：
        每个自然月中最大（最后）的交易日字符串，按月升序排列。

    纯函数，不访问 DB，可直接单测。
    """
    if not cal_dates:
        return []
    # 按 YYYYMM（前 6 位）分组；同月内字典序最大即最后交易日
    result: list[str] = []
    for _month_key, group in groupby(cal_dates, key=lambda d: d[:6]):
        days = list(group)
        result.append(max(days))  # 升序 YYYYMMDD 字典序即时序
    return result


# ──────────────────────────────────────────────────────────────
# 月度网格查询（需要 DB）
# ──────────────────────────────────────────────────────────────

def sse_month_ends(start: str, end: str) -> list[str]:
    """查 SSE 交易日历，返回 [start, end] 内每个自然月最后一个交易日的列表。

    最后一格收到 end（end 所在月的最后可用交易日，可能早于该月自然月末）。

    参数：
        start: YYYYMMDD 字符串（含）
        end:   YYYYMMDD 字符串（含）
    返回：
        每月最后一个交易日的 YYYYMMDD 列表，升序排列。
    """
    with session_scope() as s:
        rows = s.execute(
            text(
                """
                SELECT cal_date FROM raw.trade_cal
                WHERE exchange = 'SSE' AND is_open = 1
                  AND cal_date BETWEEN :s AND :e
                ORDER BY cal_date
                """
            ),
            {"s": start, "e": end},
        ).fetchall()
    cal_dates = [str(r[0]) for r in rows]
    return _month_ends_from_caldates(cal_dates)


def sse_trading_day_before(date: str, n: int) -> str:
    """查 raw.trade_cal，返回 date（含）往前第 n 个 SSE 交易日（n=0 返回自身/最近≤date）。

    不足 n 步时返回最早可得交易日。
    由 _trading_day_before_from_caldates 实现，可单独单测纯函数部分。

    参数：
        date: 参考日期 YYYYMMDD（可以是非交易日）。
        n:    往前数的步数。
    返回：
        目标交易日字符串 YYYYMMDD。
    """
    # 拉取从数据最早到 date 的全部 SSE 交易日（升序）
    with session_scope() as s:
        rows = s.execute(
            text(
                """
                SELECT cal_date FROM raw.trade_cal
                WHERE exchange = 'SSE' AND is_open = 1
                  AND cal_date <= :d
                ORDER BY cal_date
                """
            ),
            {"d": date},
        ).fetchall()
    cal_dates = [str(r[0]) for r in rows]
    return _trading_day_before_from_caldates(cal_dates, date, n)


# ──────────────────────────────────────────────────────────────
# 月度驱动器
# ──────────────────────────────────────────────────────────────

def monthly_drive(
    full_start: str,
    end: str,
    chunk_fn: Callable[[str], Any],
    *,
    progress: Callable[[str, int, int], None] | None = None,
) -> list[str]:
    """对 [full_start, end] 按月末切片，逐月调 chunk_fn(date_range)。

    关键不变量：date_range 的起点**恒为 full_start**（不是当月 1 号）。
    理由：缺口头部回看（head padding）必须从整段 start 往前看，
    若以当月 1 号为起点，月初 MA 会是 NaN，口径与整段重算不一致。

    参数：
        full_start: 探查窗口整体起点（YYYYMMDD）。
        end:        探查窗口整体终点（YYYYMMDD）。
        chunk_fn:   接受 date_range 字符串（格式 "YYYYMMDD:YYYYMMDD"）的可调用对象。
                    例：lambda dr: compute_labels(scheme=S, date_range=dr, force_recompute=False)
        progress:   可选进度回调 (date_range_str, chunk_index, total_chunks)。
    返回：
        实际推进的 date_range 字符串列表（按调用顺序）。
    """
    month_ends = sse_month_ends(full_start, end)
    total = len(month_ends)
    driven: list[str] = []
    for i, m_end in enumerate(month_ends):
        date_range = f"{full_start}:{m_end}"
        if progress is not None:
            progress(date_range, i, total)
        chunk_fn(date_range)
        driven.append(date_range)
    return driven


# ──────────────────────────────────────────────────────────────
# DB dump
# ──────────────────────────────────────────────────────────────

def dump_labels(scheme: str, start: str, end: str) -> pd.DataFrame:
    """从 factors.labels 读取指定 scheme 和日期范围的标签，返回 DataFrame。

    列：trade_date, ts_code, value, exit_reason, hold_days。
    value / hold_days 走 pd.to_numeric(errors='coerce')（同 verify 脚本）。
    """
    with session_scope() as s:
        rows = s.execute(
            text(
                """
                SELECT trade_date, ts_code, value, exit_reason, hold_days
                FROM factors.labels
                WHERE scheme = :k AND trade_date BETWEEN :s AND :e
                ORDER BY trade_date, ts_code
                """
            ),
            {"k": scheme, "s": start, "e": end},
        ).fetchall()
    df = pd.DataFrame(
        rows,
        columns=["trade_date", "ts_code", "value", "exit_reason", "hold_days"],
    )
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    df["hold_days"] = pd.to_numeric(df["hold_days"], errors="coerce")
    return df


# ──────────────────────────────────────────────────────────────
# diff（纯函数，可单测）
# ──────────────────────────────────────────────────────────────

_SAMPLE_N = 8  # 每类差异最多保留的样本条数


def diff_labels(old_df: pd.DataFrame, new_df: pd.DataFrame) -> dict[str, Any]:
    """比较两个标签 DataFrame，返回差异统计字典。

    输入列：trade_date, ts_code, value, exit_reason, hold_days。
    主键：(trade_date, ts_code)。

    返回字典键：
        only_in_old         : int  — 仅在 old 中的行数
        only_in_new         : int  — 仅在 new 中的行数
        common_rows         : int  — 公共行数（主键匹配）
        total_old_rows      : int  — old 总行数
        total_new_rows      : int  — new 总行数
        value_changed       : int  — 公共行中 value 变更数（atol=1e-9, equal_nan=True）
        exit_reason_changed : int  — 公共行中 exit_reason 变更数（fillna('∅')）
        hold_days_changed   : int  — 公共行中 hold_days 变更数（fillna(-1)）
        only_in_old_samples : list — 前 N 条 only_in_old 的 (trade_date, ts_code)
        only_in_new_samples : list — 前 N 条 only_in_new 的 (trade_date, ts_code)
        value_changed_samples        : list — 前 N 条 (key, old_val, new_val)
        exit_reason_changed_samples  : list — 前 N 条 (key, old_val, new_val)
        hold_days_changed_samples    : list — 前 N 条 (key, old_val, new_val)

    纯函数：不访问 DB，不调 compute_labels，可直接单测。
    """
    old_keys = set(zip(old_df["trade_date"], old_df["ts_code"]))
    new_keys = set(zip(new_df["trade_date"], new_df["ts_code"]))

    only_old_keys = old_keys - new_keys
    only_new_keys = new_keys - old_keys
    common_keys = old_keys & new_keys

    result: dict[str, Any] = {
        "only_in_old": len(only_old_keys),
        "only_in_new": len(only_new_keys),
        "common_rows": len(common_keys),
        "total_old_rows": len(old_df),
        "total_new_rows": len(new_df),
        "only_in_old_samples": sorted(only_old_keys)[:_SAMPLE_N],
        "only_in_new_samples": sorted(only_new_keys)[:_SAMPLE_N],
    }

    if not common_keys:
        result.update(
            value_changed=0,
            exit_reason_changed=0,
            hold_days_changed=0,
            value_changed_samples=[],
            exit_reason_changed_samples=[],
            hold_days_changed_samples=[],
        )
        return result

    idx = sorted(common_keys)
    om = old_df.set_index(["trade_date", "ts_code"]).sort_index().loc[idx]
    nm = new_df.set_index(["trade_date", "ts_code"]).sort_index().loc[idx]

    # value: np.isclose rtol=0, atol=1e-9, equal_nan=True
    val_diff_mask = ~np.isclose(
        om["value"].to_numpy(dtype=float, na_value=float("nan")),
        nm["value"].to_numpy(dtype=float, na_value=float("nan")),
        rtol=0,
        atol=1e-9,
        equal_nan=True,
    )

    # exit_reason: fillna('∅') 字符串比较
    reason_diff_mask = (
        om["exit_reason"].fillna("∅").to_numpy()
        != nm["exit_reason"].fillna("∅").to_numpy()
    )

    # hold_days: fillna(-1) 整数比较
    hold_diff_mask = (
        om["hold_days"].fillna(-1).to_numpy()
        != nm["hold_days"].fillna(-1).to_numpy()
    )

    def _samples(mask: np.ndarray, col_old: pd.Series, col_new: pd.Series) -> list:
        bad = np.nonzero(mask)[0][:_SAMPLE_N]
        return [
            (idx[i], col_old.iloc[i], col_new.iloc[i])
            for i in bad
        ]

    result["value_changed"] = int(np.asarray(val_diff_mask).sum())
    result["exit_reason_changed"] = int(np.asarray(reason_diff_mask).sum())
    result["hold_days_changed"] = int(np.asarray(hold_diff_mask).sum())
    result["value_changed_samples"] = _samples(
        val_diff_mask, om["value"], nm["value"]
    )
    result["exit_reason_changed_samples"] = _samples(
        reason_diff_mask, om["exit_reason"], nm["exit_reason"]
    )
    result["hold_days_changed_samples"] = _samples(
        hold_diff_mask, om["hold_days"], nm["hold_days"]
    )
    return result


# ──────────────────────────────────────────────────────────────
# PeakRSS 内存监控（依赖 psutil）
# ──────────────────────────────────────────────────────────────

class PeakRSS:
    """上下文管理器：后台线程每 0.5s 采 psutil RSS，记录峰值。

    用法：
        with PeakRSS() as p:
            compute_something()
        print(p.peak_mb)

    ⚠️  依赖 psutil（dev 可选依赖，见 pyproject [project.optional-dependencies].dev）。
        若 psutil 不可用，__enter__ 抛出带提示的 ImportError：
        "PeakRSS 需要 psutil，请先 uv add psutil 再运行。"
        其它功能不受影响，可先跳过 Q2 仅运行 Q1/Q3：
            uv run python tests/integration/probe_recompute_diff.py --only q1 q3
    """

    INTERVAL_S = 0.5

    def __init__(self) -> None:
        self._peak_bytes: int = 0
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._psutil_process: Any = None

    def __enter__(self) -> "PeakRSS":
        try:
            import psutil  # noqa: PLC0415
        except ImportError as exc:
            raise ImportError(
                "PeakRSS 需要 psutil，请先 uv add psutil 再运行。\n"
                "仅跳过 Q2 可用：--only q1 q3"
            ) from exc

        import os
        self._psutil_process = psutil.Process(os.getpid())
        self._peak_bytes = self._psutil_process.memory_info().rss
        self._stop_event.clear()

        def _sample() -> None:
            while not self._stop_event.is_set():
                try:
                    rss = self._psutil_process.memory_info().rss
                    if rss > self._peak_bytes:
                        self._peak_bytes = rss
                except Exception:  # noqa: BLE001
                    pass
                self._stop_event.wait(self.INTERVAL_S)

        self._thread = threading.Thread(target=_sample, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    @property
    def peak_mb(self) -> float:
        """峰值 RSS（MB）。"""
        return self._peak_bytes / (1024 * 1024)


__all__ = [
    "_trading_day_before_from_caldates",
    "_month_ends_from_caldates",
    "sse_trading_day_before",
    "sse_month_ends",
    "monthly_drive",
    "dump_labels",
    "diff_labels",
    "PeakRSS",
    "compute_labels",
]
