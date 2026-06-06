# 04 · 阶段2/3/4 labels 重算 + feature_matrix 重建 + 模型评估

[← 返回 index](./index.md) · 上一篇 [03 量化探查](./03-measure-and-calibrate.md) · 下一篇 [05 验证与回滚](./05-validation-and-rollback.md)

**仅对决策门批准的 scheme 执行。** 驱动一律 `uv run python` 自写脚本直调，**不走 worker / UI prepare**——内置「备料」强制重算是单次整段 force，3.3G 空闲下必 OOM。

## 阶段2 labels 重算

顺序：**fwd_ret_h1（轻、探路）→ strategy-aware（prod 底座）**。每个 scheme = 一个不可逆步 + 一个幂等可续循环。

```text
步2.1 (唯一不可逆, 显式二次确认)
  DELETE FROM factors.labels WHERE scheme = '<scheme>';

步2.2 (幂等, 可任意点重跑)
  for m_end in 月度网格(20230103 .. 真实dmax):
      compute_labels(scheme='<scheme>',
                     date_range=f"20230103:{m_end}",   # start 恒=全区间起点(不变量1)
                     force_recompute=False)             # 增量: 只算当月缺口
```

**关键洞察（让"不备份"可接受）**：DELETE 后该 scheme 表空，循环全程 `force=False` 即可——首月缺口 `g0=20230103`、`g0_load=max(20230103, 20230103-4)=20230103`（夹到起点、前 4 天 MA=NaN），与单次整段首 4 天**完全一致**，无需特判首月。

**为何幂等可续**：因 `force=False` 按 `DISTINCT trade_date` 查缺口 + 窗口无关性，崩在第 K 月（哪怕月中半截 upsert）→ 重跑循环自动跳过已物化、只补缺口、自收敛。**唯一禁忌：DELETE 别重跑**（会清掉进度）。所以 DELETE 与循环是两个分开的步骤，DELETE 单独确认。

**月度网格生成**：按 SSE 交易日历切月末（`raw.trade_cal WHERE exchange='SSE' AND is_open=1`），`m_end` 取每月最后一个交易日，最后一格收到真实 dmax。

## 阶段3 feature_matrix 重建

顺序：**fs_9b5ff4d69c1e（fwd）→ fs_60bc257fb173（strategy-aware/prod）**。同结构：

```text
步3.1  DELETE FROM factors.feature_matrix WHERE feature_set_id = '<fs>';
步3.2  for m_end in 月度网格(20230103 .. labels真实dmax):
           build_feature_matrix(... force_recompute=False, date_range=f"20230103:{m_end}")
```

features 零跨日、更省内存；`merge_with_labels` inner join 新 labels → 行数 ≤ labels、天然无幽灵行。feature_matrix 的 dmax 受 labels dmax 约束（inner join），执行时实测对齐。

### fail-fast 护门（必须，否则算进新 fs）

`feature_set_id` 指纹绑 6 参数 + overlay（见 [01#代码契约](./01-context-and-state.md#代码契约真源码核对appsquant-pipeline)）。重建前：

1. 从 `factors.feature_sets` 取该 fs 的 `factor_version / scheme / factor_ids / new_listing_min_days`；
2. 从原始 prepare/train job 的 `ml.jobs.params` 取 overlay 参数（`neutralize_cols / robust_z / factor_clip_sigma / label_winsorize`）；
3. python 里 dry-run `build_feature_set_id(...)`（+ overlay 层）**断言 == 目标 fs**（fs_60bc257fb173 / fs_9b5ff4d69c1e）；
4. 相符才跑。参数错一个 → 指纹变 → 算进全新 fs、旧 fs 仍脏。

## 阶段4 模型评估/重训

默认"评估"，重训与 promote 由用户拍板（scope = 单 spec 含决策门）。**绝不在脚本里盲换 prod。**

```text
受影响:
  lgb-lambdarank-v1-20260521-seed42  (fs_60bc257fb173, status=prod, 出日评分)
  lgb-multiclass-v1-20260605-seed42  (fs_9b5ff4d69c1e, status=shadow, 无日评分)

安全流程(对每个要重训的):
  读 ml.model_runs.hyperparams (沿用原超参)
    → 在重建后的 fs 上训新 model_version
    → 注册 status='shadow'
    → 比 oos_metrics 新 vs 现prod
    → 摆给用户 → 用户定是否 promote
  promote = 新版 status='prod' + 旧版 'archived'; 脚本不主动切。
```

- prod 的 lambdarank 是 live 底座 → **只增 shadow、比指标、由用户 promote**。
- shadow 的 multiclass 风险低 → 重训新 shadow 比一比即可。
- 重训重（compute），可在决策门后单独决定做不做；若跳过，至少在报告里标注"现有模型基于旧标签训，已知 stale"。
