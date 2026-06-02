# 01 · 数据与标签（三分类）

[← 返回 index](./index.md)

本文定义 LSTM 三分类训练所需的**标签方案**、它在 `factors.labels` 的落地，
`feature_set_id` 的决定性约束，以及**序列构造契约**（供
[02-python-training.md](./02-python-training.md) 实现）。

## 1. 三分类标签方案

LSTM 预测**次日（t+1）方向**，三类：`{跌=0, 横盘=1, 涨=2}`。
「横盘」的划定有两种方案，由前端 `label_scheme` 下拉切换（用户决策"两种可配"）：

```text
次日收益定义（与现有 fwd 标签同口径，后复权）：
  r = close_adj(t+1) / close_adj(t) − 1      # 单交易日前向收益

方案 A  dir3_band（固定阈值带）：
  r > +ε   → 涨(2)
  |r| ≤ ε  → 横盘(1)
  r < −ε   → 跌(0)
  ε = 0.005（0.5%）　v1 固定为模块常量（见 §4 决定性说明）

方案 B  dir3_tercile（截面三分位）：
  对每个 trade_date 截面内所有股票按 r 排序
  前 1/3 → 涨(2)　中 1/3 → 横盘(1)　后 1/3 → 跌(0)
  类天然均衡；并列值按稳定排序切分
```

**类别不均衡**：`dir3_band` 三类天然不均衡（横盘通常偏多），LSTM 训练用
`CrossEntropyLoss(weight=...)`，权重按训练集逆类频率计算（见
[02-python-training.md#损失与类别权重](./02-python-training.md#损失与类别权重)）。`dir3_tercile` 天然均衡，权重退化为 1。

## 2. `factors.labels` 落地

现有表 `factors.labels` 的 PK 为 `(trade_date, ts_code, scheme)`，列含
`value`(浮点) / `exit_reason` / `hold_days`。三分类**复用该表**，无需 schema 变更：

```text
trade_date  ts_code   scheme        value  exit_reason  hold_days
20260529    000001.SZ dir3_band     2.0    NULL         1
20260529    000002.SZ dir3_band     1.0    NULL         1
20260529    000001.SZ dir3_tercile  2.0    NULL         1
```

- `value` 存类别 id（0.0 / 1.0 / 2.0），下游 `feature_matrix.label` 承载为浮点，
  训练入口再 `.astype(int)` 还原类别。
- `exit_reason = NULL`，`hold_days = 1`（次日方向，持有 1 日语义）。
- 写入走现有 `labels/runner._upsert_labels`（PK 去重 + `ON CONFLICT DO UPDATE`，
  无需改）。

### 新增计算函数

在 `apps/quant-pipeline/src/quant_pipeline/labels/` 下新增 `direction_3class.py`：

```python
SCHEME_DIR3_BAND = "dir3_band"
SCHEME_DIR3_TERCILE = "dir3_tercile"
DIR3_BAND_EPS = 0.005  # v1 固定；见 04 决定性说明，禁改为运行时参数

def compute_dir3_labels(inputs, scheme: str) -> pd.DataFrame:
    """从后复权 daily_quote 算次日收益 r，按 scheme 分桶成类别。
    返回列 [ts_code, trade_date, scheme, value, exit_reason, hold_days]。
    每票末 1 行（无 t+1）被 shift 丢弃属正常。
    """
```

- 复用 `labels/_common.apply_hfq` 注入 `close_adj`（与 `fwd_5d_ret` 同源，
  避免复权口径双源真理）。
- 复用 `labels/runner.compute_labels` 的数据加载、新股过滤
  (`new_listing_min_days`)、退市/停牌过滤逻辑——`compute_dir3_labels` 只负责
  "r → 类别"这一步，加载与过滤仍由 `compute_labels` 统一编排（见
  [04-backend-validation.md §2.2](./04-backend-validation.md#22-labelsrunnercompute_labels)）。

### 空数据硬约束（CLAUDE.md）

- 区间内 `daily_quote` 一行没有 → `RuntimeError`（确凿数据缺口，不伪装完成）。
- `compute_dir3_labels` 原始输出（区间过滤前）为空 → `RuntimeError`。
- 区间过滤后合法为空（末 1 行被 shift） → `logger.warning` + `return 0`，**不 raise**
  （与 `fwd_5d_ret` 行为一致）。

## 3. 序列构造契约

序列**建在 `feature_matrix` 之上**（已中性化 + z-score 的宽表）。契约如下，
由 [02-python-training.md](./02-python-training.md) 的 `sequence_builder.py` 实现：

```text
输入: df  列含 [trade_date, ts_code, <因子列 f1..fN>, label]
      L  lookback 窗口长度（超参，默认 32 交易日）

对每个目标行 (ts_code=c, trade_date=t)：
  seq = 该 c 在 [t−L+1 .. t] 共 L 行的因子向量（按 trade_date 升序）  → 形状 (L, N)
  y   = 该行 label（类别 0/1/2）
  仅当该 c 在窗口内有完整 L 行连续交易日数据才生成样本；不足 → 丢弃

硬约束（防泄漏 / 防串窗）：
  · 窗口只在同一 ts_code 内取，绝不跨股票拼接
  · 因子列顺序固定（与训练时一致，存入 meta.json 供推理复现）
  · 缺失值：feature_matrix 已做截面中位数填充；若仍有 NaN → 该样本丢弃并 warn
  · 输出携带索引 (ts_code, trade_date)，供 walk-forward 按 trade_date 切分
```

### feature_set_id 决定性

`feature_set_id` 由 `features/builder.build_feature_set_id` 对
`(factor_version, label_scheme, new_listing_min_days, neutralize_cols, robust_z,
factor_ids)` 做确定性哈希。**关键约束**：

> `label_scheme` 是哈希输入之一 → 不同标签方案天然得到不同 `feature_set_id`，
> 缓存隔离正确。因此 `dir3_band` 与 `dir3_tercile` 必须是**两个独立 scheme 字符串**，
> 不能把"band vs tercile"或 ε 做成不进哈希的旁路参数（否则两种配置会哈希到同一
> `feature_set_id` 造成缓存污染）。

**ε 固定为常量**（`DIR3_BAND_EPS = 0.005`）正是为此：若 ε 可运行时配置，它必须
进哈希，否则破坏决定性。v1 固定 ε，后续如需开放则新增 scheme 字符串（如
`dir3_band_1pct`）而非加旁路参数。`lookback` 等 LSTM 超参**不影响标签/特征**，
不进 `feature_set_id`，仅进 `ml.model_runs.hyperparams`。

## 4. 数据流小结

```text
raw.daily_quote(+adj_factor)
   │ compute_dir3_labels（次日 r → 类别）
   ▼
factors.labels(scheme=dir3_band|dir3_tercile, value=类别)
   │ build_feature_matrix（透视因子 + 中性化 + z-score + 内连 labels）
   ▼
factors.feature_matrix(trade_date, ts_code, f1..fN, label=类别浮点)
   │ sequence_builder（按 ts_code 沿时间堆叠 L 天）
   ▼
(样本, L×N 序列, 类别) → LSTM
```

下一篇：[02-python-training.md](./02-python-training.md)
