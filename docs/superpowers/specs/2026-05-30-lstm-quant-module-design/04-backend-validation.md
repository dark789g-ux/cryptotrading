# 04 · 后端校验（白名单同步收口）

[← 返回 index](./index.md)

本文集中收口"新增 `lstm` 模型 + `dir3_*` 标签方案"涉及的所有**白名单/校验**改动。
其它文档引用本文，避免散落漏改。

## 1. NestJS：无需改动（重要）

`apps/server/src/modules/quant/dto/create-job.dto.ts` 的 `validateCreateJob`
**只校验 `run_type` ∈ `ALLOWED_RUN_TYPES`**，对 `params` 仅校验"是对象"，
**不校验 `params.model` / `params.label_scheme`**。其源码注释明确：

> 内部字段不在 NestJS 侧校验，由 Python worker 按 §4.1 schema 校验
> （避免双重 schema 维护）。

`run_type='train_e2e'` 与 `'train'` / `'infer'` 已在 `ALLOWED_RUN_TYPES` 中。
故 **NestJS 层零改动**——LSTM 不引入新 `run_type`，沿用 `train_e2e` / `train` / `infer`，
算法由 `params.model='lstm'` 路由。

> 这纠正了一个常见误判：以为要改 NestJS DTO 白名单。实际不需要。

## 2. Python 白名单：两处必改

### 2.1 `train_e2e_runner._validate_params`

文件：`apps/quant-pipeline/src/quant_pipeline/worker/train_e2e_runner.py` L39-40

```python
# 现状
_ALLOWED_SCHEMES = {"strategy-aware", "fwd_5d_ret"}
_ALLOWED_MODELS = {"lgb-lambdarank", "linear", "gbdt"}

# 改为
_ALLOWED_SCHEMES = {"strategy-aware", "fwd_5d_ret", "dir3_band", "dir3_tercile"}
_ALLOWED_MODELS = {"lgb-lambdarank", "linear", "gbdt", "lstm"}
```

`_validate_params` 的其余校验（factor_version / new_listing_min_days / date_range /
walk_forward / seed）对 LSTM 完全适用，无需改。

> **语义护栏**（建议）：`lstm` 应配 `dir3_*` 标签，`lgb-lambdarank` 应配排序标签。
> v1 不在 `_validate_params` 强制 model↔scheme 配对（保持松耦合，允许实验组合），
> 但前端下拉默认联动（见 [05-frontend.md](./05-frontend.md)）降低误配概率。
> 若选 `lstm` + `fwd_5d_ret`（连续标签），LSTM 训练入口会因 label 非整数类别而
> 报明确错误（见 [02](./02-python-training.md) 的 `.astype(int)` 前置校验），不静默。

### 2.2 `labels/runner.compute_labels`

文件：`apps/quant-pipeline/src/quant_pipeline/labels/runner.py` L271-275

```python
# 现状：scheme 不在白名单 → NotImplementedError
if scheme not in (LABEL_SCHEME, SCHEME_FWD_5D_RET):
    raise NotImplementedError(...)

# 改为：放行 dir3_* 并分派到 compute_dir3_labels（见 01-data-and-labels.md §2）
if scheme in (SCHEME_DIR3_BAND, SCHEME_DIR3_TERCILE):
    labels_df = compute_dir3_labels(
        FallbackInputs(daily_quotes=quotes, ...同 fwd 的过滤上下文...),
        scheme=scheme,
    )
    # 区间过滤 + 空数据硬约束同 fwd_5d_ret 分支（见 01 §2 空数据硬约束）
elif scheme == LABEL_SCHEME:
    ...  # 现有 strategy-aware
elif scheme == SCHEME_FWD_5D_RET:
    ...  # 现有 fwd_5d_ret
else:
    raise NotImplementedError(...)
```

`compute_dir3_labels` 复用 `fwd_5d_ret` 同款 `FallbackInputs`（后复权报价 +
停牌/退市/新股过滤上下文），仅"r → 类别"逻辑不同。`SCHEME_DIR3_BAND` /
`SCHEME_DIR3_TERCILE` 常量定义在新文件 `labels/direction_3class.py`，
由 `labels/runner.py` import。

## 3. 前端下拉：第三处

见 [05-frontend.md#下拉同步](./05-frontend.md#1-下拉同步)。要点：

- `TrainE2EFields.vue`：`ModelKind` 加 `'lstm'`、`modelOptions` 加 LSTM 项；
  `LabelScheme` 加 `'dir3_band' | 'dir3_tercile'`、`labelSchemeOptions` 加两项。
- `QuantTrainTriggerModal.vue`：`trainModelOptions` 加 LSTM 项。
- `buildParams.ts`：`TrainTriggerFormShape.train.model` 类型加 `'lstm'`。

## 4. 白名单同步检查清单（落地时逐项核对）

```text
☐ train_e2e_runner._ALLOWED_MODELS   += 'lstm'
☐ train_e2e_runner._ALLOWED_SCHEMES  += 'dir3_band','dir3_tercile'
☐ labels/runner.compute_labels        放行 dir3_* → compute_dir3_labels
☐ training/runner.py 第261行分派        model=='lstm' → train_lstm_model
☐ inference 分派                        meta.algorithm=='lstm' → lstm_predictor
☐ 前端 TrainE2EFields modelOptions      += LSTM
☐ 前端 TrainE2EFields labelSchemeOptions += dir3_band/tercile
☐ 前端 QuantTrainTriggerModal trainModelOptions += LSTM
☐ 前端 buildParams TrainTriggerFormShape.train.model 类型 += 'lstm'
☐ NestJS create-job.dto                 —— 无需改动（已确认）
```

> 这份清单是"白名单三处同步"硬约束的执行版。任一处漏改的具体失败现象：
> - 漏 `_ALLOWED_MODELS` → train_e2e job 在 `_validate_params` 抛 ValueError，job=failed
> - 漏 `compute_labels` 放行 → labels step 抛 NotImplementedError
> - 漏 `runner.py` 分派 → 走 lgb 路径，对类别标签做排序训练，结果错乱
> - 漏前端下拉 → 用户根本选不到 LSTM

下一篇：[05-frontend.md](./05-frontend.md)
