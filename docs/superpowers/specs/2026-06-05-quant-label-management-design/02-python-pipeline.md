# 02 · Python pipeline 改造

← 回到 [index.md](./index.md)

## 改造前后数据流（以 dir3 次日三分类为例）

```text
【改造前】dir3 在 labels 阶段就离散，ε 进 scheme、进哈希
 labels:   close_adj ─▶ 次日收益 r ─▶ 离散 0/1/2 ─▶ factors.labels.value
           (scheme = dir3_band_eps0050)
 features: merge 已离散值 ─▶ feature_matrix.label = 0/1/2
 training: 分类模型直接吃
 ⇒ 改 ε=1% = 全新 scheme = labels + features 整张重算

【改造后】labels 只存连续值，分类后移到训练时
 labels:   close_adj ─▶ 次日收益 r(连续) ─▶ factors.labels.value
           (base_scheme = fwd_ret_h1，分类参数不进键)
 features: merge 连续值 ─▶ feature_matrix.label = 连续 r
 training: 读连续 label ─▶ classify(band ε / tercile) ─▶ 离散 ─▶ 分类模型
                          ▲ 改 ε=1% 只重跑这一步
```

## 文件改动

| 文件 | 改动 |
|---|---|
| `labels/fallback.py` | `fwd_5d_ret` 泛化为 **`fwd_ret`**，`horizon` 任意正整数；`horizon=1`="第二天涨跌幅"，`horizon=5`="5 日涨跌幅"——统一一个基础算法 |
| `labels/dir3_scheme.py` | 泛化为 **`base_scheme_codec`**：从 `(base_type, base_params)` 决定性生成 `base_scheme`，**只吃基础参数、不含分类**；保留 `parse_*`/`is_dir3_band_scheme` 用于识别历史 scheme |
| `labels/classify.py`（**新建**） | 训练时调用的**纯函数**：`classify(values, mode, params)` → 离散类别；band 阈值/tercile 分位/custom 分位边界的数学从 `direction_3class.py` 迁入 |
| `labels/direction_3class.py` | 删 labels 阶段的提前离散调用；离散数学迁出到 `classify.py`；**不再产出离散 labels** |
| `labels/runner.py` | `compute_labels` 按 `base_scheme` 物化**连续值**；该 `base_scheme` 已存在则跳过（去重共享） |
| `features/builder.py` | 基本不动——`label` 已是连续值；`label_winsorize` 保留为训练超参 |
| `training/runner.py` | `train_model` 新增 `classify_mode`/`classify_params` 入参（详见下） |
| `worker/train_e2e_runner.py` | `_validate_params` 改校验 `base_*`/`classify_*` 组合；`_step_train` 透传分类参数 |

## `base_scheme_codec`：legacy 回归约束（关键，已核对源码）

`base_scheme` 是 `factors.labels`/`feature_sets` 的物化键，也是 `feature_set_id` 哈希输入。
codec 对现存 base 组合必须保持哈希不漂移。**已核对 `fallback.py:45,147`**：现状
**所有 horizon（3/5/10）的 fwd 标签 scheme 列恒写 `'fwd_5d_ret'`**（`fwd_horizon_days`
只改 `value`/`hold_days`，不改 scheme）：

```text
fwd_ret + {horizon:5}    → 'fwd_5d_ret'   （legacy 别名；h=5 是默认/主流，保大多数历史不漂移）
fwd_ret + {horizon:N≠5}  → 'fwd_ret_h{N}' （新串，含 h=1=次日；见下"既存碰撞"）
strategy_aware           → 'strategy-aware'（沿用现状串）
```

**⚠ 既存 scheme 碰撞（现状 bug，本设计顺带修复）**：现状 h=3/5/10 全写同一 scheme
`'fwd_5d_ret'`，而 `factors.labels` PK=(trade_date,ts_code,scheme) **不含 horizon**——
库里同一 key 只能存一种 horizon，改 `fwd_horizon_days` 会**互相覆盖**。新 codec 让 h≠5
用独立串 `fwd_ret_h{N}` 从源头消除碰撞；代价是历史上曾以 `'fwd_5d_ret'` 存过的 h=3/10
数据（若有）对应的 feature_set 会变孤儿、需重算（见
[07-rollout.md](./07-rollout.md#关键风险与回滚)）。h=5（主流）不漂移。

> ⚠ **实施前仍须落源头复核**：grep 确认 `strategy-aware` 的 `max_hold_days` 是否参与
> scheme/哈希（现状 `strategy_aware.py`），codec 对应分支与现状逐字节一致。加"固定输入
> →固定哈希"回归断言守住 legacy 串（`fwd_5d_ret` / `dir3_band` / `strategy-aware`）。

## `training/runner.py`：训练时套分类

```text
train_model(..., classify_mode, classify_params):
  y = feature_matrix.label                          # 基础连续涨跌幅
  if classify_mode is None:                          # lgb-lambdarank（连续/排序）
      用连续 y（现状不变：lambdarank 入口处对 y_train 截面 rank）
  else:                                               # 分类模型 lstm(284) / lgb-multiclass(305)
      y = classify(y, classify_mode, classify_params) # 调 labels/classify.py 离散
      喂分类模型
```

分类发生在**读出 `feature_matrix.label` 之后**——这是"同一 feature_set 复用于不同 ε"
能成立的实现位置。

**误配护栏（沿用现状理念，不在校验层新增矩阵）**：`train_e2e_runner.py:38-41` 注释明确
现状**刻意不在 `_validate_params` 强制 model↔scheme 配对**（松耦合），靠训练入口 label
整数护栏兜误配。分类后移后沿用此位置：分类模型（`lstm`/`lgb-multiclass`）入口要求
`classify_mode` 非 NULL（否则连续值喂入 → 现状 label 整数护栏 raise）；`lgb-lambdarank`
要求 `classify_mode` 为 NULL。误配在训练入口 raise（fail-closed 精神不变）。完整矩阵见
[06-validation-and-testing.md](./06-validation-and-testing.md#modelclassify-兼容矩阵)。

## `worker/train_e2e_runner.py`：参数流转（方案 i）

后端已把命名标签展开成明文写进 `ml.jobs.params`（见 [03-backend.md](./03-backend.md#expandfortraining)）。
Python 侧：

```text
params = { base_type, base_params, classify_mode, classify_params,
           label_id, label_version, ... }          # 后端展开 + 透传
_validate_params:
   · 校验 base_type ∈ {fwd_ret, strategy_aware}，base_params 与之匹配
   · 校验 classify_mode ∈ {None, band, tercile, custom}，classify_params 匹配
   · base_scheme = base_scheme_codec(base_type, base_params)
_step_labels:   按 base_scheme 物化连续值（已存在则跳过）
_step_features: 按 base_scheme 建/复用 feature_set
_step_train:    classify_mode/classify_params 透传给 train_model；
                label_id/label_version 写入 ml.model_runs.hyperparams（可复现追溯）
```

Python **不读** `factors.label_definitions` 表（方案 i 的核心：params 自包含）。

> **单路径（消除新旧双路径歧义）**：现状 `_validate_params`（`train_e2e_runner.py:336+`）
> 全程围绕 `label_scheme` 入参（含 `dir3_band` canonical 化）。本设计**改为只认 `base_type`
> 新形态、移除 `label_scheme` 旧入参路径**——训练类 run_type 一律经后端 `expandForTraining`
> 展开成 `base_*`/`classify_*`，无过渡期双路径。`dir3_scheme.py` 的 `parse_*`/`is_*` 仅保留
> 用于识别库中历史 scheme 串，不再参与 `_validate_params` 入参。

## 向后兼容（不留运行死代码）

- 老 `dir3_band_epsNNNN` / `fwd_5d_ret` 的 `feature_matrix` 数据**库里原样保留**，老
  `model_run` 靠"库里已物化的历史特征矩阵"复现——**不靠重跑老代码路径**
- `direction_3class.py` 的提前离散调用**直接删除**，不留 deprecated 死分支；其分桶数学
  迁入 `classify.py` 继续服务训练时离散
- `dir3_scheme.py` 仅保留**解码/识别**能力（识别历史 scheme 串），编码不再用于新路径

## Python 文件域

```text
改 apps/quant-pipeline/src/quant_pipeline/labels/fallback.py            (fwd_ret 泛化)
改 apps/quant-pipeline/src/quant_pipeline/labels/dir3_scheme.py         (base_scheme_codec)
新 apps/quant-pipeline/src/quant_pipeline/labels/classify.py            (训练时分类纯函数)
改 apps/quant-pipeline/src/quant_pipeline/labels/direction_3class.py    (删提前离散)
改 apps/quant-pipeline/src/quant_pipeline/labels/runner.py              (按 base_scheme 物化连续值)
改 apps/quant-pipeline/src/quant_pipeline/training/runner.py            (训练时套分类)
改 apps/quant-pipeline/src/quant_pipeline/worker/train_e2e_runner.py    (_validate_params + 透传)
新 apps/quant-pipeline/tests/unit/test_classify.py
新 apps/quant-pipeline/tests/unit/test_base_scheme_codec.py
改 apps/quant-pipeline/tests/unit/test_direction_3class_labels.py
```

测试细节见 [06-validation-and-testing.md](./06-validation-and-testing.md#测试矩阵)。
