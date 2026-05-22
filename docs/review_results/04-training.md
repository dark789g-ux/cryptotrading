# Code Review：`training/` 训练子系统

> 评审对象：`apps/quant-pipeline/src/quant_pipeline/training/`
> 涉及文件：`runner.py` `walk_forward.py` `walk_forward_runner.py` `tuning.py` `seed_averaging.py` `lightgbm_lambdarank.py` `gbdt_pointwise.py` `linear_baseline.py` `ensemble.py`（及 `evaluation/ab_compare.py`）
> 评审重点：训练逻辑正确性、数据泄漏/前视偏差、数据完整性、性能。
> 使用方式：新会话打开本文，逐条核实后再修复。在用本子系统指标做模型决策前，先修 #1–#4 与 #8。

## 🔴 严重

### 1. `runner.py:326` + `ab_compare.py:229` — LambdaRank 标签被双重变换，破坏排序信号
WF 通路里 `train_model` 在 326 行已把连续 label 经 `_bin_labels_by_group` 分桶成 `0..4` 整数，再把这个**已分桶**的 `y_all` 传给 `train_walk_forward` → `compare_three`；`compare_three._label_to_cross_sectional_rank`（229 行）又对它做截面 `rank(method="first")`。后果：
- linear / gbdt-pointwise 的回归目标被压成 5 档台阶，丢失连续 fwd return 信息。
- LambdaRank 拿到「对 5 档分桶值再 first-rank」，同桶 tie 由出现顺序随机打破，注入伪相关性等级。
- **评估同样被污染**：`_evaluate_one_model` 的 IC / RankIC / NDCG / portfolio 全部用分桶后的 `y_test`，OOS 指标失真。
**修复**：全链路保留原始连续 `label`，只在 `train_lambdarank` 入口处（各 fold 内对 `y_train`）做一次截面 rank；评估与 portfolio 一律用原始连续 label。`_bin_labels_by_group` 应从 `train_model` 主路径移除。

### 2. `runner.py:419` — `_train_single_fold` 调用未定义的 `_progress`，单 fold 通路必崩
`_progress` 是 `train_model` 内部闭包（292 行），`_train_single_fold` 是模块级独立函数，作用域内没有 `_progress`。一旦 `walk_forward=False`，执行到 419 行 `_progress(50, ...)` 立即 `NameError`。该通路注释称「保留，仅供冷启动/调试」，实际完全不可用。
**修复**：把 `progress_callback` 作为参数传入 `_train_single_fold`，或删除其中所有 `_progress` 调用。

### 3. `walk_forward.py:165-168` — Purged WF 测试窗口只覆盖数据后半段，与 docstring 不符
`test_pool_start = min_train_days + embargo_days`，所有 n_folds 个测试窗口都从「测试池」里等分一次。`test_pool_start` 之前的 `min_train_days + embargo_days` 天交易日**永远不会**作为任何一折的测试集。docstring §5.4 描述与实现不符，OOS 评估有「只测后段」的系统性偏差。
**修复**：明确取舍——要么 expanding-window（每折训练集扩张、测试紧随其后，覆盖全时段），要么在 docstring 如实写明「前 N 日仅作训练垫底，不参与 OOS」。

### 4. `ensemble.py:48` — `cross_sectional_zscore` 用 `std` 默认 `ddof=1`
`grouped.transform("std")` pandas 默认 `ddof=1`（样本标准差）。2 个样本时 std 偏大，z-score 被压扁。A 股每日截面通常上千只，影响小，但语义应明确。
**修复**：显式 `transform(lambda s: s.std(ddof=0))`，或注明选择 ddof=1 的理由。

## 🟡 中等

### 5. `walk_forward_runner.py:114-123,164` — 生产 artifact 的 `best_iteration` 无意义
`final_booster` 用全量数据训练且关闭早停（`early_stopping_rounds=None`），`best_iteration` 恒为 0 → 落到 `current_iteration()` = `num_boost_round`。meta 里记录的 `best_iteration` 无意义。
**修复**：直接记 `num_boost_round` 或注明无早停。

### 6. `walk_forward_runner.py:190-198` — `build_ensemble_daily_returns` 完整重训三组模型，翻倍训练成本
注释自承「最廉价的方法是直接重跑一次」。`compare_three` 已在每折训练过 linear/gbdt/lambdarank 并产出预测，这里又把 6 折 × 3 模型全部重训一遍。
**修复**：让 `compare_three` 直接返回每折的 ensemble scores / daily_returns，消除重训。

### 7. `runner.py:445` / `walk_forward_runner.py:157` — `today_yyyymmdd` 用 `datetime.now()`，无法注入
单 fold 与 WF 通路都在函数内硬取 `datetime.now(timezone.utc)`。`tune`/`seed_averaging` 都支持 `today_yyyymmdd` 注入，唯独主训练通路不支持。跨 UTC 午夜运行时 `model_version` 与 `trained_at_utc` 可能落不同日期。
**修复**：统一支持注入。

### 8. `tuning.py:129` — `splits[-1]` 取最后一折，Optuna 在固定 OOS 段上调参
docstring 宣称「多 trial 累积等价于对全数据每个时间点评估」——错。每个 trial 都用 `splits[-1]` 同一折，所有 trial 在同一固定 OOS 窗口比较，等价于在该窗口上做超参 overfitting，best_params 无泛化保证。这是「在测试集上调参」的变体。
**修复**：每个 trial 跑全部折取均值，或对 OOS 段再切一层 validation。docstring 至少要如实说明这是「单折调参」。

### 9. `tuning.py:115` — `_objective_one_trial` 每个 trial 重复 `_flatten_features`
n_trials=50 就展平 50 次。
**修复**：在 `tune` 里展平一次后传入。

### 10. `tuning.py:151` / `ab_compare.py` — NDCG 的 `y_test` 用原始连续 label，gain 口径不一致
`y_train` 经 `_label_to_int_rank` 转整数喂 LambdaRank，但 `ndcg_at_k` 用的 `y_test` 是原始连续 label。两处需统一口径。
**修复**：确认 `ranking_metrics.ndcg_at_k` 对连续 label 的语义（见 05 文档问题 7）。

### 11. `seed_averaging.py:184` — 每个 seed 完整重跑 WF 训练且各自做 SHAP
5 seed × (6 折三模型对照 + final booster + `build_ensemble_daily_returns` 重训 + SHAP)。`with_shap` 默认 True，5 次 SHAP 纯属浪费。
**修复**：子 seed 训练传 `with_shap=False`。

### 12. `runner.py:317` — `_train_single_fold` 早停在 test 段偷看（泄漏）
单 fold 通路把 `(X_test, y_test, groups_test)` 作为 `valid_data` 传入并启用早停，又在同一 test 段算 OOS 指标。早停用测试集选迭代轮数 = 测试集泄漏。WF 通路无此问题（`compare_three` 默认 `early_stopping_rounds=None`）。
**修复**：单 fold 通路单独切 validation，或关闭早停。

## 🟢 建议

- **13.** `runner.py` 568 行超 500 行硬约束。`_train_single_fold`（~130 行）可拆出，或既然它实际坏掉（#2）且仅供调试，考虑直接删除。
- **14.** `_build_groups`/`_flatten_features` 在 `runner.py`、`tuning.py`、`walk_forward_runner.py`、`ab_compare.py` 各有一份几乎相同实现，已出现漂移（`runner._build_groups` 有 `.astype` 顺序差异）。抽到单个工具模块。
- **15.** `runner.py:143` 标签分桶 `((ranks-1)*n_bins/len)` 对小样本日不均匀（3 只股票 n_bins=5 → 桶 `{0,1,3}` 不连续）。配合 #1 一并修。
- **16.** `linear_baseline.py:84` 用 `fillna(0.0)` 填特征 NaN，对未标准化的原始量纲因子是错误填充；GBDT/LambdaRank 原生支持 NaN，三组对照输入口径不一致。至少 `logger.warn` NaN 比例。
- **17.** `seed_averaging.py:206` `pct = min(95, int(done/total*90))`，5 seed 时最后一档 90 永远到不了 95。进度档位小瑕疵。
- **18.** `tuning.py:305` `float(best.value or 0.0)`，习惯性 `or` 兜底建议改 `best.value if best.value is not None else 0.0`。

## 总评

子系统架构清晰、契约统一、artifact 回滚和断点续跑都考虑到位。但存在贯穿全链路的核心正确性缺陷——**标签在 WF 通路被双重变换，导致三组对照的训练目标与 OOS 评估指标全部建立在失真标签上**（#1）；单 fold 通路因 `_progress` 作用域错误直接崩溃且早停偷看测试集（#2、#12）；Purged WF 测试窗口只覆盖后段（#3）；Optuna 在固定单折调参（#8）。这四类问题直接动摇训练结果可信度，用本子系统指标做任何模型决策前先修 #1–#4 与 #8。
