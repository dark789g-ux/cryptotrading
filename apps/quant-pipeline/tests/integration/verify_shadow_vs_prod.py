"""Phase2 对比:新重训 shadow 模型 vs 现役 prod。

两个维度:
  1) OOS 质量:shadow.oos_metrics vs prod.oos_metrics(ndcg@5/@10, ic, rank_ic)。
  2) 选股一致性:在重算后(新 close_adj) fm 上,对 20260515 分别用 shadow / prod
     固定权重 predict_one_day(只读),与存档 ml.scores_daily(旧特征算)三方对比 top-K。
     - shadow 是「训练+服务都用新 close_adj」→ 自洽(修了 problem2 错配)。
     - prod 是「旧训练 + 新特征服务」→ 错配(problem2 漂移)。

用法(pytest 不收集):
  cd apps/quant-pipeline
  uv run python tests/integration/verify_shadow_vs_prod.py lgb-lambdarank-v1-20260607-seed42
"""

from __future__ import annotations

import sys

import pandas as pd
from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.inference.runner import predict_one_day

PROD = "lgb-lambdarank-v1-20260521-seed42"
DATE = "20260515"
TOPKS = (20, 50, 100)


def _oos(s, mv: str) -> dict:
    row = s.execute(
        text("SELECT oos_metrics FROM ml.model_runs WHERE model_version=:m"),
        {"m": mv},
    ).fetchone()
    return dict(row[0]) if row and row[0] else {}


def _topk_overlap(a: pd.DataFrame, b: pd.DataFrame, k: int) -> tuple[int, int]:
    sa = set(a.loc[a["rank_in_day"] <= k, "ts_code"])
    sb = set(b.loc[b["rank_in_day"] <= k, "ts_code"])
    return len(sa & sb), max(len(sa), 1)


def main() -> int:
    shadow = sys.argv[1] if len(sys.argv) > 1 else "lgb-lambdarank-v1-20260607-seed42"
    with session_scope() as s:
        po, so = _oos(s, PROD), _oos(s, shadow)
        print(f"=== OOS 质量对比 (prod={PROD}  shadow={shadow}) ===", flush=True)
        print(f"{'metric':<12}{'prod':>14}{'shadow':>14}", flush=True)
        for k in ("ndcg@5", "ndcg@10", "ic", "rank_ic"):
            pv = po.get(k)
            sv = so.get(k)
            pv_s = f"{pv:.4f}" if isinstance(pv, (int, float)) else str(pv)
            sv_s = f"{sv:.4f}" if isinstance(sv, (int, float)) else str(sv)
            print(f"{k:<12}{pv_s:>14}{sv_s:>14}", flush=True)

        # 存档(旧特征算)
        rows = s.execute(
            text(
                "SELECT ts_code, rank_in_day FROM ml.scores_daily "
                "WHERE model_version=:m AND trade_date=:d"
            ),
            {"m": PROD, "d": DATE},
        ).fetchall()
        archived = pd.DataFrame(rows, columns=["ts_code", "rank_in_day"])

        prod_new = predict_one_day(PROD, DATE, s)[["ts_code", "rank_in_day"]].dropna()
        shadow_new = predict_one_day(shadow, DATE, s)[["ts_code", "rank_in_day"]].dropna()

    print(f"\n=== {DATE} top-K 选股对比 (archived=旧prod特征算) ===", flush=True)
    print(f"{'pair':<28}" + "".join(f"top{k:>4}" for k in TOPKS), flush=True)
    for label, df in (("prod(新fm) vs archived", prod_new), ("shadow(新fm) vs archived", shadow_new)):
        cells = []
        for k in TOPKS:
            inter, denom = _topk_overlap(archived, df, k)
            cells.append(f"{100.0*inter/denom:>6.0f}%")
        print(f"{label:<28}" + "".join(cells), flush=True)
    # shadow vs prod 都在新 fm 上(看两模型在同特征下选股差异)
    cells = []
    for k in TOPKS:
        inter, denom = _topk_overlap(prod_new, shadow_new, k)
        cells.append(f"{100.0*inter/denom:>6.0f}%")
    print(f"{'shadow vs prod(均新fm)':<28}" + "".join(cells), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
