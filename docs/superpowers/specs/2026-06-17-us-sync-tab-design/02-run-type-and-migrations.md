# 02 新 run_type `us_one_click_sync` 登记与迁移

[← index](./index.md)

新增 run_type 必须**四处同步登记**，漏任一处后果不同（漏 DB CHECK → POST 派 job INSERT 直接 500，项目已踩过此坑）。本文给出确切改动点与枚举值，全部已核到真值。

## 4 处登记清单

```text
① TS 实体联合      apps/server/src/entities/ml/ml-job.entity.ts:37-55  ✅已核
② DTO 白名单       apps/server/src/modules/quant/dto/create-job.dto.ts:60-80  ✅已核
③ DB CHECK 约束    alembic 新 revision + NestJS .sql 镜像（见下）
④ 前端 run_type    apps/web/src/api/modules/quant.ts:135-148（JobRunType）  ✅已核
```

> ⚠️ **三处基线不同，逐处「追加」勿照搬同一份清单**：TS 实体联合、DTO 白名单、DB CHECK 三处当前枚举值集合**并不相同**（历史 drift：`train_e2e` 只在 DB CHECK、`prepare` 等分布不一）。一律在**各处现有列表末尾追加 `us_one_click_sync` 一项**，不要把 DB CHECK 的 17 值清单整份覆盖到 DTO/实体（会误引入 `train_e2e` 到 TS 侧）。

### ① TS 实体联合（ml-job.entity.ts）

在 `MlJobRunType` 联合（当前 15 值，L37-55）追加：

```typescript
  | 'us_one_click_sync' // 美股一键同步（顺序跑 us_sync→us_index_sync→us_index_amv_sync）
```

### ② DTO 白名单（create-job.dto.ts）

`ALLOWED_RUN_TYPES` 数组（L60-80）追加 `'us_one_click_sync'`。校验逻辑（L289-294）无需改，自动覆盖。

### ④ 前端 JobRunType（quant.ts）

`JobRunType` 联合（L135-148）追加 `'us_one_click_sync'`。

> ⚠️ 已知 drift：该前端类型当前**尚未包含** `us_sync / us_index_sync / us_index_amv_sync`（设计期核到）。本次**只补 `us_one_click_sync`**（最小必要），其余既有缺失列入「不做」边界（见 [index 范围边界](./index.md#范围边界不做)），避免扩大改动面。

## ③ DB CHECK 迁移

### 当前约束（权威）

最新 alembic revision：`20260616_0002`（`apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/20260616_0002_add_us_index_amv_sync_run_type.py` ✅已核），约束当前 **16 个值**：

```sql
run_type IN (
  'noop','sync','quality','factors','labels','features',
  'train','infer','optuna','seed_avg','train_e2e','prepare','kelly_sweep',
  'us_sync','us_index_sync','us_index_amv_sync'
)
```

> 注：DB CHECK 含历史遗留 `train_e2e`（TS 侧已删，不能新建），新迁移须**保留**它，只**追加** `us_one_click_sync` → 共 17 值。

### 新 alembic revision

新建 `apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/<rev>_add_us_one_click_sync_run_type.py`：

- `down_revision = "20260616_0002"`（指向当前最新，避免 [Alembic 版本脱节] 坑）。
- `upgrade()`：`DROP CONSTRAINT ml_jobs_run_type_check` → `ADD CONSTRAINT ml_jobs_run_type_check CHECK (run_type IN (...17 值...))`。
- `downgrade()`：还原为 16 值。

迁移落库前先 `alembic current` 确认 head 对齐 `20260616_0002`，避免脱节重跑撞「已存在」。

### NestJS .sql 镜像（+ .ps1）

镜像现有两份的模式（`apps/server/migrations/20260616150000-us-index-amv-run-type-check.sql` ✅已核）：

- 新建 `apps/server/migrations/<ts>-us-one-click-sync-run-type-check.sql`：同样 `DROP` 再 `ADD` 17 值约束。
- 配套同名 `.ps1`（内置 `docker exec crypto-postgres psql ...`，参考既有 `.ps1`）。

> 两套迁移（alembic + NestJS .sql）作用于**同一张** `ml.jobs` 表、**同一个**约束名 `ml_jobs_run_type_check`，二者最终枚举值必须字面一致（17 值）。实际只需任一套真正执行一次；两套并存是项目既有约定（双轨镜像），spec 要求两份文件内容一致。

## 验收

- 应用迁移后：`docker exec crypto-postgres psql ... -c "\d+ ml.jobs"` 查 `ml_jobs_run_type_check` 含 `us_one_click_sync`。
- `POST /api/us-stocks/one-click-sync` 派 job 不再 500（INSERT 过 CHECK）。
- 单测：create-job DTO 接受 `us_one_click_sync`、拒绝未知值（见 [07](./07-testing-and-verification.md)）。
