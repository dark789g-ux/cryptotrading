"""Phase2: 在重算后(新 close_adj) fm 上重训 lambdarank,产 shadow model_run。

复刻 prod(lgb-lambdarank-v1-20260521-seed42)训练配置:
  walk_forward=True, seed=42, DEFAULT_HYPERPARAMS, n_folds=6/embargo21/min_train252。
新 run status 默认 'shadow'(不 promote;promote 是人工硬门)。

用法(pytest 不收集,verify_ 前缀):
  cd apps/quant-pipeline
  # smoke(轻量验证全链路):
  uv run python tests/integration/verify_retrain_lambdarank_new_fm.py 20 2 smoke
  # 全量(复刻 prod):
  uv run python tests/integration/verify_retrain_lambdarank_new_fm.py 500 6

argv: [num_boost_round] [n_folds] [version_suffix?]
"""

from __future__ import annotations

import json
import sys

from quant_pipeline.training.runner import train_model

FS = "fs_60bc257fb173"


def main() -> int:
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 500
    n_folds = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    suffix = sys.argv[3] if len(sys.argv) > 3 else None
    # 注入 today 以便 smoke / 重跑不撞 model_version 唯一约束。
    today = "20260607" + (suffix if suffix else "")

    print(f"[retrain] fs={FS} rounds={rounds} n_folds={n_folds} version_date={today}", flush=True)
    try:
        result = train_model(
            FS,
            model="lgb-lambdarank",
            walk_forward=True,
            seed=42,
            hyperparams=None,  # DEFAULT_HYPERPARAMS,与 prod 一致
            walk_forward_params={
                "n_folds": n_folds,
                "embargo_days": 21,
                "min_train_days": 252,
                "lgb_num_boost_round": rounds,
            },
            with_shap=False,
            today_yyyymmdd=today,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[retrain] FAILED -> {type(exc).__name__}: {exc}", flush=True)
        return 1

    print(f"\n[retrain] OK run_id={result.model_run_id} version={result.model_version}", flush=True)
    oos = result.oos_metrics
    keys = ["ndcg@5", "ndcg@10", "ic", "rank_ic", "walk_forward"]
    brief = {k: oos.get(k) for k in keys if k in oos}
    print(f"[retrain] oos(primary lambdarank)={json.dumps(brief, ensure_ascii=False, default=str)}", flush=True)
    ab = oos.get("ab_summary", {})
    for name in ("linear", "gbdt-pointwise", "lgb-lambdarank", "ensemble"):
        m = ab.get(name, {})
        if m:
            print(
                f"[ab] {name:14s} ndcg@5={m.get('ndcg_at_5_mean')} "
                f"ndcg@10={m.get('ndcg_at_10_mean')} ic={m.get('ic_mean')} "
                f"rank_ic={m.get('rank_ic_mean')}",
                flush=True,
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
