# A1 · LSTM 的 IC/RankIC 用真实次日收益

> 入口见 [index.md](./index.md)。本文档定义 A1 的实现设计。

## 问题

`oos_metrics.ic / rank_ic` 应是 **排序分 `score=P(涨)−P(跌)`** 与 **真实次日收益** 的相关性，
但当前用类别序数 `{0,1,2}` 作退化代理：

```text
apps/quant-pipeline/src/quant_pipeline/training/lstm_walk_forward.py:200-202
  # true_ret：dir3 方案下 feature_matrix 不含连续收益，用真实类别序数（0/1/2）
  # 作单调代理（...退化口径），仍反映方向排序力。
  true_ret = y_true.astype(np.float64)        # ← {0,1,2}，不是真实收益
```

后果：IC/RankIC 反映方向排序力但非真实收益相关性，对实盘价值判断失真。

## 目标

让 `oos_metrics.ic / rank_ic` 基于**真实次日后复权收益**：

```text
r = close_adj(t+1) / close_adj(t) − 1      # 与 direction_3class 算 dir3 标签同源
```

分类主指标（accuracy / macro_f1 / 混淆矩阵）**不动**；只修排序兼容指标。

## 架构

新增单一职责模块 **`training/forward_returns.py`**：给定验证样本的
`(ts_code, trade_date)` 列表，回表算每个样本真实次日后复权收益，**仅供 oos 指标上报**，
不进训练、不改 labels / feature_matrix schema、不动决定性哈希。

### helper 契约

```python
# training/forward_returns.py
def load_forward_returns(
    pairs: list[tuple[str, str]],      # [(ts_code, trade_date=YYYYMMDD), ...]
    *, session=None,                   # 可注入 session 便于测试；None 走 session_scope()
) -> dict[tuple[str, str], float]:
    """返回 {(ts_code, trade_date): r}。
    取不到 t+1 收益的样本（停牌/退市/末日）**不出现在 dict 里**（由调用方填 NaN）。
    口径：r = close_adj(t+1)/close_adj(t) − 1，后复权同 direction_3class。
    """
```

实现要点：
1. 由 `pairs` 求涉及 `ts_code` 集合与日期跨度 `[minDate .. maxDate]`；查 `raw.daily_quote`
   + `raw.adj_factor` 需把上界延到 `maxDate` 之后若干交易日（取 t+1 用），复用
   `labels/runner._compute_end_padded` 的尾部缓冲思路或直接多取 N 个交易日。
2. **复用 `_common.apply_hfq`** 注入 `close_adj`（唯一 hfq 源，只读 import，不改 `_common`）。
3. 组内 `sort_values(["ts_code","trade_date"])` 后 `groupby("ts_code").shift(-1)` 取
   `close_adj(t+1)` 与 `trade_date(t+1)`；`r = c_t1/c_t - 1`，过滤 `c_t>0 & c_t1.notna()`。
4. 只保留 `pairs` 请求到的 `(ts_code, t)` 键回填 dict。

> **单一真理源说明**：hfq 计算复用 `apply_hfq`（共享）。`r = c_t1/c_t-1` 这 1 行算术在本模块
> 内实现并注释「口径同 `labels/direction_3class.compute_dir3_labels`，权威定义在彼处」。
> 这是 A1 选「最小侵入」的代价：1 行收益定义的轻微重复，换取 A1/A2 文件域完全不相交、可并行。
> 严格单一源备选（抽 `forward_return_1d` 到 `_common.py` 两处共用）会让 A1 触碰
> `direction_3class.py`、与 A2 文件域重叠 → 只能串行；本设计**不采用**。

## 数据流

```text
┌──────────────────────────────────────────────────────────────────┐
│ _run_folds 逐折循环（lstm_walk_forward.py）：                       │
│   bundle_va.index [ts_code, trade_date] ──┐                        │
│   score = P涨−P跌  ───────────────────────┤ 按相同行序累计          │
│   y_true / y_pred ────────────────────────┘ 新增 val_index_all     │
│   （删除 true_ret = y_true.astype(...) 这一行及其退化注释）          │
└───────────────────────────┬──────────────────────────────────────┘
                            ▼  所有折跑完
   val_index_all → 全量 pairs list[(ts_code, trade_date)]
                            ▼
   load_forward_returns(pairs) → dict[(ts_code,trade_date) → r]
                            ▼
   按 score_all 行序构造 true_ret_all：命中取 r，未命中填 NaN
                            ▼
   build_oos_metrics(..., true_ret=true_ret_all)
     → score_ic_rank_ic 计算前 mask NaN 对（score 与 true_ret 同步剔除）
     → logger.warning 暴露覆盖缺口：缺 N / 共 M + 样例 (ts_code,date)
```

### buffer 改动（关键：行序对齐）

`_run_folds` 当前累计 4 个 buffer `[y_true_all, y_pred_all, score_all, true_ret_all]`。
改为：
- **删除** 折内 `true_ret = y_true.astype(np.float64)` 与 `true_ret_all.extend(...)`；
- **新增** `val_index_all`：每折 `val_index_all.append(bundle_va.index)`（与 score 同序）；
- 折后 `concat(val_index_all)` 得 pairs，调 `load_forward_returns`，按行序映射成
  `true_ret_all`（命中 r / 未命中 NaN），再交 `build_oos_metrics`。

**概念区分**（避免「折后 append」误读）：
- 折内 buffer 减为 3 个 `[y_true_all, y_pred_all, score_all]` + 新 `val_index_all`；
  `true_ret_all` **不在折内累计**（折内不再有 `true_ret_all.extend`）。
- 折后由 `load_forward_returns` 结果**按 `score_all` 行序整体一次性构造** `true_ret_all`
  （命中 r / 未命中 NaN），再以原 `[y_true_all, y_pred_all, score_all, true_ret_all]`
  4 元组形态交回下游解包（`lstm_walk_forward.py:338` 的 `... = buffers`），保持下游解包
  签名不变、`train_lstm_model` 主流程零改动。

## `lstm_metrics.score_ic_rank_ic` 改动

- **新增 NaN 处理**：计算 Pearson(IC)/Spearman(RankIC) 前，对 `true_ret` 为 NaN 的位置
  生成 mask，`score` 与 `true_ret` 同步剔除；有效样本不足 2 个 → 返回 NaN。
- 删除函数顶部「退化代理」契约注释，改写为「真实次日后复权收益相关性」口径说明。
- 函数签名不变（仍 `score_ic_rank_ic(score, true_ret)`），仅内部增 NaN 健壮性。

## 错误处理（CLAUDE.md 硬约束）

- 取不到收益样本 → NaN → 从 IC/RankIC 剔除 + `logger.warning`（暴露覆盖率：缺 N/共 M +
  样例），**禁止**用 0 或类别序数静默填充。
- 全部 NaN（DB 异常返回空 / 覆盖为 0）→ `ic = rank_ic = NaN` + warning，**不**让训练崩溃
  （分类主指标不依赖此路径）。
- `load_forward_returns` 内**双路径 warn**：① DB 查询 0 行；② 部分 (ts_code,t) 无 t+1
  收益。附 apiName 语义标识与缺口计数，禁 `.catch/except` 静默吞。

## 文件域

```text
新 apps/quant-pipeline/src/quant_pipeline/training/forward_returns.py
改 apps/quant-pipeline/src/quant_pipeline/training/lstm_walk_forward.py  (_run_folds buffer + 折后查收益)
改 apps/quant-pipeline/src/quant_pipeline/training/lstm_metrics.py        (NaN mask + 注释改写)
新 apps/quant-pipeline/tests/unit/test_forward_returns.py
改 apps/quant-pipeline/tests/unit/test_lstm_metrics*.py / test_lstm_walk_forward_embargo.py
```

A1 **不触碰** `labels/`（仅只读 import `_common.apply_hfq`）→ 与 A2 文件域不相交。

## 测试（DB 用 monkeypatch/桩，不连线上）

| 用例 | 断言 |
|------|------|
| `load_forward_returns` 正确 join | 注入桩 quotes/adj_factor，r 与手算后复权值吻合 |
| NaN 样本剔除 + warn | 含停牌/末日样本 → 不在 dict；调用方填 NaN；捕获 warning 文本含缺口计数 |
| IC/RankIC 数值 | 已知 score vs true_ret → 与手算 Pearson/Spearman 吻合 |
| NaN mask | true_ret 含 NaN → 剔除后计算；有效 <2 → NaN |
| `_run_folds` 行序对齐 | val_index_all 与 score_all 同序，映射后 true_ret 与样本一一对应 |
| 不破坏分类指标 | 既有 accuracy/macro_f1/混淆矩阵测试全过 |

验证命令见 [03-partition-and-validation.md](./03-partition-and-validation.md#a1-验证)。
