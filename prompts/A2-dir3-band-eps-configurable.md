# 任务 A2 · `dir3_band` 横盘阈值 ε 可配

> 先读本目录 [README.md](./README.md) 的共享背景与通用约束，再读本文件。

## 问题（已知限制）

三分类标签方案 `dir3_band` 把"次日收益 |r| ≤ ε 判为横盘"。当前 ε 固定为常量
`DIR3_BAND_EPS = 0.005`（0.5%），见
`apps/quant-pipeline/src/quant_pipeline/labels/direction_3class.py`。

ε 固定**不是疏忽**，而是为保 `feature_set_id` 决定性：`features/builder.build_feature_set_id`
对 `(factor_version, label_scheme, new_listing_min_days, neutralize_cols, robust_z, factor_ids)`
做确定性哈希，`label_scheme` 是哈希输入之一。若 ε 作为不进哈希的旁路参数，两种不同 ε
会哈希到**同一** `feature_set_id` → 缓存污染（不同标签共用一份特征集）。详见
`docs/superpowers/specs/2026-05-30-lstm-quant-module-design/01-data-and-labels.md`
的「feature_set_id 决定性」一节。

## 目标

让用户能选择 `dir3_band` 的横盘阈值 ε，且**不破坏 feature_set_id 决定性**。

## 两个方案（先和用户/brainstorming 确认选哪个）

### 方案 ①：预设变体 scheme（推荐，小工作量、零哈希改动）

把若干常用 ε 做成独立 scheme 字符串，ε 编进 scheme 名（即编进哈希语义）：
```
dir3_band      ε=0.005 (0.5%)   现状保留
dir3_band_1pct ε=0.01  (1%)
dir3_band_2pct ε=0.02  (2%)
```
改动点：
```
labels/direction_3class.py     加常量 + scheme→ε 映射表，compute_dir3_labels 按 scheme 取 ε
labels/runner.py               compute_labels 放行新 scheme
worker/train_e2e_runner.py     _ALLOWED_SCHEMES 加新 scheme
apps/web 前端 TrainE2EFields.vue  LabelScheme 类型 + labelSchemeOptions 加项
```
优点：不动 build_feature_set_id 哈希契约、决定性天然成立；缺点：ε 只能从预设里选。

### 方案 ②：ε 进哈希 + 前端自由输入（真·可配，工作量大）

让 ε 成为 `build_feature_set_id` 的哈希输入之一，前端开放 ε 数字输入框。
改动点更广：
```
features/builder.build_feature_set_id   签名加 eps 参数并纳入哈希（动核心契约，需全链路核对）
labels/direction_3class.py / runner.py  compute_dir3_labels 接收 eps（不再用常量）
worker/train_e2e_runner.py              _validate_params 接收并校验 eps（范围如 0<ε≤0.1）
features/runner.build_feature_matrix    透传 eps
apps/web TrainE2EFields.vue + buildParams.ts  ε 输入框（dir3_band 时显示）+ 打进 params
```
优点：任意 ε；缺点：动 `build_feature_set_id` 这个被多处依赖的决定性契约，**风险高**，
必须核对所有调用方与既有 feature_set 的兼容（老 feature_set_id 不应被新签名改变哈希）。

> 默认建议方案 ①。除非用户明确要任意 ε，否则别动哈希契约。

## 验证

```bash
cd apps/quant-pipeline
./.venv/bin/python -m pytest tests/unit/test_direction_3class_labels.py -q
./.venv/bin/python -m pytest tests/unit/ -q   # 既有 19 个无关失败见 A1 说明
# 方案②还需：确认老 feature_set_id 哈希不变（加回归断言固定输入→固定 hash）
# 前端（任一方案动了前端）：
pnpm --filter @cryptotrading/web type-check
pnpm --filter @cryptotrading/web lint:quant-lines
pnpm --filter @cryptotrading/web test
```
单测覆盖：每个 ε 对边界 r 的分桶正确；方案①各 scheme→ε 映射正确；
方案②的 feature_set_id 随 ε 变化而变、且既有调用 hash 不漂移。

## 约束
- 新分支开发，禁推 main；UTF-8、禁静默吞错；单文件 ≤500 行。
- 白名单三处同步（labels runner / train_e2e_runner._ALLOWED_SCHEMES / 前端下拉），
  漏一处则 job 被校验挡掉——参见 spec `04-backend-validation.md` 的同步清单。
- 前端自定义 select option 接口须 `extends SelectOption`（vue-tsc 约束）。
