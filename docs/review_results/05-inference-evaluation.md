# Code Review：`inference/` 推理 + `evaluation/` 评估子系统

> 评审对象：`apps/quant-pipeline/src/quant_pipeline/inference/` 与 `evaluation/`
> 涉及文件：`inference/runner.py` `inference/score_writer.py`、`evaluation/{portfolio,ranking_metrics,report_generator,ab_compare,shap_explainer}.py`
> 评审重点：推理逻辑、PIT 违规、指标计算正确性、性能。
> 使用方式：新会话打开本文。优先级：先与 labels 模块对齐 label 的成本口径与持仓 horizon 定义，再回头修 portfolio/ranking_metrics。

## 🔴 严重

### 1. `evaluation/portfolio.py:136` — 交易成本被双重扣除
`labels/strategy_aware.py:443` 处 `value = gross - ROUND_TRIP_COST` —— label 本身已扣过一次往返交易成本。而 `portfolio.py` 又在 `cost = turnover * (commission_rate + slippage_rate)` 处对同一笔持仓再扣一次。`net_return_*` 对交易成本重复计费。
**修复**：明确成本口径。要么 label 用 `gross`、portfolio 独占成本扣减；要么 portfolio 不再扣 turnover 成本（label 已是净值）。需与 labels 模块对齐 `ROUND_TRIP_COST` 与 `commission_rate+slippage_rate` 的关系。

### 2. `evaluation/portfolio.py:121-141` — turnover 成本错配到收益日，且 label horizon 口径自相矛盾
`compute_portfolio_metrics` 文件头 docstring 第 33 行写「label 视为『当日选股 → 持有到下个交易日的净收益率』」，与 portfolio.py 顶部止血说明（持仓 1~20 日）**直接矛盾**。对 label 语义没有统一认知。连带问题：
- Sharpe 的 `sqrt(252)` 年化是否成立取决于 label 是单日还是多日 horizon。
- `equity = (1+returns).cumprod()` 把多个重叠持仓期的收益按日复利——同一只股票在持仓窗口内会被多个 `trade_date` 重复计入，`cumprod` 跨重叠持仓期累乘几乎肯定高估净值。
**修复**：先和团队确认 label 到底是单日还是多日 horizon，再决定 Sharpe 年化与 equity 复利的算法。

### 3. `inference/runner.py:72-95` — `_load_model_run` 对同名 model_version 取行不确定
`SELECT ... WHERE model_version = :mv LIMIT 1` 没有 `ORDER BY`。若同一 `model_version` 存在多条 `ml.model_runs`（重训、walk-forward 会产生多条），`LIMIT 1` 返回哪条由 PG 物理顺序决定，可能取到旧 artifact / 错误 `feature_set_id`。推理用错模型是静默的正确性事故。
**修复**：加 `ORDER BY created_at DESC`；若业务上 model_version 应唯一，应加唯一约束。

## 🟡 中等

### 4. `inference/runner.py:215-222` — 缺失股票静默填 NaN，score_writer 行数校验形同虚设
`predict_one_day` 把 `daily_quote` 里有、但 feature_matrix 缺特征的股票补成 `score=NaN` 行。于是 `write_scores` 的 `enforce_row_count` 永远相等（这里凑齐了行数），「所有股票均有评分」的硬约束被「有 NaN 评分的行」满足。这正是 CLAUDE.md 反复强调的「数据残缺被伪装成完整」。
**修复**：NaN score 的股票数量应显式 `logger.warning`（带计数/ts_code 列表），让特征覆盖不足可见。

### 5. `shap_explainer.py:115` — `feats.get(col)` 真值判断 + 重复调用
写法绕且 `feats.get(col)` 调用两次。与 `runner.py:137` 的 `is not None` 写法应保持一致。
**修复**：简化为 `v = feats.get(col); rec[col] = float(v) if v is not None else np.nan`。

### 6. `evaluation/ab_compare.py:118` — LambdaRank 预测用 `X_test.values` 绕过列名
`booster.predict(X_test.values)` 用 ndarray 预测时 LightGBM 不校验列顺序。当前由 `_flatten_features` 保证同序，暂安全。
**修复**：统一传 DataFrame，让 LightGBM 做列名校验，与 inference 的列顺序契约一致。

### 7. `evaluation/ranking_metrics.py:62` — NDCG 用 `2^gain - 1`，gain 是连续收益率会数值爆炸
`ndcg_at_k` 的 gain = `np.clip(labels, 0, None)`，labels 是收益率。label 量级可达 +11（1100%），`np.power(2.0, 11)` ≈ 2048，对大 label 指数爆炸，NDCG 完全由极端值主导，失去排序质量意义。评估侧直接吃原始连续 label，与训练侧 `_label_to_cross_sectional_rank` 的整数 rank 口径不一致。
**修复**：评估 NDCG 时也把 label 转为有界整数 gain（如截面分位 0..4），或改用线性 gain。当前 NDCG 数值不可信。

### 8. `inference/runner.py:276` — gate_check 的 quality 写入与主 scores 事务关系需确认
`run_inference` 先 `gate_check`（可能写 quality_reports），再 `with session_scope()` 写 scores。`gate_check` 内部 quality 写入与主 scores 事务不在同一事务——若是有意为之（gate 失败时 quality 记录需保留），建议补注释说明。非 bug。

### 9. `evaluation/portfolio.py:160` — 小样本 Sharpe 极不稳定
`n_days` 很小时（walk-forward 单折测试集可能只有几天）Sharpe 极不稳定，`report_generator` 直接展示会误导。
**修复**：report 中对 `n_days < 20` 的 Sharpe 标注不可靠。

## 🟢 建议

- **10.** `inference/runner.py:48-63` 与 `shap_explainer.py:55-65` 的 `_resolve_artifact_local_path` 完全重复。抽到 `utils/paths.py`。
- **11.** `inference/runner.py:_attach_rank_in_day` 与 `score_writer.py:compute_rank_in_day` 重复实现 rank。`_attach_rank_in_day` 对 NaN 做了 `fillna(-inf)`，`compute_rank_in_day` 没有——若调用方不经 `predict_one_day` 直接调 `write_scores`，NaN score 的 rank 会是 NaN，`int(...)` 抛 `ValueError`。统一用一个实现（`compute_rank_in_day` 补 NaN 处理）。
- **12.** `shap_explainer.py:88-121` `_load_sample_features` docstring 说「取最近 n_samples/5 个交易日」，实际 SQL `ORDER BY trade_date DESC, ts_code LIMIT n_samples*3`，截断让最后一个交易日样本不完整。docstring 与实现不符。
- **13.** `score_writer.py:114` 去重 `keep="last"` 与上游 concat 顺序耦合，脆弱（当前 `missing` 列表构造正确所以安全）。
- **14.** `ab_compare.py` 442 行内大量延迟 import 防循环依赖，提示 `evaluation` 与 `training` 存在循环依赖结构，建议梳理模块边界。
- **15.** `report_generator.py:33-37` `_EXPECTED_RANGES` 的 key 与 `_troubleshooting` 的 `map_key` 手工维护易漂移，建议加单测断言 key 一致性。

## 总评

子系统功能链路完整、防御性注释充分，但存在一个确定的正确性 bug（交易成本在 label 与 portfolio 双重扣除）和一个对 label horizon 语义认知不统一的根因问题——后者连带影响 Sharpe 年化、equity 复利、NDCG gain 口径三处指标的可信度。`portfolio.py` 的「止血」只解决了年化爆炸的表象，收益统计口径尚未真正理清。**优先级：先与 labels 模块对齐 label 的成本口径与持仓 horizon 定义，再回头修 portfolio/ranking_metrics。**
