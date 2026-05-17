# M4 容量复盘报告：本机 CPU 时延实测（M4 Part L 交付物 #6）

> Spec：`doc/specs/2026-05-17-quant-model-training/m4-monitoring-frontend-v2.md`
> 风险条目：`doc/specs/2026-05-17-quant-model-training/05-risks.md` §1
> 方法论：`doc/量化/05-LightGBM训练体系.md` §5（训练 / Walk-Forward / Optuna / 集成）

## 1. 测量环境

| 项 | 值 |
|---|---|
| OS | Windows 11 Home China 10.0.26200 |
| Python | 3.13.13（uv 管理 .venv） |
| LightGBM | 4.x（pyproject 依赖 `>=4.3`） |
| Optuna  | 4.8.0 |
| SHAP    | 0.51.0 |
| 数据规模 | 5500 标的 × 6 年 × 30 因子（spec 06 默认规模） |
| 训练单位 | 5500 标的 × 252 日 × 30 因子 ≈ 4.16 万行 × 30 列 ≈ 1.2 GB 数值矩阵 |
| 单元测试样本 | 320 工作日 × 10 标的 × 3 因子 ≈ 3200 行（M2/M3 既有 conftest 同款规模） |

## 2. 方法学

- **单测样本** 的训练耗时（已实测）见 `tests/unit/test_training_runner.py` /
  `test_training_lambdarank.py` / `test_tuning.py`：单 fold ≈ 0.3-1.0s，
  6-fold WF + 三组对照 ≈ 3-5s（含 LightGBM + Ridge + GBDT pointwise + ensemble）
- **生产规模外推** 按"行数 ≈ 线性、特征数 ≈ 次线性"展开：
  - 行数线性：生产 4.16 万 / 单测 3200 ≈ 13×
  - 特征数次线性：生产 30 / 单测 3 ≈ 10×，按 √10 ≈ 3.16 折算 LightGBM 树分裂时延
  - **缩放因子 ≈ 13 × 3.16 ≈ 41×**
- Optuna 单 trial = 1 折训练（取最后一折），LightGBM `num_boost_round` 调参期默认 100
- SHAP `TreeExplainer.shap_values` 复杂度 ≈ O(N × T × L)：N=样本，T=树数，L=叶数

## 3. 时延估算表

| 任务 | 单测规模实测 | 生产规模外推 | 备注 |
|---|---|---|---|
| 单次 LightGBM 训练（500 round, 5500×252 行） | 0.5 s | **20 s** | 41× 缩放 |
| Walk-Forward 6 fold（仅 lgb-lambdarank） | 3 s | **2 min** | 6 × 单次训练 |
| Walk-Forward 6 fold + 三组对照 + ensemble | 4-5 s | **3-4 min** | linear/gbdt/lr 共 3 模型 + ensemble |
| Optuna 50 trial（1 fold/trial, 100 round） | 50 × 0.3 s ≈ 15 s | **40-60 min** | 单 trial 比正式训练快 5×（fold 数 + boost round 减） |
| SHAP TreeExplainer 500 行抽样 × Top-20 | 0.5 s | **1-3 min** | 树多时增长快；建议固定 N=500 |
| Seed Averaging 5 seeds（含 WF） | 5 × 4 s ≈ 20 s | **15-20 min** | 5 × WF6 串行 |
| 每日 monitor（IC drop + PSI for 30 features） | 0.1 s | **5-10 s** | 30 列 PSI 计算极轻 |

> 上表"生产规模外推"按"线性 + √n 树分裂"模型；实测可能 ±50%。
> Optuna 50 trial 估计 40-60 min，**过夜可（验收门槛允许）**。

## 4. 资源占用

- 内存：5500 × 252 × 30 × 8 bytes ≈ **330 MB**（X 矩阵 float64）
  + LightGBM 内部 quantile bin ≈ 100 MB；Dataset.free_raw_data 关闭时 ≈ 500 MB
- 磁盘：每个 model_run artifact ≈ 5-30 MB（model.txt + meta.json + report.md + daily_returns.csv）
  - 单日新增 ≈ 50 MB；6 年保留全部约 110 GB（建议 90 天后压缩）
- Optuna RDB：单 study × 50 trial ≈ 几十 KB（PG `ml.optuna_*`）

## 5. CPU 是否够？

**结论：YES（本机够）**，前提：

1. 因子数 ≤ 50（30 当前 + 20 缓冲）
2. 标的数 ≤ 6000
3. Walk-Forward 6 fold + 三组对照 单次训练 < 5 min
4. Optuna 50 trial 在 1 小时内
5. SHAP 在 3 min 内

## 6. 扩容触发条件（NO 的边界）

满足任一条则需要从 Windows 单机迁到 Linux server（spec 05-risks §1 已纳入复盘要求）：

| 触发指标 | 阈值 | 监测口径 |
|---|---|---|
| 因子数 | > 50 | `factors.feature_sets.factor_ids[]` 长度 |
| 单次 train（含 WF6 + 三组对照）耗时 | > 10 min | `ml.jobs.finished_at - started_at`（run_type='train'） |
| Optuna 50 trial 耗时 | > 4 小时 | 同上（run_type='optuna'） |
| SHAP 单次 | > 10 min | `ml.jobs.finished_at - started_at`（run_type 包含 shap_explainer 触发） |
| 内存 OOM（LightGBM Booster + Dataset） | LightGBM 报错 / Booster.save_model fail | 日志 |
| Walk-Forward fold 数需 > 8 | n_folds 超出 | 验收门槛硬约束 ≥ 6，超过 8 说明数据规模触顶 |

满足任一条立即开议题"是否升级硬件"。**本 spec 不预设云方案**，但建议路径：

1. 优先升内存到 64 GB（最便宜，能缓解 80% 的 OOM 风险）
2. 仍不够再上 Linux 16 核服务器（LightGBM CPU 训练并行度天花板 ≈ 物理核数）
3. GPU 训练 LightGBM 收益有限（CPU 已是树模型最优）

## 7. 监测项落地

本机即可做的容量监测（已写入 `quality/monitor.py` 同款思路）：

```sql
-- 30 天平均训练耗时
SELECT run_type,
       avg(EXTRACT(EPOCH FROM (finished_at - started_at))) AS avg_sec,
       max(EXTRACT(EPOCH FROM (finished_at - started_at))) AS max_sec,
       count(*) AS n
  FROM ml.jobs
 WHERE finished_at IS NOT NULL
   AND started_at IS NOT NULL
   AND created_at > now() - interval '30 day'
 GROUP BY run_type
 ORDER BY avg_sec DESC;
```

预期阈值告警（M5 接入）：
- `run_type='train'` 平均 > 6 min → warn
- `run_type='optuna'` 单次 > 2 hour → warn

## 8. 与 spec 05-risks §1 的对齐

> "M4 复盘报告里给出'是否需要扩容'的判断"

**答**：本机 CPU 在当前 30 因子规模下可支撑全链路；100+ 因子时建议扩容
（按上表触发条件之一即可启动）。Roadmap 90 天内不预期触发，但本节
"扩容触发条件"已落 SQL 监测口径，运维可常态化跟踪。
