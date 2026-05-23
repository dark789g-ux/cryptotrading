# 01 总体架构与数据流

## 端到端流水线视图

```text
┌─ Web Modal (TrainE2EFields.vue) ──────────────────────────────────┐
│  factor_version │ label_scheme │ new_listing_min_days │            │
│  date_range     │ model        │ walk_forward │ seed              │
│                                              └─→ buildParams()    │
└──────────────────────┬────────────────────────────────────────────┘
                       │ POST /api/quant/jobs
                       │   { run_type:'train_e2e', params:{...} }
                       ▼
┌─ NestJS create-job.dto.ts ────────────────────────────────────────┐
│  ALLOWED_RUN_TYPES + 'train_e2e' │ 透传 params jsonb              │
└──────────────────────┬────────────────────────────────────────────┘
                       │ INSERT ml.jobs (status=pending)
                       ▼
┌─ Worker poller.py (FOR UPDATE SKIP LOCKED) ──────────────────────┐
│  → dispatcher._ROUTES['train_e2e'] = _runner_train_e2e           │
└──────────────────────┬────────────────────────────────────────────┘
                       ▼
┌─ train_e2e_runner.run_train_e2e(job_id, params, cb) ─────────────┐
│   1. _validate_params(params) → ValidatedParams                  │
│   2. step_labels   (cb 0→30)  ──→ factors.labels upsert          │
│   3. step_features (cb 30→60) ──→ factors.feature_sets + matrix  │
│        └─ build_feature_set_id 预查机制                          │
│        └─ 取出 feature_set_id                                    │
│   4. step_train    (cb 60→100)──→ ml.model_runs(hyperparams 注入)│
│   5. UPDATE ml.jobs.result_payload = {feature_set_id, ...}        │
│   失败:UPDATE error_text = '[step:<name>] <traceback>'           │
│   取消:每步入口 check_cancel_requested → JobCancelled            │
└──────────────────────┬────────────────────────────────────────────┘
                       │ NOTIFY ml_jobs_progress (existing)
                       ▼
                Web SSE → 进度条
```

## 与现有 run_type 的关系

- `train`(老路径)**保留不变**:Modal `mode='existing'` + feature_set_id 显式输入
- `labels` / `features`(独立 run_type)**保留不变**:CLI/调度可单跑
- `optuna` / `seed_avg` **零改动**(D-9):它们假设输入 `feature_set_id` 已存在
- `train_e2e`(新)= labels + features + train 的编排版

## 关键概念

| 概念 | 落位 | 关键约束 |
|---|---|---|
| **预查复用** | `features/builder.py::resolve_feature_set_id` | 算哈希后先 SELECT 同逻辑元组,命中即复用老 ID(D-16) |
| **进度切片** | `worker/progress.py::make_scaled_callback` | 子 runner 0-100 缩放到父 [lo,hi] 整数区间(D-7) |
| **元信息注入** | `train_e2e_runner._step_train` | factor_version / label_scheme / new_listing_min_days merge 到 hyperparams(D-14) |
| **step 名前缀** | `dispatcher._runner_train_e2e` | 失败时 error_text 首行 `[step:<name>] <traceback>`(D-18) |

## feature_set 与 model 的关系(为什么不合并)

- **多对多关系**:一个 feature_set 喂多个 model(optuna 多 trial、seed_avg 多 seed、AB 对比);一个 model 训练时绑定唯一 feature_set
- **成本不对称**:features build 几分钟~几十分钟(横截面中性化);train 几秒~几分钟(LGB)
- **推理需要反查**:model 记录 feature_set_id,推理时按 fs 配置重算当天特征
- 合并 = 把"数据加工"和"算法训练"绑死,失去独立迭代能力

详见 PROMPT 讨论历史(BTW 分支)。

## 进度切片整数化与漂移防御

```text
labels  step    features step    train  step
[0% ─── 30%]    [30% ── 60%]    [60% ── 100%]
   span=30          span=30          span=40

scaled_pct = lo + (span * clamped) // 100   ← 整除,避免浮点累积漂移
clamped     = max(0, min(100, pct))         ← 防御:子 runner 偶传超界
```

## 失败与取消的语义快照

| 场景 | jobs.status | jobs.error_text | jobs.result_payload | 写入侧产物 |
|---|---|---|---|---|
| 全跑成功 | completed | (空) | `{feature_set_id, model_version, last_completed_step:'train'}` | labels / matrix / model_runs |
| labels 步抛异常 | failed | `[step:labels] <traceback>` | `{}` | labels 部分写入(upsert 幂等) |
| features 步抛异常 | failed | `[step:features] <traceback>` | `{}` | labels 全 + matrix 部分 |
| train 步抛异常 | failed | `[step:train] <traceback>` | `{}` | labels + matrix 全(可作下次起点) |
| 用户 cancel | cancelled | (空) | `{}` | 已写部分保留 |
| params 校验失败 | failed | `[step:validate] <traceback>` | `{}` | 无 |

**幂等保证**:三步全部走 `INSERT ... ON CONFLICT DO UPDATE`,重提同参数 = 覆盖,不留垃圾。
