# 03 · NestJS 后端

← 回到 [index.md](./index.md)

## API 端点（仿现有 `factors` CRUD）

```text
GET   /api/quant/labels                  列表（按 enabled / base_type 过滤）
GET   /api/quant/labels/:id/:version     详情
POST  /api/quant/labels                  新建标签定义（或新建版本）
PATCH /api/quant/labels/:id/:version     改元数据（见版本化规则）
GET   /api/quant/labels/base-types       基础类型 + 分类方式枚举（供前端下拉）

POST  /api/quant/jobs                    建训练任务（扩展：可选 labelRef）
```

## 实体 `LabelDefinitionEntity`

仿 `entities/ml/factor-definition.entity.ts`：

```text
@Entity({ schema: 'factors', name: 'label_definitions' })
  labelId        @PrimaryColumn({ name: 'label_id' })
  labelVersion   @PrimaryColumn({ name: 'label_version' })
  name           @Column()
  baseType       @Column({ name: 'base_type' })
  baseParams     @Column({ name: 'base_params', type: 'jsonb' })
  classifyMode   @Column({ name: 'classify_mode', nullable: true })
  classifyParams @Column({ name: 'classify_params', type: 'jsonb' })
  description / enabled / displayOrder / createdAt
```

> ⚠ **实体双注册（项目踩过的坑）**：新实体**必须同时**加到
> ① `quant.module.ts` 的 `TypeOrmModule.forFeature([... LabelDefinitionEntity])`
> ② `app.module.ts` 根 `entities` 数组。
> 漏 ② → 编译绿、运行时 `EntityMetadataNotFound` 500。

## `expandForTraining`

建 job 时把命名标签展开成明文参数（方案 i）：

```text
前端 POST /quant/jobs { ..., labelRef:{label_id, label_version} }
        │
QuantJobsService.create()
        ├─ LabelsService.expandForTraining(id, version)
        │     ├─ 查 factors.label_definitions
        │     │   └─ 不存在 / enabled=false → fail-fast 抛 400（禁止静默回退默认）
        │     └─ 返回 { base_type, base_params, classify_mode, classify_params }
        │
        └─ 写 ml.jobs.params:
             { base_type, base_params, classify_mode, classify_params,  ← 明文展开
               label_id, label_version,                                 ← 透传供 model_run 追溯
               factor_version, model, walk_forward, seed, ... }         ← 其余照旧
```

- `create-job.dto.ts` 新增 `labelRef`：**训练类 run_type（`train_e2e`/`train`/`optuna`/
  `seed_avg`）必填**，由后端展开；其余 run_type 不涉及标签。**移除旧的 `label_scheme`
  直填路径**，前端统一改用命名标签（一次性改造、无过渡期，详见
  [02-python-pipeline.md](./02-python-pipeline.md)）
- 展开逻辑收在 `LabelsService.expandForTraining()`，由 `QuantJobsService.create()` 调用
- `label_id`/`label_version` 经现状 `extra_hyperparams` 机制（`train_e2e_runner.py:272-282`）
  写入 `ml.model_runs.hyperparams`（jsonb，`MlModelRunEntity` 已有此列），与现状透传
  `label_scheme` 同路径

## 版本化策略：语义字段不可变

| 字段类别 | 字段 | 可否原地改 |
|---|---|---|
| **语义字段** | `base_type` / `base_params` / `classify_mode` / `classify_params` | **否**——改了即另一个训练目标，会让旧 `model_run` 追溯失真。要改用 POST 新建版本（`v1`→`v2`，同 `label_id`） |
| **展示元数据** | `name` / `description` / `enabled` / `display_order` | 可 PATCH 原地改 |

`PATCH` 收到语义字段变更 → 拒绝（400，提示新建版本）。这样 `model_run` 记的
`label_id+version` 永远精确指向当时的训练目标。

## 校验（后端层，即时反馈）

- `base_type` ∈ 合法枚举（镜像 Python，见下）；`classify_mode` ∈ `{null, band, tercile, custom}`
- 组合校验：`fwd_ret`→`horizon` 为 ≥1 整数；`band`→`eps`>0；`strategy_aware`→
  `max_hold_days` ∈ [10,30]；`tercile`→无额外参数
- 非法 → 400 + 明确信息

> **`base_type` 枚举单一真相源**：权威定义在 Python labels 模块，后端枚举只是**镜像**、
> 注释指向 Python 源，避免两边漂移误杀（项目规则：硬编码枚举要落源头）。后端做第一层
> 组合校验（即时反馈），Python `_validate_params` 做第二层（最终防线）。

## 后端文件域

```text
新 apps/server/src/entities/ml/label-definition.entity.ts
改 apps/server/src/app.module.ts                                   (根 entities 数组 +1)
新 apps/server/src/modules/quant/labels/labels.controller.ts
新 apps/server/src/modules/quant/labels/labels.service.ts
新 apps/server/src/modules/quant/labels/dto/create-label.dto.ts
新 apps/server/src/modules/quant/labels/dto/update-label.dto.ts
改 apps/server/src/modules/quant/dto/create-job.dto.ts             (+ 可选 labelRef)
改 apps/server/src/modules/quant/services/quant-jobs.service.ts    (create 调 expandForTraining)
改 apps/server/src/modules/quant/quant.module.ts                   (注册 controller/service + forFeature)
新 apps/server/src/modules/quant/labels/__tests__/labels.service.spec.ts
```

测试细节见 [06-validation-and-testing.md](./06-validation-and-testing.md#测试矩阵)。
