# 03 · 阶段1 量化探查 + chunk RSS 校准（安全网核心）

[← 返回 index](./index.md) · 上一篇 [02 流水线与决策门](./02-pipeline-and-gate.md) · 下一篇 [04 重算与级联](./04-recompute-and-cascade.md)

用户选了**不备份**，所以本阶段是动 prod 前**唯一的安全网**。它在临时 scheme 上、零生产副作用，同时回答三个独立问题。

```text
              量化探查阶段(只读 prod, 只写临时 scheme)
  ┌──────────────────────────────────────────────────────────┐
  │ 问题① 新码 vs 旧值差多少   → 喂决策门                      │
  │ 问题② 单月吃多少内存       → 锁 chunk 粒度                 │
  │ 问题③ 月度驱动 == 单次整段? → 自证执行路径不引偏          │
  └──────────────────────────────────────────────────────────┘
```

## 运行方式与命名

- 直接 `uv run python` 在 `apps/quant-pipeline` 内调 `compute_labels(scheme="...__recheck", ...)`，**不走 worker / ml.jobs 队列**。理由：①同进程内便于采样 RSS；②不污染 ml.jobs；③用当前代码树（本就是新码），与"确认 worker 跑新码"解耦。
- 临时 scheme 命名：`strategy-aware__recheck` / `fwd_ret_h1__recheck`。
- 探查只碰 `factors.labels`，**不建临时 feature_matrix**。

## 问题① 差异量化（喂决策门）

不做全区间二次重算（等于把重算干两遍、小时级）。用**策略性探查窗口**抽样再外推：

```text
scheme           探查窗口                      抓的 bug
strategy-aware   W1 = 20230103:20230630   bug3次新股(集中早期)+20230103起点边界
                 W2 = 20240601:20240630   bug4 MA翻转 + bug2 涨停(时间均匀,单月采样率)
fwd_ret_h1       W1 = 20230103:20230630   bug3 + bug1尾padding (无bug2/4)
```

diff 方法**直接复用** `apps/quant-pipeline/tests/integration/verify_incremental_correctness.py`：

- `_dump(scheme, s, e)`：`SELECT trade_date, ts_code, value, exit_reason, hold_days FROM factors.labels WHERE scheme=:k AND trade_date BETWEEN :s AND :e ORDER BY trade_date, ts_code`；`value`/`hold_days` 走 `pd.to_numeric(errors='coerce')`。
- 行集合差（主键 `(trade_date, ts_code)`）：`only_in_old = prod_keys - recheck_keys`（被新码剔的幽灵行）、`only_in_new = recheck_keys - prod_keys`（预期≈0）。
- 公共行逐列：`value` 用 `np.isclose(rtol=0, atol=1e-9, equal_nan=True)`；`exit_reason` `fillna("∅")` 后字符串比；`hold_days` `fillna(-1)` 后整数比。
- **外推**：bug3 影响**有界**（直接数 W1 被剔行数，几乎不随后续年份增长）；bug2/bug4 是**时间均匀**的小比例（W2 单月率 × 月数）→ 给出每 scheme「预计总变更行数 / 占比」区间。

> 注：W1 用月度增量驱动算进 `__recheck`（验证驱动同时产出探查数据）；diff 对象是 prod 的 `strategy-aware` / `fwd_ret_h1` 在同窗口的行。

## 问题② chunk RSS 校准（锁粒度）

跑 W2 单月 chunk 时，用 `psutil` 在采样线程里记**峰值 RSS**（同进程直采）：

```text
判定规则:
  峰值RSS + 当前已占 + 安全余量(≥1G)  ≤ 16G  → 该粒度可用
  实测单月很省(如 <600M) 且已腾内存          → 放大到季度省墙钟
  单月就吃紧                                  → 降到双周
粒度由本步实测拍板, 不提前写死。
```

实现要点：起一个后台线程每 ~0.5s 采 `psutil.Process().memory_info().rss`，记录 max；compute 完打印峰值。

## 问题③ 月度驱动 == 单次整段（自证执行路径）

底层 `compute_labels` 增量==整段已被前序 verify 脚本证过（210001 行 PASS）。本步只自证**新写的月度推进驱动**没传错参数：

- 在临时 scheme 上取一个 3 个月窗（如 `20230103:20230331`），跑两路：
  1. 月度驱动：逐月 `force=False`、`date_range.start` 恒 `20230103`；
  2. 基准：单次 `force=True, date_range="20230103:20230331"`（写另一个临时 scheme，如 `__recheck_full`）。
- 逐行 diff 必须**完全一致**（value/exit_reason/hold_days + 行集合），一次性证伪 off-by-one / start 传错。

## 收尾与产出

- 清临时行：`DELETE FROM factors.labels WHERE scheme LIKE '%\_\_recheck%';`（含 `__recheck` 与 `__recheck_full`）。
- **产出物**：一份探查报告（控制台 + 落 `docs/.../recompute-probe-report-YYYYMMDD.md` 或 prompts 旁），含：
  - 每 scheme 的 `only_in_old / only_in_new / value变更 / reason变更 / hold_days变更` 计数与占比；
  - 外推总变更量区间；
  - 实测单月 RSS 与选定 chunk 粒度；
  - 问题③ PASS/FAIL。
- **这份报告就是决策门上摆给用户的数据。** 问题③ FAIL → 停，先查驱动，绝不进阶段2。
