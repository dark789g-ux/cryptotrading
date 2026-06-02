# 02 · Python 训练（PyTorch LSTM）

[← 返回 index](./index.md)

本文定义 LSTM 训练侧的所有 Python 新增/改动文件、模型结构、walk-forward 集成、
产物格式与 `oos_metrics`。前置阅读 [01-data-and-labels.md](./01-data-and-labels.md)。

## 1. 新增/改动文件总览

```text
apps/quant-pipeline/src/quant_pipeline/training/
├─ sequence_builder.py    [新] feature_matrix 宽表 → (样本, L×N, 类别, 索引)
├─ lstm_model.py          [新] torch nn.Module 定义 + 单 fold 训练循环
├─ lstm_walk_forward.py   [新] LSTM 专用 Purged Walk-Forward + 逐 fold OOS + 产物落地
└─ runner.py              [改] model=='lstm' 在第 261 行硬卡前分派到 LSTM 路径
```

设计原则：LSTM 路径**与 lgb 路径平行、独立**（分类任务、torch 训练循环、序列输入
都与 LambdaRank 不同），不强行复用 `train_walk_forward`（那是 lgb 专用、连续标签、
排序）。但**复用** `walk_forward.PurgedWalkForwardSplit` 的切分原语、
`_insert_model_run` / `_write_artifact` 的落库原语、`update_progress` 的进度原语。

## 2. `runner.py` 分派改动

现状（`runner.py` L261）：

```python
if model != "lgb-lambdarank":
    raise ValueError("M2/M3 只支持 model='lgb-lambdarank' ...")
```

改为按 model 分派（lstm 走独立路径，在 lgb 数据加载/SHAP 之前 return）：

```python
if model == "lstm":
    from quant_pipeline.training.lstm_walk_forward import train_lstm_model
    # LSTM 自带数据加载 + 序列构造 + walk-forward；不走下方 lgb 通路、不挂 lgb SHAP
    return train_lstm_model(
        feature_set_id=feature_set_id,
        seed=seed,
        job_id=job_id,
        hyperparams=hyperparams,
        walk_forward_params=walk_forward_params or {},
        progress_callback=_progress,
        today_yyyymmdd=today_yyyymmdd,
        insert_model_run=_insert_model_run,
        write_artifact=_write_artifact,
    )
if model not in ("lgb-lambdarank",):
    raise ValueError(f"不支持的 model={model!r}（支持 lgb-lambdarank / lstm）")
```

- LSTM 路径**返回同型 `TrainResult`**（`model_run_id` / `model_version` /
  `artifact_uri` / `report_uri`），让 `train_e2e_runner._normalize_train_result`
  与下游零改动。
- LSTM 路径**不调用** lgb 的 `safely_explain_after_train`（SHAP 是 LightGBM 专用，
  首版跳过，`shap_uri=NULL`）。
- `with_shap` 对 lstm 无效——分派在 SHAP 钩子之前 return，天然不触发。
- `extra_hyperparams`（factor_version / label_scheme / new_listing_min_days）的
  merge 逻辑在分派**之前**已执行（L271-274），LSTM 路径拿到的 `hyperparams`
  已含这些元字段，照常落 `ml.model_runs.hyperparams`。

## 3. `sequence_builder.py`

实现 [01-data-and-labels.md#序列构造契约](./01-data-and-labels.md#3-序列构造契约) 的契约：

```python
@dataclass(frozen=True)
class SequenceBundle:
    X: np.ndarray          # (样本数, L, N) float32
    y: np.ndarray          # (样本数,) int64  类别 0/1/2
    index: pd.DataFrame     # 列 [ts_code, trade_date]，与 X/y 行对齐
    feature_cols: list[str] # N 个因子列名（顺序固定，存 meta）

def build_sequences(df: pd.DataFrame, lookback: int, feature_cols: list[str]) -> SequenceBundle:
    """按 ts_code 分组、按 trade_date 升序滑窗。
    - 仅生成有完整连续 L 行的样本（用交易日序号判连续，不依赖自然日）
    - NaN 样本丢弃 + logger.warning（计数）
    - 绝不跨 ts_code 串窗
    - 标签整数校验：见下「标签整数护栏」
    """
```

**连续性判定**：用 `feature_matrix` 内该票实际出现的 `trade_date` 序列的相邻位置，
而非自然日差（停牌/非交易日不算断裂）。窗口取"该票最近 L 个有数据的交易日"。

### 标签整数护栏（防误配连续标签）

`feature_matrix.label` 是浮点列。三分类标签存的是 `{0.0, 1.0, 2.0}`，
还原为类别 id 需 `.astype(int)`。但若用户误把 `lstm` 配了连续标签方案
（如 `fwd_5d_ret`，label 是收益率浮点），`.astype(int)` 会**静默截断**成乱码类别。
因此 `build_sequences`（或 `train_lstm_model` 入口）**必须显式校验**：

```python
lbl = df["label"].dropna()
# 所有非空 label 必须等于其取整值，且落在 {0,1,2}
if not np.allclose(lbl, lbl.round()) or not set(lbl.round().astype(int)) <= {0, 1, 2}:
    raise ValueError(
        "LSTM 三分类要求 label 为整数类别 {0,1,2}；"
        f"检测到非整数/越界值（可能误配了连续标签方案，如 fwd_5d_ret）。"
        f"unique={sorted(set(lbl.unique()))[:10]}"
    )
y = lbl.round().astype(int).to_numpy()
```

> 这是 [04-backend-validation.md §2.1](./04-backend-validation.md#21-train_e2e_runner_validate_params)
> 所述"`lstm + fwd_5d_ret` 误配会报明确错误、不静默"的落地点——`_validate_params`
> v1 不强制 model↔scheme 配对，由此护栏在训练入口兜住，禁止静默截断（CLAUDE.md）。

## 4. `lstm_model.py`

```python
class DirectionLSTM(nn.Module):
    def __init__(self, input_size, hidden_size=128, num_layers=2, dropout=0.2):
        # nn.LayerNorm(N) → nn.LSTM(batch_first=True) → 取末步 hidden
        #   → Dropout → Linear(hidden, 3)
    def forward(self, x):  # x: (B, L, N) → logits (B, 3)
        ...

def train_one_fold(
    X_tr, y_tr, X_va, y_va, *, hyperparams, seed, progress_cb=None,
) -> tuple[nn.Module, dict]:
    """单 fold 训练循环：
      - 固定随机种子（torch / numpy / random）
      - DataLoader(batch_size, shuffle=True)
      - Adam(lr) + CrossEntropyLoss(weight=类别权重)
      - 按 epoch 训练，验证集 macro-F1 早停（patience）
      - 返回 (best_model, fold_metrics)
    """
```

### 损失与类别权重

```text
weight[c] = N_total / (3 * N_c)   # 训练集逆频率（dir3_band 用；tercile 近似均衡→≈1）
loss = CrossEntropyLoss(weight=weight)
```

### 超参（默认值；进 ml.model_runs.hyperparams）

| 超参 | 默认 | 说明 |
|------|------|------|
| `lookback` | 32 | 序列窗口（交易日） |
| `hidden_size` | 128 | LSTM 隐层维度 |
| `num_layers` | 2 | LSTM 层数 |
| `dropout` | 0.2 | 层间 dropout |
| `learning_rate` | 1e-3 | Adam lr |
| `epochs` | 50 | 最大 epoch（早停可提前） |
| `batch_size` | 512 | mini-batch |
| `patience` | 8 | 早停耐心（验证 macro-F1 无提升） |
| `seed` | 42 | 随机种子 |

缺省值集中在 `lstm_model.DEFAULT_LSTM_HYPERPARAMS` 常量，前端不传则后端补默认
（单一真理源，前端 placeholder 仅提示，不重复 hardcode 默认值）。

### 输入归一化与已知张力（横截面 z-score 时序水平不可比）

**张力**：`feature_matrix` 的特征在 `features/builder.py` 是「逐交易日横截面 z-score」
（每个 `trade_date` 截面内标准化）。LSTM 把同一股票连续 L 天的横截面 z-score 堆成
序列喂入，而每天截面 `mean/std` 不同——「昨天 z=1.5」与「今天 z=1.5」对应不同原始
量级，**时序水平不可比**，削弱 LSTM 学时序形态的能力。这是**设计层张力**，非崩溃 bug。

**为何不彻底修**：真正对症的修复需在特征侧保留原始量级 / 截面 `mean·std`，即改动
`features/builder.build_feature_set_id` 的**哈希契约**。该契约一旦变更，全部历史
`feature_matrix` 失效（口径漂移），代价不可接受——**硬约束禁止**。

**采用的最小缓解（方案甲）**：在 `DirectionLSTM` 输入处加 `nn.LayerNorm(input_size)`
（对 `(B, L, N)` 的最后一维 N 做 per-timestep 跨特征归一）。

- 解决到什么程度（诚实边界）：LayerNorm 稳定每个时间步内各特征的相对尺度、抑制
  个别日截面 std 异常导致的水平漂移、改善训练数值条件；但**不直接「恢复跨日可比」**
  ——绝对水平信息在做 z-score 时已丢失，模型内无法找回。
- 为何无泄漏 / 训练推理一致：LayerNorm 仿射参数（`input_norm.weight/bias`）是模型
  权重，随 `model.pt` 的 `state_dict` 落盘；推理侧用同一 `DirectionLSTM` 构造 +
  `load_state_dict` 自动复现，**变换完全一致**，`meta.json` **无需新增任何统计量
  字段**，不存在「用未来 / 全样本统计」的泄漏面。
- 为何不用「序列级 per-feature 时序标准化」：横截面 z-score 本身每日 `mean≈0/std≈1`，
  全局时序标准化收益微弱，却需把 per-fold 统计量存进 `meta.json` 并在推理对齐，
  引入 meta 往返与防泄漏负担，不划算。

未尽事项：若后续要真正恢复跨日可比，须在特征侧另立新 `feature_set`（新哈希、不复用
历史矩阵），而非在 LSTM 侧补救。

## 5. `lstm_walk_forward.py`

```python
def train_lstm_model(feature_set_id, *, seed, job_id, hyperparams,
                     walk_forward_params, progress_callback,
                     today_yyyymmdd, insert_model_run, write_artifact) -> TrainResult:
    # 0%  加载 feature_matrix（复用 runner._load_feature_matrix）
    # 10% gate_check（复用 training_pregate）
    # 10-70% Purged Walk-Forward 逐 fold：
    #        每 fold 内 build_sequences(train) / build_sequences(valid) → train_one_fold
    #        累计逐 fold oos（分类指标 + 排序指标）
    # 70-85% 全量重训最终模型（或取最后 fold 模型）→ 产物
    # 85-100% _insert_model_run + _write_artifact
```

### 泄漏防护：embargo 扩容

```text
PurgedWalkForwardSplit 现有 embargo_days（默认 21）防"训练标签泄漏到验证窗"，
且源码 walk_forward.py 有硬下限 _MIN_EMBARGO_DAYS = 21（强制 embargo >= 21，财报窗口约束）。
LSTM 额外引入 L 天回看 → 验证样本的输入窗口可能回看进训练区。
故 embargo 必须把三者一并纳入 max：
   embargo_eff = max(walk_forward_params.embargo_days, lookback + 1, 21)
                 │                                      │            └ 既有硬下限 _MIN_EMBARGO_DAYS
                 │                                      └ LSTM 回看窗 + label_horizon(=1)
                 └ 调用方显式传入（默认 21）
例：lookback=32 → embargo_eff=33（> 21，自动覆盖硬下限，不绕过）。
确保任一验证样本的 [t−L+1 .. t] 输入窗 + t+1 标签都不与训练集 trade_date 重叠。
此扩容在 lstm_walk_forward 内计算后传给 PurgedWalkForwardSplit；因已 >= 21，
不会触碰、也不重复施加 PurgedWalkForwardSplit 内部的 _MIN_EMBARGO_DAYS 地板。
```

### oos_metrics 结构（写 ml.model_runs.oos_metrics, jsonb）

```json
{
  "task": "classification_3class",
  "accuracy": 0.41,
  "macro_f1": 0.39,
  "per_class": {
    "down":  {"precision": 0.4, "recall": 0.38, "f1": 0.39, "support": 1200},
    "flat":  {"precision": 0.43,"recall": 0.5,  "f1": 0.46, "support": 2100},
    "up":    {"precision": 0.4, "recall": 0.35, "f1": 0.37, "support": 1180}
  },
  "confusion_matrix": [[..],[..],[..]],
  "ic": 0.03, "rank_ic": 0.041,
  "fold_metrics": [ { "fold": 1, "train_dates": "...", "valid_dates": "...",
                      "accuracy": .., "macro_f1": .., "ic": .. }, ... ]
}
```

- `ic` / `rank_ic` 按**排序分 = P(涨) − P(跌)** 与真实次日收益算（让现有
  `OosTrendChart` / Overview 不空；混淆矩阵走新前端组件，见
  [05-frontend.md](./05-frontend.md)）。
- `confusion_matrix` 行=真实类、列=预测类，顺序 [down, flat, up]。

## 6. 产物与 model_version

```text
artifact 目录 ./artifacts/<run_uuid>/
  ├─ model.pt     torch.save(model.state_dict())
  └─ meta.json    {input_size, lookback, hidden_size, num_layers, dropout,
                   feature_cols(顺序), label_scheme, class_order:["down","flat","up"]}
model_version = f"lstm-v1-{today_yyyymmdd}-seed{seed}"   # 与 lgb 命名风格一致
artifact_uri  = "./artifacts/<run_uuid>/model.pt"
```

`meta.json` 的 `feature_cols` 顺序 + `lookback` 是推理复现的关键，
[03-inference.md](./03-inference.md) 据此重建序列。

下一篇：[03-inference.md](./03-inference.md)
