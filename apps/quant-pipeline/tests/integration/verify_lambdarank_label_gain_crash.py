"""验证 lambdarank label_gain 修复:真实稠密数据(prod fs 2 个稠密日,~1万样本)上,
截面分位分桶后 train_lambdarank 不再崩溃,且 gain 落在默认 label_gain 表内。

历史两崩(已修):
  崩A: 截面 rank 0..n-1 → "Label N is not less than number of label mappings (31)"
  崩B: 原始连续含负 y_all → "label should be int type"
现在统一走 group_utils.label_to_bucketed_gain(0..4,与 NDCG 评估同口径)。

pytest 不收集(verify_ 前缀)。手动跑:
  cd apps/quant-pipeline; uv run python tests/integration/verify_lambdarank_label_gain_crash.py
"""

from __future__ import annotations

import sys

import lightgbm as lgb
import numpy as np

from quant_pipeline.training.group_utils import (
    LABEL_GAIN_LEVELS,
    build_groups,
    flatten_features,
    label_to_bucketed_gain,
)
from quant_pipeline.training.lightgbm_lambdarank import train_lambdarank
from quant_pipeline.training.runner import _load_feature_matrix

FS = "fs_60bc257fb173"
RANGE = "20260514:20260515"


def main() -> int:
    df = _load_feature_matrix(FS, RANGE)
    df = df.sort_values(["trade_date", "ts_code"]).reset_index(drop=True)
    mask = df["label"].notna()
    df = df.loc[mask].reset_index(drop=True)
    X, _cols = flatten_features(df)
    y = df["label"]
    groups = build_groups(df)
    per_day = df.groupby("trade_date").size().to_dict()
    print(f"[data] rows={len(df)} groups={len(groups)} per_day={per_day}", flush=True)
    print(f"[data] y range=[{y.min():.4f},{y.max():.4f}] neg={int((y<0).sum())}", flush=True)
    print(f"[lightgbm] {lgb.__version__}", flush=True)

    # 修复后:截面分位分桶 → gain ∈ 0..LABEL_GAIN_LEVELS-1
    y_gain = label_to_bucketed_gain(df, y, LABEL_GAIN_LEVELS)
    print(
        f"\n[fix] bucketed gain: min={int(y_gain.min())} max={int(y_gain.max())} "
        f"(<= {LABEL_GAIN_LEVELS - 1} < 31 默认 label_gain 上限)",
        flush=True,
    )
    try:
        b = train_lambdarank(X, y_gain, groups, num_boost_round=10, early_stopping_rounds=None)
        pred = np.asarray(b.predict(X.values), dtype=np.float64)
        uniq = len(np.unique(np.round(pred, 8)))
        print(
            f"[fix] OK 训练成功;pred 唯一值={uniq}/{len(pred)} "
            f"(>1 说明模型对稠密截面学到了区分度)",
            flush=True,
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"[fix] FAIL 仍崩溃 -> {type(exc).__name__}: {exc}", flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
