# 01 · 背景、口径变更、真 DB 现状与代码契约

[← 返回 index](./index.md)

本文档锁定**已落源头验证**的事实底座（真 DB 查询 + 真源码，非二手转述），后续阶段的硬断言均引用此处。

## 口径变更（bug1-4）

窗口依赖修复让逐 signal_date 的计算不再依赖加载窗口起点/长度。四个 bug 对两个 scheme 的影响：

| bug | 影响 scheme | 口径变更 | 性质 | 规模 |
|---|---|---|---|---|
| **bug1** trade_cal 漏 `exchange='SSE'` → padding 窗口减半（头部 g0_load / 尾部 end_padded）| strategy-aware + fwd_ret_h1 | padding 范围错误 | 值变（边界 MA NaN / 持仓窗口算不完）| 边界点，小 |
| **bug2** `_load_stk_limit` 只到 g1、漏 `buy_date=next_day(g1)>g1` 的涨停 | 仅 strategy-aware | 更严格剔行（漏剔涨停入场被纠正）| 剔行 | 每缺口末日次日有涨停的标的，少 |
| **bug3** `filter_new_listing` 改用全局 SSE 日历计"上市后第N交易日" | strategy-aware + fwd_ret_h1 | 更严格剔行（次新股 list_date 早于加载窗口起点的被正确剔）| 剔行 | **有界**：list_date 早于区间起点但上市<60交易日的票，集中早期 |
| **bug4** `_ensure_ma` 改 bit-stable 逐窗求和 | 仅 strategy-aware | close≈ma5 边界点出场判定翻转 | 值翻转（exit_reason/hold_days/value）| ~0.06%（前序实测）|

**关键纠偏（写进决策门）**：bug3 即便当初是"单次整段算"也会触发 —— 凡 list_date 早于区间起点 `20230103` 但上市不足 60 交易日的票，旧码漏剔。**所以差异不会精确为 0，但集中在 2023 年初。** `only_in_new`（新码新增行）预期 ≈ 0，新码只剔不增。

窗口无关原则（硬约束）三类陷阱：①滚动统计浮点累加路径（须逐窗独立求和）②按日历位置计数（须全局日历）③外部数据加载范围（须覆盖到 buy_date 最大值 end_padded）。

## 真 DB 现状（2026-06-06 快照，**执行时必重查**）

```text
factors.labels
  scheme          rows       days  range
  strategy-aware  4,283,513  812   20230103..20260515   ← 受 bug2/3/4
  fwd_ret_h1      2,528,986  484   20230103..20241231   ← 受 bug1/3

factors.feature_matrix  (= features ⋈ labels, inner join)
  feature_set_id   rows       days  range                scheme
  fs_60bc257fb173  4,285,271  813   20230103..20260528   strategy-aware
  fs_9b5ff4d69c1e  2,525,225  484   20230103..20241231   fwd_ret_h1

ml.model_runs
  model_version                      feature_set_id   status   日评分
  lgb-lambdarank-v1-20260521-seed42  fs_60bc257fb173  prod     有(20260515..28, 11001行)
  lgb-multiclass-v1-20260605-seed42  fs_9b5ff4d69c1e  shadow   无

alembic current = 20260606_0004 (head)   ✔ 无 drift
```

**待复核的不一致**：`feature_matrix fs_60bc257fb173` 到 20260528，但 `labels.strategy-aware` 快照只到 20260515（晚 13 天）。inner join 下 feature_matrix 不应超过 labels —— 很可能两次子代理查询时刻不同，或今天 prepare 已把 labels 也追到 20260528 而 labels 那条读到了更早状态。**∴ 重算范围用执行时实测 `[20230103, 真实dmax]` 动态取，不硬编码任何 dmax。**

重查命令（只读）：

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT scheme,count(*),min(trade_date),max(trade_date),count(DISTINCT trade_date) FROM factors.labels GROUP BY scheme ORDER BY scheme;"
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT feature_set_id,count(*),min(trade_date),max(trade_date),count(DISTINCT trade_date) FROM factors.feature_matrix GROUP BY feature_set_id ORDER BY feature_set_id;"
```

## 代码契约（真源码核对，apps/quant-pipeline）

> 下列文件路径均相对 `apps/quant-pipeline/src/quant_pipeline/`；行号指向相关定义/SQL 文本，执行时以函数名为准。

- `compute_labels(*, scheme, date_range, new_listing_min_days=None, fwd_horizon_days=None, exit_rules=None, label_winsorize=None, force_recompute=False, job_id=None, progress_callback=None) -> int`（`labels/runner.py:404`）。`date_range` 格式严格 **`"YYYYMMDD:YYYYMMDD"`（冒号分隔）**。
- `_upsert_labels` = `INSERT INTO factors.labels (...) ON CONFLICT (trade_date,ts_code,scheme) DO UPDATE SET value/exit_reason/hold_days`（`labels/runner.py:383`）—— **不删旧行**。`force_recompute=True` 仅跳过缺口检测、对整段重算，仍走同一条 upsert、不删行。
- `g0_load = max(start, g0 - head_pad 个 SSE 交易日)`（`labels/runner.py:199`）。head_pad = `ma_window-1`：strategy-aware + ma_break 规则 → **4**（默认 MA_WINDOW=5）；无 ma_break 或 fwd_ret → **0**。
- `build_feature_matrix(*, factor_version, label_scheme, date_range, new_listing_min_days, neutralize_cols=None, robust_z=None, factor_clip_sigma=None, label_winsorize=None, force_recompute=False, ...) -> str(feature_set_id)`（`features/runner.py:318`）。
- `_upsert_feature_matrix` = `INSERT ... ON CONFLICT (trade_date,ts_code,feature_set_id) DO UPDATE`（`features/runner.py:302`）—— 同样**不删旧行**。
- `merge_with_labels`（`features/builder.py:448`）：**inner join on (trade_date, ts_code)**，labels 侧按 `scheme == label_scheme` 过滤，取 `value` 列为 label。→ labels 重算后行集合变 → feature_matrix 必须重建。
- `build_feature_set_id(factor_version, label_scheme, *, new_listing_min_days, neutralize_cols, robust_z, factor_ids)`（`features/builder.py:62`）：6 字段 sha256 前 12 位；overlay 层（`feature_set_hash.py`）对非默认 `factor_clip_sigma`/`label_winsorize` 再叠一层。**重建前必须 dry-run 此函数断言 == 目标 fs。**

## 模型注册表（证实 `factors.model_runs` 不存在）

训练产物在 **`ml` schema**：

| 表 | 关键列 | 用途 |
|---|---|---|
| `ml.model_runs` | `model_version`(UNIQUE), `feature_set_id`, `hyperparams`(jsonb), `oos_metrics`(jsonb), `status`('prod'/'shadow'/'archived'), `artifact_uri` | 训练产物 + 模型选择 |
| `ml.jobs` | `run_type`, `params`(jsonb), `status`, `result_payload` | 作业队列；`params` 含重建 fs 所需的 overlay 参数 |
| `ml.scores_daily` | `trade_date`, `ts_code`, `model_version`, `score`, `rank_in_day` | 每日推理评分 |

查"某 fs 上训过的模型"：`SELECT model_version,status,hyperparams,oos_metrics FROM ml.model_runs WHERE feature_set_id='fs_xxx' ORDER BY created_at DESC;`

## 硬约束（data-integrity 规范）

- trade_cal 一律 `exchange='SSE'` 过滤（A 股标准口径，bug1 教训）。
- 进硬断言/SQL 前自查实体或真 DB 一条；子代理报告=二手，不直接进硬断言。
- 终端 Windows PowerShell（禁 `&&`，用 `;`）；`uv run`/`docker exec`/`alembic` 可能需绕 sandbox；源文件一律 UTF-8。
- 同步/重算任务错误不得 `.catch(()=>[])` 静默吞，须透出 scheme + date_range + 异常。
