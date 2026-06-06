"""生产标签 vs 新口径重算差异探查工具（只读安全网）。

跑法：cd apps/quant-pipeline; uv run python tests/integration/probe_recompute_diff.py

只读保证：生产 scheme 仅读，写操作仅针对 scheme LIKE '%__recheck%'，收尾 DELETE。
选项：--schemes / --only q1 q2 q3 / --out <path> / --no-cleanup
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime
from typing import Any

from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.labels.runner import compute_labels

from tests.integration._recompute_helpers import (
    PeakRSS,
    diff_labels,
    dump_labels,
    monthly_drive,
)

# ──────────────────────────────────────────────────────────────
# 默认配置
# ──────────────────────────────────────────────────────────────

# 生产 scheme 名
PROD_SCHEMES = ["strategy-aware", "fwd_ret_h1"]

# 各 scheme 默认探查窗口（W1、W2，...）
DEFAULT_WINDOWS: dict[str, list[tuple[str, str]]] = {
    "strategy-aware": [
        ("20230103", "20230630"),
        ("20240601", "20240630"),
    ],
    "fwd_ret_h1": [
        ("20230103", "20230630"),
    ],
}

# Q2 峰值校准：单个月度 chunk（用 strategy-aware 跑这一格）
Q2_SCHEME = "strategy-aware"
Q2_WINDOW = ("20240601", "20240630")

# Q3 驱动自证：3 个月窗口
Q3_START = "20230103"
Q3_END = "20230331"
Q3_SCHEME_DRIVE = "strategy-aware__recheck_drv"
Q3_SCHEME_FULL = "strategy-aware__recheck_full"


# ──────────────────────────────────────────────────────────────
# 辅助
# ──────────────────────────────────────────────────────────────

def _recheck_scheme(prod_scheme: str, suffix: str = "recheck") -> str:
    """生成临时 recheck scheme 名（避免与生产名冲突）。"""
    return f"{prod_scheme}__{suffix}"


def _cleanup(extra_schemes: list[str] | None = None) -> None:
    """DELETE factors.labels WHERE scheme LIKE '%__recheck%'，并清除额外列表中的 scheme。"""
    with session_scope() as s:
        s.execute(
            text("DELETE FROM factors.labels WHERE scheme LIKE '%\\_\\_recheck%'")
        )
        if extra_schemes:
            for sc in extra_schemes:
                s.execute(
                    text("DELETE FROM factors.labels WHERE scheme = :sc"),
                    {"sc": sc},
                )
    print("[cleanup] DELETE __recheck* scheme 行完成", flush=True)


def _available_memory_mb() -> float:
    """尝试读可用物理内存（MB）；psutil 不可用时返回 -1。"""
    try:
        import psutil  # noqa: PLC0415
        return psutil.virtual_memory().available / (1024 * 1024)
    except ImportError:
        return -1.0


def _pct(count: int, total: int) -> str:
    if total == 0:
        return "N/A"
    return f"{count / total * 100:.2f}%"


# ──────────────────────────────────────────────────────────────
# Q1：差异量化
# ──────────────────────────────────────────────────────────────

def run_q1(
    schemes: list[str],
    windows: dict[str, list[tuple[str, str]]],
) -> dict[str, Any]:
    """问题①：量化每个 scheme 在各探查窗口内的标签差异。

    对每个 (scheme, window) 对：
      1. 用 monthly_drive 把窗口算进临时 __recheck scheme（新口径、force=False）。
      2. dump 生产 scheme 与临时 scheme 的标签。
      3. diff_labels 得到差异统计。
    返回嵌套结果字典。
    """
    print("\n" + "=" * 60, flush=True)
    print("[ Q1 ] 差异量化", flush=True)
    print("=" * 60, flush=True)

    q1_results: dict[str, Any] = {}

    for prod_scheme in schemes:
        recheck = _recheck_scheme(prod_scheme)
        wins = windows.get(prod_scheme, [])
        scheme_results = []

        print(f"\n  scheme={prod_scheme!r}  recheck={recheck!r}", flush=True)

        for w_start, w_end in wins:
            print(f"\n  窗口 {w_start}:{w_end}", flush=True)
            t0 = time.time()

            # 新口径：monthly_drive（force=False，增量缺口）
            print(f"    monthly_drive {w_start}:{w_end} → {recheck!r} ...", flush=True)
            driven = monthly_drive(
                full_start=w_start,
                end=w_end,
                chunk_fn=lambda dr, s=recheck: compute_labels(
                    scheme=s, date_range=dr, force_recompute=False
                ),
                progress=lambda dr, i, total: print(
                    f"    chunk [{i+1}/{total}] {dr}", flush=True
                ),
            )
            print(f"    driven={len(driven)} chunks, {time.time()-t0:.0f}s", flush=True)

            # dump 两路
            old_df = dump_labels(prod_scheme, w_start, w_end)
            new_df = dump_labels(recheck, w_start, w_end)
            print(
                f"    prod rows={len(old_df)}  recheck rows={len(new_df)}",
                flush=True,
            )

            diff = diff_labels(old_df, new_df)
            scheme_results.append(
                {
                    "window": f"{w_start}:{w_end}",
                    "prod_rows": len(old_df),
                    "recheck_rows": len(new_df),
                    "diff": diff,
                }
            )

            # 打印摘要
            print(f"    only_in_prod  = {diff['only_in_old']}", flush=True)
            print(f"    only_in_new   = {diff['only_in_new']}", flush=True)
            common = diff["common_rows"]
            print(f"    common_rows   = {common}", flush=True)
            print(
                f"    value_changed = {diff['value_changed']} "
                f"({_pct(diff['value_changed'], common)})",
                flush=True,
            )
            print(
                f"    exit_reason   = {diff['exit_reason_changed']} "
                f"({_pct(diff['exit_reason_changed'], common)})",
                flush=True,
            )
            print(
                f"    hold_days     = {diff['hold_days_changed']} "
                f"({_pct(diff['hold_days_changed'], common)})",
                flush=True,
            )

        q1_results[prod_scheme] = scheme_results

    return q1_results


# ──────────────────────────────────────────────────────────────
# Q2：RSS 校准
# ──────────────────────────────────────────────────────────────

def run_q2() -> dict[str, Any]:
    """问题②：用 PeakRSS 包住单个月度 chunk 测峰值 MB，打印判定建议。"""
    print("\n" + "=" * 60, flush=True)
    print("[ Q2 ] RSS 峰值校准", flush=True)
    print("=" * 60, flush=True)

    recheck = _recheck_scheme(Q2_SCHEME, "recheck_q2")
    date_range = f"{Q2_WINDOW[0]}:{Q2_WINDOW[1]}"
    print(f"  scheme={recheck!r}  date_range={date_range}", flush=True)

    try:
        with PeakRSS() as p:
            compute_labels(scheme=recheck, date_range=date_range, force_recompute=True)
        peak_mb = p.peak_mb
        avail_mb = _available_memory_mb()

        if avail_mb > 0:
            headroom_mb = avail_mb - peak_mb
            # 全量重算估算：4.28M 行 / 单月约等规模行 * peak
            suggestion = (
                "内存充裕，建议月度粒度重算"
                if headroom_mb > peak_mb * 3
                else "建议缩短窗口或分批跑"
            )
        else:
            headroom_mb = -1.0
            suggestion = "psutil 不可用，无法判断余量"

        print(f"  peak_mb   = {peak_mb:.1f} MB", flush=True)
        print(f"  avail_mb  = {avail_mb:.1f} MB", flush=True)
        print(f"  headroom  = {headroom_mb:.1f} MB", flush=True)
        print(f"  建议      = {suggestion}", flush=True)

        # 清理 Q2 临时 scheme
        with session_scope() as s:
            s.execute(
                text("DELETE FROM factors.labels WHERE scheme = :sc"),
                {"sc": recheck},
            )

        return {
            "status": "ok",
            "peak_mb": peak_mb,
            "avail_mb": avail_mb,
            "headroom_mb": headroom_mb,
            "suggestion": suggestion,
        }
    except ImportError as exc:
        msg = str(exc)
        print(f"  ⚠️  Q2 跳过: {msg}", flush=True)
        return {"status": "skipped", "reason": msg}


# ──────────────────────────────────────────────────────────────
# Q3：驱动自证
# ──────────────────────────────────────────────────────────────

def run_q3() -> dict[str, Any]:
    """问题③：monthly_drive 逐月 vs 整段 force 重算，diff 必须完全一致（全 0）。

    两路各用独立临时 scheme，互不干扰：
      - strategy-aware__recheck_drv：monthly_drive（force=False）
      - strategy-aware__recheck_full：单次 compute_labels(force_recompute=True)
    """
    print("\n" + "=" * 60, flush=True)
    print("[ Q3 ] 驱动自证（monthly_drive == force 整段重算）", flush=True)
    print("=" * 60, flush=True)
    print(f"  窗口={Q3_START}:{Q3_END}", flush=True)

    # 先清理两路临时 scheme（避免残留干扰）
    with session_scope() as s:
        for sc in (Q3_SCHEME_DRIVE, Q3_SCHEME_FULL):
            s.execute(
                text("DELETE FROM factors.labels WHERE scheme = :sc"),
                {"sc": sc},
            )

    # 路径 A：monthly_drive（force=False，增量缺口）
    t0 = time.time()
    print(f"\n  [路径 A] monthly_drive → {Q3_SCHEME_DRIVE!r}", flush=True)
    driven = monthly_drive(
        full_start=Q3_START,
        end=Q3_END,
        chunk_fn=lambda dr: compute_labels(
            scheme=Q3_SCHEME_DRIVE, date_range=dr, force_recompute=False
        ),
        progress=lambda dr, i, total: print(
            f"    chunk [{i+1}/{total}] {dr}", flush=True
        ),
    )
    print(f"  路径 A: {len(driven)} chunks, {time.time()-t0:.0f}s", flush=True)

    # 路径 B：整段 force 重算
    t0 = time.time()
    print(f"\n  [路径 B] force整段 → {Q3_SCHEME_FULL!r}", flush=True)
    n_full = compute_labels(
        scheme=Q3_SCHEME_FULL,
        date_range=f"{Q3_START}:{Q3_END}",
        force_recompute=True,
    )
    print(f"  路径 B: {n_full} 行, {time.time()-t0:.0f}s", flush=True)

    # dump 两路并比较
    drv_df = dump_labels(Q3_SCHEME_DRIVE, Q3_START, Q3_END)
    full_df = dump_labels(Q3_SCHEME_FULL, Q3_START, Q3_END)
    print(
        f"\n  drive rows={len(drv_df)}  full rows={len(full_df)}",
        flush=True,
    )

    diff = diff_labels(drv_df, full_df)

    failed_items = [
        k
        for k, v in diff.items()
        if k in ("only_in_old", "only_in_new", "value_changed",
                 "exit_reason_changed", "hold_days_changed")
        and isinstance(v, int) and v != 0
    ]
    passed = len(failed_items) == 0

    status = "PASS" if passed else "FAIL"
    icon = "✅" if passed else "❌"
    print(f"\n  {icon} Q3 {status}", flush=True)
    if not passed:
        for k in failed_items:
            sample_key = f"{k}_samples"
            print(f"    {k}={diff[k]}", flush=True)
            for s_item in diff.get(sample_key, [])[:4]:
                print(f"      样本: {s_item}", flush=True)

    return {
        "status": status,
        "diff": diff,
        "drive_rows": len(drv_df),
        "full_rows": len(full_df),
    }


# ──────────────────────────────────────────────────────────────
# 报告格式化
# ──────────────────────────────────────────────────────────────

def _format_report(
    q1: dict[str, Any] | None,
    q2: dict[str, Any] | None,
    q3: dict[str, Any] | None,
    run_ts: str,
) -> str:
    lines: list[str] = [
        f"# 生产标签差异探查报告",
        f"",
        f"生成时间：{run_ts}",
        f"",
    ]

    # Q1
    if q1 is not None:
        lines.append("## Q1 差异量化")
        for scheme, windows in q1.items():
            lines.append(f"### scheme={scheme}")
            for w in windows:
                win = w["window"]
                diff = w["diff"]
                common = diff["common_rows"]
                lines += [
                    f"#### 窗口 {win}",
                    f"- prod 行数：{w['prod_rows']}",
                    f"- recheck 行数：{w['recheck_rows']}",
                    f"- 仅在生产：{diff['only_in_old']}",
                    f"- 仅在新算：{diff['only_in_new']}",
                    f"- 公共行数：{common}",
                    f"- value 变更：{diff['value_changed']} ({_pct(diff['value_changed'], common)})",
                    f"- exit_reason 变更：{diff['exit_reason_changed']} "
                    f"({_pct(diff['exit_reason_changed'], common)})",
                    f"- hold_days 变更：{diff['hold_days_changed']} "
                    f"({_pct(diff['hold_days_changed'], common)})",
                    f"",
                ]
        lines.append("")

    # Q2
    if q2 is not None:
        lines.append("## Q2 RSS 峰值校准")
        if q2.get("status") == "skipped":
            lines.append(f"跳过（{q2['reason']}）")
        else:
            def _fmt_mb(val: Any) -> str:
                return f"{val:.1f}" if isinstance(val, (int, float)) else "N/A"

            lines += [
                f"- peak_mb：{_fmt_mb(q2.get('peak_mb'))} MB",
                f"- avail_mb：{_fmt_mb(q2.get('avail_mb'))} MB",
                f"- headroom：{_fmt_mb(q2.get('headroom_mb'))} MB",
                f"- 建议：{q2.get('suggestion', 'N/A')}",
            ]
        lines.append("")

    # Q3
    if q3 is not None:
        lines.append("## Q3 驱动自证")
        status = q3.get("status", "N/A")
        icon = "✅" if status == "PASS" else "❌"
        lines += [
            f"- 结果：{icon} {status}",
            f"- drive 路径行数：{q3.get('drive_rows', 'N/A')}",
            f"- force 整段行数：{q3.get('full_rows', 'N/A')}",
        ]
        diff = q3.get("diff", {})
        for k in ("only_in_old", "only_in_new", "value_changed",
                  "exit_reason_changed", "hold_days_changed"):
            if k in diff:
                lines.append(f"- {k}：{diff[k]}")
        lines.append("")

    return "\n".join(lines)


# ──────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="生产标签差异探查工具（只读安全网）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--schemes",
        nargs="+",
        default=PROD_SCHEMES,
        help="要探查的生产 scheme（默认：strategy-aware fwd_ret_h1）",
    )
    parser.add_argument(
        "--only",
        nargs="+",
        choices=["q1", "q2", "q3"],
        default=["q1", "q2", "q3"],
        help="只跑指定问题（q1/q2/q3，可多个；默认全跑）",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="同时写一份 Markdown 报告到此路径",
    )
    parser.add_argument(
        "--no-cleanup",
        action="store_true",
        help="跳过收尾 DELETE（保留 __recheck* 行供排查）",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    run_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    run_only: set[str] = set(args.only)
    schemes: list[str] = args.schemes

    # 使用默认窗口（当前版本不支持 CLI 覆盖窗口，可后续扩展）
    windows = {s: DEFAULT_WINDOWS.get(s, []) for s in schemes}

    q1_result: dict[str, Any] | None = None
    q2_result: dict[str, Any] | None = None
    q3_result: dict[str, Any] | None = None

    try:
        if "q1" in run_only:
            q1_result = run_q1(schemes, windows)

        if "q2" in run_only:
            q2_result = run_q2()

        if "q3" in run_only:
            q3_result = run_q3()

    finally:
        if not args.no_cleanup:
            _cleanup()
        else:
            print("\n[no-cleanup] 已跳过 DELETE，__recheck* 行保留供排查", flush=True)

    # 报告
    report = _format_report(q1_result, q2_result, q3_result, run_ts)
    print("\n" + "=" * 60, flush=True)
    print("[ 报告摘要 ]", flush=True)
    print("=" * 60, flush=True)
    print(report, flush=True)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(report)
        print(f"\n报告已写入：{args.out}", flush=True)

    # 返回码：q3 FAIL 则非 0
    if q3_result is not None and q3_result.get("status") != "PASS":
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
