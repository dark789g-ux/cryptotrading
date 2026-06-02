# 03 · 推理（LSTM 分支，写 scores_daily）

[← 返回 index](./index.md)

本文定义 LSTM 模型的推理路径：如何在现有 `inference/runner.py` 上分支，重建序列，
产出排序分写入 `ml.scores_daily`。前置 [02-python-training.md](./02-python-training.md)。

## 1. 与 lgb 推理的关键差异

现有 `predict_one_day`（`inference/runner.py` L144）是 **lgb 专用**：
`lgb.Booster(model_file=...)`，且只读**当日单截面**特征
（`_load_daily_feature_section` 读 `factors.feature_matrix.features` jsonb 当日行）。

LSTM 推理的两点差异：

```text
1. 模型加载：torch state_dict（model.pt）+ meta.json 重建 DirectionLSTM，非 lgb.Booster
2. 输入窗口：每只股票需 [trade_date−L+1 .. trade_date] 共 L 天的特征序列，
             而非单日截面 → 必须读 L 天 feature_matrix 窗口并按 ts_code 滑窗
```

## 2. 分支策略

在 `meta.json` 增加 `"algorithm"` 字段（训练侧 [02](./02-python-training.md) 已写入）。
推理入口按 `algorithm` 分派，**不破坏现有 lgb 路径**：

```python
# run_inference / predict 入口处：
meta = _load_meta_json(model_path)
algorithm = meta.get("algorithm", "lgb-lambdarank")  # 老模型无该字段 → lgb 兜底

if algorithm == "lstm":
    from quant_pipeline.inference.lstm_predictor import predict_one_day_lstm
    df = predict_one_day_lstm(model_version, trade_date, session)
else:
    df = predict_one_day(model_version, trade_date, session)  # 现有 lgb 路径不动
```

> 兜底设计：现存所有 lgb 模型的 `meta.json` 无 `algorithm` 字段，
> `meta.get("algorithm", "lgb-lambdarank")` 让它们继续走 lgb 路径，**向后兼容**。

`run_inference` 的"前必检 gate_check → 预测 → write_scores 严格行数校验"主框架
**完全复用**（gate / 写库 / 监控钩子都与算法无关）。仅把"加载模型 + 预测"这一步
按 algorithm 分派。建议把分派逻辑收口在 `predict_one_day` 内部或 `run_inference`
内一处，避免散落。

## 3. `lstm_predictor.py`（新增）

```python
def predict_one_day_lstm(model_version, trade_date, session) -> pd.DataFrame:
    """LSTM 当日推理；返回 DataFrame[ts_code, score, rank_in_day]，与 lgb 同契约。"""
    # 1. _load_model_run → feature_set_id / artifact_uri
    # 2. 加载 meta.json：lookback L、feature_cols 顺序、class_order
    # 3. 还原 model.pt：DirectionLSTM(**结构超参) + load_state_dict
    # 4. 读 L 天窗口特征：
    #      取该 feature_set_id 下 trade_date 及其之前最近 L 个交易日的 feature_matrix
    #      （用 raw.trade_cal / feature_matrix 实际 trade_date 取"最近 L 个有数据交易日"）
    # 5. 按 ts_code 构造序列（复用 sequence_builder.build_sequences 的滑窗逻辑，
    #      但目标日固定为 trade_date；不足 L 天的票 → 无法预测，进 missing）
    # 6. 前向 → softmax → score = P(涨) − P(跌)
    # 7. 缺失票补 NaN + logger.warning（复用现有 inference_missing_feature_codes 模式）
    # 8. compute_rank_in_day 按 score desc 排名
```

### 排序分定义

```text
logits → softmax → [P(跌), P(横盘), P(涨)]      # class_order = [down, flat, up]
score = P(涨) − P(跌)   ∈ [−1, 1]
        ▲ 越大越看多 → 与 LambdaRank 的"分数越高越优"语义一致
```

写库走现有 `score_writer.write_scores(enforce_row_count=True)`，
`ml.scores_daily` schema 不变（`score` 列承载 P(涨)−P(跌)）。

## 4. 窗口读取的取数约束

```text
· "最近 L 个交易日"按 feature_matrix 中该 feature_set_id 实际存在的 trade_date 取，
  不按自然日（停牌/非交易日不算），与训练侧 sequence_builder 连续性判定一致。
· 若某票在窗口内交易日数 < L → 该票无法构造完整序列 → 计入 missing，score=NaN，
  显式 warn（禁止 pad 成假序列伪装"全覆盖"——CLAUDE.md 静默降级禁令）。
· 当日 feature_matrix 截面为空 → 维持现有 ValueError（确凿缺口）。
```

## 5. 行数校验兼容

`write_scores(enforce_row_count=True)` 校验"评分行数 == 当日 `raw.daily_quote`
行数"。LSTM 因序列窗口不足会有较多 missing（NaN score）行，但这些行**仍写入**
（score=NaN）以凑齐行数 + 已 `logger.warning` 暴露覆盖缺口——与现有 lgb 路径
"特征不足填 NaN + warn"行为一致，不改 `score_writer`。

> 注意：LSTM 上线初期，历史数据不足 L 天的票会偏多（尤其样本区间起始段），
> warn 计数会高，属预期；这是数据覆盖问题而非 bug，监控阈值需知悉（写入
> [06-deps-and-testing.md](./06-deps-and-testing.md) 验证注意事项）。

下一篇：[04-backend-validation.md](./04-backend-validation.md)
