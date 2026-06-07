"""重算影响验证：prod 模型固定权重在重算后 feature_matrix 上对单日重打分，
与存档 scores_daily（旧特征算）对比 rank 漂移 / top-K 重叠 / score 相关。

背景（spec 2026-06-06 recompute 任务 H）：
  labels + feature_matrix 已用修正后代码（bug1-5）就地重算（同 fs id），prod 模型
  lgb-lambdarank 权重未变。本脚本用**固定权重**在新 fm 上复跑生产推理 predict_one_day
  （只读、不写库），与存档 ml.scores_daily（旧特征算）对比，直接量化「label/feature
  校正对 live 模型实际输出（排名）的影响」。

  仅 20260515 在重算后 fm 完全覆盖（fm strategy-aware dmax=20260515）；20260528 的
  fm 行在重算范围外（fm 无此日），无法只读重打分，故只评 20260515。

  指标：score Pearson/Spearman、rank_in_day 漂移分布、top-K（20/50/100）成员重叠。
  top-K 重叠是关键——下游用 rank 选股，rank 稳则校正对实盘选股无实质影响。

pytest 不收集（verify_ 前缀）。手动跑（单日，秒级）：
  cd apps/quant-pipeline; uv run python tests/integration/verify_recompute_inference_drift.py
"""

from __future__ import annotations

import sys

import numpy as np
import pandas as pd
from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.inference.runner import predict_one_day

MV = "lgb-lambdarank-v1-20260521-seed42"
DATE = "20260515"
TOPKS = (20, 50, 100)


def main() -> int:
    with session_scope() as s:
        rows = s.execute(
            text(
                "SELECT ts_code, score, rank_in_day FROM ml.scores_daily "
                "WHERE model_version=:m AND trade_date=:d"
            ),
            {"m": MV, "d": DATE},
        ).fetchall()
        old = pd.DataFrame(rows, columns=["ts_code", "score_old", "rank_old"])
        for c in ("score_old",):
            old[c] = pd.to_numeric(old[c], errors="coerce")
        # 固定权重 + 新 fm 重打分（只读，不写库）
        new = predict_one_day(MV, DATE, s)

    new = new.rename(columns={"score": "score_new", "rank_in_day": "rank_new"})
    n_old = len(old)
    n_new_total = len(new)
    n_new_nan = int(new["score_new"].isna().sum())

    merged = old.merge(new[["ts_code", "score_new", "rank_new"]], on="ts_code", how="inner")
    both = merged.dropna(subset=["score_old", "score_new"]).copy()

    print(f"[cover] stored(old)={n_old}  repredict(new)={n_new_total} "
          f"(nan_score={n_new_nan})  matched_nonnan={len(both)}", flush=True)
    only_old = set(old["ts_code"]) - set(new["ts_code"])
    only_new = set(new.dropna(subset=["score_new"])["ts_code"]) - set(old["ts_code"])
    print(f"[cover] only_in_old={len(only_old)}  only_in_new(nonnan)={len(only_new)}", flush=True)

    pear = both["score_old"].corr(both["score_new"], method="pearson")
    spear = both["score_old"].corr(both["score_new"], method="spearman")
    print(f"\n[corr] score Pearson={pear:.6f}  Spearman={spear:.6f}", flush=True)

    # rank 漂移（两侧 rank_in_day：1=最高分；同口径直接比）
    both["rank_delta"] = (both["rank_new"] - both["rank_old"]).abs()
    rd = both["rank_delta"]
    print(f"[rank] |Δrank| mean={rd.mean():.2f} median={rd.median():.0f} "
          f"p95={rd.quantile(0.95):.0f} max={rd.max():.0f}  (N={len(both)})", flush=True)

    # top-K 成员重叠（rank<=K 两侧各取一集合，交集/K）
    print(flush=True)
    for k in TOPKS:
        old_top = set(both.loc[both["rank_old"] <= k, "ts_code"])
        new_top = set(both.loc[both["rank_new"] <= k, "ts_code"])
        inter = len(old_top & new_top)
        denom = max(len(old_top), 1)
        print(f"[top{k:>3}] overlap={inter}/{denom}  "
              f"({100.0 * inter / denom:.1f}%)  churn={denom - inter}", flush=True)

    # 判定：rank 高度稳定即「校正对 live 选股无实质影响」
    spear_ok = bool(spear is not None and spear >= 0.99)
    top20_old = set(both.loc[both["rank_old"] <= 20, "ts_code"])
    top20_new = set(both.loc[both["rank_new"] <= 20, "ts_code"])
    top20_overlap = len(top20_old & top20_new) / max(len(top20_old), 1)
    print(f"\nRESULT: Spearman={spear:.4f} (>=0.99? {spear_ok})  "
          f"top20_overlap={top20_overlap:.0%}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
