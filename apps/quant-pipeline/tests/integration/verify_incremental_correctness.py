"""真 DB 正确性逐行比对（约束 1 头号）：增量(含头部 MA padding) == force 整段重算。

spec docs/superpowers/specs/2026-06-06-labels-features-incremental-prepare-design/
06-testing-verification.md 场景 A。**必须用 strategy-aware（含 ma5_break）scheme**——
只有它走 simulate_exit 的滚动 MA、能验头部 padding；纯 fwd_ret 测不到这条。

设计：
  INCR 路径：scheme=strategy-aware__incrtest
    ① compute_labels(C0:C1, force=False)  → 物化第一段 [C0,C1]
    ② compute_labels(C0:C2, force=False)  → 增量，gap=[C1后第一交易日..C2]，g0 在历史中段
                                            （前有 ① 已物化）→ 触发头部 padding
  FULL 路径：scheme=strategy-aware__fulltest
    ③ compute_labels(C0:C2, force=True)   → 整段重算覆盖（= 改造前基线）
  断言：INCR 与 FULL 在 [C0,C2] 逐行逐值完全一致（value/exit_reason/hold_days/行集合）。
  头部 padding 回归：gap 起点后 ma_window-1(=4) 个交易日的 ma5_break 出场必须与 FULL 一致；
                     漏头部 padding 时这几天 MA5=NaN、ma5_break 不触发 → 本场景必抓。

pytest 不收集本文件（`verify_` 前缀，非 `test_`）；耗时 strategy_aware compute（数分钟），
手动跑：`cd apps/quant-pipeline; uv run python tests/integration/verify_incremental_correctness.py`
跑完自动 DELETE 清理两个 test scheme 行（PASS 时清；FAIL 时保留供排查）。
"""

from __future__ import annotations

import sys
import time

import numpy as np
import pandas as pd
from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.labels.runner import compute_labels

INCR_SCHEME = "strategy-aware__incrtest"
FULL_SCHEME = "strategy-aware__fulltest"

# 窗口：C0..C1 第一段；C1后..C2 为增量 gap（g0 在历史中段，前有 C0..C1 已物化）。
# 取 2023 年 3 月（第一段）/ 4 月（gap），全市场 ~1.5 个月 compute，控制耗时。
C0 = "20230301"
C1 = "20230331"
C2 = "20230428"


def _cleanup() -> None:
    with session_scope() as s:
        s.execute(
            text("DELETE FROM factors.labels WHERE scheme IN (:a, :b)"),
            {"a": INCR_SCHEME, "b": FULL_SCHEME},
        )


def _dump(scheme: str, start: str, end: str) -> pd.DataFrame:
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
        rows, columns=["trade_date", "ts_code", "value", "exit_reason", "hold_days"]
    )
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    df["hold_days"] = pd.to_numeric(df["hold_days"], errors="coerce")
    return df


def _trading_days(start: str, end: str) -> list[str]:
    with session_scope() as s:
        rows = s.execute(
            text(
                """
                SELECT cal_date FROM raw.trade_cal
                WHERE exchange='SSE' AND is_open=1 AND cal_date BETWEEN :s AND :e
                ORDER BY cal_date
                """
            ),
            {"s": start, "e": end},
        ).fetchall()
    return [str(r[0]) for r in rows]


def main() -> int:
    print(f"[setup] 清理历史 test scheme 行 ({INCR_SCHEME}, {FULL_SCHEME})", flush=True)
    _cleanup()

    t = time.time()
    print(f"[INCR ①] compute_labels {C0}:{C1} force=False", flush=True)
    n1 = compute_labels(scheme=INCR_SCHEME, date_range=f"{C0}:{C1}", force_recompute=False)
    print(f"        写入 {n1} 行, {time.time()-t:.0f}s", flush=True)

    t = time.time()
    print(f"[INCR ②] compute_labels {C0}:{C2} force=False (增量, gap=4月)", flush=True)
    n2 = compute_labels(scheme=INCR_SCHEME, date_range=f"{C0}:{C2}", force_recompute=False)
    print(f"        写入 {n2} 行, {time.time()-t:.0f}s", flush=True)

    t = time.time()
    print(f"[FULL ③] compute_labels {C0}:{C2} force=True (整段重算基线)", flush=True)
    n3 = compute_labels(scheme=FULL_SCHEME, date_range=f"{C0}:{C2}", force_recompute=True)
    print(f"        写入 {n3} 行, {time.time()-t:.0f}s", flush=True)

    incr = _dump(INCR_SCHEME, C0, C2)
    full = _dump(FULL_SCHEME, C0, C2)
    print(f"\n[compare] INCR rows={len(incr)}  FULL rows={len(full)}", flush=True)

    ok = True

    # 1) 行集合比对 (trade_date × ts_code)
    incr_keys = set(zip(incr["trade_date"], incr["ts_code"]))
    full_keys = set(zip(full["trade_date"], full["ts_code"]))
    only_incr = incr_keys - full_keys
    only_full = full_keys - incr_keys
    if only_incr or only_full:
        ok = False
        print(f"  ❌ 行集合不一致: only_in_INCR={len(only_incr)} only_in_FULL={len(only_full)}")
        for k in sorted(only_incr)[:10]:
            print(f"     only_INCR {k}")
        for k in sorted(only_full)[:10]:
            print(f"     only_FULL {k}")
    else:
        print(f"  ✅ 行集合完全一致 ({len(incr_keys)} 行)")

    # 2) 公共行逐值比对 value / exit_reason / hold_days
    common = incr_keys & full_keys
    im = incr.set_index(["trade_date", "ts_code"]).sort_index()
    fm = full.set_index(["trade_date", "ts_code"]).sort_index()
    idx = sorted(common)
    im = im.loc[idx]
    fm = fm.loc[idx]

    val_diff = (~np.isclose(im["value"], fm["value"], rtol=0, atol=1e-9, equal_nan=True))
    reason_diff = im["exit_reason"].fillna("∅") != fm["exit_reason"].fillna("∅")
    hold_diff = im["hold_days"].fillna(-1) != fm["hold_days"].fillna(-1)

    for name, mask in (("value", val_diff), ("exit_reason", reason_diff), ("hold_days", hold_diff)):
        nbad = int(np.asarray(mask).sum())
        if nbad:
            ok = False
            print(f"  ❌ {name} 不一致 {nbad} 行；样本:")
            bad_idx = np.asarray(mask).nonzero()[0][:8]
            for i in bad_idx:
                k = idx[i]
                print(f"     {k} INCR={im.iloc[i][name]!r} FULL={fm.iloc[i][name]!r}")
        else:
            print(f"  ✅ {name} 逐行一致 ({len(idx)} 行)")

    # 3) ★头部 padding 焦点验证：gap 起点后 ma_window-1(=4) 个交易日的 ma5_break 一致
    april_days = _trading_days(C2[:6] + "01", C2)  # 4 月交易日
    boundary = april_days[:5]  # gap 起点起头 5 个交易日（含边界 4 天）
    print(f"\n[head-padding 焦点] gap 起点边界交易日 {boundary}")
    for d in boundary:
        ic = incr[(incr["trade_date"] == d) & (incr["exit_reason"] == "ma5_break")].shape[0]
        fc = full[(full["trade_date"] == d) & (full["exit_reason"] == "ma5_break")].shape[0]
        flag = "✅" if ic == fc else "❌"
        if ic != fc:
            ok = False
        print(f"  {flag} {d}  INCR ma5_break={ic}  FULL ma5_break={fc}")

    print("\n" + ("RESULT: ✅ PASS 增量 == force 整段，逐行逐值一致，头部 padding 边界一致"
                  if ok else "RESULT: ❌ FAIL 见上方差异（test scheme 行已保留供排查）"))

    if ok:
        print("[teardown] 清理 test scheme 行", flush=True)
        _cleanup()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
