"""一次性运维脚本：月度幂等重建单个 feature_set 的 feature_matrix（force=False，**绝不 DELETE**）。

DELETE 由运维者在调用前显式执行（spec 02 §硬不变量：DELETE 独立不可逆步；崩溃重跑只重跑
本脚本、绝不重跑 DELETE）。neutralize_cols/robust_z/factor_clip_sigma/label_winsorize 全走
builder 默认（None）→ overlay 为空 → fsid == base_fsid；resolve_feature_set_id 预查按
(factor_version, scheme, new_listing_min_days, factor_ids) 复用既有 fs id。

⚠️ 调用前必须先跑 fail-fast 护门确认「默认参数 + resolve 复用 == 目标 fs」（见会话记录：
strategy-aware=fs_60bc257fb173 是旧 hash 契约 + 默认 neutralize/robust，已 hash 重构核验；
fwd_ret_h1=fs_9b5ff4d69c1e 新契约 + 默认）。features 截面无跨日依赖 → 月度分块等价整段。

用法：
  cd apps/quant-pipeline; $env:PYTHONPATH="."
  uv run python tests/integration/run_recompute_features.py <factor_version> <label_scheme> <nd> <start> <end>
"""

from __future__ import annotations

import sys
import time

from quant_pipeline.factors import registry as _factor_registry
from quant_pipeline.features.runner import build_feature_matrix
from tests.integration._recompute_helpers import monthly_drive


def main() -> int:
    if len(sys.argv) != 6:
        print(
            "usage: run_recompute_features.py <factor_version> <label_scheme> "
            "<new_listing_min_days> <start> <end>",
            flush=True,
        )
        return 2
    fv, scheme, nd_s, start, end = sys.argv[1:6]
    nd = int(nd_s)

    # CLI 入口必须预热因子注册表（import_all_factors + reload_from_db），否则
    # _load_factor_ids → list_active 读空缓存抛 FactorMetaMissing（registry.py
    # ensure_loaded docstring 明示 CLI 入口需此步；worker 在进程启动期已做）。
    _factor_registry.ensure_loaded()
    holder: dict[str, str] = {}

    def _chunk(dr: str) -> str:
        fsid = build_feature_matrix(
            factor_version=fv,
            label_scheme=scheme,
            date_range=dr,
            new_listing_min_days=nd,
            force_recompute=False,
        )
        holder["fsid"] = fsid
        return fsid

    print(
        f"[rebuild-fm] fv={fv} scheme={scheme} nd={nd} range={start}:{end} "
        f"(force=False, neutralize/robust/clip/winsorize=默认)",
        flush=True,
    )
    t0 = time.time()
    driven = monthly_drive(
        full_start=start,
        end=end,
        chunk_fn=_chunk,
        progress=lambda dr, i, total: print(
            f"  [{i + 1}/{total}] {dr}  (+{time.time() - t0:.0f}s)", flush=True
        ),
    )
    print(
        f"[DONE] scheme={scheme} fsid={holder.get('fsid')} chunks={len(driven)} "
        f"range={start}:{end} elapsed={time.time() - t0:.0f}s",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
