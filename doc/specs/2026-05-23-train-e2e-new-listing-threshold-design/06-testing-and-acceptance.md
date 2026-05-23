# 06 测试矩阵 + 验收命令 + 手工 e2e

## 单测覆盖矩阵(Python,`apps/quant-pipeline/tests/unit/`)

| 文件 | 新增 / 修改的 case 与不变量 |
|---|---|
| `test_labels_strategy_aware.py` | (1) `min_days = 0 / 30 / 60 / 90 / 250` 边界 case;(2) 非法值 `-1 / 251 / "60" / 60.0` 抛 `ValueError`;(3) `min_days=0` → 无过滤;`min_days=250` → 几乎全过滤 |
| `test_labels_fallback.py`(D-1 缺口) | (1) fwd_5d_ret + listing → 上市 < 60 日的新股被过滤;(2) `min_days=0` 跳过 filter_new_listing;(3) listing=None 时向后兼容(不过滤) |
| `test_features_builder.py` | (1) `build_feature_set_id` 对 factor_ids 顺序不敏感(`("f1","f2")` 与 `("f2","f1")` 等价);(2) `new_listing_min_days` 不同 → 不同 ID;(3) `resolve_feature_set_id` 命中预先 INSERT 的老行(返回 `(fs_legacy, True)`);(4) 无命中时返回 `(new_id, False)` |
| `test_progress.py` | (1) `make_scaled_callback` 正常窗口缩放(`pct=0/50/100` → `lo/中点/hi`);(2) 超界 clamp(`-10 → lo`、`150 → hi`);(3) 无效窗口 `hi < lo` 抛 `ValueError` |
| `test_train_e2e_runner.py`(新建) | (1) `_validate_params` 8 个非法 case(缺字段 / 越界 / 类型错);(2) 三个 step 顺序调用(mock 三个子 runner);(3) `check_cancel_requested` 在第二次抛 `JobCancelled` 时,后续 step 不再执行;(4) 子 runner 抛 `RuntimeError` 被包装为 `StepError(step='features', ...)`;(5) 进度回调值始终 ∈ `[0, 100]` |

## 集成测覆盖矩阵(Python,`apps/quant-pipeline/tests/integration/`,若存在)

| case | 验证点 |
|---|---|
| `test_train_e2e_end_to_end_small_window` | 跑 7 个交易日的小窗口端到端,断言:(1) `result["feature_set_id"]` 形如 `fs_*`;(2) `factors.labels` 在窗口期 COUNT > 0;(3) `factors.feature_matrix` WHERE feature_set_id 命中 COUNT > 0;(4) `ml.model_runs` WHERE feature_set_id 命中 COUNT == 1 |
| `test_train_e2e_min_days_change_produces_different_feature_set` | 同 `factor_version+scheme`,`min_days=30` 与 `min_days=60` 两次跑产出**不同** `feature_set_id` |
| `test_train_e2e_reuse_via_resolve` | 同参数跑两次,第二次 `factors.feature_sets` **不增加行**,feature_set_id 与第一次相同(D-16 验证) |

## 单测覆盖矩阵(NestJS,`apps/server/src/.../dto/__tests__/`)

| 文件 | case |
|---|---|
| `create-job.dto.spec.ts` | (1) 接受 `run_type='train_e2e'` + 完整 params;(2) 拒绝未知 run_type(如 `'train_e2e_extra'`);(3) `result_payload` 列在实体上读写正常 |

## 单测覆盖矩阵(前端,`apps/web/src/components/quant/__tests__/`)

| 文件 | case |
|---|---|
| `QuantTrainTriggerModal.spec.ts` | (1) `run_type='train'` 时默认显示 `TrainE2EFields`;(2) mode switch 切到"使用现有 feature_set"后 `TrainE2EFields` 隐藏;(3) `factor_version` 空时提交按钮 disabled;(4) `buildParams` 输出 `run_type='train_e2e'` + 完整 params 结构;(5) `formatDateRange` 用本地午夜,固定 TZ=Asia/Shanghai + `new Date(2026, 4, 9)` 输出 `20260509`(不漂前/后) |
| `TrainE2EFields.spec.ts`(可选) | 子组件 props/emits 双向绑定;不再单独验证 select / input 内部逻辑(naive-ui 自身职责) |

## 验收命令(全部 0 退出才能交付)

```powershell
# Python
cd apps/quant-pipeline
uv run pytest tests/unit
uv run alembic check                  # schema diff 干净
uv run alembic upgrade head --sql     # 离线 SQL 审核

# NestJS
pnpm --filter @cryptotrading/server build
pnpm --filter @cryptotrading/server exec jest

# 前端
pnpm --filter @cryptotrading/web type-check
pnpm --filter @cryptotrading/web test
pnpm --filter @cryptotrading/web lint:quant-lines

# 整体
pnpm build
```

## 手工 e2e 截图清单(PR 描述必含)

1. **端到端模式 happy path**:Modal 端到端模式默认显示,提交一次 7 天窗口的 job,SSE 进度从 0%→30%→60%→100%
2. **三张表都写入**:SQL `SELECT COUNT(*)` 验证 `factors.labels` / `factors.feature_matrix` / `ml.model_runs` 三张表新增了行
3. **result_payload 含 feature_set_id**:`SELECT result_payload FROM ml.jobs WHERE id=...` 输出含 `feature_set_id`
4. **mode 切换**:切换到"使用现有 feature_set",老路径仍可提交
5. **min_days 变化 → 不同 feature_set_id**:同 `factor_version=v1 / label_scheme=strategy-aware`,先用 `min_days=30` 跑一次,再用 `min_days=60` 跑一次,SELECT 验证两行不同 feature_set_id
6. **cancel 在 step 边界响应**:端到端跑到 features 阶段时点 cancel,验证 job 状态变 cancelled,labels 已写的行保留
7. **错误带 step 名**:故意写错 `factor_version='nonexistent'`,验证 job 失败,`error_text` 首行带 `[step:features]` 前缀
8. **预查复用**:用同一组参数跑两次,验证第二次 feature_set 表行数**不增加**,feature_set_id 与第一次相同

## D-1 ~ D-24 决策确认清单(PR 描述附)

PR 描述里逐行确认 24 个决策:

```text
[x] D-1  fwd_5d_ret 加新股过滤
[x] D-2  单 run_type='train_e2e' 端到端流水线
[x] D-3  阈值在 labels 阶段生效
[x] D-4  factor_version / label_scheme / min_days / date_range 进 Modal
[x] D-5  单 job 集成,worker 占用接受 30 分钟+
[x] D-6  不实现断点续跑
[x] D-7  进度切片 0-30 / 30-60 / 60-100
[x] D-8  Modal mode switch 默认端到端
[x] D-9  optuna / seed_avg 不动
[x] D-10 factor_version 纯文本(无 GET /factor-versions)
[x] D-11 factors.feature_sets 加 new_listing_min_days 列
[x] D-12 feature_set_id 哈希并入 new_listing_min_days
[x] D-13 新增 ml.jobs.result_payload jsonb 列
[x] D-14 元信息写入 ml.model_runs.hyperparams
[x] D-15 migration 顺带加 train_e2e 到 CHECK
[x] D-16 feature_set_id 预查复用
[x] D-17 Modal 隐藏 neutralize_cols / robust_z
[x] D-18 error_text 首行 [step:<name>]
[x] D-19 预拆 TrainE2EFields.vue 子组件
[x] D-20 提交成功 toast 提示长任务排队
[x] D-21 HyperparamsPanel 缺字段不展示
[x] D-22 factor_ids 加入 feature_set_id 哈希
[x] D-23 train_model 显式加 extra_hyperparams kwarg
[x] D-24 单 PR 大一统
```

## 哈希示例对比(PR 描述附)

```text
旧哈希契约(预改造):
  payload = { factor_version: "v1", label_scheme: "strategy-aware",
              neutralize_cols: ["industry_l1","mv"], robust_z: true }
  → fs_a1b2c3d4e5f6

新哈希契约(本 PR):
  payload = { factor_version: "v1", label_scheme: "strategy-aware",
              new_listing_min_days: 60, neutralize_cols: ["industry_l1","mv"],
              robust_z: true, factor_ids: ["f1","f2",...] }
  → fs_x9y8z7w6v5u4

预查复用机制下,首次跑预改造数据后,新 e2e 提交 min_days=60 命中:
  实际写入老 ID(回退到 fs_a1b2c3d4e5f6),不产生新行
```

## 已知限制(PR 描述 Future Work 段)

- 单 worker 实例下,train_e2e 长任务(30+ 分钟)期间其他 pending 作业排队 —— **接受**(D-5)
- 不支持断点续跑 —— **接受**(D-6)
- `optuna` / `seed_avg` 仍需手动指定 `feature_set_id`,不能直接接 e2e 输出 —— **后续 spec 改进**
- migration CHECK 没修复 `monitor` 既有 bug —— **后续单独 PR**(D-15 边界)
- `GET /api/quant/factor-versions` 接口未实现,factor_version 纯文本 —— **后续可选优化**(D-10)
- CLI `train-e2e` 子命令实现优先级低 —— PR 周期紧时可拆到后续 PR
