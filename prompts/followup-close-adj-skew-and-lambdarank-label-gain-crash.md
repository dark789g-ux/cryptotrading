# 后续交接：close_adj train/serve 特征错配 + lambdarank label_gain 崩溃

> 这两个问题是在 **2026-06-07「生产标签重算后的模型评估(任务 H)」** 中顺带挖出的**独立既有问题**，与 bug1-5 标签重算无关。重算那摊本身已干净收口（bug1-5 对 prod 模型影响经证 ≈ 零）。本文把这两个问题完整登记，供专门任务处理。
> **接手第一件事：按下方「复现」重跑 `verify_recompute_inference_drift.py`，别信本文可能过期的数字。**

## 一句话
1. **lambdarank label_gain 崩溃**：当前 `quant evaluate` / walk-forward 训练对全市场稠密截面（~5500 票/天）必崩，挡住一切 lambdarank 重训/评估。
2. **close_adj train/serve 错配**：prod 模型 `lgb-lambdarank-v1-20260521-seed42` 训于**旧 close_adj**；`83aeda0 close_adj 纯后复权`(2026-06-06)后，fm 在同一个 `fs_60bc257fb173` 下被刷成**新 close_adj** 特征 → prod 模型被喂它没训练过的特征，live 排名漂移 ~85%（top-20）。

---

## 问题 1：lambdarank `label_gain` 崩溃

### 现象
```
uv run quant evaluate --run-id <prod uuid> --lgb-num-boost-round 500 --ab-baseline linear,gbdt
→ LightGBMError: Label 3182 is not less than the number of label mappings (31)
```
出在 `evaluation/ab_compare.py:112 _fold_predict_three` → `training/lightgbm_lambdarank.py:194 train_lambdarank` 的 `lgb.train`。

### 根因（已查实）
- `ab_compare.py:65 _label_to_cross_sectional_rank` 把每日截面 label rank 成 **0..n-1**（A 股一天数千只 → rank 上千）。
- `train_lambdarank` **从未设 `label_gain`**（`git log -S label_gain -- apps/quant-pipeline/` 为空），LightGBM 4.6.0 默认 `label_gain` 只认 label 0..30（31 项）→ label>30 即崩。
- 密度实证：`factors.labels` scheme='strategy-aware' 最密一天 **5495** 非空（`SELECT trade_date,count(*) ... GROUP BY trade_date ORDER BY 2 DESC LIMIT 1`）。

### 为何以前没崩
prod 模型建于 **2026-05-21**；改 lambdarank label/walk-forward 的提交（`1427481`/`b7f1f44`「修复 Walk-Forward 训练」/`0aca2d5`改 `_label_to_cross_sectional_rank`/`37af60d`）**全在其后**。即当前这套截面 rank → 0..n-1 的逻辑是 prod 训练之后引入的，疑似自 `0aca2d5`(05-23) 起 lambdarank 全市场训练就坏了，因之后没人跑过全量 lambdarank 重训（multiclass 是另一条通路、label 0/1/2，不受影响）。

### 修复方向（需先定语义，再 TDD）
两条候选，**择一需想清 ranking 语义**：
1. **传 `label_gain`**：在 `train_lambdarank` 按 `max_label` 动态构造 `label_gain`（长度 = 每折最大组 + 1）。保留 0..n-1 连续 rank 语义，但 gain 表巨大、且把每只票当独立相关度等级，未必是想要的 LambdaRank 语义。
2. **分桶 rank**：把截面 rank 压成少量相关度等级（如分位 0..K，K≤30，分位数/十分位）。更符合 LTR 常规，但改变 label 语义、需重验指标口径。
- **先确认**：prod 当初（崩溃前的旧代码）lambdarank 用的是哪种 label→gain，以此为基准选修法，否则又制造一次方法漂移。看 `0aca2d5`/`b7f1f44` 的 diff 还原旧逻辑。

---

## 问题 2：close_adj train/serve 特征错配

### 现象
用 prod 固定权重在**重算后** fm 上对 20260515 重打分（只读，复用 `inference.predict_one_day`），与存档 `ml.scores_daily`(旧特征算)对比：
```
同股票集合(only_in_old=0/only_in_new=0,各 5495 票)
score Pearson≈0.57  Spearman≈0.72
|Δrank| mean≈765 median≈472 p95≈2542 max≈5455
top20 重叠 3/20(15%)  top50 16%  top100 38%
```
即排名几乎重排、top-20 选股 85% 换血。

### 根因（已查实）
- **同模型、同股票集合、仅特征值变** → 漂移来自特征。
- `83aeda0 close_adj 改纯后复权,统一到 apply_hfq`(**2026-06-06**) 改了 close_adj——`fs_60bc257fb173` 的 16 因子里 12+ 个是 close 派生（bollinger_position_20d / close_to_high_60d / ma_ratio_20d / momentum_20d{,_neu} / momentum_60d / price_max_drawdown_60d / rsi_14 / volatility_20d …），close_adj 一变全变（参 记忆 `reference_factor_compute_hash`：改 close_adj 即使数学等价也逐 bit 变）。
- 时间线：prod 训于 05-21（旧 close_adj）→ close_adj 改于 06-06 → 本会话(06-07)任务 G 用当前因子代码重建 fm，把新 close_adj 物化进 fm。存档 scores 生成于五月底（旧 close_adj）。
- bug1-5 对该日特征零影响：20260515 成员两侧逐票相同，bug1-5 是标签 bug、只经 inner-join 成员影响特征。

### 系统性隐患（重点）
**`feature_set_id` 哈希只绑 `factor_version / scheme / factor_ids / new_listing_min_days / overlay`，不绑「因子计算代码版本」**。所以 `close_adj` 计算口径变了，`factor_version` 仍是 `'v1'`、fs 哈希不变、任务 G 的 fail-fast 护门也拦不住——**同一个 fs id 下特征值悄悄换了定义**，训练/推理特征因此可能错配而无人察觉。
- 建议：要么改 close_adj 这类底层口径时**bump `factor_version`**（让 fs 指纹真正区分），要么把因子计算代码哈希纳入 fs 指纹。

### 处置选项
- **重训 prod on 新特征**（在新 close_adj fm 上沿用超参重训 lambdarank）——**被问题 1 挡住**，必须先修 label_gain。promote 仍人工硬门。
- 或先 bump factor_version 厘清新旧 fs，再决定迁移。
- 注意：本项目是回测/研究系统（非实盘下单），此为研究管线正确性问题、非实盘资金风险，但 prod 日评分会持续产出错配排名。

---

## 复现
```powershell
cd apps/quant-pipeline
# 问题2 漂移度量（只读，秒级）：
uv run python tests/integration/verify_recompute_inference_drift.py
# 问题1 崩溃复现（重，会跑 walk-forward）：
uv run quant evaluate --run-id <SELECT id FROM ml.model_runs WHERE model_version='lgb-lambdarank-v1-20260521-seed42'> --lgb-num-boost-round 500
```

## 关键文件
- 漂移验证：`apps/quant-pipeline/tests/integration/verify_recompute_inference_drift.py`
- 崩溃点：`apps/quant-pipeline/src/quant_pipeline/evaluation/ab_compare.py`(`_label_to_cross_sectional_rank` / `_fold_predict_three`)、`training/lightgbm_lambdarank.py:train_lambdarank`(无 `label_gain`)
- 推理路径：`inference/runner.py:predict_one_day`（只读 predict，复用即可）
- close_adj 变更：commit `83aeda0`；记忆 `reference_factor_compute_hash`
- 模型/特征现状查询见重算 spec `docs/superpowers/specs/2026-06-06-recompute-production-labels-design/`

## 硬约束（带走）
- 不假设、暴露权衡、用中文（CLAUDE.md）。进硬断言/SQL 前自查实体或真 DB 一条。
- promote prod 模型 = 人工硬门。
- 终端 Windows PowerShell（禁 `&&`，用 `;`）；docker exec 多 `-c` 在 Windows 会卡，单 `-c`。
