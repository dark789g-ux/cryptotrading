# Code Review 跟进：`training/` + `evaluation/` 修复评审

> 评审对象：`apps/quant-pipeline/src/quant_pipeline/training/` 与 `evaluation/`
> 承接文档：[04-training.md](04-training.md)（首轮训练子系统评审）
> 本轮提交：`c773f0d`（测试集泄漏）、`37af60d`（口径/方法论 #3–#9）
> 评审重点：本轮针对训练 / 评估子系统的二次审查所发现问题的修复落地情况、与代码的一致性核对，以及如实记录未根治的遗留项。
> 使用方式：本文是 04 的延续。04 关注首轮已知问题；本文记录在 spec 02/03（lgb-multiclass、LSTM）通路上发现的新问题与本轮修复。在用本子系统指标做模型决策前，先读「三、遗留 / 未根治问题清单」了解残余偏差。

## 一、背景

首轮评审（04-training.md）聚焦 lambdarank / linear / gbdt 三组对照的老通路。此后新增的 spec 02（lgb-multiclass walk-forward）与 spec 03（LSTM walk-forward）两条通路引入了同源但回归的问题，最严重的是**把 OOS 测试折同时当作早停 / 选最优轮次（epoch）的验证集，再在同一折报告 OOS 指标**——即用测试集做模型选择，使 OOS 系统性乐观。这正是 04-#12 在 lambdarank 单 fold 通路修过的问题在新通路里复发。

本轮分两次提交处理：`c773f0d` 修测试集泄漏（🔴 #1、#2），`37af60d` 修剩余口径 / 方法论项（#3–#9）。

## 二、已修复项

### 🔴 #1 lgb-multiclass walk-forward 测试集泄漏（提交 c773f0d）
- **问题**：`lgb_multiclass_walk_forward._train_one_fold` 把 OOS 测试折当作 `valid_data` 传入 LightGBM 用于早停 / 选最优轮次，又在同一测试折上报告 OOS 指标。
- **根因**：早停验证集与评估集同源，模型选择偷看了测试集，OOS 乐观偏差。
- **修复**：`valid_data` 改由调用方从**训练折时序尾部**切出 inner-validation；`X_eval`（测试折）仅用于 `predict`，不再参与早停。切不出 inner-val 时退化为不早停。
- **文件**：`training/lgb_multiclass_walk_forward.py`、新增 `training/walk_forward.py::time_series_inner_split`。

### 🔴 #2 LSTM walk-forward 测试集泄漏（提交 c773f0d）
- **问题**：`lstm_walk_forward._run_folds` 把测试折当作早停 + 选最优 epoch 权重的验证集；更严重的是该折的「分类指标」实际来自 `val == test`，即直接是测试折指标。
- **根因**：同 #1，叠加 fold 分类指标口径错误（指标基于验证集而验证集即测试集）。
- **修复**：fold 内从训练折切 inner-val 专供早停 / 选 epoch；测试折只用于评估；**fold 分类指标改为基于测试折重算**（与 OOS 语义对齐）。切不出 inner-val 时跳过该折。
- **文件**：`training/lstm_walk_forward.py`、`training/walk_forward.py`。

### #1/#2 共用机制：`time_series_inner_split`
- 新增 `training/walk_forward.py::time_series_inner_split(trade_dates, *, val_ratio=0.2, embargo_days)`：把一个训练折按交易日时序切成 `(inner_train_pos, inner_val_pos)`，inner-val 取时序尾部 `ceil(n_uniq*val_ratio)`（至少 1）个交易日的全部行，inner-train 取其前段再去掉尾部 `embargo_days` 个交易日做 gap。
- **防泄漏要点**：inner-train 与 inner-val 之间留 embargo（lgb 用外层 `embargo_eff`、LSTM 用 `lookback+1` 防序列回看 + 次日标签跨界）；同一交易日所有行整体落一侧（不拆截面）；交易日不足时回退 `(arange(n), empty)`，由调用方决定退化为不早停 / 跳过该折。
- **测试**：`test_inner_val_split`（尾部性、embargo gap、不拆截面、不足回退）、`test_lgb_multiclass`（早停验证集与 OOS 测试折零交集、全来自训练区）、`test_lstm_walk_forward_embargo`（传给早停的验证序列 == inner-val 且 != 测试折）。

### #3 portfolio Sharpe 年化持仓天数按 label_scheme 解析（提交 37af60d）
- **问题**：Sharpe 年化用的平均持仓天数此前为固定经验值，与实际 label 视界脱钩。
- **修复**：新增 `evaluation/portfolio.py::resolve_avg_hold_days(label_scheme)`，依据**官方 labels 实现常量**解析持仓视界，不凭 scheme 名猜：
  - `fwd_5d_ret` → `fallback.FWD_HORIZON_DAYS` = 5
  - `dir3_band` 家族（含 `dir3_band_epsNNNN` 全部 ε 变体）/ `dir3_tercile` → `direction_3class.DIR3_HOLD_DAYS` = 1
  - `strategy-aware` → 变长 1~20，无逐笔 hold_days 时用经验均值 `_DEFAULT_AVG_HOLD_DAYS` = 10
  - 未知 scheme 或 `None` → `logger.warning` + 回退 10.0（不静默，符合 CLAUDE.md「未命中映射必须 warn」）
- **接线**：`compare_three` / `run_ab_compare` 新增 `label_scheme` 参数并透传到 `compute_portfolio_metrics`；`walk_forward_runner` 从 `hyperparams` 取 `label_scheme` 接通生产路径。默认 `None` 时行为与改动前完全一致（向后兼容）。
- **文件**：`evaluation/portfolio.py`、`evaluation/ab_compare.py`、`training/walk_forward_runner.py`。测试 `test_portfolio_hold_days`、`test_ab_compare`。

### #4 Optuna 调参 = 评估的乐观偏差（提交 37af60d）
- **问题**：Optuna 的 best_value 来自参与搜参的同一 OOS 段，消费者可能误把「in-tuning OOS」当干净泛化指标。
- **修复**：
  - 新增可选 `holdout_n_folds`（默认 0 = 关闭，完全向后兼容）。启用时按交易日切出独立 holdout 评估区（与调参区之间留 `embargo_days` gap、holdout 严格在调参区之后、绝不进任何调参折），best_params 在调参区全量训练后于 holdout 报告干净 OOS（`holdout_metrics`）。数据不足自动回退默认 in-tuning 路径，照常标注 `optimistic_bias=True`（不静默伪装）。
  - 无论哪条路径都如实标注 `objective_source`（`in_tuning_oos` | `holdout_oos`）、`optimistic_bias`（bool）、`best_value_kind`、`holdout_evaluated`、`holdout_metrics`，落 `ml.model_runs.oos_metrics`。
- **文件**：`training/tuning.py`（新增 `_split_tuning_holdout_dates`、`_evaluate_on_holdout`）。测试 `test_tuning`。

### #5 LSTM 横截面 z-score 时序不可比 → 输入 LayerNorm（提交 37af60d）
- **问题**：特征侧做的是横截面 z-score（每日截面内标准化），跨交易日尺度不可比，LSTM 序列输入存在尺度漂移。
- **修复（缓解，非根治）**：`DirectionLSTM` 输入处加 `nn.LayerNorm(input_size)`（对每个时间步、跨 N 个特征归一化），稳定输入尺度。权重随 `state_dict` 落盘，推理自动一致、无泄漏、**不改 `feature_set_id` 哈希**。
- **诚实标注**：LayerNorm 是 per-timestep 跨特征归一，能稳输入尺度但**不等于**时序可比；根治需在特征侧另立 feature_set（改 `features/builder.build_feature_set_id`）。代码与 spec 文档均明确记为缓解。
- **文件**：`training/lstm_model.py`、spec 文档 `docs/superpowers/specs/2026-05-30-lstm-quant-module-design/02-python-training.md`。测试 `test_lstm_input_norm`。

### #6 feature_matrix 重复加载 → 明确不加缓存（提交 37af60d）
- **问题**：评估通路可能重复加载 feature_matrix，存在重训 / 重载的性能浪费。
- **决定**：经评估**明确不加缓存**。`lru_cache` 会破坏大量依赖 monkeypatch 的单测、且跨 job 有陈旧数据风险——正确性优先于性能。改为在 `runner.py` docstring 指引调用方在外层复用。
- **文件**：`training/runner.py`（docstring）。

### #7 seed_avg child job 永久 running → finalize 防御 + reap 兜底（提交 37af60d）
- **问题**：seed averaging 的 child job 若 finalize 失败可能永久停留在 `running`。
- **修复**：finalize-success 加 `try/except` 防御；未 finalize 的 child 由 dispatcher 的 `reap_stale_running_jobs`（heartbeat 超时 3 分钟）兜底回收。
- **文件**：`training/seed_averaging.py`。测试 `test_training_seed_averaging`。

### #8 portfolio 折边界换手不连续 → 保守近似，文档化保留（提交 37af60d）
- **问题**：`compute_portfolio_metrics` 每折独立调用、`prev_holdings` 每折从空集起算，故每折首笔 turnover 恒为 1.0。walk-forward 跨折 concat 时，折边界处那笔会被多计一次 100% 换手成本（上一折期末持仓与本折期初持仓的真实重叠未衔接）。
- **决定**：判定为**保守近似**——成本高估使指标更难看、不会粉饰。默认 6 折下边界笔占比小，暂作文档化近似保留，留待事件驱动持仓回测统一处理。
- **文件**：`evaluation/portfolio.py`（注释，未改算法）。

### #9 lgb-multiclass final booster meta 标注对齐 lambdarank（提交 37af60d）
- **问题**：final booster 全量重训且无早停，`best_iteration` 等 meta 易被误读为「早停选出的最优轮次」。
- **修复**：`used_hp` 标 `early_stopping=False` + `best_iteration=num_boost_round`，对齐 lambdarank 口径，防误读。
- **文件**：`training/lgb_multiclass_walk_forward.py`。测试 `test_lgb_multiclass`。

## 三、遗留 / 未根治问题清单（重要，如实记录）

以下问题本轮**未根治**或有意保留近似，使用本子系统指标前需知晓：

1. **#5 仅缓解，未根治**：LayerNorm 稳定输入尺度但不等于「时序可比」。根治需改特征侧 `feature_set_id` 哈希（另立一套带原始量级 / 截面 mean·std 的 feature_set），影响面大，本轮未做。

2. **#4 holdout 默认未开启**：`holdout_n_folds` 默认 0 = 关闭。默认路径仍是 in-tuning OOS，只是如实标注了 `optimistic_bias=True`，并非默认给出干净泛化指标。需手动开启 holdout 才有 `holdout_oos`。

3. **#8 折边界换手为保守近似**：跨折 concat 时折边界笔多计一次 100% 换手成本，未做跨折 `prev_holdings` 衔接。方向偏保守（成本高估），但数值不精确。

4. **#6 性能问题保留**：feature_matrix 重复加载未通过缓存解决，仅以 docstring 指引外层复用。若调用方不复用，仍有重复加载开销。

5. **前导训练窗不作 OOS（PurgedWalkForwardSplit 固有，非缺陷 —— 已复查纠正）**：复查 `split` 实现，每折训练集 = 该折测试窗之前的**全部**交易日 − embargo（`train_end_exclusive = test_start - embargo_days`），随折扩张，本身即 **expanding-window + purge/embargo**。首轮「只测后半段」属措辞夸大：真实含义仅为「前 `min_train_days + embargo_days` 天不作任一折 OOS」，而这是任何 walk-forward（含纯 expanding）的固有限制（第一折必须保留训练数据），改纯 expanding 无法消除、去掉 embargo 反而引入泄漏。故本轮**确认无需改、也不应改**。如需让 OOS 更密 / 更靠前，应增大 `n_folds` 或前移 `test_pool_start`（属调参，非改架构）。

6. **三组对照 NaN 输入口径差异**：04-#16 指出 linear baseline 用 `fillna(0.0)` 而 GBDT/LambdaRank 原生支持 NaN，三组对照输入口径不一致，本轮未统一。

7. **`portfolio_annual_after_cost` 字段命名误导**：该字段在止血后实际承载「单笔净收益中位数」（`net_return_median`），并非年化值（见 `evaluation/report_generator.py`、`ab_compare.py`）。字段名暂留不改（避免 DB / server / 前端连锁改动），属命名债。

8. **市值中性化为单变量近似**：现有中性化为单变量近似处理，非严格多因子中性化（遗留近似）。

9. **全项目 pre-existing mypy / ruff 债**：本轮未引入新增 lint / 类型债，但项目存量 mypy / ruff 告警未在本轮清理。

10. **`test_factors_runner` 2 个 pre-existing 失败**：factors 子系统有 2 个**改动前即存在**的失败，与本轮 training / evaluation 改动无关，本轮不处理。

## 四、验证情况

- 提交信息记录：相关单测 **282 passed**，**0 回归**。
- 唯二的失败为 `test_factors_runner` 的 2 个 **pre-existing** 失败（factors 子系统存量问题，非本轮引入、与训练 / 评估改动无关）。
- 本轮**未引入**新增 lint / 类型债（项目存量债见遗留项 #9）。
- 说明：上述测试数与失败计数取自提交信息（`37af60d`），本文档为代码评审跟进、未在本会话重跑全量测试套件复核该计数。

## 五、与代码核对结论

逐条核对了两次提交的 diff 与当前源码，文档所述修复与代码实现**一致**，关键点均已落地验证：
- `time_series_inner_split` 存在于 `training/walk_forward.py` 并导出，切分 / embargo / 回退逻辑与 #1/#2 描述吻合。
- `resolve_avg_hold_days` 存在于 `evaluation/portfolio.py`，常量来源（`FWD_HORIZON_DAYS` / `DIR3_HOLD_DAYS=1` / strategy-aware=10）与 labels 子包实际常量一致；未命中走 `logger.warning` 回退 10.0。
- `tuning.py` 的 holdout 切分、`optimistic_bias` / `objective_source` / `best_value_kind` 等标注字段均落实。
- `lstm_model.py` 的 `nn.LayerNorm(input_size)` 输入归一化已加，spec 文档同步记录为缓解。
- `portfolio_annual_after_cost` 命名误导项经核实仍存在（实际承载单笔净收益中位数），属本轮**有意保留**的命名债。

文档已按 `04-training.md` 既有风格（`> 评审对象` 头、🔴/🟡/🟢 与编号、文件路径标注）对齐。
