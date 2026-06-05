# 因子/标签「定向更新」入口设计

- 日期：2026-06-06
- 分支基线：`feat/quant-strategy-management`
- 状态：设计已评审通过，待实施

## 1. 背景与目标

量化模块已有按日期重算因子/标签的能力，但**只能走 CLI 或裸 REST**（`uv run quant factors compute` / `labels build`，或 `POST /api/quant/jobs`）。前端只有"触发训练"入口（`QuantTrainTriggerModal`，仅 `train/optuna/seed_avg`），**没有"只备料、按需更新某个因子/标签"的 UI**。

本设计加一个前端入口：**选具体因子（可多选）+ 具体标签 + 日期范围，只重算它们的基础表数据**。典型场景：改了某因子算法 / 修了 bug / 新加一个因子，要回填它在某段历史日期的值，而不必整体重算全部 16 个因子或动特征矩阵。

### 成功标准

1. 用户在 UI 上选若干 `factor_id` + 一个命名标签 + 日期范围（= **入场日 T 范围**，标签出场闭合见 §8 约束 1），点提交即可触发计算。
2. 因子只重算选中的 `factor_id`；标签按选中命名标签解析出的 scheme 计算。
3. 只 upsert 基础表 `factors.daily_factors` / `factors.labels`，**不触碰特征矩阵、不触发训练**。
4. 进度可在现有 jobs 列表 / SSE 中观察。

## 2. 范围

### In scope
- 新建前端 `QuantTargetedUpdateModal.vue` + 入口按钮。
- `labels` run_type 接受 `label_ref`（后端展开 + Python 解析 scheme）。
- 因子侧复用现成 `factors` run_type，**零后端改动**。

### Out of scope（明确不做）
- ❌ 特征矩阵（`feature_set`）的"单列定向更新"——它天然全宽，无此能力，本设计不涉及。
- ❌ 缺口检测增量物化（见 `2026-06-06-labels-features-incremental-prepare-design/`，本设计是其轻量子集，前向兼容但不实现）。
- ❌ 备料/训练解耦的 `prepare` 聚合 run_type。
- ❌ 删除/清理残留旧行（upsert 覆盖语义不变）。

## 3. 架构与数据流

```text
┌─ QuantTargetedUpdateModal（前端新建）─────────────────┐
│ 因子多选  ☑momentum_20d  ☑rsi_14   ← GET /api/quant/factors │
│ 标签选择  ▾ strategy-aware (命名)  ← GET /api/quant/labels  │
│ factor_version ▾ v1               ← GET /api/quant/factor-versions │
│ 日期范围  [20260301 ~ 20260420]  (入场日 T，见 §8 约束1)│
│                       [取消]            [提交]         │
└───────────────┬───────────────────────┬───────────────┘
       选了因子 │              选了标签 │  （两者独立，可各自单独提交）
                ▼                       ▼
   POST /api/quant/jobs           POST /api/quant/jobs
   run_type:"factors"            run_type:"labels"
   params:{version,              label_ref:{label_id,label_version}
     date_range,factor_ids[]}     params:{date_range}
                │                       │
                │              后端 expandForTraining
                │              → params 注入 base_type/base_params
                ▼                       ▼
   factors.runner            labels.runner_entrypoint
   只算选中 factor_id        base_scheme_codec(base_type,base_params)
                │              → scheme → compute_labels
                ▼                       ▼
   upsert factors.daily_factors    upsert factors.labels
   PK(date,ts_code,factor_id,ver)  PK(date,ts_code,scheme)

                ❌ 不写 feature_set / 特征矩阵
```

## 4. 关键设计决策

### 决策 1 — 因子路径：后端零改动
- `factors` 已在 `ALLOWED_RUN_TYPES`（`create-job.dto.ts`），且**不是** `TRAIN_RUN_TYPES`，不需要 `labelRef`。
- job 入参 `{version, date_range, factor_ids?}` 现成支持 `factor_ids` 子集（dispatcher 路由 `factors.runner.runner_entrypoint`）。
- 前端列因子用现成 `GET /api/quant/factors`（`factors.controller` `@Get()`）。
- ⚠ **`/api/quant/factors` 类级挂 `@UseGuards(AdminGuard)`（`factors.controller.ts:36`），是 admin-only**。故本"定向更新"入口（依赖因子多选）应**限定 admin 可见**——与"数据写操作工具"的定位一致。`GET /api/quant/factor-versions` 无 AdminGuard，可正常取版本。
- ⚠ **`factor_ids` 空数组语义**：`run_factors` 用 `list(factor_ids) if factor_ids else None`（`factors/runner.py:246`），**空列表 falsy → 落 None → 全量重算 16 因子**。故前端**仅在选了因子时发 factors job，且禁止发空数组**（见 §8）。
- 结论：因子侧纯前端工作。

### 决策 2 — 标签路径：选命名标签，scheme 由 Python 解析（方案 A）
- **约束**：`labels` job 当前入参是 `scheme` 字符串；而 scheme 编码权威在 Python `labels/dir3_scheme.py::base_scheme_codec`，**前端不得自拼 scheme**。
- **方案 A（采纳）**：前端选 `label_definitions` 注册表里的命名标签；`labels` job 接受 `label_ref{label_id,label_version}`：
  1. 后端 `LabelsService.expandForTraining(labelId, labelVersion)`（已存在）展开为 `base_type/base_params`，顺带校验 strategy_aware 引用的策略仍 `enabled`（fail-fast）。
  2. 写入 `ml.jobs.params` 的 `base_type/base_params`。
  3. Python `labels.runner_entrypoint` 用 `base_scheme_codec(base_type, base_params)` 算出 scheme，再走现有 `compute_labels`。
- **理由**：scheme 权威留在 Python（不在 TS 复制 codec）；与训练入口（`train_e2e` 同样靠 base_type/base_params + codec）一致；可更新"尚未算过"的 scheme。
- 被否方案 B（前端直接列 `factors.labels` 已有 distinct scheme）：零后端改动，但只能更新已存在 scheme、且要硬过滤 legacy `dir3_*` 死 scheme，不够干净。

### 决策 3 — 作业粒度：最多 2 个独立 job（方案 A）
- 去掉 features 后 `factors ⊥ labels`，无顺序依赖。
- 选了因子发 1 个 `factors` job，选了标签发 1 个 `labels` job，**worker 零改动**。
- 被否方案 B（新增 `prepare` 聚合 run_type 合成 1 条）：UX 更干净但要动 worker + dispatcher + DTO，权衡后不值得。

## 5. 后端改动（NestJS）

**关键发现（已核对源码）：`labels` + `label_ref` 今天就端到端可用，后端核心逻辑零改动。**

- `validateCreateJob`（`create-job.dto.ts:135-157`）对**任意** run_type 都接受 `label_ref`（只要传了就解析），仅在**训练类**缺 `label_ref` 时才 400；非训练类传了照收。
- `QuantJobsService.create()`（`quant-jobs.service.ts:88`）凭 `if (dto.labelRef)` 展开，**不按 run_type 门控**——`labels` + `label_ref` 会正常调 `expandForTraining` 并把 `base_type/base_params/label_id/label_version` 注入 `params`。
- 故**不改** `ALLOWED_RUN_TYPES`（`labels` 已在内）、**不改** `create()` 展开逻辑、**不把** `labels` 加进 `TRAIN_RUN_TYPES`。

实际待办（均为小项）：

1. **更正误导性注释**：`create-job.dto.ts:63,132` 注释写"非训练类不存在/不接受 labelRef"，与实际代码相反（非训练类也接受），需更新以免后续误判。
2. **（推荐，真实新增工作量）labels 专属 400 校验**：当 `run_type==='labels'` 且 `scheme` 与 `label_ref` **同时缺失** → 400。**当前后端不拦**，会延迟到 Python `runner_entrypoint` 抛 `ValueError` → job 直接 failed，体验差。在 DTO/service 显式加这条校验把错误前移。
3. **classify_* 注入但无害**：`expandForTraining` 会把 `classify_mode/classify_params` 一并注入 `params`（`quant-jobs.service.ts:99-100`），但 labels runner **不消费** classify_*（见 §6），仅 `base_type/base_params` 用于 codec。功能无害，无需特殊处理。
- 向后兼容：`labels` job 仍允许直接传 `scheme`（CLI/脚本既有用法）；`label_ref` 与 `scheme` 二选一。

## 6. Python 改动（quant-pipeline）

唯一改动点：`labels/runner.py` 的 `runner_entrypoint`（即 `compute_labels` 的 job 入口）支持从 `base_type/base_params` 推 scheme。

- 现状：入口读 `params['scheme']` 直接用。
- 改动：若 `params` 未给 `scheme` 但给了 `base_type/base_params`，调用 `base_scheme_codec(base_type, base_params)` 得到 scheme；两者都给以显式 `scheme` 为准；都没有 → 显式抛错（fail-fast，禁静默）。
- 不改 `compute_labels` 的核心计算路径与 upsert 语义。
- runner 只读 `scheme`/`base_type`/`base_params`（及 strategy_id/version），**不读 `classify_*`**——后端注入的 classify 字段在此被忽略（与 §5 第 3 条呼应）。
- codec 咬合：`base_scheme_codec` 的 `_VALID_BASE_TYPES = {fwd_ret, strategy_aware}` 恰等于后端 `LABEL_BASE_TYPES`，故命名标签展开后必然合法；**将来新增 base_type 须同步改 Python codec 白名单**，否则展开会抛错。
- 注意：strategy_aware 非 default 策略的 `exit_rules` 接线属另一分支工作（`feat/quant-strategy-management` Task B/C/D，当前 `compute_strategy_aware_labels` 仍走 `max_hold_days`）。本设计**不依赖**该接线完成——default 标签经 codec 得 `strategy-aware`、fwd_ret 得 `fwd_5d_ret`/`fwd_ret_h{N}` 即可正常更新。

## 7. 前端组件

- 新建组件放 `apps/web/src/components/quant/targeted-update/` 子目录（与既有 `train-modal/`、`label-modal/`、`strategy-modal/` 惯例一致）：
  - `QuantTargetedUpdateModal.vue` 主壳；受 `lint:quant-lines` 约束，**单文件 ≤ 500 行**，超出则按现有 `components/quant/train-modal/TrainE2EFields.vue` 的模式拆子组件（如 `TargetedFactorSelect.vue` / `TargetedLabelSelect.vue`）。
- 入口按钮加在 `apps/web/src/views/quant/QuantJobsView.vue`"触发训练"按钮旁，文案"定向更新"；**入口限 admin 可见**（§4 决策 1：`/quant/factors` admin-only）。
- 表单字段与数据源：
  - 因子多选 → `GET /api/quant/factors`（admin-only；取 `factor_id` 列表，可按 `enabled` 过滤展示）。
  - 命名标签单选 → `GET /api/quant/labels`（取 `label_id/label_version/name`，提交时传 `label_ref`）。
  - `factor_version` 单选 → `GET /api/quant/factor-versions`，默认 `v1`。
  - 日期范围 → naive-ui `n-date-picker` daterange。**日历日提取用 `getFullYear/getMonth/getDate`（本地午夜 ms），不得用 UTC 方法**（否则 CST 用户日期漂前 1 天），格式化为 `YYYYMMDD` 字符串拼 `date_range`。

## 8. 校验与必须暴露的约束

```text
⚠ 约束 1（标签闭合窗口）
  date_range 是入场日 T 范围；strategy-aware/fwd_ret 出场要 T 之后
  ~N 个交易日的未来 raw 才能闭合。选了太近的日期 → 标签未闭合/错误。
  → Modal 对"标签"侧给出 warn 文案（提示近端日期可能未闭合）。

⚠ 约束 2（raw 依赖）
  factors/labels 读 raw.*；目标日期的 raw 未同步会算空。
  → 文案提示：请确认目标日期 raw 已同步。

⚠ 约束 3（upsert 覆盖 ≠ 删除）
  只更新/插入，不清旧行；退市股残留旧值不会被抹掉。
  → 文案如实说明语义。
```

提交校验：
- 因子和标签**至少选一个**（都没选 → 禁用提交）。
- **factors job 仅在 `factor_ids` 非空时发送，禁止发空数组**（空数组会被 Python 当"全量"，见 §4 决策 1）。
- 日期范围必填且 start ≤ end。
- `factor_version` 默认 `v1`。
- labels 侧 `scheme`/`label_ref` 二选一：若要后端把"同时缺失"前移成 400，需新增 §5 待办 2 的校验（否则错误延迟到 Python）。

## 9. 测试计划

- 前端单测（vitest）：
  - modal 校验：至少选一个、日期必填、start ≤ end。
  - 提交 payload 形态：factors job `{version,date_range,factor_ids}`、labels job `{label_ref,params:{date_range}}`。
- 后端单测（jest）：
  - 回归确认：`labels` run_type 传 `label_ref` 时 `expandForTraining` 被调用、`base_type/base_params` 注入 `params`（验证"零改动即可用"未被破坏）。
  - `labels` 传 `scheme` 直通（向后兼容）。
  - 若实现 §5 待办 2：`labels` 且 `scheme`/`label_ref` 同时缺 → 400。
  - strategy_aware 标签引用的策略 `enabled=false` → 422/400（复用 `expandForTraining` 现有校验）。
- Python 单测：
  - `runner_entrypoint` 从 `base_type/base_params` 经 `base_scheme_codec` 推出正确 scheme；显式 `scheme` 优先；都缺抛错。
- 端到端（真机）：选 1 个因子 + 1 个标签 + 一段历史日期，提交后两条 job 跑通、基础表被 upsert、特征矩阵未变。

## 10. 与既有 spec/分支的关系 & 文件域协调

- 本设计是 `2026-06-06-labels-features-incremental-prepare-design/`（未实现）的**轻量前向兼容子集**：只做"前端定向触发基础表"，不做缺口检测增量、不做备料/训练解耦。
- 与 `feat/quant-strategy-management` 分支**共改 `labels/runner.py`**：本设计在 `runner_entrypoint` 加"base_type/base_params → scheme"分支；策略管理改 `compute_strategy_aware_labels` 的 exit_rules 接线。两者改动点不同（入口路由 vs 计算体），但同文件，需注意提交顺序避免冲突。
- 后端 `QuantJobsService.create()` 的 label_ref 展开逻辑与训练入口共用 `expandForTraining`，无新增重复。

## 11. 实施任务拆分（供后续开发）

| # | 任务 | 文件域 | 依赖 |
|---|------|--------|------|
| T1 | 后端（小）：更正 `create-job.dto.ts:63,132` 误导注释；**可选**加 labels 缺 scheme&label_ref 的 400 校验。`labels`+`label_ref` 展开本身已可用、零核心改动 | `apps/server/src/modules/quant/dto/create-job.dto.ts`（必要时 `services/quant-jobs.service.ts`） | 无 |
| T2 | Python：`runner_entrypoint` 支持 base_type/base_params → scheme（codec）；显式 scheme 优先；都缺抛错 | `apps/quant-pipeline/src/quant_pipeline/labels/runner.py` | 无（与策略分支同文件，注意协调） |
| T3 | 前端：`components/quant/targeted-update/` 模态 + 入口按钮（限 admin）+ API 调用（factors 非空才发、labels 传 label_ref） | `apps/web/src/components/quant/targeted-update/*`、`views/quant/QuantJobsView.vue` | T2（labels 经 base_type/base_params 解析 scheme） |
| T4 | 测试：前端/后端/Python 单测 + 真机端到端 | 各 `__tests__` / `tests/` | T1-T3 |

T1 与 T2 可并行（不同子项目）；T3 主要依赖 T2（labels 经命名标签触发需 runner 能从 base_type/base_params 解析 scheme）；T4 收尾。注：因后端展开已可用，端到端打通的真正前置是 **T2**（Python 解析 scheme），而非后端。
