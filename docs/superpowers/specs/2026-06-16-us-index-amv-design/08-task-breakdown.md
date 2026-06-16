# 08 · 任务拆分（供 subagent-driven-development）

> 按**互不相交的文件域**切分，避免多 agent 同改一文件（不用 worktree 隔离）。下表标「独占文件」=
> 只有该任务能编辑；标「新建」=该任务创建。共享文件（`app.module.ts`/`ml-job.entity.ts`/
> `create-job.dto.ts`/`dispatcher.py`/`cli.py`）已**指定唯一属主**。

## 依赖 DAG

```text
   T2 (公式+parity, 纯, 可即起)
            |
            v
T1 ---+---> T3 (Python管线: 含 dispatcher 路由) ---+
      |                                            +--> T6 (真机 e2e)
      +---> T4 (NestJS模块) ---> T5 (前端) --------+
```
- T1、T2 可并行起步。T3 需 T1(表)+T2(公式)。T4 需 T1(表+实体+run_type声明)。T5 需 T4(API契约)。
- T6 需全部完成。

**⚠️ 集成顺序硬约束（run_type 声明 vs worker 路由的中间态）**：T1 把 `us_index_amv_sync` 放进
DB CHECK + DTO 白名单（声明可派），但 dispatcher `_ROUTES` 路由在 **T3**。若 T1+T4 先合、T3 未合，
POST `/api/us-index-amv/sync` 会**派 job 成功（过 CHECK）却被 worker 判 `unknown run_type` 静默 failed**
（[dispatcher.py:654-661] 兜底 `_finalize_job(status='failed')`，不撞约束 500）。故：
- **T3（dispatcher 路由）必须先于「任何能 POST /sync 的真机路径（T4 controller + T5 按钮）」可用之前合入**，
  或 T1+T3+T4 同批合入。
- CLI 直跑（`job_id=None`，不经 dispatcher）不受此限，可在 T3 完成后先验。

## T1 · 数据模型 + run_type 声明

**独占 / 新建文件：**
- 新建 `apps/server/migrations/20260616160000-create-us-index-amv-tables.{sql,ps1}`（两张表 DDL，见 [02](./02-data-model.md)）
- 新建 `apps/server/migrations/20260616150000-us-index-amv-run-type-check.{sql,ps1}`（CHECK +`us_index_amv_sync`）
- 新建 `apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/20260616_0002_add_us_index_amv_sync_run_type.py`
- 新建 `apps/server/src/entities/raw/us-index-amv-daily.entity.ts`、`entities/raw/us-index-constituent.entity.ts`
- **独占编辑** `apps/server/src/entities/ml/ml-job.entity.ts`（`MlJobRunType` +`| 'us_index_amv_sync'`）
- **独占编辑** `apps/server/src/modules/quant/dto/create-job.dto.ts`（`ALLOWED_RUN_TYPES` +`'us_index_amv_sync'`）

**不碰** `app.module.ts`（归 T4）。
**Done**：跑两组建表/约束 `.ps1`；alembic 先 `uv run alembic current`（预期 `20260614_0001`，**当前脱节**见
[02 §4](./02-data-model.md#4-迁移执行与顺序alembic-当前脱节已实跑核验)）→ `--sql` 审 → `upgrade head`（会连跑
`0001`+`0002`，幂等安全）→ **`alembic current` 应推进到 `20260616_0002`**；真 DB `\d` 两表存在、
`pg_get_constraintdef` 含 16 值（含 `us_index_amv_sync`）；`pnpm --filter @cryptotrading/server build` 绿。

## T2 · 公式移植 + parity（纯，可即起）

**新建文件：**
- `apps/quant-pipeline/src/quant_pipeline/sync/us_index_amv_formula.py`（[03](./03-amv-formula.md) 全 7 函数：
  td_sma/td_ema/calc_macd/ma5/calc_amv_series/calc_zdf/calc_signal）
- `apps/quant-pipeline/tests/fixtures/amv_parity_golden.json`（一次性用 TS `amv-formula.ts` 的 **6 个 export
  函数**跑出，checked-in）
- `apps/quant-pipeline/tests/test_us_index_amv_formula.py`（逐式 parity）

**ma5 注意**：TS `ma5`（[amv-formula.ts:108]）**未 export、不可 import** → golden 只覆盖 6 个 export 函数，
ma5 经 `calc_amv_series` 端到端间接覆盖（见 [03 Parity](./03-amv-formula.md#parity-测试金标准-fixture)）。
**T2 不改 A 股 `amv-formula.ts`**（不为 US 功能给它加 export，零碰 active-mv 域）。
**Done**：`uv run pytest tests/test_us_index_amv_formula.py` 绿；golden 覆盖 NaN/边界/`v3≤0`/`amv_close≤0`。

## T3 · Python 管线

**新建文件：**
- `sync/us_index_constituent.py`（seed + 读名单）、`sync/us_index_amv.py`（取数+Σ+套公式+写表）、
  `sync/us_index_amv_orchestrator.py`（`run_us_index_amv_sync`）
- `data/us_index_constituent_ndx.csv`（101 行）
- `tests/test_us_index_amv_pipeline.py`（Σ聚合 / 空数据双路径 / warmup / 不×1000 / seed 幂等）

**独占编辑（追加，唯一属主 T3）：**
- `worker/dispatcher.py`（`_runner_us_index_amv` + `_ROUTES["us_index_amv_sync"]`）
- `cli.py`（`us-index-amv-sync` + `us-index-constituent seed`）

**依赖**：T1（表）、T2（`us_index_amv_formula`）。
**Done**：pytest 绿；`uv run quant us-index-constituent seed --csv ...` + `us-index-amv-sync --date-range ...`
真跑写出 `us_index_amv_daily` 行。

## T4 · NestJS 模块

**新建文件：** `apps/server/src/market-data/us-index-amv/`：`us-index-amv.controller.ts` /
`.service.ts` / `.module.ts` / `.types.ts`（+ `.service.spec.ts`）。复用 us-index `format.util`（import，不复制）。

**独占编辑** `apps/server/src/app.module.ts`：import 两实体 + 根 `entities[]` 追加 +
import `UsIndexAmvModule` 进 imports[]（**唯一属主 T4**，T1 不碰）。

**依赖**：T1（实体文件 + 表 + run_type 声明）。
**Done**：`pnpm --filter @cryptotrading/server build` 绿；jest（[07](./07-testing-and-verification.md) §2）绿；
**重启后端**后 `GET /api/us-index-amv?...` 返回（先有 T3 灌的数据）。

## T5 · 前端

**新建文件：** `apps/web/src/api/modules/market/usIndexAmv.ts`（+ vitest）。
**独占编辑** `apps/web/src/components/symbols/us-index/UsIndexPanel.vue`（两处，[06](./06-frontend.md)）。

**依赖**：T4（API 契约）。
**Done**：`pnpm --filter @cryptotrading/web build`（vite）绿 + vitest 绿。

## T6 · 真机 e2e（最终铁证）

无新文件。前置：T1~T5 完成 + migration 已跑 + alembic upgrade + **重启后端**。
按 [07 §4](./07-testing-and-verification.md#4-真机-e2e最终铁证独立浏览器驱动) 6 步全过。

## 冲突矩阵（同一文件的唯一属主）

| 共享文件 | 属主 |
|---|---|
| `apps/server/src/app.module.ts` | **T4** |
| `apps/server/src/entities/ml/ml-job.entity.ts` | **T1** |
| `apps/server/src/modules/quant/dto/create-job.dto.ts` | **T1** |
| `apps/quant-pipeline/.../worker/dispatcher.py` | **T3** |
| `apps/quant-pipeline/.../cli.py` | **T3** |

其余文件均为各任务独占新建，无交叉。
