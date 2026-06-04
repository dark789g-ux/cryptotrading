# 01 · 两层标签模型与数据模型

← 回到 [index.md](./index.md)

## 两层标签模型

一条「命名标签定义」拆成基础层 + 分类层，**底层连续值按基础层去重共享**：

```text
┌─ 一条「命名标签定义」 ──────────────────────────────────┐
│                                                         │
│  基础层（base_type + base_params）  ←── 只算/存一份连续值│
│   · fwd_ret      第 N 天涨跌幅（horizon=1 即"第二天"）   │
│   · strategy_aware  固定策略涨跌幅（T+1 入场、规则出场） │
│                                                         │
│  分类层（classify_mode + classify_params）←── 不物化     │
│   · NULL      连续值（回归/排序模型用，如 LambdaRank）   │
│   · band(ε)   |r| ≤ ε 判横盘                            │
│   · tercile   截面三分位                                │
│   · custom    自定义分位/阈值边界                        │
└─────────────────────────────────────────────────────────┘
```

举例：「次日涨跌·横盘±0.5%」`[fwd_ret h1 | band 0.5%]` 与「次日涨跌·横盘±1.0%」
`[fwd_ret h1 | band 1.0%]` 是两条标签，但底层共享同一份 `fwd_ret_h1` 连续值。

## 新表 `factors.label_definitions`

PK 仿 `factor_definitions` 用 `(label_id, label_version)`。

```text
factors.label_definitions
┌────────────────┬───────────────────┬──────────────────────────────┐
│ 列             │ 类型              │ 说明                         │
├────────────────┼───────────────────┼──────────────────────────────┤
│ label_id       │ varchar(64)       │ PK，稳定标识 next_day_band05 │
│ label_version  │ varchar(16)       │ PK，'v1' 起；语义改→递增版本 │
│ name           │ text NOT NULL     │ 人类可读名 次日涨跌·横盘±0.5%│
│ base_type      │ text NOT NULL     │ fwd_ret / strategy_aware     │
│ base_params    │ jsonb NOT NULL    │ {"horizon":1} / {"max_hold_  │
│                │   DEFAULT '{}'    │   days":20}                  │
│ classify_mode  │ text NULL         │ NULL=连续 · band/tercile/    │
│                │                   │   custom                     │
│ classify_params│ jsonb NOT NULL    │ {"eps":0.005} / {} / 分位边界│
│                │   DEFAULT '{}'    │                              │
│ description    │ text NULL         │ 中文描述                     │
│ enabled        │ bool NOT NULL     │ 启停（训练下拉只列 enabled） │
│                │   DEFAULT true    │                              │
│ display_order  │ int NOT NULL      │ 前端排序                     │
│                │   DEFAULT 0       │                              │
│ created_at     │ timestamptz       │ 项目规则：时间列一律         │
│                │   NOT NULL now()  │   timestamptz                │
└────────────────┴───────────────────┴──────────────────────────────┘
PK: (label_id, label_version)
INDEX: (enabled, base_type) 供前端筛选
```

- **不加 CHECK 枚举**：`base_type`/`classify_mode` 合法值权威在 Python labels 模块；
  DB CHECK 会成第三处真相源、加新类型要改 migration。校验交后端 DTO + Python（见
  [06-validation-and-testing.md](./06-validation-and-testing.md)）
- **不加外键**到 `labels`/`feature_sets`——沿用项目"字符串契约、不加 FK"的惯例
  （见 `factor_definitions` 先例）

## `factors.labels` / `feature_sets` 零结构变更

解耦**不改这两张表的结构**，只改 Python 写入 `scheme` 列的**值**：

```text
factors.labels      表结构不动；scheme 从"含分类键 dir3_band_eps0050"
                    → "基础键 fwd_ret_h1"（只存连续涨跌幅）；历史行原样保留
factors.feature_sets 表结构不动；scheme 列同理写 base_scheme
```

## `feature_set_id` 哈希语义改动（核心权衡）

**现状**（见 [`2026-05-30-lstm-real-ic-and-dir3-eps-design`](../2026-05-30-lstm-real-ic-and-dir3-eps-design/02-a2-dir3-eps-configurable.md)）：
`build_feature_set_id` 对含 `label_scheme` 的元组做确定性哈希。dir3 的 ε 被**编进 scheme
串**（`dir3_band_eps0080`）一起进哈希，所以不同 ε → 不同 `feature_set_id` → 各自一份特征集。

**改造后**：

```text
feature_set_id 哈希输入：... + base_scheme（如 fwd_ret_h1）
                              ▲ 只含基础键，分类参数(ε/分位)不进哈希
feature_matrix.label = 基础连续涨跌幅（不离散）
分类发生在 training/runner.py 读出 label 之后
  ⇒ 同一 feature_set 可喂给不同 ε/分位的训练 → 改阈值不重算 labels/features
```

**代价与缓解**：训练目标不再由 `feature_set_id` 单独确定，而由 `feature_set + 标签定义(含分类)`
共同确定。缓解——`ml.model_runs.hyperparams` **必须**记下引用的 `label_id` + `label_version`
（含完整 `classify_mode`/`classify_params`），靠它精确追溯可复现。

## 与现有 dir3_scheme.py「ε 编进 scheme」机制的关系

2026-05-30 为避免缓存污染，引入 `labels/dir3_scheme.py` 把 ε 编进 scheme 串。本设计的
"分类后移"让这套机制对**新路径不再必要**：ε 走 `classify_params`、训练时用、不进任何 scheme 串
也不进哈希。处理方式：

- `dir3_scheme.py` 的**编码**（ε→scheme）对新路径废弃；**解码/识别**（`parse_dir3_band_eps`/
  `is_dir3_band_scheme`）保留，用于识别库里**历史** dir3 数据。注意默认 ε=0.005 的历史
  scheme 是**裸串 `'dir3_band'`**（`dir3_scheme.py:68` 确认，`'0050'` 永不产出），
  `dir3_band_epsNNNN` 仅对应非默认 ε（向后兼容）
- 新建标签的横盘阈值一律走 `classify_params.eps`，由 `classify.py` 在训练时消费
  （见 [02-python-pipeline.md](./02-python-pipeline.md)）
