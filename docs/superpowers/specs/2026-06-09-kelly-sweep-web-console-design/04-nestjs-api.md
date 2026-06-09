# 04 · NestJS 侧改动（接入 + 查询接口）

← 返回 [index.md](./index.md)

分两块：**① 让 `kelly_sweep` 这个 run_type 能发起**（复用 jobs 机制，6 处接入）；**② 新增只读结果查询栈**（独立 controller/service/entity）。

## ① run_type 接入（6 处，缺一不可）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `apps/server/src/entities/ml/ml-job.entity.ts:36-47` | `MlJobRunType` 联合类型加 `'kelly_sweep'` |
| 2 | `apps/server/src/modules/quant/dto/create-job.dto.ts:58-70` | `ALLOWED_RUN_TYPES` 数组加 `'kelly_sweep'` + 新增 params 校验（见下） |
| 3 | alembic migration | `ml_jobs_run_type_check` 加 `'kelly_sweep'`（见 [02](./02-data-model.md#动作-1ml_jobs_run_type_check-加入-kelly_sweep)）—— **漏此处 = HTTP 500** |
| 4 | `apps/web/src/api/modules/quant.ts:135-148` | 前端 `JobRunType` 加 `'kelly_sweep'` |
| 5 | `apps/web/src/views/quant/QuantJobsView.vue:135-147` | `runTypeOptions` 加展示项（jobs 列表能识别该类型） |
| 6 | `apps/quant-pipeline/.../worker/dispatcher.py:358-377` | `_ROUTES` 加 `"kelly_sweep": _runner_kelly_sweep`（见 [03](./03-python-runner.md)） |

> **TS union ⊊ DB enum，勿盲目同步**：DB CHECK 约束（含已废弃的 `train_e2e`）是 TS 侧 `MlJobRunType`/`ALLOWED_RUN_TYPES` 的真超集——TS 故意不含 `train_e2e`。给这两处加 `'kelly_sweep'` 即可，**不要**把 DB 枚举整段照抄进 TS（否则会把 `train_e2e` 误带回）。

## DTO params 校验（create-job.dto）

`kelly_sweep` 的 `params` 校验须覆盖 12 个 `SweepConfig` 字段 + `exit_families`，与 Python `SweepConfig`（`config.py:23-110`）口径一致（口径单一真相源在 Python，NestJS 做基础边界校验，深度校验由 Python `SweepConfig` pydantic 兜底）：

- `base_trigger`: `{field:string, op:enum(lt,lte,gt,gte,eq,neq), value:number}`，**`field` 必须 ∈ 白名单**（见下白名单接口）。
- `universe`: `'all'` 或 `string[]`（ts_code 列表）。
- `train_range`/`valid_range`: `[string,string]`，8 位 YYYYMMDD；train_start≤train_end、valid_start≤valid_end、train_start≤valid_start。
- `max_window`≥1、`max_entry_filters`≥0、`min_samples`≥1、`bootstrap_iters`≥1、`rs_lookback`≥1、`top_k`≥1。
- `same_day_rule`: `'sl_first'|'tp_first'`。
- `rs_benchmark`: `('hs300'|'zz500')[]`（**`industry` 暂未接通，禁止提交**，Python 会抛 NotImplementedError）。
- `exit_families`: 非空子集 ⊆ `{fixed_n,tp_sl,trailing,atr_stop}`。

## ② 结果查询栈（只读）

新模块（如 `apps/server/src/modules/quant/kelly-sweep/` 或并入 quant 模块），controller 基路由 `quant/kelly-sweep`，全局 `/api` 前缀 → `/api/quant/kelly-sweep`。受全局 `AuthGuard`。

### TypeORM entity 双注册

`KellySweepResult` entity 映射 `research.kelly_sweep_results`（`@Entity({schema:'research', name:'kelly_sweep_results'})`，列与 [02](./02-data-model.md#结果表-ddl) DDL 对齐，全部**只读**——NestJS 不写此表）。

> **必须双注册**（项目硬约束 + 记忆教训）：① 业务 module 的 `forFeature([KellySweepResult])`；② `app.module` 根 `entities` 数组。漏第 ② 项编译绿但运行时 `EntityMetadataNotFound` 500。

### 查询接口契约

| 方法 路由 | 入参 | 出参 |
|---|---|---|
| `GET /runs/:jobId/summary` | — | `result_payload` 摘要 + job 元信息（区间/run_type/status） |
| `GET /runs/:jobId/scatter?group=with_rs\|no_rs` | group 必填 | 该组全行精简点集 `[{n_valid,kelly_valid,is_frontier,below_floor,variant_id,exit_id,id}]` |
| `GET /runs/:jobId/topk?group=&page=&pageSize=&sort=` | group 必填 | `is_topk` 行分页，默认 `kelly_valid DESC`，列含 CI |
| `GET /runs/:jobId/rows?group=&page=&pageSize=&sort=` | group 必填 | 全量行分页 + 任意列排序 |
| `GET /runs/:jobId/rows/:rowId` | — | 单行完整字段（详情弹窗） |
| `GET /history?status=&page=` | — | `ml.jobs WHERE run_type='kelly_sweep'` 列表（历史下拉） |

- `sort` 白名单化（只允许表内数值/文本列名），防注入。
- 分页默认 pageSize 50，上限 200。
- group 是必填且只接受两个枚举值——**口径不可跨组比**，接口层强制分组取数，前端不混合。

### 字段白名单派生接口（避免前端硬编码漂移）

base 触发字段白名单的唯一真源是 Python `_ALLOWED_INDICATOR_FIELDS`（`enumerate.py:57`）。**前端不另维护一份**。两种落地方式（实现时择一，推荐 A）：

- **A（推荐）**：NestJS 提供 `GET /api/quant/kelly-sweep/meta`，返回 `{base_fields:[...], exit_families:[...], rs_benchmarks:[...]}`。其中 `base_fields` 由 NestJS 维护一份与 Python 白名单**对齐的常量**（加注释指明源头 `enumerate.py:57`，改 Python 白名单时同步），或后端启动时从一个共享配置读。
- **B**：前端硬编码（最易漂移，不推荐）。

> 注：Python 与 NestJS 跨语言无法直接共享 frozenset，A 的常量仍是「人工对齐」，故必须在两处都加交叉引用注释，并在 [06](./06-testing-verification.md) 加一条「白名单一致性」检查项。这是本设计已知的、可接受的小重复（跨语言边界固有）。
