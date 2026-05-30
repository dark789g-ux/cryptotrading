# 任务 A1 · LSTM 的 IC/RankIC 用真实次日收益（消除类别序数退化代理）

> 先读本目录 [README.md](./README.md) 的共享背景与通用约束，再读本文件。

## 问题（真实技术债）

LSTM 三分类 Run 的 `oos_metrics` 里有兼容排序指标 `ic` / `rank_ic`，本应是
**排序分 score=P(涨)−P(跌)** 与 **真实次日收益** 的相关性。但当前实现是**退化代理**：

`apps/quant-pipeline/src/quant_pipeline/training/lstm_walk_forward.py:200-207`
```python
# true_ret：dir3 方案下 feature_matrix 不含连续收益，用真实类别序数（0/1/2）
# 作单调代理（lstm_metrics.score_ic_rank_ic 文档约定的退化口径），仍反映方向排序力。
true_ret = y_true.astype(np.float64)          # ← 这是 {0,1,2} 类别序数，不是真实收益
...
true_ret_all.extend(float(v) for v in true_ret)
```

`lstm_metrics.score_ic_rank_ic(score, true_ret)`（`training/lstm_metrics.py:100`）
拿这个序数当收益算 Pearson/Spearman。结果：**IC/RankIC 反映方向排序力，但不是真实收益相关性**，
对实盘价值的判断会失真。

## 目标

让 `oos_metrics.ic` / `rank_ic` 基于**真实次日收益**（后复权口径，与
`labels/direction_3class.py` 算 dir3 标签时的 `r = close_adj(t+1)/close_adj(t)-1` 同源）。
分类指标（accuracy/macro_f1/混淆矩阵）是主指标、不要动；本任务只修排序兼容指标。

## 关键事实（已核对）

- `sequence_builder.build_sequences(df, lookback, feature_cols)` 返回的 `SequenceBundle`
  含 `index: pd.DataFrame`（列 `[ts_code, trade_date]`，与 X/y 行对齐）。
  → 每个验证样本都能映射回 `(ts_code, trade_date=t)`，据此可取真实次日收益。
- dir3 标签的真实收益口径在 `labels/direction_3class.py` 已实现（后复权 r）；
  后复权工具在 `labels/_common.apply_hfq`，报价来自 `raw.daily_quote` + `raw.adj_factor`。
- `lstm_walk_forward.py` 每折循环里目前从 `y_true`（类别）造 `true_ret`；需要改成
  从该折验证样本的 `index[(ts_code,trade_date)]` 取真实收益，并把 index 一路 thread
  到累计 buffer（现在累计的是 `true_ret_all`，要保证它装的是真实收益）。

## 实现指引（先走 brainstorming 出设计，再动手）

这是改训练评估的数据流，建议先用 `brainstorming` skill 把方案敲定。三个候选：

1. **最小侵入（推荐）**：新增 helper `load_forward_returns(pairs: list[(ts_code, trade_date)]) -> dict`，
   查 `raw.daily_quote`(+adj_factor) 算每个 (ts_code,t) 的真实次日 r，**仅用于 oos 指标上报**，
   不进训练、不改 labels/feature_matrix schema。在 `lstm_walk_forward` 每折把验证 index 收集起来，
   折后统一查一次真实收益填 `true_ret_all`。
   - 优点：不动既有 schema 与决定性哈希；缺点：训练路径多一次 DB 查询（可批量、可缓存窗口）。
2. **标签侧持久化**：让 `compute_dir3_labels` 同时落一份连续收益（新列或新 scheme），
   feature_matrix 带出来。改动面大（涉及 `factors.labels` 列 / feature_matrix），慎重。
3. **训练前 join**：在 `_load_feature_matrix` 之后旁路 join 真实收益列。

无论哪种，**必须**：
- 真实收益口径与 dir3 标签同源（后复权、同一 r 定义），避免双源真理（CLAUDE.md）。
- 取不到收益的样本（停牌/退市/末日无 t+1）按 NaN 处理并从 IC 计算中剔除 + `logger.warning`
  暴露覆盖缺口，禁止用 0 或类别序数静默填充。
- 删掉 `lstm_walk_forward.py:200-201` 和 `lstm_metrics.py:10-12` 关于"退化代理"的注释，
  改成真实口径说明。

## 文件域

```
改 apps/quant-pipeline/src/quant_pipeline/training/lstm_walk_forward.py  （true_ret 来源）
改 apps/quant-pipeline/src/quant_pipeline/training/lstm_metrics.py        （注释/契约，可能无需改逻辑）
新 apps/quant-pipeline/src/quant_pipeline/training/...（如选方案1的 load_forward_returns helper）
改/新 对应单测 apps/quant-pipeline/tests/unit/
```

## 验证

```bash
cd apps/quant-pipeline
./.venv/bin/python -m pytest tests/unit/test_lstm_walk_forward_embargo.py tests/unit/test_lstm_metrics*.py -q
./.venv/bin/python -m pytest tests/unit/ -q   # 不破坏既有（注意：基线已有 19 个与本任务无关的既有失败：
                                              #   factor golden 漂移 / test_predict_one_day session=None / 连不上真实 DB）
```
新增单测至少覆盖：真实收益正确 join、NaN 样本剔除 + warn、IC 数值与已知输入吻合。

## 约束
- 新分支开发，禁推 main；不动分类主指标；单文件 ≤500 行；UTF-8、禁静默吞错。
- 真实收益取数若需连真实 DB，单测用 monkeypatch/桩，不依赖在线 DB。
