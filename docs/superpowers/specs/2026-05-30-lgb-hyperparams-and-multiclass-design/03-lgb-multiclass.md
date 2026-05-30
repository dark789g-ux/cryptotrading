# 03 · lgb-multiclass（LightGBM 三分类，照 LSTM 范本）

> 上级：[index.md](./index.md)。前端见 [01](./01-frontend.md)，后端透传见 [02](./02-backend-passthrough.md)。

## 定位与原则

新增独立模型类型 `lgb-multiclass`：LightGBM 多分类，吃 dir3 三分类标签（跌/横盘/涨），输出每类概率。**与 lstm 平行**——完全绕开 ranking 的 `compare_three`，走自己的 walk-forward 路径。实现全程对齐 LSTM 范本，最大化复用，降低风险。

固定项（不暴露给用户）：`objective="multiclass"`、`num_class=3`、`metric="multi_logloss"`。可调项 = 与 lgb-lambdarank 共享的 LightGBM 树参数（见 [01](./01-frontend.md#lgbhyperfields)，复用 `LgbHyperFields.vue`）。

类别编码（与现有 dir3 一致，`labels/direction_3class.py`）：

```text
0.0 = down 跌   1.0 = flat 横盘   2.0 = up 涨
class_order = ["down", "flat", "up"]
```

## 训练路径

### 分派（runner.py）

`training/runner.py:273` 现有 `if model == "lstm":` 分支同级加：

```python
elif model == "lgb-multiclass":
    from quant_pipeline.training.lgb_multiclass_walk_forward import train_lgb_multiclass_model
    return train_lgb_multiclass_model(
        feature_set_id=feature_set_id, seed=seed, job_id=job_id,
        hyperparams=hyperparams, walk_forward_params=walk_forward_params or {},
        progress_callback=_progress, today_yyyymmdd=today_yyyymmdd,
        insert_model_run=_insert_model_run, write_artifact=_write_artifact,
    )
```

模型白名单更新：
- `runner.py:290` 附近 `("lgb-lambdarank",)` → `("lgb-lambdarank", "lgb-multiclass")`（若该处用于"走 lgb 标准路径"的判断，需排除 multiclass——multiclass 在上面 elif 已 return，不进该判断）。
- `train_e2e_runner.py:43` `_ALLOWED_MODELS` 加 `"lgb-multiclass"`。

### 新建 training/lgb_multiclass_walk_forward.py

照 `lstm_walk_forward.py` 结构（约 250–300 行）：

```text
train_lgb_multiclass_model(feature_set_id, *, seed, job_id, hyperparams,
                           walk_forward_params, progress_callback,
                           today_yyyymmdd, insert_model_run, write_artifact)
  0%   _build_wide_df：加载 feature_matrix + 展平（复用 lstm 的 _build_wide_df 逻辑/抽公共）
  10%  quality 门禁（复用现有 gate）
       PurgedWalkForwardSplit(n_folds=6, embargo_days=max(req,21), min_train_days=252)
       —— lgb 非序列模型，embargo 无 lookback 扩容，下限 21
  10-70% _run_folds：逐折
           lgb.Dataset(X_tr, y_tr 整数类别)
           params = DEFAULT_LGB_MC_HYPERPARAMS ∪ hyperparams(覆盖)
                    + {objective:multiclass, num_class:3, metric:multi_logloss}
           booster = lgb.train(...); proba = booster.predict(X_va)  # (N,3)
           y_pred = proba.argmax(1); score = proba[:,up] - proba[:,down]
           累计 y_true / y_pred / score / true_ret
  70-85% build_oos_metrics（见下「评估」）
  85-100% 全量重训 final booster（X_all,y_all，关闭早停）
          落 model.txt + meta.json；insert ml.model_runs
  model_version = f"lgb-multiclass-v1-{today}-seed{seed}"
```

`DEFAULT_LGB_MC_HYPERPARAMS`：与 `lightgbm_lambdarank.py:DEFAULT_HYPERPARAMS` 的树参数一致，仅 objective/num_class/metric 不同。建议新建模块级常量，注释标注「树参数与 lambdarank 对齐，仅目标函数为 multiclass」。

artifact 与既有 lgb 一致用 `model.txt`（LightGBM `booster.save_model`），非 LSTM 的 `model.pt`。

### meta.json

```python
meta = {
    "algorithm": "lgb-multiclass",       # 推理分派依据
    "model_run_id": str(run_id),
    "model_version": model_version,
    "feature_set_id": feature_set_id,
    "feature_cols": feature_cols,
    "feature_columns_order": feature_cols,  # 推理列顺序契约（同 lambdarank 约定）
    "label_scheme": label_scheme,
    "class_order": ["down", "flat", "up"],
    "num_class": 3,
    "objective": "multiclass",
    "metric": "multi_logloss",
    "hyperparams": used_hp,               # 默认 ∪ 用户覆盖 ∪ seed
    "oos_metrics": oos_metrics,
    "trained_at_utc": "...",
    "latest_train_date": latest_trade_date,
    "seed": seed,
    "walk_forward": True,
}
```

> `feature_columns_order` 是**推理时列对齐的权威契约**（`lgb_multiclass_predictor` 据此重排当日特征列，顺序错位会导致打分错误）；`feature_cols` 为同值冗余/可读字段。实现时确认范本现状：lambdarank meta 用 `feature_columns`/`feature_columns_order`、lstm meta 用 `feature_cols`——两者命名不统一。lgb-multiclass **以 `feature_columns_order` 为准**，推理侧只读它；`feature_cols` 可省略，若保留须与 order 同值。不要让推理侧依赖两个可能漂移的字段。

## 评估（新建 training/lgb_multiclass_metrics.py）

直接复用 `lstm_metrics.py` 的纯函数（混淆矩阵 / per-class PRF / macro-F1 / accuracy / ic-rank_ic）。两种实现方式（实现者择一）：

- **优先**：把 `lstm_metrics.py` 的通用三分类函数抽到共享模块（如 `training/classification_metrics.py`），lstm 与 lgb-multiclass 都 import，避免复制。
- 退化：lgb_multiclass_metrics.py 直接 `from ...lstm_metrics import ...` 复用。

`build_oos_metrics` 输出（与 lstm 同构，便于前端统一展示）：

```python
{
  "task": "classification_3class",
  "accuracy": ...,
  "macro_f1": ...,
  "per_class": {"down": {...prf}, "flat": {...}, "up": {...}},
  "confusion_matrix": [[...],[...],[...]],
  "ic": ...,          # score(=P涨-P跌) vs 真实次日后复权收益 Pearson
  "rank_ic": ...,     # Spearman
  "fold_metrics": [ {fold, train_dates, valid_dates, accuracy, macro_f1, n_valid}, ... ],
  "walk_forward_params": {n_folds, embargo_days, min_train_days},
}
```

## 推理路径

### 分派（inference/runner.py）

按 `meta.algorithm` 分派（现有 lstm 分支同级加）：

```python
if algorithm == "lstm":
    return predict_one_day_lstm(model_version, trade_date, session)
elif algorithm == "lgb-multiclass":
    from quant_pipeline.inference.lgb_multiclass_predictor import predict_one_day_lgb_multiclass
    return predict_one_day_lgb_multiclass(model_version, trade_date, session)
# else: 既有 lgb-lambdarank / 标准路径
```

### 新建 inference/lgb_multiclass_predictor.py

照 `inference/lstm_predictor.py`，返回值契约一致（DataFrame[ts_code, score, rank_in_day]）：

```text
predict_one_day_lgb_multiclass(model_version, trade_date, session):
  门禁 gate_check(strict=True)（同既有 infer）
  从 ml.model_runs 取 artifact_uri → 载 model.txt（lgb.Booster）
  读 meta.json → feature_columns_order + class_order
  载当日 feature_matrix 截面，列顺序严格对齐 feature_columns_order
  proba = booster.predict(X)              # (N,3)
  score = proba[:,up_idx] - proba[:,down_idx]   # 与 LSTM 同口径
  缺票补 NaN（复用 lgb 路径 _load_all_ts_codes / 对齐 raw.daily_quote 全量）
  rank_in_day（score 降序，NaN 末尾）
  write_scores(..., enforce_row_count=True)  # 行数 == 当日全量股票数（M2 硬约束）
```

`score = P(涨) − P(跌)` 与 LSTM 完全一致，保证 `ml.scores_daily.score` 跨模型同向同口径，下游选股逻辑（按 rank_in_day / score 选 top-k）无需区分模型。

## 标签消费

无需改 `direction_3class.py` / `dir3_scheme.py`。lgb-multiclass 从 `factors.feature_matrix` 直接拿已分桶 label（0/1/2 float → 训练前 `astype(int)`）。误配（如配连续标签 strategy-aware）由训练入口标签整数护栏报错——新增护栏：训练入口校验 label 取值 ⊆ {0,1,2}，否则报错提示「lgb-multiclass 需 dir3 系标签」（对齐 LSTM 的护栏策略）。

## 联动校验

- 前端：选 `lgb-multiclass` 自动切 `label_scheme='dir3_band'`（见 [01](./01-frontend.md#联动逻辑traine2efieldsvue)）。
- 后端：保持松耦合（不在 `_validate_params` 强制 model↔scheme 配对，沿用 LSTM 现状注释 `train_e2e_runner.py:38-43`），由训练入口标签护栏兜底。

## walk_forward 开关

lgb-multiclass 始终走 walk-forward（同 LSTM，无 single_fold 变体）。前端该模型下 `walk_forward` 开关固定 true 且 disabled，或后端对该 model 忽略 walk_forward=false（实现时二选一，前端禁用更直观）。
