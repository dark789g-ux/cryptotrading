"""一次性运维脚本：对单个 scheme 月度幂等重算 labels（force=False，**绝不 DELETE**）。

DELETE 由运维者在调用本脚本前显式执行（spec 02 §硬不变量：DELETE 是唯一不可逆步、
独立确认；崩溃重跑只重跑本脚本、**绝不重跑 DELETE**）。本脚本 force_recompute=False
→ 已物化的月份自动跳过、缺口自收敛，可安全重复运行。

date_range.start **恒为 full_start**（monthly_drive 不变量；月初不传当月 1 号，否则
g0_load 夹不回上月、月初 MA=NaN、口径错——bug5 已修但仍守此口径）。

pytest 不收集（无 test_/verify_ 前缀）。手动跑：
  cd apps/quant-pipeline; $env:PYTHONPATH="."
  uv run python tests/integration/run_recompute_labels.py <scheme> <start> <end>
"""

from __future__ import annotations

import sys
import time

from tests.integration._recompute_helpers import compute_labels, monthly_drive


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: run_recompute_labels.py <scheme> <start> <end>", flush=True)
        return 2
    scheme, start, end = sys.argv[1], sys.argv[2], sys.argv[3]
    print(
        f"[recompute] scheme={scheme} range={start}:{end} "
        f"(force=False, 月度幂等, 不 DELETE)",
        flush=True,
    )
    t0 = time.time()
    driven = monthly_drive(
        full_start=start,
        end=end,
        chunk_fn=lambda dr: compute_labels(
            scheme=scheme, date_range=dr, force_recompute=False
        ),
        progress=lambda dr, i, total: print(
            f"  [{i + 1}/{total}] {dr}  (+{time.time() - t0:.0f}s)", flush=True
        ),
    )
    print(
        f"[DONE] scheme={scheme} chunks={len(driven)} range={start}:{end} "
        f"elapsed={time.time() - t0:.0f}s",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
