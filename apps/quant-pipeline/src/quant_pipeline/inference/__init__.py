"""inference 模块（M3 起实装）。

子模块：
  - score_writer：写 ml.scores_daily（严格行数校验 + rank_in_day）
  - runner：推理主框架（进入前必须先调用 quality 的推理前必检），按 meta.json
    的 algorithm 字段分派 lgb / lstm 预测路径
  - lstm_predictor：LSTM 当日推理（序列窗口 + torch state_dict）
"""

from quant_pipeline.inference.lstm_predictor import predict_one_day_lstm
from quant_pipeline.inference.runner import (
    predict_one_day,
    run_inference,
    runner_entrypoint,
)
from quant_pipeline.inference.score_writer import (
    ScoreRowCountMismatch,
    compute_rank_in_day,
    write_scores,
)

__all__ = [
    "ScoreRowCountMismatch",
    "compute_rank_in_day",
    "predict_one_day",
    "predict_one_day_lstm",
    "run_inference",
    "runner_entrypoint",
    "write_scores",
]
