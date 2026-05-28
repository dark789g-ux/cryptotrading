# 2026-05-29 inference-only feature_matrix（labels-optional 路径）

## 问题

`features/builder.py:466` 的 `merge_with_labels` 用 `how="inner"` 与 `factors.labels` 做内连接 → labels 缺失行 0 行进 `factors.feature_matrix`，inference 当日报"为空"。

strategy-aware 标签需要 `MAX_HOLD_DAYS=20` + T+1 ≈ 30 个未来交易日才能闭合 exit 窗（`labels/runner.py` 用 `_compute_end_padded(end, n_trade_days=30)`）。所以最新 ~30 个交易日永远无 label。

结果：M4 daily 22:00 任务设计意图是"为今日出评分"，但因 feature_matrix 当日无行，inference 永远失败；事故诊断报告见 `memory/project_m4_daily_infer_unreachable.md`。

## 设计

在 `features/builder.py` 新增 labels-optional 计算入口（**不**修改训练路径用的 `merge_with_labels` / `build_feature_matrix_from_frames`）：

- `merge_with_labels_optional(wide, labels, label_scheme)`：left join；labels 为 None / 空时也返回 wide 全行，label 列 NaN。
- `build_feature_matrix_for_inference(...)`：与 `build_feature_matrix_from_frames` 共享前 ①–④.5 步骤（pivot / 行业中位数填充 / ±3σ winsorize / 中性化 / 截面 z-score / 死因子检测），⑤ 改 left-merge，⑥ winsorize_label 跳过，⑦ `dropna(subset=feature_cols)` 保留 label NaN 行。

`features/runner.py` 加 DB IO 入口 `build_feature_matrix_inference`：跳过 `_load_labels`，其它 helper 全复用；feature_set_id 与训练共享（同 factor_version × label_scheme × new_listing_min_days × factor_ids 四元组 → 同 fsid）。

`cli.py` 加 `quant features build-inference` 子命令，与 `features build` 并列，参数同名。

## 安全性证据

**训练侧不会被 label NaN 污染**：
- `training/runner.py:289` 显式 `valid_mask = y_all.notna()`；`< 20` 有效样本则抛 ValueError 拒绝训练。
- 进 `train_walk_forward` / `train_single_fold` 的 `df_train / X_all / y_all` 都已经过 `.loc[valid_mask]` 过滤。
- 回归测试：`tests/unit/test_training_filters_null_labels.py`。

**推理侧不读 label 列**：
- `inference/runner.py:97` 的 `_load_daily_feature_section` SQL 是 `SELECT ts_code, features FROM factors.feature_matrix`，根本不取 label 列。
- 即便 label 为 NULL 也不影响 predict。

**Schema 已允许**：
- `factors.feature_matrix.label` 列无 NOT NULL 约束（migration 检查通过）。
- `_upsert_feature_matrix` 已经处理 `label: ... if pd.notna(r["label"]) else None`，写 NULL 是合法路径。

**PIT 不破坏**：
- pivot / 中性化 / z-score 都是当日截面计算，不引入跨日泄漏。
- feature_set_id 哈希包含 label_scheme，但 builder 函数本身不读 labels DF 的内容；inference / 训练共用 fsid 仅意味"特征工程口径"一致，与"是否使用 label"正交。

## 不可训练约定

任何 caller 拿到 `factors.feature_matrix.label IS NULL` 的行**禁止**直接用于训练：
- 训练统一入口 `training/runner.py train_model` 已经过滤。
- 写自定义训练脚本时必须 `WHERE label IS NOT NULL` 或 `df[df['label'].notna()]`。
- 严禁绕过 `train_model` 直接读 `factors.feature_matrix` 进训练。

## CLI 用法

为最新交易日（无 label）出评分：

```powershell
cd apps/quant-pipeline
uv run quant features build-inference --factor-version v1 --label-scheme strategy-aware `
   --date-range 20260528:20260528 --new-listing-min-days 60
uv run quant infer --date 20260528 --model-version <model>
```

历史日（已有 label）走原路径不变：

```powershell
uv run quant features build --factor-version v1 --label-scheme strategy-aware `
   --date-range 20260515:20260515 --new-listing-min-days 60
```

## 与 Daily 脚本的对接

`scripts/quant-daily/daily-sync-quality-infer.ps1` 重写为 7 stage 后，features-build 阶段直接用 `features build-inference` —— 即便 daily 脚本扩展到 T-30 同时调 `labels build`，inference 路径也不依赖那条 stage 是否提前完成；这是为了让"补跑历史日"和"每日新交易日"走同一段代码，减少分支。

## 单元测试

`tests/unit/test_features_builder_labels_optional.py`：
- `merge_with_labels_optional` 空 labels / None labels / 部分覆盖 / scheme 过滤
- `build_feature_matrix_for_inference` 全 NaN / 部分覆盖 / 与训练 fsid 一致 / feature 列 NaN 仍 drop
- 回归：`merge_with_labels`（inner）行为不变

`tests/unit/test_training_filters_null_labels.py`：
- 含 NaN label 的 feature_matrix → 训练能跑通且只用 valid 行
- valid < 20 → ValueError
