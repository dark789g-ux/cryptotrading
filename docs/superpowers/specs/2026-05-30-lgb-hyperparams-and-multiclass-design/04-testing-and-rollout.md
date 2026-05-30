# 04 · 测试、验证与文件改动清单

> 上级：[index.md](./index.md)。

## 文件改动清单

### 前端（apps/web）

| 文件 | 动作 | 要点 |
|------|------|------|
| `components/quant/train-modal/LgbHyperFields.vue` | 新建 | 9 个 lgb 树参数，lgb 系复用 |
| `components/quant/train-modal/FeatureLabelFields.vue` | 新建 | 特征/标签参数，仅 E2E |
| `components/quant/train-modal/TrainE2EFields.vue` | 改 | factor_version 下拉、两个 n-collapse、model 联动扩展、组件条件渲染 |
| `components/quant/train-modal/QuantTrainTriggerModal.vue` | 改 | 普通 train 区挂 LgbHyperFields（early_stopping disabled） |
| `components/quant/train-modal/buildParams.ts` | 改 | 打包 hyperparams + 特征/标签参数；neutralize 枚举映射；winsorize 成对校验 |
| `views/quant/**` 或 api 层 | 改 | 新增 factor-versions 请求方法 |

### 后端 NestJS（apps/server）

| 文件 | 动作 | 要点 |
|------|------|------|
| `modules/quant/*.controller.ts` | 改 | 加 `GET /factor-versions`（勿加 @UseGuards） |
| `modules/quant/*.service.ts` | 改 | 查 `factors.factor_definitions` DISTINCT factor_version |

### Python pipeline（apps/quant-pipeline）

| 文件 | 动作 | 要点 |
|------|------|------|
| `worker/train_e2e_runner.py` | 改 | ValidatedParams 加字段；_validate_params 严格校验；_step_features/_step_labels 透传；_ALLOWED_MODELS 加 lgb-multiclass |
| `features/runner.py` | 改 | build_feature_matrix 签名加 neutralize_cols/robust_z/factor_clip_sigma/label_winsorize 并透传至 builder |
| `labels/runner.py` | 改 | compute_labels 加 fwd_horizon_days/max_hold_days/label_winsorize 透传 |
| `labels/fallback.py` | 改 | FWD_HORIZON_DAYS 常量→入参（默认 5） |
| `labels/strategy_aware.py` | 改 | MAX_HOLD_DAYS / WINSORIZE_LO/HI 常量→入参（默认不变） |
| `features/<feature_set_id 计算处>` | 改 | 新参数纳入哈希（先 SubAgent 定位函数） |
| `training/runner.py` | 改 | 加 lgb-multiclass 分派；hyperparams 已透传 lgb（lambdarank 现成） |
| `training/lgb_multiclass_walk_forward.py` | 新建 | 训练主路径 |
| `training/lgb_multiclass_metrics.py` | 新建 | 三分类评估（复用/抽共享） |
| `training/classification_metrics.py` | 新建(可选) | 从 lstm_metrics 抽公共三分类函数 |
| `inference/runner.py` | 改 | 按 meta.algorithm 加 lgb-multiclass 分派 |
| `inference/lgb_multiclass_predictor.py` | 新建 | 推理打分 |
| `lightgbm_lambdarank.py` | 不改 | hyperparams 覆盖已支持（:141-146） |

> NestJS `create-job.dto.ts` **不改**（params 任意 jsonb 透传）。

## 测试

### 前端（vitest）

- `LgbHyperFields`：留空字段不进 payload；越界由 n-input-number min/max 约束。
- `FeatureLabelFields`：neutralize 三档 → 正确语义映射；winsorize 只填一个时报错；条件字段随 label_scheme 显隐。
- `buildParams`：
  - E2E + lgb-lambdarank + 部分超参 → params.hyperparams 仅含已填项。
  - E2E + lgb-multiclass → 自动 dir3_band；特征参数正确打包。
  - 普通 train + lgb → p.hyperparams 不含 early_stopping_rounds。
- 命令：`pnpm --filter @cryptotrading/web test`；行数：`pnpm --filter @cryptotrading/web lint:quant-lines`；类型：`pnpm --filter @cryptotrading/web type-check`。

### 后端 NestJS（jest）

- factor-versions service：返回 DISTINCT 升序；空表返回 `[]`。
- 命令：`pnpm --filter @cryptotrading/server exec jest <pattern>`，`pnpm --filter @cryptotrading/server build`。

### Python（pytest）

- `_validate_params`：
  - 各新参数越界 → ValueError，信息含字段名+值+范围。
  - 未知 hyperparams 键 → warn + 跳过，不报错。
  - fwd_horizon_days 配非 fwd_5d_ret → warn + 忽略。
- feature_set_id 哈希（方案 A）：
  - **回归红线**：全默认配置算出的 id == 改动前 id（小样本固定输入对拍，硬断言）。
  - 不同 robust_z / neutralize_cols / clip / winsorize（非默认值）→ 不同 id。
  - 「不传」与「显式传默认值」→ **同一** id（默认值不入覆盖层）。
  - neutralize_cols 顺序无关（去重排序后同 id）。
- lgb hyperparams 透传：自定义 num_leaves 等 → 进入 `train_lambdarank` 的 params（可 mock booster 断言 params）。
- lgb-multiclass：
  - 小样本端到端：train → meta.json algorithm=lgb-multiclass、class_order 正确。
  - score = P(涨)-P(跌)；rank_in_day 降序；行数 == 全量股票数。
  - 标签护栏：喂连续标签 → 报错。
  - oos_metrics task=classification_3class，含 accuracy/macro_f1/per_class/confusion/ic/rank_ic。

### 手动验证（CLAUDE.md verification-before-completion）

- `pnpm dev` 起服务，创建一个 lgb-lambdarank E2E 任务带自定义超参 + 特征参数，SSE 跑通，`ml.model_runs.hyperparams` 落库含用户值。
- 创建一个 lgb-multiclass 任务，infer 后 `ml.scores_daily` 行数对齐当日全量。
- 查库：`docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT model_version, hyperparams FROM ml.model_runs ORDER BY created_at DESC LIMIT 3;"`

## 向后兼容

- 所有新参数可选，留空时行为与现状完全一致（默认值=原硬编码常量）。
- 既有 model（lgb-lambdarank/linear/gbdt/lstm）不受影响。
- feature_set_id 哈希采用**方案 A：仅显式非默认参数入哈希**（见 [02](./02-backend-passthrough.md#feature-set-id-哈希)）。由此「全默认配置」哈希串与历史一致 → **旧 feature_set 仍被旧任务命中**，无需重算。这是回归红线，pytest 必须断言「全默认 id == 改动前 id」（小样本固定输入对拍）。

## 并行任务切分（供 dispatching-parallel-agents）

按互不相交文件域切分，避免冲突：

```text
任务A 前端：LgbHyperFields + FeatureLabelFields + TrainE2EFields + QuantTrainTriggerModal
           + buildParams + 前端 factor-versions 请求 + vitest
任务B 后端API：NestJS controller/service factor-versions + jest
任务C Python特征/标签透传+哈希：train_e2e_runner(校验/透传) + features/runner
           + labels/runner + fallback + strategy_aware + feature_set_id 哈希 + pytest
任务D Python lgb-multiclass：runner.py 分派 + lgb_multiclass_walk_forward
           + lgb_multiclass_metrics + classification_metrics + inference 分派
           + lgb_multiclass_predictor + pytest
```

依赖关系：A 依赖 B 的接口契约（路由 + 返回结构，可先约定）；D 依赖 C 的 ValidatedParams.hyperparams 字段（C 先合或先约定 dataclass 字段）。建议顺序：C/B 先行 → A/D 跟进；或 D 与 C 串行（同改 train_e2e_runner.py / runner.py，需协调）。

> ⚠️ 任务 C 与 D 都改 `train_e2e_runner.py` 与 `training/runner.py`，**有文件重叠**，不宜完全并行——令 C 先完成这两文件的改动并合入，D 再在其上加 lgb-multiclass 分派；或合并 C+D 为一个串行 Python 任务。
